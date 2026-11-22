import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiClient, DbBookRow, FileRow, WireBook } from './api.ts';
import { HttpError } from './api.ts';
import type { LibraryBook } from './books.ts';
import { hash7, liveBooks, loadLibrary, ms, parseMetadata } from './books.ts';
import type { Profile } from './config.ts';
import type { Deps } from './deps.ts';
import { AuthRequiredError, CliError, UsageError } from './errors.ts';
import { md5Fingerprint, partialMD5Bytes } from './hash.ts';
import { withLock } from './lock.ts';
import { EXT, readBookFile } from './metadata.ts';
import type { BookFileInfo } from './metadata.ts';
import { configDir } from './session.ts';

/** The book's `files` record (its key ends in `.<ext>`, unlike cover.png) and whether the object is there. */
export type Probe = { record?: FileRow; present: boolean };

export type Decision = {
  kind: 'uploaded' | 'reuploaded' | 'revived' | 'skipped';
  reason?: 'already' | 'duplicate';
  server?: LibraryBook;
  dup?: LibraryBook;
  bookFileName: string;
  uploadCover: boolean;
};

export type UploadResult = {
  file: string;
  status: Decision['kind'] | 'error';
  reason?: string;
  hash?: string;
  title?: string;
  group?: string;
  duplicateOf?: { hash: string; title: string };
  dryRun?: true;
  format?: string;
  metaHash?: string | null;
  author?: string;
  keys?: string[];
};

type StorageApi = Pick<ApiClient, 'storageList' | 'downloadUrl' | 'probeObject'>;

export const probeBook = async (api: StorageApi, hash: string, ext: string): Promise<Probe> => {
  const files = await api.storageList(hash);
  const record = files.find(
    (f) => f.file_key.endsWith(`.${ext}`) && !f.file_key.endsWith('/cover.png'),
  );
  if (!record) return { present: false };
  let url: string;
  try {
    url = await api.downloadUrl(record.file_key);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return { record, present: false };
    throw e;
  }
  return { record, present: (await api.probeObject(url)) === 'present' };
};

const coverKey = (hash: string) => `Readest/Books/${hash}/cover.png`;

/** A record's key without its `<user_id>/` prefix: the name the upload endpoint takes. */
const fileNameOf = (info: BookFileInfo, p: Probe) =>
  p.record
    ? p.record.file_key.slice(p.record.file_key.indexOf('/') + 1)
    : `Readest/Books/${info.hash}/${info.hash}.${EXT[info.format]}`;

export const decide = async (
  info: BookFileInfo,
  books: LibraryBook[],
  probe: (hash: string) => Promise<Probe>,
  opts: { allowDuplicate: boolean },
): Promise<Decision> => {
  const server = books.find((b) => b.hash === info.hash);
  const hasCover = !!info.cover;
  if (server && !server.deleted) {
    const p = await probe(info.hash);
    if (server.uploadedAt && p.present) {
      return {
        kind: 'skipped',
        reason: 'already',
        server,
        bookFileName: fileNameOf(info, p),
        uploadCover: false,
      };
    }
    return {
      kind: 'reuploaded',
      server,
      bookFileName: fileNameOf(info, p),
      uploadCover: hasCover && !server.raw.cover_hash,
    };
  }
  if (server) {
    const p = await probe(info.hash);
    return { kind: 'revived', server, bookFileName: fileNameOf(info, p), uploadCover: hasCover };
  }
  if (!opts.allowDuplicate && info.metaHash) {
    const dup = liveBooks(books).find((b) => b.metaHash === info.metaHash);
    if (dup) {
      return {
        kind: 'skipped',
        reason: 'duplicate',
        dup,
        bookFileName: fileNameOf(info, { present: false }),
        uploadCover: false,
      };
    }
  }
  // A record without a row is left by an interrupted first upload: reuse its key.
  const p = await probe(info.hash);
  return { kind: 'uploaded', bookFileName: fileNameOf(info, p), uploadCover: hasCover };
};

