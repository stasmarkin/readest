import type { ApiClient, DbBookRow, WireBook } from './api.ts';
import { isBookHash } from './api.ts';
import type { LibraryBook } from './books.ts';
import { ms } from './books.ts';
import type { Profile } from './config.ts';
import { bookRow, purgeBookObjects, tombstoneBook } from './delete.ts';
import type { Deps } from './deps.ts';
import { AuthRequiredError, CliError, markUncertain, UsageError } from './errors.ts';
import { withLock } from './lock.ts';
import { readBookFile } from './metadata.ts';
import { errorResult, uploadLockPath, uploadOneWith } from './upload.ts';
import type { Carry, Ctx, UploadResult } from './upload.ts';

/** What the old row hands to the new one; a finished book is unread again, as importBook re-keys it. */
const carryFrom = (old: LibraryBook): Omit<Carry, 'keepAlready'> => {
  const a = old.raw;
  const status = a.reading_status === 'finished' ? 'unread' : (a.reading_status ?? null);
  const progress = JSON.stringify(a.progress ?? null);
  return {
    overlay: (row: WireBook, current?: LibraryBook): WireBook => ({
      ...row,
      groupId: a.group_id ?? null,
      groupName: a.group_name ?? null,
      // Above both stamps: the server merges group and status on their own clocks.
      groupUpdatedAt: Math.max(ms(a.group_updated_at), ms(current?.raw.group_updated_at)) + 1,
      progress: a.progress ?? null,
      readingStatus: status,
      readingStatusUpdatedAt:
        Math.max(ms(a.reading_status_updated_at), ms(current?.raw.reading_status_updated_at)) + 1,
    }),
    settled: (r: DbBookRow) =>
      (r.group_id ?? null) === (a.group_id ?? null) &&
      (r.group_name ?? null) === (a.group_name ?? null) &&
      JSON.stringify(r.progress ?? null) === progress &&
      (r.reading_status ?? null) === status &&
      ms(r.reading_status_updated_at) > ms(a.reading_status_updated_at),
  };
};

/** The columns the new row takes over, to see that the old one did not move meanwhile. */
const carried = (r: DbBookRow) =>
  JSON.stringify([
    r.group_id ?? null,
    r.group_name ?? null,
    ms(r.group_updated_at),
    r.progress ?? null,
    r.reading_status ?? null,
    ms(r.reading_status_updated_at),
  ]);

const replaceOne = async (
  ctx: Ctx,
  file: string,
  oldHash: string,
  opts: { resume: boolean; expectMeta?: string },
): Promise<UploadResult> => {
  const { deps, api, held } = ctx;
  const old = await bookRow(api, oldHash);
  if (!old) throw new CliError('replace target not found');
  // Only a resumed replace of our own may find the old book deleted: else the user removed it.
  if (old.deleted && !opts.resume) throw new CliError('replace target deleted');
  const info = await readBookFile(file);
  if (info.hash === oldHash) throw new CliError('same hash: the new file is the old book');

  const r = await uploadOneWith(
    ctx,
    file,
    {
      excludeFromDuplicates: oldHash,
      ...(opts.expectMeta !== undefined ? { expectMeta: opts.expectMeta } : {}),
      // Once the old row is gone, a complete new book is the replace already done.
      carry: { ...carryFrom(old), keepAlready: old.deleted },
    },
    info,
  );
  if (r.status === 'error') return r;
  if (r.status === 'skipped' && r.reason === 'duplicate') {
    return {
      ...r,
      status: 'error',
      reason: `duplicate of ${r.duplicateOf?.hash ?? 'another book'}`,
    };
  }

  try {
    // The new row carries this snapshot of the old one: a later change must reach it first.
    await tombstoneBook(deps, api, held, oldHash, (r) => carried(r) === carried(old.raw));
    await purgeBookObjects(api, oldHash, held);
  } catch (e) {
    // The new book is in: whatever failed here, only a retry with --resume can tell.
    throw markUncertain(e);
  }
  return {
    file,
    status: 'replaced',
    step: r.status === 'skipped' ? 'already' : (r.status as 'uploaded' | 'reuploaded' | 'revived'),
    hash: info.hash,
    title: info.title,
    ...(r.group ? { group: r.group } : {}),
    metaHash: r.metaHash ?? null,
    replacedHash: oldHash,
  };
};

/** `upload --replace`: a new version of the book under the profile's upload lock. */
export const runReplace = async (
  deps: Deps,
  api: ApiClient,
  profile: Profile,
  file: string,
  oldHash: string,
  opts: { resume: boolean; expectMeta?: string },
): Promise<UploadResult> => {
  if (!isBookHash(oldHash)) throw new UsageError(`--replace needs a book hash: "${oldHash}"`);
  await api.ensureAuth();
  return withLock(
    uploadLockPath(deps, profile),
    {
      waitMs: null,
      label: 'upload lock',
      onWait: (pid) => deps.stderr(`waiting for upload process ${pid}\n`),
    },
    async (held) => {
      const ctx: Ctx = { deps, api, opts: { dryRun: false, allowDuplicate: false }, held };
      try {
        return await replaceOne(ctx, file, oldHash, opts);
      } catch (e) {
        if (e instanceof AuthRequiredError) throw e;
        return errorResult(file, e);
      }
    },
    deps,
  );
};
