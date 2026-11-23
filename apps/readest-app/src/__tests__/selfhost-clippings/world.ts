// A whole sync run in tmp: a fake pandoc, a fake readest library, scripted web and levi.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main } from '../../../../../selfhost/clippings/clippings-sync.ts';
import type { RunOpts, RunResult, SyncDeps } from '../../../../../selfhost/clippings/lib/deps.ts';
import type { State } from '../../../../../selfhost/clippings/lib/state.ts';
import { partialMD5Bytes } from '../../../../../selfhost/cli/lib/hash.ts';
import { fakePandoc } from './fake-pandoc';
import { syncDeps } from './helpers';
import type { RunCall } from './helpers';

export type FakeBook = {
  hash: string;
  metaHash: string | null;
  title: string;
  deleted: boolean;
  group?: string;
};
export type Reply = RunResult | undefined;

const res = (code: number, stdout: unknown = '', stderr = ''): RunResult => ({
  code,
  stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout),
  stderr,
});

export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const world = () => {
  const root = mkdtempSync(join(tmpdir(), 'clip-run-'));
  const vault = join(root, 'vault');
  const stateDir = join(root, 'state');
  mkdirSync(vault);
  const books = new Map<string, FakeBook>();
  const w = {
    root,
    vault,
    stateDir,
    books,
    t: Date.UTC(2026, 10, 22, 10),
    userId: 'u1',
    server: 'https://r.test',
    calls: [] as RunCall[],
    fetches: [] as string[],
    /** Runs first for every readest call: return a reply to answer it instead of the fake. */
    readestHook: undefined as ((args: string[]) => Reply | 'after-throw') | undefined,
    web: (_args: string[]): RunResult => res(2, '', 'chromium_down'),
    levi: (_args: string[]): RunResult => res(0),
    fetch: (async () => {
      throw new TypeError('network');
    }) as typeof fetch,
    over: {} as Partial<SyncDeps>,
    pandoc: fakePandoc,
  };

  const flag = (args: string[], name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const live = () => [...books.values()].filter((b) => !b.deleted);

  const fakeReadest = (args: string[]): RunResult => {
    const [cmd] = args;
    if (cmd === '--version') return res(0, 'test\n');
    if (cmd === 'whoami') return res(0, { email: 'me@x', userId: w.userId, server: w.server });
    const expectUser = flag(args, '--expect-user');
    if (expectUser !== undefined && expectUser !== w.userId)
      return res(3, '', 'readest: another account');
    if (cmd === 'books')
      return res(
        0,
        live().map((b) => ({ hash: b.hash, metaHash: b.metaHash, title: b.title })),
      );
    if (cmd === 'delete') {
      const b = books.get(args[1]!);
      if (!b) return res(0, [{ hash: args[1], status: 'skipped', reason: 'missing' }]);
      b.deleted = true;
      return res(0, [{ hash: b.hash, status: 'deleted' }]);
    }
    if (cmd === 'upload') {
      const file = args[1]!;
      const hash = partialMD5Bytes(new Uint8Array(readFileSync(file)));
      const metaHash = flag(args, '--expect-meta')!;
      const title = file;
      const old = flag(args, '--replace');
      const err = (reason: string) => res(1, [{ file, status: 'error', reason }]);
      const existing = books.get(hash);
      if (existing && existing.metaHash !== metaHash) return err('conflict: meta');
      if (old !== undefined) {
        const a = books.get(old);
        if (!a) return err('replace target not found');
        if (a.deleted && !args.includes('--resume')) return err('replace target deleted');
        if (hash === old) return err('same hash');
        let step = 'uploaded';
        if (existing && !existing.deleted) step = 'already';
        else if (existing) {
          existing.deleted = false;
          step = 'revived';
        } else books.set(hash, { hash, metaHash, title, deleted: false, group: a.group });
        books.get(hash)!.group = a.group;
        a.deleted = true;
        return res(0, [{ file, status: 'replaced', step, hash, metaHash, replacedHash: old }]);
      }
      if (existing && !existing.deleted) {
        return res(0, [{ file, status: 'skipped', reason: 'already', hash, metaHash }]);
      }
      if (existing) {
        existing.deleted = false;
        return res(0, [{ file, status: 'revived', hash, metaHash }]);
      }
      const dup = live().find((b) => b.metaHash === metaHash);
      if (dup) {
        return res(0, [
          {
            file,
            status: 'skipped',
            reason: 'duplicate',
            hash,
            metaHash,
            duplicateOf: { hash: dup.hash, title: dup.title },
          },
        ]);
      }
      books.set(hash, { hash, metaHash, title, deleted: false, group: flag(args, '--group') });
      return res(0, [{ file, status: 'uploaded', hash, metaHash, group: flag(args, '--group') }]);
    }
    return res(2, '', `fake readest: ${args.join(' ')}`);
  };

  const run = async (cmd: string, args: string[], opts: RunOpts): Promise<RunResult> => {
    if (cmd === 'pandoc') return w.pandoc(args, opts);
    if (cmd === 'web') return w.web(args);
    if (cmd === 'levi') return w.levi(args);
    if (cmd === 'readest') {
      const hooked = w.readestHook?.(args);
      if (hooked === 'after-throw') {
        fakeReadest(args);
        throw new Error('crash after readest');
      }
      return hooked ?? fakeReadest(args);
    }
    throw new Error(`unexpected process ${cmd}`);
  };

  const sync = async (...flags: string[]) => {
    const s = syncDeps(root, {
      run,
      now: () => w.t,
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        w.fetches.push(String(input));
        return w.fetch(input, init);
      }) as typeof fetch,
      ...w.over,
    });
    const code = await main([...flags, '--vault', vault, '--state', stateDir], s.deps);
    w.calls.push(...s.calls);
    return { code, out: s.stdout(), err: s.stderr(), calls: s.calls };
  };

  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(vault, rel)), { recursive: true });
    writeFileSync(join(vault, rel), text);
  };
  const remove = (rel: string) => rmSync(join(vault, rel));
  const state = (): State =>
    JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) as State;
  const writeState = (s: State) => writeFileSync(join(stateDir, 'state.json'), JSON.stringify(s));
  const outbox = () =>
    existsSync(join(stateDir, 'outbox')) ? readdirSync(join(stateDir, 'outbox')) : [];
  const readestCalls = (calls: RunCall[], sub: string) =>
    calls.filter((c) => c.cmd === 'readest' && c.args[0] === sub);
  const stealLock = () =>
    writeFileSync(
      join(stateDir, 'sync.lock'),
      JSON.stringify({ pid: process.pid, started: 'Mon Jan  1 00:00:00 2024', token: 'thief' }),
    );
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  return {
    w,
    sync,
    put,
    remove,
    state,
    writeState,
    outbox,
    readestCalls,
    live,
    stealLock,
    cleanup,
  };
};

export type World = ReturnType<typeof world>;