/** `--group A/B`: the app keys groups by md5Fingerprint of the path (libraryStore.refreshGroups). */
export const groupFields = (
  path?: string,
): { groupId: string | null; groupName: string | null } => {
  if (path === undefined) return { groupId: null, groupName: null };
  const segments = path.split('/').map((s) => s.trim());
  if (segments.some((s) => !s)) throw new UsageError(`--group has an empty segment: "${path}"`);
  const name = segments.join('/');
  return { groupId: md5Fingerprint(name), groupName: name };
};

const time = (s?: string | null): number | null => (s ? Date.parse(s) : null);

/** transformBookFromDB's fields: POST /api/sync writes an omitted field as null. */
export const bookFromDbRow = (r: DbBookRow): WireBook => {
  const b: WireBook = {
    hash: r.book_hash,
    metaHash: r.meta_hash ?? null,
    format: r.format,
    title: r.title,
    author: r.author,
    sourceTitle: r.source_title ?? null,
    groupId: r.group_id ?? null,
    groupName: r.group_name ?? null,
    groupUpdatedAt: time(r.group_updated_at),
    tags: r.tags ?? null,
    progress: r.progress ?? null,
    readingStatus: r.reading_status ?? null,
    readingStatusUpdatedAt: time(r.reading_status_updated_at),
    coverHash: r.cover_hash ?? null,
    coverUpdatedAt: time(r.cover_updated_at),
    metadata: parseMetadata(r.metadata),
    metadataUpdatedAt: time(r.metadata_updated_at),
    createdAt: time(r.created_at) ?? Date.now(),
    updatedAt: time(r.updated_at) ?? Date.now(),
    deletedAt: time(r.deleted_at),
    uploadedAt: time(r.uploaded_at),
  };
  if (r.page_count != null) b.pageCount = r.page_count;
  if (r.original_filename != null) b.originalFilename = r.original_filename;
  return b;
};

export const buildRow = (
  info: BookFileInfo,
  d: Decision,
  opts: { group?: string },
  now: number,
  cover?: { hash: string },
): WireBook => {
  const group = groupFields(opts.group);
  const fromFile = {
    metaHash: info.metaHash,
    format: info.format,
    title: info.title,
    sourceTitle: info.sourceTitle,
    author: info.author,
    originalFilename: info.originalFilename,
    metadata: { ...info.metadata } as Record<string, unknown>,
    metadataUpdatedAt: now,
  };
  const newCover = cover ? { coverHash: cover.hash, coverUpdatedAt: now } : {};
  if (d.kind === 'skipped') throw new CliError('internal: no row for a skipped book');
  if (d.kind === 'uploaded' || !d.server) {
    return {
      hash: info.hash,
      ...fromFile,
      groupId: group.groupId,
      groupName: group.groupName,
      groupUpdatedAt: opts.group !== undefined ? now : null,
      progress: null,
      readingStatus: null,
      coverHash: cover?.hash ?? null,
      coverUpdatedAt: cover ? now : null,
      createdAt: now,
      updatedAt: now,
      uploadedAt: now,
      deletedAt: null,
    };
  }
  const base = bookFromDbRow(d.server.raw);
  // The server keeps the row with the later updated_at: beat it even if its writer's clock runs ahead.
  const updatedAt = Math.max(now, ms(d.server.raw.updated_at) + 1, ms(d.server.raw.deleted_at) + 1);
  if (d.kind === 'reuploaded') return { ...base, uploadedAt: now, updatedAt, ...newCover };
  return {
    ...base,
    ...fromFile,
    // Like importBook: a filename-salted metaHash is kept, a renamed file must not re-key the book.
    metaHash: info.format === 'PDF' && base.metaHash ? base.metaHash : info.metaHash,
    ...(opts.group !== undefined
      ? { groupId: group.groupId, groupName: group.groupName, groupUpdatedAt: now }
      : {}),
    ...newCover,
    deletedAt: null,
    uploadedAt: now,
    updatedAt,
  };
};

