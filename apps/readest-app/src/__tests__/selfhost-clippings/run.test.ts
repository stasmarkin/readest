import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { buildEpub, parseBody } from '../../../../../selfhost/clippings/lib/epub.ts';
import { loadImageCache } from '../../../../../selfhost/clippings/lib/images.ts';
import { buildMeta } from '../../../../../selfhost/clippings/lib/meta.ts';
import { scanVault } from '../../../../../selfhost/clippings/lib/scan.ts';
import type { SyncDeps } from '../../../../../selfhost/clippings/lib/deps.ts';
import type { State } from '../../../../../selfhost/clippings/lib/state.ts';
import { fakePandoc } from './fake-pandoc';
import { syncDeps } from './helpers';
import { DAY, HOUR, world } from './world';
import type { World } from './world';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let cur: World | undefined;
afterEach(() => {
  cur?.cleanup();
  cur = undefined;
});
const mk = () => {
  cur = world();
  return cur;
};

const md = (title: string, body = 'Body text.') => `---\ntitle: ${title}\n---\n${body}\n`;
const liveFor = (W: World, rel: string) => {
  const h = W.state().files[rel]?.bookHash;
  return W.live().filter((b) => b.hash === h);
};

/** The book this file will build to: the build is deterministic. */
const buildOf = async (W: World, rel: string) => {
  const s = syncDeps(W.w.root, { run: (_cmd, args, opts) => fakePandoc(args, opts) });
  const scan = await scanVault(s.deps, W.w.vault);
  const f = scan.files.get(rel)!;
  const built = buildMeta(rel, new TextDecoder().decode(f.bytes), f.srcKey);
  const doc = await parseBody(s.deps, built.body);
  const cache = await loadImageCache(s.deps, join(W.w.root, 'scratch-images'));
  return buildEpub({
    relpath: rel,
    scanned: f,
    built,
    doc,
    cache,
    tmpDir: join(W.w.root, 'scratch'),
    deps: s.deps,
  });
};
const expectedHash = async (W: World, rel: string) => (await buildOf(W, rel)).bookHash;

describe('the fake pandoc', () => {
  it('builds an EPUB the sync reads: the same source, the same book; text, image and srcKey change it', async () => {
    const W = mk();
    W.put('a.md', md('A', 'one ![](p.png)'));
    writeFileSync(join(W.w.vault, 'p.png'), PNG);
    const a = await buildOf(W, 'a.md');
    expect(a.title).toBe('A');
    expect(a.metaHash).toMatch(/^[0-9a-f]{32}$/);
    expect((await buildOf(W, 'a.md')).epubSha256, 'deterministic').toBe(a.epubSha256);
    const png2 = new Uint8Array([...PNG, 1]);
    // srcKey (in dc:relation) changes with text and image too: the content is checked on its own.
    const variants: Array<[string, () => void, (zip: Record<string, Uint8Array>) => void]> = [
      [
        'text',
        () => W.put('a.md', md('A', 'two ![](p.png)')),
        (zip) => expect(strFromU8(zip['t.xhtml']!)).toContain('<p>two <img'),
      ],
      [
        'image',
        () => writeFileSync(join(W.w.vault, 'p.png'), png2),
        (zip) => expect(Object.entries(zip).find(([n]) => n.startsWith('loc-'))?.[1]).toEqual(png2),
      ],
      [
        'srcKey only',
        () => W.put('a.md', `---\ntitle: A\nextra: x\n---\ntwo ![](p.png)\n`),
        () => {},
      ],
    ];
    const seen = new Set([a.bookHash]);
    for (const [what, change, check] of variants) {
      change();
      const b = await buildOf(W, 'a.md');
      expect(seen.has(b.bookHash), what).toBe(false);
      expect(b.metaHash, `${what}: the same metadata`).toBe(a.metaHash);
      check(unzipSync(b.bytes));
      seen.add(b.bookHash);
    }
    W.put('a.md', md('B'));
    expect((await buildOf(W, 'a.md')).metaHash, 'another title').not.toBe(a.metaHash);
  });
});

