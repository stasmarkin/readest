import { AuthRequiredError, CliError } from '../../cli/lib/errors.ts';
import type { RunResult, SyncDeps } from './deps.ts';

export const READEST_TIMEOUT_MS = 15 * 60 * 1000;
export const GROUP = 'Clippings';

export type Whoami = { email: string; userId: string; server: string };
export type LiveBook = { hash: string; metaHash: string | null; title: string };
export type CliItem = {
  status: string;
  reason?: string;
  hash?: string;
  metaHash?: string | null;
  uncertain?: boolean;
  duplicateOf?: { hash: string; title: string };
  step?: string;
};
/** `unknown` — the write may or may not have happened: the operation stays in the journal. */
export type CliOutcome =
  | { kind: 'done'; item: CliItem }
  | { kind: 'fileError'; reason: string }
  | { kind: 'unknown'; reason: string };

const readest = (deps: SyncDeps, args: string[]) =>
  deps.run('readest', args, { timeoutMs: READEST_TIMEOUT_MS });

const tail = (r: RunResult) => (r.stderr.trim().split('\n').pop() ?? '').slice(0, 300);

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** Code 3 is the login (or another account) for any command; other failures are the command's own. */
const checked = (what: string, r: RunResult): unknown => {
  if (r.code === 3) throw new AuthRequiredError(tail(r) || 'login required');
  if (r.code !== 0)
    throw new CliError(`readest ${what} failed (${r.code ?? 'timeout'}): ${tail(r)}`);
  const v = parse(r.stdout);
  if (v === undefined) throw new CliError(`readest ${what}: output is not JSON`);
  return v;
};

export const readestWhoami = async (deps: SyncDeps): Promise<Whoami> => {
  const v = checked('whoami', await readest(deps, ['whoami', '--json'])) as Partial<Whoami>;
  if (typeof v?.userId !== 'string' || typeof v.server !== 'string' || !v.userId) {
    throw new CliError('readest whoami: no userId or server in the answer');
  }
  return { email: String(v.email ?? ''), userId: v.userId, server: v.server };
};

export const readestBooks = async (deps: SyncDeps, userId: string): Promise<LiveBook[]> => {
  const v = checked('books', await readest(deps, ['books', '--json', '--expect-user', userId]));
  if (!Array.isArray(v)) throw new CliError('readest books: not an array');
  return v.filter((b): b is LiveBook => typeof (b as LiveBook)?.hash === 'string');
};

/** One item of upload/delete --json, read per the CLI contract. */
export const interpret = (r: RunResult): CliOutcome => {
  if (r.code === 3) throw new AuthRequiredError(tail(r) || 'login required');
  // A usage error means this program called the CLI wrong: nothing was written.
  if (r.code === 2) return { kind: 'fileError', reason: `readest usage error: ${tail(r)}` };
  if (r.code === null) return { kind: 'unknown', reason: 'readest timed out' };
  const v = parse(r.stdout);
  if (!Array.isArray(v))
    return { kind: 'unknown', reason: `readest output unreadable: ${tail(r)}` };
  if (v.length !== 1) return { kind: 'unknown', reason: `readest run failed: ${tail(r)}` };
  const item = v[0] as CliItem;
  if (typeof item?.status !== 'string')
    return { kind: 'unknown', reason: 'readest item has no status' };
  if (item.status === 'error') {
    const reason = item.reason ?? 'error';
    return item.uncertain ? { kind: 'unknown', reason } : { kind: 'fileError', reason };
  }
  return { kind: 'done', item };
};

export const readestUpload = async (
  deps: SyncDeps,
  epub: string,
  mode: { group: string } | { replace: string; resume: boolean },
  expectMeta: string,
  userId: string,
): Promise<CliOutcome> => {
  const how =
    'group' in mode
      ? ['--group', mode.group]
      : ['--replace', mode.replace, ...(mode.resume ? ['--resume'] : [])];
  return interpret(
    await readest(deps, [
      'upload',
      epub,
      ...how,
      '--expect-meta',
      expectMeta,
      '--expect-user',
      userId,
      '--json',
    ]),
  );
};

export const readestDelete = async (
  deps: SyncDeps,
  hash: string,
  userId: string,
): Promise<CliOutcome> =>
  interpret(await readest(deps, ['delete', hash, '--expect-user', userId, '--json']));