export const uploadLockPath = (deps: Deps, profile: Profile) =>
  join(configDir(deps), `upload-${profile.key}.lock`);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isLockLost = (e: unknown) => e instanceof CliError && e.message.startsWith('lock lost');

/** A failed POST that may still have been applied: network errors, timeouts, 5xx. */
const isUncertain = (e: unknown) =>
  !(e instanceof AuthRequiredError) && !(e instanceof HttpError && e.status < 500);

const rowChanged = (a?: LibraryBook, b?: LibraryBook) =>
  !a !== !b ||
  (!!a &&
    !!b &&
    (ms(a.raw.updated_at) !== ms(b.raw.updated_at) ||
      ms(a.raw.deleted_at) !== ms(b.raw.deleted_at)));

// The server refuses POST /api/sync bodies over 1 MiB; keep headroom.
const MAX_ROW_BYTES = 900 * 1024;
const rowBytes = (row: WireBook) =>
  Buffer.byteLength(JSON.stringify({ books: [row], notes: [], configs: [] }));

const isOurs = (got: DbBookRow | undefined, row: WireBook) =>
  !!got && !got.deleted_at && ms(got.uploaded_at) === row.uploadedAt;

type Ctx = {
  deps: Deps;
  api: ApiClient;
  opts: { group?: string; dryRun: boolean; allowDuplicate: boolean };
  held: { assertHeld: () => void };
};

const groupOf = (d: Decision, opts: Ctx['opts']): string | null => {
  if ((d.kind === 'uploaded' || d.kind === 'revived') && opts.group !== undefined) {
    return groupFields(opts.group).groupName;
  }
  return d.server?.groupName ?? null;
};

const resultOf = (
  file: string,
  info: BookFileInfo,
  d: Decision,
  group: string | null,
): UploadResult => ({
  file,
  status: d.kind,
  ...(d.reason ? { reason: d.reason } : {}),
  hash: info.hash,
  title: info.title,
  ...(group ? { group } : {}),
  ...(d.dup ? { duplicateOf: { hash: d.dup.hash, title: d.dup.title } } : {}),
});