describe('runSync: basics', () => {
  it('first run uploads into Clippings with --expect-user and --expect-meta; a rerun does nothing', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.put('sub/b.md', md('B'));
    const r = await W.sync();
    expect(r.code, r.err).toBe(0);
    const ups = W.readestCalls(r.calls, 'upload');
    expect(ups).toHaveLength(2);
    for (const c of ups) {
      expect(c.args).toEqual(
        expect.arrayContaining(['--group', 'Clippings', '--expect-user', 'u1', '--json']),
      );
      expect(c.args[c.args.indexOf('--expect-meta') + 1]).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(W.readestCalls(r.calls, 'books')[0]!.args).toEqual([
      'books',
      '--json',
      '--expect-user',
      'u1',
    ]);
    expect(W.live()).toHaveLength(2);
    expect(W.live().every((b) => b.group === 'Clippings')).toBe(true);
    const s = W.state();
    expect(s.identity).toEqual({ vault: W.w.vault, server: 'https://r.test', userId: 'u1' });
    expect(Object.keys(s.files).sort()).toEqual(['a.md', 'sub/b.md']);
    expect(s.history[s.files['a.md']!.bookHash]).toBe('a.md');
    expect(s.ops).toEqual([]);
    expect(W.outbox()).toEqual([]);
    expect(readdirSync(join(W.w.stateDir, 'tmp')), 'build dirs removed').toEqual([]);
    const again = await W.sync();
    expect(again.code).toBe(0);
    expect(W.readestCalls(again.calls, 'upload')).toEqual([]);
    expect(again.out).toBe('итог: +0 ~0 -0, отложено 0, ошибок 0\n');
  });

  it('no pandoc or no readest: exit 2 before anything', async () => {
    const W = mk();
    W.w.over = {
      run: async (cmd) => ({ code: cmd === 'readest' ? 127 : 0, stdout: '', stderr: '' }),
    };
    const r = await W.sync();
    expect(r.code).toBe(2);
    expect(r.err).toContain('readest is not available');
    expect(existsSync(join(W.w.stateDir, 'state.json'))).toBe(false);
  });

  it('a held lock: exit 0, "уже идёт"', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    await W.sync();
    W.stealLock();
    const r = await W.sync();
    expect(r.code).toBe(0);
    expect(r.out).toBe('уже идёт\n');
  });

  it('an unreadable vault: exit 2, no recovery', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.readestHook = (a) => (a[0] === 'upload' ? 'after-throw' : undefined);
    await W.sync();
    W.w.readestHook = undefined;
    rmSync(W.w.vault, { recursive: true });
    const r = await W.sync();
    expect(r.code).toBe(2);
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    expect(W.state().ops).toHaveLength(1);
  });

  it('identity: another server on a later run exits 2; another user exits 3', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    await W.sync();
    W.w.server = 'https://other.test';
    const r = await W.sync();
    expect(r.code).toBe(2);
    expect(r.err).toContain('another server');
    W.w.server = 'https://r.test';
    W.w.userId = 'u2';
    const u = await W.sync();
    expect(u.code).toBe(3);
    expect(u.err).toContain('сменился пользователь readest');
  });

  it('identity is saved on the first run before recovery', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.readestHook = (a) =>
      a[0] === 'books' ? { code: 1, stdout: '', stderr: 'down' } : undefined;
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(W.state().identity?.userId).toBe('u1');
  });
});

const stateWrites =
  (pred: (s: State) => boolean) => async (path: string, data: string | Uint8Array) => {
    if (
      /state\.json\..*\.tmp$/.test(path) &&
      typeof data === 'string' &&
      pred(JSON.parse(data) as State)
    ) {
      throw new Error('crash in saveState');
    }
    writeFileSync(path, data);
  };

describe('runSync: changes', () => {
  it('a replaced local image replaces the book', async () => {
    const W = mk();
    W.put('a.md', md('A', '![](pic.png)'));
    writeFileSync(join(W.w.vault, 'pic.png'), PNG);
    await W.sync();
    const h = W.state().files['a.md']!.bookHash;
    writeFileSync(join(W.w.vault, 'pic.png'), new Uint8Array([...PNG, 9]));
    const r = await W.sync();
    expect(r.out).toMatch(/^replaced a\.md — /);
    expect(W.state().files['a.md']!.bookHash).not.toBe(h);
  });

  it('a registered file emptied is neither deleted nor replaced; written again it is replaced', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    await W.sync();
    W.put('a.md', '');
    const e = await W.sync();
    expect(e.code).toBe(0);
    expect(W.readestCalls(e.calls, 'delete')).toEqual([]);
    expect(W.readestCalls(e.calls, 'upload')).toEqual([]);
    expect(W.live()).toHaveLength(1);
    W.put('a.md', md('A', 'written'));
    expect((await W.sync()).out).toMatch(/^replaced a\.md — /);
  });
});

