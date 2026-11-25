import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { AuthRequiredError, CliError } from '../../cli/lib/errors.ts';
import type { SyncDeps } from './deps.ts';

export type Held = { assertHeld: () => void };

export type FileRecord = {
  srcKey: string;
  epubSha256: string;
  bookHash: string;
  metaHash: string;
  title: string;
  syncedAt: number;
  imagesComplete: boolean;
  /** Remote images this EPUB carries as links: a rebuild is due only when one of them comes in. */
  missingImages: string[];
  rebuildAttemptAt?: number;
};

/** `epub` is relative to the state directory. */
export type Op =
  | { kind: 'upload'; relpath: string; epub: string; newHash: string; record: FileRecord }
  | {
      kind: 'replace';
      relpath: string;
      epub: string;
      oldHash: string;
      newHash: string;
      record: FileRecord;
    }
  | { kind: 'delete'; relpath: string; oldHash: string };

export type Identity = { vault: string; server: string; userId: string };

export type State = {
  version: 1;
  identity?: Identity;
  files: Record<string, FileRecord>;
  history: Record<string, string>;
  optOut: Record<string, string>;
  pending: Record<string, { srcKey: string; firstDeferredAt: number }>;
  ops: Op[];
  authAlertSentAt?: number;
};

export const emptyState = (): State => ({
  version: 1,
  files: {},
  history: {},
  optOut: {},
  pending: {},
  ops: [],
});

const STATE = 'state.json';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const BOOK_HASH = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** The journal steers uploads and recursive outbox removal, so a bad entry stops the run instead. */
export const opProblem = (op: unknown, history: Record<string, unknown> = {}): string | null => {
  if (!isObject(op)) return 'not an object';
  const relpath = op['relpath'];
  if (
    typeof relpath !== 'string' ||
    !relpath ||
    isAbsolute(relpath) ||
    relpath.split(/[\\/]/).includes('..')
  )
    return 'bad relpath';
  const hex = (k: string) => typeof op[k] === 'string' && BOOK_HASH.test(op[k] as string);
  // Only books this sync created may be uploaded over or deleted by a journal entry.
  const ours = (k: string) =>
    typeof op[k] === 'string' &&
    Object.hasOwn(history, op[k] as string) &&
    history[op[k] as string] === relpath;
  if (op['kind'] === 'delete')
    return !hex('oldHash') ? 'bad oldHash' : ours('oldHash') ? null : 'oldHash not ours';
  if (op['kind'] !== 'upload' && op['kind'] !== 'replace') return 'bad kind';
  if (!hex('newHash')) return 'bad newHash';
  if (op['kind'] === 'replace' && !hex('oldHash')) return 'bad oldHash';
  if (!ours('newHash') || (op['kind'] === 'replace' && !ours('oldHash'))) return 'hash not ours';
  const epub = op['epub'];
  const parts = typeof epub === 'string' ? epub.split('/') : [];
  if (
    parts.length !== 3 ||
    parts[0] !== 'outbox' ||
    parts[1] !== op['newHash'] ||
    !/^[^/\\]+\.epub$/.test(parts[2]!) ||
    parts[2]!.startsWith('.')
  )
    return 'bad epub path';
  const rec = op['record'];
  if (
    !isObject(rec) ||
    rec['bookHash'] !== op['newHash'] ||
    typeof rec['metaHash'] !== 'string' ||
    typeof rec['epubSha256'] !== 'string' ||
    !SHA256.test(rec['epubSha256']) ||
    typeof rec['srcKey'] !== 'string' ||
    typeof rec['title'] !== 'string' ||
    typeof rec['syncedAt'] !== 'number' ||
    typeof rec['imagesComplete'] !== 'boolean' ||
    !Array.isArray(rec['missingImages']) ||
    !rec['missingImages'].every((u) => typeof u === 'string')
  )
    return 'bad record';
  return null;
};

export const loadState = async (deps: SyncDeps, dir: string): Promise<State> => {
  let text: string;
  try {
    text = new TextDecoder().decode(await deps.readFile(join(dir, STATE)));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw e;
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new CliError(`state is not valid JSON: ${join(dir, STATE)}`, 2);
  }
  if (!isObject(v) || v['version'] !== 1) {
    throw new CliError(`state has an unknown version: ${join(dir, STATE)}`, 2);
  }
  for (const k of ['files', 'history', 'optOut', 'pending']) {
    if (!isObject(v[k])) throw new CliError(`state is damaged (${k}): ${join(dir, STATE)}`, 2);
  }
  if (!Array.isArray(v['ops']))
    throw new CliError(`state is damaged (ops): ${join(dir, STATE)}`, 2);
  const history = v['history'] as Record<string, unknown>;
  v['ops'].forEach((op, i) => {
    const why = opProblem(op, history);
    if (why) throw new CliError(`state is damaged (ops[${i}]: ${why}): ${join(dir, STATE)}`, 2);
  });
  return v as State;
};

/** tmp + rename, so a crash leaves either the old state or the new one. */
export const saveState = async (deps: SyncDeps, dir: string, s: State, held: Held) => {
  const tmp = join(dir, `${STATE}.${process.pid}.${randomUUID()}.tmp`);
  await deps.writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`);
  try {
    held.assertHeld();
    await deps.rename(tmp, join(dir, STATE));
  } catch (e) {
    await deps.rm(tmp).catch(() => {});
    throw e;
  }
};

export const checkIdentity = (s: State, seen: Identity): 'ok' | 'first' => {
  if (!s.identity) return 'first';
  if (s.identity.vault !== seen.vault) {
    throw new CliError(`state belongs to another vault: ${s.identity.vault}`, 2);
  }
  if (s.identity.server !== seen.server) {
    throw new CliError(`state belongs to another server: ${s.identity.server}`, 2);
  }
  if (s.identity.userId !== seen.userId)
    throw new AuthRequiredError('сменился пользователь readest');
  return 'ok';
};