const uploadOne = async (ctx: Ctx, file: string): Promise<UploadResult> => {
  const { deps, api, opts } = ctx;
  const info = await readBookFile(file);
  const probe = (h: string) => probeBook(api, h, EXT[info.format]);

  /** Every decision is made on this book's rows (by hash or metaHash) fresh from the server. */
  let rows: LibraryBook[] = [];
  const reread = async (): Promise<LibraryBook | undefined> => {
    rows = await loadLibrary({ pullBooks: () => api.pullBookRows(info.hash, info.metaHash) });
    return rows.find((b) => b.hash === info.hash);
  };

  const first = await reread();
  let d = await decide(info, rows, probe, opts);

  const uploadedKeys: string[] = [];
  const leftAt = () => uploadedKeys.join(', ');

  /** The row to POST, within the server's body limit; drops a too-large description once. */
  const sizedRow = (dd: Decision, cover?: { hash: string }): WireBook => {
    let row = buildRow(info, dd, opts, deps.now(), cover);
    if (
      rowBytes(row) > MAX_ROW_BYTES &&
      dd.kind !== 'reuploaded' &&
      info.metadata.description !== undefined
    ) {
      delete info.metadata.description;
      deps.stderr(`warning: ${file}: the description is too large for the sync row; dropped it\n`);
      row = buildRow(info, dd, opts, deps.now(), cover);
    }
    if (rowBytes(row) > MAX_ROW_BYTES) {
      const left = uploadedKeys.length ? `; uploaded objects left at ${leftAt()}` : '';
      throw new CliError(`the book's sync row is too large (over ${MAX_ROW_BYTES} bytes)${left}`);
    }
    return row;
  };

  const finish = (dd: Decision, group: string | null): UploadResult => {
    if (opts.group !== undefined && (dd.kind === 'skipped' || dd.kind === 'reuploaded')) {
      const groupName = dd.dup ? dd.dup.groupName : group;
      deps.stderr(
        `warning: ${file}: --group is not applied to a book already in the library; it stays in ${
          groupName ? `"${groupName}"` : 'no group'
        }\n`,
      );
    }
    return resultOf(file, info, dd, group);
  };

  const plannedCover = (dd: Decision) =>
    dd.uploadCover && info.cover ? { hash: partialMD5Bytes(info.cover) } : undefined;
  const planned = d.kind === 'skipped' ? undefined : sizedRow(d, plannedCover(d));

  if (opts.dryRun) {
    const keys =
      d.kind === 'skipped' ? [] : [d.bookFileName, ...(d.uploadCover ? [coverKey(info.hash)] : [])];
    return {
      ...finish(d, groupOf(d, opts)),
      dryRun: true,
      format: info.format,
      metaHash: planned ? (planned.metaHash ?? null) : info.metaHash,
      author: info.author,
      keys,
    };
  }
  if (d.kind === 'skipped') return finish(d, groupOf(d, opts));

  const duplicateAppeared = (): UploadResult => ({
    file,
    status: 'error',
    reason: `duplicate appeared during upload; uploaded objects left at ${leftAt()}, re-run with --allow-duplicate to finish or remove them in the app`,
  });
  /** A decision made after the PUTs: a skip as duplicate would orphan the uploaded objects. */
  const finishLate = (dd: Decision): UploadResult =>
    dd.kind === 'skipped' && dd.reason === 'duplicate'
      ? duplicateAppeared()
      : finish(dd, groupOf(dd, opts));

  const putDone = new Set<string>();
  let coverTried = false;
  let cover: { hash: string } | undefined;

  const putBook = async (fileName: string) => {
    let up: { uploadUrl: string; fileKey: string };
    ctx.held.assertHeld();
    try {
      up = await api.uploadUrl(fileName, info.size, info.hash);
    } catch (e) {
      const body = e instanceof HttpError ? (e.body as Record<string, unknown> | null) : null;
      if (
        e instanceof HttpError &&
        e.status === 403 &&
        body?.['error'] === 'Insufficient storage quota'
      ) {
        throw new CliError(
          `not enough storage quota for ${info.size} bytes (usage: ${String(body['usage'] ?? 'unknown')} bytes)`,
        );
      }
      throw e;
    }
    const now = await stat(info.path);
    if (now.size !== info.size || now.mtimeMs !== info.mtimeMs) {
      throw new CliError(
        `file changed during upload; the reservation ${up.fileKey} stays: run readest upload ${file} again`,
      );
    }
    ctx.held.assertHeld();
    try {
      await api.put(up.uploadUrl, { path: info.path }, info.size);
    } catch (e) {
      if (e instanceof AuthRequiredError) throw e;
      throw new CliError(
        `${message(e)}; the reservation ${up.fileKey} stays: run readest upload ${file} again`,
      );
    }
    putDone.add(fileName);
    uploadedKeys.push(up.fileKey);
  };

  // A failed cover never fails the book: the row then goes without (or keeps the server's) cover.
  const putCover = async (bytes: Uint8Array) => {
    try {
      ctx.held.assertHeld();
      const up = await api.uploadUrl(coverKey(info.hash), bytes.length, info.hash);
      ctx.held.assertHeld();
      await api.put(up.uploadUrl, { bytes }, bytes.length);
      uploadedKeys.push(up.fileKey);
      cover = { hash: partialMD5Bytes(bytes) };
    } catch (e) {
      if (e instanceof AuthRequiredError || isLockLost(e)) throw e;
      deps.stderr(`warning: ${file}: cover upload failed: ${message(e)}\n`);
    }
  };

  const ensureFiles = async (dd: Decision) => {
    if (!putDone.has(dd.bookFileName)) await putBook(dd.bookFileName);
    if (dd.uploadCover && info.cover && !coverTried) {
      coverTried = true;
      await putCover(info.cover);
    }
  };

  await ensureFiles(d);

  // Re-read right before the POST: another client may have created or changed the row.
  let before = await reread();
  if (rowChanged(first, before)) {
    d = await decide(info, rows, probe, opts);
    if (d.kind === 'skipped') return finishLate(d);
    await ensureFiles(d);
  }
  if (d.kind === 'uploaded' && !opts.allowDuplicate && info.metaHash) {
    const dup = liveBooks(rows).find((b) => b.metaHash === info.metaHash && b.hash !== info.hash);
    if (dup) return duplicateAppeared();
  }

  for (let attempt = 0; ; attempt++) {
    const row = sizedRow(d, d.uploadCover ? cover : undefined);
    ctx.held.assertHeld();
    let resp: DbBookRow[];
    try {
      resp = await api.pushBooks([row]);
    } catch (e) {
      if (!isUncertain(e)) throw e;
      const now = await reread();
      if (isOurs(now?.raw, row)) return finish(d, now!.raw.group_name ?? null);
      // Unchanged since the re-read: the POST did not apply.
      if (!rowChanged(before, now) || attempt > 0) {
        throw new CliError(`sync not confirmed (${message(e)}): run readest upload ${file} again`);
      }
      before = now;
      d = await decide(info, rows, probe, opts);
      if (d.kind === 'skipped') return finishLate(d);
      await ensureFiles(d);
      continue;
    }
    const got = resp.find((r) => r.book_hash === info.hash);
    if (!isOurs(got, row)) {
      throw new CliError(
        `conflict with another client: the server kept its version (deleted_at ${
          got?.deleted_at ?? 'null'
        }, uploaded_at ${got?.uploaded_at ?? 'null'})`,
      );
    }
    // The server merges the group by its own clock and may keep the old one.
    return finish(d, got!.group_name ?? null);
  }
};