describe('runSync: journal', () => {
  const crashPoints: Array<[string, (W: World) => Partial<SyncDeps> | 'readest']> = [
    [
      'writing the outbox tmp',
      () => ({
        writeFile: async (p, d) => {
          if (p.endsWith('.epub.tmp')) throw new Error('crash');
          writeFileSync(p, d);
        },
      }),
    ],
    [
      'renaming into the outbox',
      () => ({
        rename: async (a, b) => {
          if (a.endsWith('.epub.tmp')) throw new Error('crash');
          const { renameSync } = await import('node:fs');
          renameSync(a, b);
        },
      }),
    ],
    ['saving the op', () => ({ writeFile: stateWrites((s) => s.ops.length > 0) })],
    ['running readest (after it wrote)', () => 'readest'],
    [
      'saving files without the op',
      () => ({
        writeFile: stateWrites((s) => s.ops.length === 0 && 'a.md' in s.files),
      }),
    ],
    [
      'removing the outbox',
      () => ({
        rm: async (p) => {
          if (p.includes('/outbox/')) throw new Error('crash');
          rmSync(p, { recursive: true, force: true });
        },
      }),
    ],
  ];
  for (const [name, crash] of crashPoints) {
    it(`a crash ${name}: the next run finishes, one live book, empty outbox`, async () => {
      const W = mk();
      W.put('a.md', md('A'));
      const c = crash(W);
      if (c === 'readest') W.w.readestHook = (a) => (a[0] === 'upload' ? 'after-throw' : undefined);
      else W.w.over = c;
      const first = await W.sync();
      expect(first.code).toBe(1);
      expect(readdirSync(join(W.w.stateDir, 'tmp')), 'build dir removed').toEqual([]);
      if (name === 'saving files without the op')
        expect(W.outbox(), 'outbox kept until files').toHaveLength(1);
      W.w.over = {};
      W.w.readestHook = undefined;
      const r = await W.sync();
      expect(r.code, r.err).toBe(0);
      expect(W.live()).toHaveLength(1);
      expect(liveFor(W, 'a.md')).toHaveLength(1);
      expect(W.state().ops).toEqual([]);
      expect(W.outbox()).toEqual([]);
    });
  }

  it('an outbox file without an op (crash before step 2) is removed at the start', async () => {
    const W = mk();
    W.put('a.md', md('A', 'v1'));
    W.w.over = {
      rename: async (a, b) => {
        if (a.endsWith('.epub.tmp')) throw new Error('crash');
        const { renameSync } = await import('node:fs');
        renameSync(a, b);
      },
    };
    await W.sync();
    expect(W.outbox()).toHaveLength(1);
    W.w.over = {};
    W.put('a.md', md('A', 'v2'));
    const r = await W.sync();
    expect(r.code).toBe(0);
    expect(W.outbox()).toEqual([]);
  });

  it('a foreign file in the outbox is not removed', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(W.w.stateDir, 'outbox'), { recursive: true });
    writeFileSync(join(W.w.stateDir, 'outbox', 'notes.txt'), 'mine');
    writeFileSync(join(W.w.stateDir, 'outbox', 'f'.repeat(32)), 'mine too');
    expect((await W.sync()).code).toBe(0);
    expect(W.outbox().sort()).toEqual(['f'.repeat(32), 'notes.txt']);
  });

  it('recovery of a delete; a journalled delete runs even under a mass-delete stop', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    await W.sync();
    const hash = W.state().files['a.md']!.bookHash;
    W.remove('a.md');
    W.w.readestHook = (a) => (a[0] === 'delete' ? 'after-throw' : undefined);
    // An empty vault stops deletes: allowed here to get the op journalled.
    expect((await W.sync('--allow-mass-delete')).code).toBe(1);
    expect(W.state().ops).toEqual([{ kind: 'delete', relpath: 'a.md', oldHash: hash }]);
    W.w.readestHook = undefined;
    const r = await W.sync();
    expect(r.out).toContain('recovered a.md — delete');
    expect(W.state().files).toEqual({});
    expect(W.state().history[hash], 'history stays').toBe('a.md');
    expect(W.readestCalls(r.calls, 'delete')).toHaveLength(1);
    expect(r.code).toBe(0);
  });

  it('skipped: missing on a delete drops the record; no second DELETE', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.put('b.md', md('B'));
    await W.sync();
    W.remove('a.md');
    W.w.readestHook = (a) =>
      a[0] === 'delete'
        ? {
            code: 0,
            stdout: JSON.stringify([{ hash: a[1], status: 'skipped', reason: 'missing' }]),
            stderr: '',
          }
        : undefined;
    const r = await W.sync();
    expect(r.code).toBe(0);
    expect(Object.keys(W.state().files)).toEqual(['b.md']);
    W.w.readestHook = undefined;
    const again = await W.sync();
    expect(W.readestCalls(again.calls, 'delete')).toEqual([]);
  });

  it('A → B → C: B in, crash before files, source now C: B is recovered, then C replaces B', async () => {
    const W = mk();
    W.put('a.md', md('A', 'version A'));
    await W.sync();
    const hashA = W.state().files['a.md']!.bookHash;
    W.put('a.md', md('A', 'version B'));
    W.w.over = {
      writeFile: stateWrites((s) => s.ops.length === 0 && s.files['a.md']?.bookHash !== hashA),
    };
    expect((await W.sync()).code).toBe(1);
    const op = W.state().ops[0]!;
    expect(op.kind).toBe('replace');
    W.w.over = {};
    W.put('a.md', md('A', 'version C'));
    const r = await W.sync();
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^recovered a\.md — replace\nreplaced a\.md — /);
    const s = W.state();
    expect(W.live().map((b) => b.hash)).toEqual([s.files['a.md']!.bookHash]);
    expect(s.files['a.md']!.bookHash).not.toBe(op.kind === 'replace' ? op.newHash : '');
    const replaces = W.readestCalls(r.calls, 'upload');
    expect(replaces[0]!.args, 'recovery resumes').toContain('--resume');
    expect(replaces[1]!.args).not.toContain('--resume');
  });

  it('two unknown outcomes in recovery, then a good run', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.readestHook = (a) => (a[0] === 'upload' ? 'after-throw' : undefined);
    await W.sync();
    const unsure = (a: string[]) =>
      a[0] === 'upload'
        ? {
            code: 1,
            stdout: JSON.stringify([{ status: 'error', reason: 'fetch failed', uncertain: true }]),
            stderr: '',
          }
        : undefined;
    W.w.readestHook = unsure;
    for (let i = 0; i < 2; i++) {
      const r = await W.sync();
      expect(r.code).toBe(1);
      expect(W.readestCalls(r.calls, 'books'), 'stops before the snapshot').toEqual([]);
      expect(W.state().ops).toHaveLength(1);
      expect(W.outbox()).toHaveLength(1);
    }
    W.w.readestHook = undefined;
    const ok = await W.sync();
    expect(ok.code).toBe(0);
    expect(W.state().ops).toEqual([]);
    expect(liveFor(W, 'a.md')).toHaveLength(1);
  });
});

