import type { ApiClient, DbBookRow } from './api.ts';
import { isBookHash } from './api.ts';
import type { LibraryBook } from './books.ts';
import { hash7, loadLibrary } from './books.ts';
import type { Profile } from './config.ts';
import type { Deps } from './deps.ts';
import { AuthRequiredError, CliError, markUncertain, UsageError } from './errors.ts';
import { withLock } from './lock.ts';
import { beatRow, bookFromDbRow, isLockLost, uploadLockPath } from './upload.ts';

export type DeleteResult = {
  hash: string;
  status: 'deleted' | 'skipped' | 'error';
  reason?: string;
  uncertain?: true;
};

type Held = { assertHeld: () => void };

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A read that checks a write: when it fails, the write's outcome is unknown. */
const checking = async <T>(p: () => Promise<T>): Promise<T> => {
  try {
    return await p();
  } catch (e) {
    throw markUncertain(e);
  }
};

export const bookRow = async (api: ApiClient, hash: string): Promise<LibraryBook | undefined> =>
  (await loadLibrary({ pullBooks: () => api.pullBookRows(hash) })).find((b) => b.hash === hash);

/** Marks the row deleted unless it already is; false when there is no row at all. */
export const tombstoneBook = async (
  deps: Deps,
  api: ApiClient,
  held: Held,
  hash: string,
  unchanged?: (r: DbBookRow) => boolean,
): Promise<boolean> => {
  const book = await bookRow(api, hash);
  if (!book) return false;
  if (book.deleted) return true;
  if (unchanged && !unchanged(book.raw)) {
    throw markUncertain(new CliError('the book changed meanwhile: run it again'));
  }
  const now = deps.now();
  const row = { ...bookFromDbRow(book.raw), deletedAt: now, updatedAt: beatRow(now, book.raw) };
  held.assertHeld();
  let resp: DbBookRow[];
  try {
    resp = await api.pushBooks([row]);
  } catch (e) {
    if (!(e instanceof CliError && e.uncertain)) throw e;
    if ((await checking(() => bookRow(api, hash)))?.deleted) return true;
    throw markUncertain(new CliError(`sync not confirmed (${message(e)}): run it again`));
  }
  const got = resp.find((r) => r.book_hash === hash);
  if (!got) {
    // An answer without our row says nothing about the write: look.
    if ((await checking(() => bookRow(api, hash)))?.deleted) return true;
    throw markUncertain(new CliError('sync not confirmed (no row in the answer): run it again'));
  }
  if (!got.deleted_at) {
    throw new CliError('conflict with another client: the server kept the book live');
  }
  return true;
};

/** Deletes every object of the book one by one, then proves it by listing again: a 404 proves nothing. */
export const purgeBookObjects = async (api: ApiClient, hash: string, held: Held): Promise<void> => {
  for (const f of await api.bookObjects(hash)) {
    held.assertHeld();
    await api.deleteObject(f.file_key);
  }
  const left = await checking(() => api.bookObjects(hash));
  if (left.length) {
    throw markUncertain(
      new CliError(`objects left after delete: ${left.map((f) => f.file_key).join(', ')}`),
    );
  }
};

const deleteOne = async (
  deps: Deps,
  api: ApiClient,
  held: Held,
  hash: string,
): Promise<DeleteResult> => {
  const hadRow = await tombstoneBook(deps, api, held, hash);
  if (!hadRow && (await api.bookObjects(hash)).length === 0) {
    return { hash, status: 'skipped', reason: 'missing' };
  }
  try {
    await purgeBookObjects(api, hash, held);
  } catch (e) {
    // The row is already gone from the library: only a retry finishes the cleanup.
    throw hadRow ? markUncertain(e) : e;
  }
  return { hash, status: 'deleted' };
};

/** Hashes one by one under the profile's upload lock; one failure does not stop the rest. */
export const runDelete = async (
  deps: Deps,
  api: ApiClient,
  profile: Profile,
  hashes: string[],
): Promise<DeleteResult[]> => {
  const bad = hashes.find((h) => !isBookHash(h));
  if (bad !== undefined) throw new UsageError(`not a book hash: "${bad}"`);
  await api.ensureAuth();
  return withLock(
    uploadLockPath(deps, profile),
    {
      waitMs: null,
      label: 'upload lock',
      onWait: (pid) => deps.stderr(`waiting for upload process ${pid}\n`),
    },
    async (held) => {
      const results: DeleteResult[] = [];
      for (const hash of hashes) {
        try {
          results.push(await deleteOne(deps, api, held, hash));
        } catch (e) {
          if (e instanceof AuthRequiredError) throw e;
          const uncertain = isLockLost(e) || (e instanceof CliError && e.uncertain);
          results.push({
            hash,
            status: 'error',
            reason: message(e),
            ...(uncertain ? { uncertain: true as const } : {}),
          });
          if (isLockLost(e)) break;
        }
      }
      return results;
    },
    deps,
  );
};

export const deleteText = (results: DeleteResult[]): string =>
  results
    .map((r) => {
      if (r.status === 'error') return `error  ${r.hash}: ${r.reason ?? ''}\n`;
      return `${r.status}${r.reason ? ` (${r.reason})` : ''}  ${hash7(r.hash)}\n`;
    })
    .join('');