/** Files one by one under the profile's upload lock; one failure does not stop the rest. */
export const runUpload = async (
  deps: Deps,
  api: ApiClient,
  profile: Profile,
  files: string[],
  opts: { group?: string; dryRun: boolean; allowDuplicate: boolean },
): Promise<UploadResult[]> => {
  groupFields(opts.group);
  return withLock(
    uploadLockPath(deps, profile),
    {
      waitMs: null,
      label: 'upload lock',
      onWait: (pid) => deps.stderr(`waiting for upload process ${pid}\n`),
    },
    async (held) => {
      const ctx: Ctx = { deps, api, opts, held };
      const results: UploadResult[] = [];
      for (const file of files) {
        try {
          results.push(await uploadOne(ctx, file));
        } catch (e) {
          if (e instanceof AuthRequiredError || isLockLost(e)) throw e;
          results.push({ file, status: 'error', reason: message(e) });
        }
      }
      return results;
    },
    deps,
  );
};

const label = (r: UploadResult) => {
  if (!r.reason) return r.status;
  if (r.reason === 'duplicate' && r.duplicateOf) {
    return `${r.status} (duplicate of ${hash7(r.duplicateOf.hash)} "${r.duplicateOf.title}")`;
  }
  return `${r.status} (${r.reason})`;
};

export const uploadText = (results: UploadResult[]): string =>
  results
    .map((r) => {
      if (r.status === 'error') return `error  ${r.file}: ${r.reason ?? ''}`;
      if (r.dryRun) {
        return [
          `${r.file}: would be ${label(r)}`,
          `  format:   ${r.format ?? ''}`,
          `  hash:     ${r.hash ?? ''}`,
          `  metaHash: ${r.metaHash ?? '-'}`,
          `  title:    ${r.title ?? ''}`,
          `  author:   ${r.author ?? ''}`,
          `  group:    ${r.group ?? '-'}`,
          `  keys:     ${r.keys?.length ? r.keys.join(', ') : '-'}`,
        ].join('\n');
      }
      return `${label(r)}  ${hash7(r.hash ?? '')}  ${r.title ?? ''}${r.group ? `  [${r.group}]` : ''}`;
    })
    .map((line) => `${line}\n`)
    .join('');