describe('runSync: ownership', () => {
  it('a live book with the built hash that is not ours: conflict, upload never called', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    const h = await expectedHash(W, 'a.md');
    W.w.books.set(h, { hash: h, metaHash: 'm', title: 'foreign', deleted: false });
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(r.out).toContain('error a.md — conflict');
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    expect(W.state().files).toEqual({});
  });

  it('already, revived or reuploaded for a hash not in history: conflict, not in files', async () => {
    for (const status of ['revived', 'reuploaded', 'skipped']) {
      const W = mk();
      W.put('a.md', md('A'));
      W.w.readestHook = (a) => {
        if (a[0] !== 'upload') return undefined;
        const hash = a[1]!.split('/').at(-2);
        const item = {
          status,
          ...(status === 'skipped' ? { reason: 'already' } : {}),
          hash,
          metaHash: 'm',
        };
        return { code: 0, stdout: JSON.stringify([item]), stderr: '' };
      };
      const r = await W.sync();
      expect(r.code, status).toBe(1);
      expect(r.out).toContain('error a.md — conflict');
      const s = W.state();
      expect(s.files, status).toEqual({});
      expect(s.history, 'not claimed').toEqual({});
      expect(W.outbox()).toEqual([]);
      W.cleanup();
    }
  });

  it('skipped: duplicate is an error with duplicateOf', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.readestHook = (a) =>
      a[0] === 'upload'
        ? {
            code: 0,
            stdout: JSON.stringify([
              {
                status: 'skipped',
                reason: 'duplicate',
                hash: a[1]!.split('/').at(-2),
                duplicateOf: { hash: 'd'.repeat(32), title: 'Other' },
              },
            ]),
            stderr: '',
          }
        : undefined;
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`error a.md — duplicate of ${'d'.repeat(32)} (Other)`);
  });

  it('a file error (quota) drops the op and the outbox; the next files go on', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.put('b.md', md('B'));
    let n = 0;
    W.w.readestHook = (a) =>
      a[0] === 'upload' && n++ === 0
        ? {
            code: 1,
            stdout: JSON.stringify([{ status: 'error', reason: 'quota exceeded' }]),
            stderr: '',
          }
        : undefined;
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(r.out).toContain('error a.md — quota exceeded');
    expect(r.out).toMatch(/uploaded b\.md — /);
    expect(W.state().ops).toEqual([]);
    expect(W.outbox()).toEqual([]);
  });

  it('an uncertain error keeps the op and its outbox file', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.readestHook = (a) =>
      a[0] === 'upload'
        ? {
            code: 1,
            stdout: JSON.stringify([{ status: 'error', reason: 'HTTP 502', uncertain: true }]),
            stderr: '',
          }
        : undefined;
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(W.state().ops).toHaveLength(1);
    expect(W.outbox()).toHaveLength(1);
  });

  it('exit 2 from readest: an error of the file, the op is dropped, the run exits 1', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.readestHook = (a) =>
      a[0] === 'upload' ? { code: 2, stdout: '', stderr: 'readest: bad flag' } : undefined;
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(r.out).toContain('error a.md — readest usage error');
    expect(W.state().ops).toEqual([]);
  });

  it('a changed source whose EPUB has the old book hash: hash collision, no CLI call', async () => {
    const W = mk();
    W.put('a.md', md('A', 'v1'));
    await W.sync();
    W.put('a.md', md('A', 'v2'));
    const h2 = await expectedHash(W, 'a.md');
    const s = W.state();
    const old = s.files['a.md']!.bookHash;
    W.w.books.set(h2, { ...W.w.books.get(old)!, hash: h2 });
    s.files['a.md']!.bookHash = h2;
    s.history[h2] = 'a.md';
    W.writeState(s);
    const r = await W.sync();
    expect(r.out).toContain('error a.md — hash collision');
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    expect(W.state().ops).toEqual([]);
  });
});

