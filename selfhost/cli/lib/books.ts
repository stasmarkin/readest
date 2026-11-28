import type { ApiClient, DbBookRow } from './api.ts';
import { CliError } from './errors.ts';

export type LibraryBook = {
  hash: string;
  metaHash: string | null;
  title: string;
  author: string;
  format: string;
  progress: number | null;
  readingStatus: string | null;
  groupId: string | null;
  groupName: string | null;
  uploadedAt: string | null;
  updatedAt: string;
  deleted: boolean;
  metadata: Record<string, unknown> | null;
  raw: DbBookRow;
};

// The sync API returns this placeholder row to a user with an empty library.
const ZERO_HASH = /^0+$/;

export const ms = (s?: string | number | null): number => {
  if (s === null || s === undefined || s === '') return 0;
  const t = typeof s === 'number' ? s : Date.parse(s);
  return Number.isFinite(t) ? t : 0;
};

export const parseMetadata = (m: DbBookRow['metadata']): Record<string, unknown> | null => {
  if (!m) return null;
  if (typeof m === 'object') return m;
  try {
    const v: unknown = JSON.parse(m);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

const percent = (p: DbBookRow['progress']): number | null => {
  if (!Array.isArray(p) || p.length < 2) return null;
  const [cur, total] = p;
  if (typeof cur !== 'number' || typeof total !== 'number' || total <= 0) return null;
  return Math.round((cur / total) * 100);
};

export const toLibraryBook = (r: DbBookRow): LibraryBook => ({
  hash: r.book_hash,
  metaHash: r.meta_hash ?? null,
  title: r.title ?? '',
  author: r.author ?? '',
  format: r.format ?? '',
  progress: percent(r.progress),
  readingStatus: r.reading_status ?? null,
  groupId: r.group_id ?? null,
  groupName: r.group_name ?? null,
  uploadedAt: r.uploaded_at ?? null,
  updatedAt: r.updated_at ?? '',
  deleted: !!r.deleted_at,
  metadata: parseMetadata(r.metadata),
  raw: r,
});

/** Every row of the user, deleted ones included, one per book_hash. */
export const loadLibrary = async (api: Pick<ApiClient, 'pullBooks'>): Promise<LibraryBook[]> => {
  const latest = new Map<string, DbBookRow>();
  for (const r of await api.pullBooks()) {
    if (!r || typeof r.book_hash !== 'string' || ZERO_HASH.test(r.book_hash)) continue;
    const prev = latest.get(r.book_hash);
    const newer =
      !prev ||
      ms(r.synced_at) > ms(prev.synced_at) ||
      (ms(r.synced_at) === ms(prev.synced_at) && ms(r.updated_at) >= ms(prev.updated_at));
    if (newer) latest.set(r.book_hash, r);
  }
  return [...latest.values()].map(toLibraryBook);
};

export const liveBooks = (books: LibraryBook[]): LibraryBook[] => books.filter((b) => !b.deleted);

const lower = (s: string | null) => (s ?? '').toLocaleLowerCase();

export const hash7 = (hash: string) => hash.slice(0, 7);

export const findBook = (books: LibraryBook[], query: string): LibraryBook => {
  const live = liveBooks(books);
  const q = query.trim();
  const exact = live.find((b) => b.hash === q.toLowerCase());
  if (exact) return exact;
  let found: LibraryBook[] = [];
  if (/^[0-9a-f]{6,}$/i.test(q)) found = live.filter((b) => b.hash.startsWith(q.toLowerCase()));
  if (found.length === 0) found = live.filter((b) => lower(b.title).includes(lower(q)));
  if (found.length === 1) return found[0]!;
  if (found.length === 0) throw new CliError(`no book matches "${query}"`);
  const list = found.map((b) => `  ${hash7(b.hash)} ${b.title}`).join('\n');
  throw new CliError(`"${query}" matches ${found.length} books:\n${list}`);
};

export const searchBooks = (books: LibraryBook[], s: string): LibraryBook[] => {
  const q = lower(s);
  return books.filter(
    (b) =>
      lower(b.title).includes(q) || lower(b.author).includes(q) || lower(b.groupName).includes(q),
  );
};

const forOutput = (books: LibraryBook[]) =>
  liveBooks(books).sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));

export const booksJson = (books: LibraryBook[]): string =>
  `${JSON.stringify(
    forOutput(books).map((b) => ({
      hash: b.hash,
      metaHash: b.metaHash,
      title: b.title,
      author: b.author,
      format: b.format,
      progress: b.progress,
      readingStatus: b.readingStatus,
      groupName: b.groupName,
      uploadedAt: b.uploadedAt,
      updatedAt: b.updatedAt,
    })),
    null,
    2,
  )}\n`;

export const booksTable = (books: LibraryBook[]): string => {
  const rows = forOutput(books).map((b) => [
    hash7(b.hash),
    b.format,
    b.progress === null ? '-' : `${b.progress}%`,
    b.uploadedAt ? 'cloud' : '-',
    b.groupName || '-',
    b.author ? `${b.author} — ${b.title}` : b.title,
  ]);
  if (rows.length === 0) return 'books: none\n';
  const widths = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows
    .map((r) => r.map((c, i) => (i < widths.length ? c.padEnd(widths[i]!) : c)).join('  '))
    .join('\n')
    .concat('\n');
};