const ESOC = 'https://esoc.yandex-team.ru/a.png';
const webServes = (W: World, answer: (url: string) => object) => {
  let at = '';
  W.w.web = (args) => {
    if (args[0] === 'open') at = args[1]!;
    if (args[0] === 'get') return { code: 0, stdout: `${at}\n`, stderr: '' };
    if (args[0] === 'eval') {
      const script = Buffer.from(args[2]!, 'base64').toString();
      const url = JSON.parse(script.match(/fetch\(("[^"]*")/)![1]!) as string;
      return { code: 0, stdout: JSON.stringify(JSON.stringify(answer(url))), stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
};
const pngAnswer = (url: string) => ({
  status: 200,
  finalUrl: url,
  b64: Buffer.from(PNG).toString('base64'),
});
const webCalls = (calls: World['w']['calls']) => calls.filter((c) => c.cmd === 'web');

describe('runSync: manual deletion', () => {
  it('a book gone from the library: optOut; never touched again, edited, gone or back', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.put('keep.md', md('Keep'));
    await W.sync();
    const h = W.state().files['a.md']!.bookHash;
    W.w.books.get(h)!.deleted = true;
    const r = await W.sync();
    expect(r.code).toBe(0);
    expect(r.out).toContain('optout a.md');
    expect(W.state().optOut).toEqual({ 'a.md': h });
    expect(Object.keys(W.state().files)).toEqual(['keep.md']);
    W.put('a.md', md('A', 'edited'));
    const e = await W.sync();
    W.remove('a.md');
    const g = await W.sync();
    W.put('a.md', md('A', 'back'));
    const b = await W.sync();
    for (const x of [e, g, b]) {
      expect(W.readestCalls(x.calls, 'upload')).toEqual([]);
      expect(W.readestCalls(x.calls, 'delete')).toEqual([]);
      expect(x.code).toBe(0);
    }
    expect(W.live().map((b) => b.hash)).toEqual([W.state().files['keep.md']!.bookHash]);
  });

  it('replace target deleted: an error now, optOut on the next run', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.put('keep.md', md('Keep'));
    await W.sync();
    const h = W.state().files['a.md']!.bookHash;
    W.put('a.md', md('A', 'edited'));
    W.w.readestHook = (a) => {
      if (a[0] !== 'upload' || !a.includes('--replace')) return undefined;
      W.w.books.get(h)!.deleted = true;
      return {
        code: 1,
        stdout: JSON.stringify([{ status: 'error', reason: 'replace target deleted' }]),
        stderr: '',
      };
    };
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(r.out).toContain('error a.md — replace target deleted');
    expect(W.state().ops).toEqual([]);
    W.w.readestHook = undefined;
    const n = await W.sync();
    expect(n.out).toContain('optout a.md');
    expect(W.state().optOut['a.md']).toBe(h);
  });
});

describe('runSync: deferral and rebuild', () => {
  for (const [name, setup] of [
    ['an intranet image without Chromium', (W: World) => W.put('a.md', md('A', `![](${ESOC})`))],
    [
      'a public image timing out',
      (W: World) => W.put('a.md', md('A', '![](https://p.test/slow.png)')),
    ],
  ] as const) {
    it(`new file with ${name}: deferred, code 0; after 24 h uploaded as a link, code 1`, async () => {
      const W = mk();
      setup(W);
      const r = await W.sync();
      expect(r.code).toBe(0);
      expect(r.out).toContain('deferred a.md — недоступно картинок: 1');
      expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
      const first = W.state().pending['a.md']!.firstDeferredAt;
      expect(first).toBe(W.w.t);
      W.w.t += DAY - 1;
      expect((await W.sync()).code).toBe(0);
      W.w.t += 1;
      const late = await W.sync();
      expect(late.code).toBe(1);
      expect(late.out).toMatch(/uploaded a\.md — [0-9a-f]{7}, без картинок: 1/);
      const s = W.state();
      expect(s.files['a.md']!.imagesComplete).toBe(false);
      expect(s.pending).toEqual({});
    });
  }

  it('a changed file waits too; an edit restarts the wait; a gone file clears pending', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    await W.sync();
    W.put('a.md', md('A', `![](${ESOC})`));
    const r = await W.sync();
    expect(r.code).toBe(0);
    expect(r.out).toContain('deferred a.md');
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    const t0 = W.w.t;
    W.w.t += 20 * HOUR;
    W.put('a.md', md('A', `edited ![](${ESOC})`));
    await W.sync();
    expect(W.state().pending['a.md']!.firstDeferredAt, 'reset by the edit').toBe(t0 + 20 * HOUR);
    W.w.t += 5 * HOUR;
    expect(
      W.readestCalls((await W.sync()).calls, 'upload'),
      '25 h after the first, 5 after the edit',
    ).toEqual([]);
    W.remove('a.md');
    await W.sync('--allow-mass-delete');
    expect(W.state().pending).toEqual({});
  });

  const incomplete = async () => {
    const W = mk();
    W.put('a.md', md('A', `![](${ESOC})`));
    await W.sync();
    W.w.t += DAY;
    expect((await W.sync()).code).toBe(1);
    return W;
  };

  it('rebuild: the image now ok replaces the book; complete afterwards', async () => {
    const W = await incomplete();
    const old = W.state().files['a.md']!.bookHash;
    webServes(W, pngAnswer);
    W.w.t += DAY - 1;
    expect(W.readestCalls((await W.sync()).calls, 'upload'), 'not yet due').toEqual([]);
    W.w.t += 2;
    const r = await W.sync();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('replaced a.md');
    const rec = W.state().files['a.md']!;
    expect(rec.bookHash).not.toBe(old);
    expect(rec.imagesComplete).toBe(true);
    expect(rec.missingImages).toEqual([]);
  });

  it('rebuild: the last temp went gone: complete without a replace', async () => {
    const W = await incomplete();
    webServes(W, (url) => ({ status: 404, finalUrl: url, b64: '' }));
    W.w.t += DAY + 1;
    const r = await W.sync();
    expect(r.code).toBe(0);
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    expect(W.state().files['a.md']!.imagesComplete).toBe(true);
  });

  it('rebuild without improvement: code 0, attempt stamped, no second try the same day', async () => {
    const W = await incomplete();
    W.w.t += DAY + 1;
    const r = await W.sync();
    expect(r.code).toBe(0);
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    expect(webCalls(r.calls).length, 'the image was tried').toBeGreaterThan(0);
    expect(W.state().files['a.md']!.rebuildAttemptAt).toBe(W.w.t);
    W.w.t += HOUR;
    const again = await W.sync();
    expect(webCalls(again.calls)).toEqual([]);
    expect(again.code).toBe(0);
  });

  it('rebuild looks at its own missing images, not at a shared URL another article already has', async () => {
    const W = await incomplete();
    const s = W.state();
    // An image of this article that is cached ok elsewhere must not count as an improvement.
    const cachePath = join(W.w.stateDir, 'images', 'images.json');
    const index = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    index['https://p.test/shared.png'] = { status: 'ok', file: 'x.png', failures: 0, checkedAt: 0 };
    writeFileSync(cachePath, JSON.stringify(index));
    W.put('a.md', md('A', `![](${ESOC}) ![](https://p.test/shared.png)`));
    s.files['a.md']!.srcKey = (await scanVault(syncDeps(W.w.root).deps, W.w.vault)).files.get(
      'a.md',
    )!.srcKey;
    W.writeState(s);
    W.w.t += DAY + 1;
    const r = await W.sync();
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    expect(W.state().files['a.md']!.rebuildAttemptAt).toBe(W.w.t);
  });
});

describe('runSync: login', () => {
  it('whoami exit 3: the login hint on stderr, exit 3', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.readestHook = (a) =>
      a[0] === 'whoami' ? { code: 3, stdout: '', stderr: 'login required' } : undefined;
    const r = await W.sync();
    expect(r.code).toBe(3);
    expect(r.err).toContain('readest: нужен вход — выполни `readest login`');
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
  });

  it('exit 3 mid-run: stop after that operation, which stays journalled; exit 3', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.put('b.md', md('B'));
    W.put('c.md', md('C'));
    let n = 0;
    W.w.readestHook = (a) =>
      a[0] === 'upload' && ++n === 2 ? { code: 3, stdout: '', stderr: 'login' } : undefined;
    const r = await W.sync();
    expect(r.code).toBe(3);
    expect(W.readestCalls(r.calls, 'upload')).toHaveLength(2);
    expect(W.state().ops.map((o) => o.relpath)).toEqual(['b.md']);
    expect(Object.keys(W.state().files)).toEqual(['a.md']);
  });

  it('--notify: one levi call per run of refusals; refused by levi it is sent again; reset by a good run', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    await W.sync();
    const refuse = (a: string[]) =>
      a[0] === 'whoami' ? { code: 3, stdout: '', stderr: 'x' } : undefined;
    const levis = (calls: World['w']['calls']) => calls.filter((c) => c.cmd === 'levi');
    W.w.readestHook = refuse;
    W.w.levi = () => ({ code: 1, stdout: '', stderr: 'daemon down' });
    const r0 = await W.sync('--notify');
    expect(levis(r0.calls)).toHaveLength(1);
    expect(W.state().authAlertSentAt, 'not accepted').toBeUndefined();
    W.w.levi = () => ({ code: 0, stdout: '', stderr: '' });
    const r1 = await W.sync('--notify');
    expect(levis(r1.calls).map((c) => c.args)).toEqual([
      ['notify', 'readest: нужен вход — выполни `readest login`', '--from', 'clippings-sync'],
    ]);
    expect(W.state().authAlertSentAt).toBe(W.w.t);
    const r2 = await W.sync('--notify');
    expect(r2.code).toBe(3);
    expect(levis(r2.calls), 'second refusal in a row').toEqual([]);
    // A run whose login calls all pass resets the flag, a file error notwithstanding.
    W.w.readestHook = (a) =>
      a[0] === 'upload'
        ? { code: 1, stdout: JSON.stringify([{ status: 'error', reason: 'quota' }]), stderr: '' }
        : undefined;
    W.put('b.md', md('B'));
    expect((await W.sync('--notify')).code).toBe(1);
    expect(W.state().authAlertSentAt).toBeUndefined();
    W.w.readestHook = refuse;
    expect(levis((await W.sync('--notify')).calls)).toHaveLength(1);
  });

  it('without --notify no levi call', async () => {
    const W = mk();
    W.w.readestHook = (a) => (a[0] === 'whoami' ? { code: 3, stdout: '', stderr: 'x' } : undefined);
    const r = await W.sync();
    expect(r.calls.filter((c) => c.cmd === 'levi')).toEqual([]);
  });
});

describe('runSync: guards', () => {
  it('an empty vault: no deletes, exit 2; --allow-mass-delete deletes', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    await W.sync();
    W.remove('a.md');
    const r = await W.sync();
    expect(r.code).toBe(2);
    expect(r.err).toContain('vault пуст');
    expect(W.readestCalls(r.calls, 'delete')).toEqual([]);
    expect(W.live()).toHaveLength(1);
    const ok = await W.sync('--allow-mass-delete');
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/deleted a\.md — /);
    expect(W.live()).toEqual([]);
  });

  it('11 of 50 gone: no deletes, other work done, exit 2; the flag lifts it', async () => {
    const W = mk();
    for (let i = 0; i < 39; i++) W.put(`f${i}.md`, md(`F${i}`));
    const scan = await scanVault(syncDeps(W.w.root).deps, W.w.vault);
    const s: State = {
      version: 1,
      identity: { vault: W.w.vault, server: W.w.server, userId: W.w.userId },
      files: {},
      history: {},
      optOut: {},
      pending: {},
      ops: [],
    };
    for (let i = 0; i < 50; i++) {
      const hash = i.toString(16).padStart(32, '0');
      s.files[`f${i}.md`] = {
        srcKey: scan.files.get(`f${i}.md`)?.srcKey ?? 'gone',
        epubSha256: 'e',
        bookHash: hash,
        metaHash: `m${i}`,
        title: 't',
        syncedAt: W.w.t,
        imagesComplete: true,
        missingImages: [],
      };
      s.history[hash] = `f${i}.md`;
      W.w.books.set(hash, { hash, metaHash: `m${i}`, title: 't', deleted: false });
    }
    const { mkdirSync } = await import('node:fs');
    mkdirSync(W.w.stateDir, { recursive: true });
    W.writeState(s);
    W.put('new.md', md('New'));
    const r = await W.sync();
    expect(r.code).toBe(2);
    expect(r.err).toContain('исчезло 11 файлов');
    expect(W.readestCalls(r.calls, 'delete')).toEqual([]);
    expect(r.out).toMatch(/uploaded new\.md/);
    const ok = await W.sync('--allow-mass-delete');
    expect(ok.code).toBe(0);
    expect(W.readestCalls(ok.calls, 'delete')).toHaveLength(11);
  });

  it('a library missing more books than the limit: no optOut, exit 2; the flag lifts it', async () => {
    const W = mk();
    for (let i = 0; i < 11; i++) W.put(`f${i}.md`, md(`F${i}`));
    await W.sync();
    for (const b of W.w.books.values()) b.deleted = true;
    const r = await W.sync();
    expect(r.code).toBe(2);
    expect(r.err).toContain('optOut не записан');
    expect(W.state().optOut).toEqual({});
    expect(Object.keys(W.state().files)).toHaveLength(11);
    const ok = await W.sync('--allow-mass-delete');
    expect(ok.code).toBe(0);
    expect(Object.keys(W.state().optOut)).toHaveLength(11);
  });

  it('an empty library snapshot with a few books: no optOut, exit 2', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.put('b.md', md('B'));
    await W.sync();
    for (const b of W.w.books.values()) b.deleted = true;
    const r = await W.sync();
    expect(r.code).toBe(2);
    expect(W.state().optOut).toEqual({});
  });

  it('a stat failure in the vault: exit 2, no delete', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.put('b.md', md('B'));
    await W.sync();
    W.w.over = {
      stat: async (p) => {
        if (p.endsWith('a.md')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        const { fsDeps } = await import('../../../../../selfhost/clippings/lib/deps.ts');
        return fsDeps.stat(p);
      },
    };
    const r = await W.sync();
    expect(r.code).toBe(2);
    expect(W.readestCalls(r.calls, 'delete')).toEqual([]);
  });

  it('--dry-run prints the plan and pending ops; writes, downloads and calls nothing', async () => {
    const W = mk();
    W.put('keep.md', md('Keep'));
    W.put('edit.md', md('Edit'));
    W.put('gone.md', md('Gone'));
    W.put('z-crash.md', md('Crash'));
    W.w.readestHook = (a) =>
      a[0] === 'upload' && a[1]!.includes('z-crash') ? 'after-throw' : undefined;
    await W.sync();
    W.w.readestHook = undefined;
    W.put('edit.md', md('Edit', 'changed'));
    W.remove('gone.md');
    W.put('new.md', md('New', '![](https://p.test/x.png)'));
    const listing = () => {
      const all: string[] = [];
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name);
          if (e.isDirectory()) walk(p);
          else all.push(`${p}:${readFileSync(p).length}`);
        }
      };
      walk(W.w.stateDir);
      return all.sort();
    };
    const before = listing();
    const stateBefore = readFileSync(join(W.w.stateDir, 'state.json'), 'utf8');
    W.w.fetches.length = 0;
    const r = await W.sync('--dry-run');
    expect(r.code).toBe(0);
    expect(readFileSync(join(W.w.stateDir, 'state.json'), 'utf8')).toBe(stateBefore);
    expect(listing()).toEqual(before);
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    expect(W.readestCalls(r.calls, 'delete')).toEqual([]);
    expect(r.calls.filter((c) => c.cmd === 'web')).toEqual([]);
    expect(W.w.fetches).toEqual([]);
    expect(r.out).toContain('незавершённая операция: upload z-crash.md');
    expect(r.out).toContain('требуется скачивание https://p.test/x.png');
    expect(r.out).toContain('план: залить new.md (отсрочка, если не скачаются картинки: 1)');
    expect(r.out).toContain('план: заменить edit.md');
    expect(r.out).toContain('план: удалить gone.md');
  });

  it('a first run with --dry-run creates no state', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    const r = await W.sync('--dry-run');
    expect(r.code).toBe(0);
    expect(r.out).toContain('план: залить a.md');
    expect(existsSync(join(W.w.stateDir, 'state.json'))).toBe(false);
  });
});

describe('runSync: lock', () => {
  const renameThen = (W: World, when: (s: State) => boolean) => ({
    rename: async (a: string, b: string) => {
      const { renameSync } = await import('node:fs');
      renameSync(a, b);
      if (b.endsWith('state.json') && when(W.state())) W.stealLock();
    },
  });

  it('lock taken after the op is written: readest is not called, the op stays, exit 1', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.over = renameThen(W, (s) => s.ops.length > 0);
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(r.err).toContain('lock lost');
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    expect(W.state().ops).toHaveLength(1);
  });

  it('lock taken before recovery calls readest: not called, the op stays', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.readestHook = (a) => (a[0] === 'upload' ? 'after-throw' : undefined);
    await W.sync();
    W.w.readestHook = undefined;
    W.w.over = {
      readdir: async (p) => {
        if (p.endsWith('/outbox')) W.stealLock();
        const { fsDeps } = await import('../../../../../selfhost/clippings/lib/deps.ts');
        return fsDeps.readdir(p);
      },
    };
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(W.readestCalls(r.calls, 'upload')).toEqual([]);
    expect(W.state().ops).toHaveLength(1);
  });

  it('lock taken before the outbox is removed: the file stays for its new owner', async () => {
    const W = mk();
    W.put('a.md', md('A'));
    W.w.over = renameThen(W, (s) => s.ops.length === 0 && 'a.md' in s.files);
    const r = await W.sync();
    expect(r.code).toBe(1);
    expect(W.outbox()).toHaveLength(1);
  });
});

describe('runSync: output', () => {
  it('a mixed run: one line per action in order, then the total; exit 1', async () => {
    const W = mk();
    W.put('d-change.md', md('D'));
    W.put('e-gone.md', md('E'));
    W.put('r-rec.md', md('R'));
    W.w.readestHook = (a) =>
      a[0] === 'upload' && a[1]!.includes('r-rec') ? 'after-throw' : undefined;
    await W.sync();
    W.w.readestHook = (a) =>
      a[0] === 'upload' && a[1]!.includes('c-quota')
        ? {
            code: 1,
            stdout: JSON.stringify([{ status: 'error', reason: 'quota exceeded' }]),
            stderr: '',
          }
        : undefined;
    W.put('d-change.md', md('D', 'changed'));
    W.remove('e-gone.md');
    W.put('a-new.md', md('A'));
    W.put('b-defer.md', md('B', `![](${ESOC})`));
    W.put('c-quota.md', md('C'));
    const eHash = W.state().files['e-gone.md']!.bookHash;
    const r = await W.sync();
    const s = W.state();
    const h7 = (rel: string) => s.files[rel]!.bookHash.slice(0, 7);
    expect(r.out).toBe(
      [
        'recovered r-rec.md — upload',
        `uploaded a-new.md — ${h7('a-new.md')}`,
        'deferred b-defer.md — недоступно картинок: 1',
        'error c-quota.md — quota exceeded',
        `replaced d-change.md — ${h7('d-change.md')}`,
        `deleted e-gone.md — ${eHash.slice(0, 7)}`,
        'итог: +1 ~1 -1, отложено 1, ошибок 1',
        '',
      ].join('\n'),
    );
    expect(r.code).toBe(1);
  });
});
