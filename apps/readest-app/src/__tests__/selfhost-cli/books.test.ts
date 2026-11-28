import { describe, it, expect } from 'vitest';
import type { DbBookRow } from '../../../../../selfhost/cli/lib/api.ts';
import {
  booksJson,
  booksTable,
  findBook,
  liveBooks,
  loadLibrary,
  searchBooks,
} from '../../../../../selfhost/cli/lib/books.ts';
import { CliError } from '../../../../../selfhost/cli/lib/errors.ts';

const ZERO = '00000000000000000000000000000000';

const row = (hash: string, over: Partial<DbBookRow> = {}): DbBookRow => ({
  book_hash: hash,
  meta_hash: `m-${hash}`,
  format: 'EPUB',
  title: `Title ${hash}`,
  author: 'Author',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  deleted_at: null,
  uploaded_at: null,
  ...over,
});

const lib = (rows: DbBookRow[]) => loadLibrary({ pullBooks: async () => rows });

describe('loadLibrary', () => {
  it('merges duplicates, drops the zero row, parses metadata as string and object', async () => {
    const books = await lib([
      row('a'.repeat(32), { title: 'old', synced_at: '2026-01-01T00:00:00.000Z' }),
      row('a'.repeat(32), { title: 'new', synced_at: '2026-01-03T00:00:00.000Z' }),
      row('a'.repeat(32), { title: 'older', synced_at: '2026-01-02T00:00:00.000Z' }),
      row('b'.repeat(32), { title: 'b1', updated_at: '2026-01-05T00:00:00.000Z' }),
      row('b'.repeat(32), { title: 'b2', updated_at: '2026-01-04T00:00:00.000Z' }),
      row(ZERO, { deleted_at: '2026-01-01T00:00:00.000Z' }),
      row('c'.repeat(32), { metadata: JSON.stringify({ language: 'ru' }) }),
      row('d'.repeat(32), { metadata: { language: 'en' } }),
      row('e'.repeat(32), { metadata: 'not json' }),
    ]);
    expect(books).toHaveLength(5);
    expect(books.find((b) => b.hash === 'a'.repeat(32))!.title).toBe('new');
    expect(books.find((b) => b.hash === 'b'.repeat(32))!.title).toBe('b1');
    expect(books.find((b) => b.hash === ZERO)).toBeUndefined();
    expect(books.find((b) => b.hash === 'c'.repeat(32))!.metadata).toEqual({ language: 'ru' });
    expect(books.find((b) => b.hash === 'd'.repeat(32))!.metadata).toEqual({ language: 'en' });
    expect(books.find((b) => b.hash === 'e'.repeat(32))!.metadata).toBeNull();
  });

  it('turns [cur,total] progress into a percentage and keeps deleted rows flagged', async () => {
    const [a, b, c] = await lib([
      row('a'.repeat(32), { progress: [3, 10] }),
      row('b'.repeat(32), { progress: [0, 0] }),
      row('c'.repeat(32), { deleted_at: '2026-01-03T00:00:00.000Z' }),
    ]);
    expect(a!.progress).toBe(30);
    expect(b!.progress).toBeNull();
    expect(c!.deleted).toBe(true);
    expect(liveBooks([a!, b!, c!]).map((x) => x.hash)).toEqual([a!.hash, b!.hash]);
  });
});

describe('findBook', () => {
  const H1 = 'abcdef0123456789abcdef0123456789';
  const H2 = 'abcde99999999999999999999999999a';
  const H3 = '1234567890abcdef1234567890abcdef';
  const books = () =>
    lib([
      row(H1, { title: 'The Cyberiad' }),
      row(H2, { title: 'Solaris' }),
      row(H3, { title: 'Cyber Stories' }),
      row('f'.repeat(32), { title: 'Deleted Solaris', deleted_at: '2026-01-03T00:00:00.000Z' }),
      row('9'.repeat(32), { title: 'abcde title' }),
    ]);

  it('finds by full hash and by a 6-char prefix', async () => {
    const b = await books();
    expect(findBook(b, H1).title).toBe('The Cyberiad');
    expect(findBook(b, 'abcdef').title).toBe('The Cyberiad');
  });

  it('an ambiguous title substring lists both candidates', async () => {
    const b = await books();
    let err: unknown;
    try {
      findBook(b, 'cyber');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CliError);
    const msg = (err as CliError).message;
    expect(msg).toContain('abcdef0 The Cyberiad');
    expect(msg).toContain('1234567 Cyber Stories');
  });

  it('a 5-char prefix is matched as a title substring', async () => {
    const b = await books();
    expect(findBook(b, 'abcde').hash).toBe('9'.repeat(32));
  });

  it('does not find a deleted book', async () => {
    const b = await books();
    expect(() => findBook(b, 'Deleted')).toThrow(CliError);
    expect(() => findBook(b, 'f'.repeat(32))).toThrow(/no book matches/);
    expect(findBook(b, 'solaris').hash).toBe(H2);
  });
});

describe('searchBooks', () => {
  it('matches title, author and group name, case-insensitively, Cyrillic included', async () => {
    const b = await lib([
      row('a'.repeat(32), { title: 'Солярис', author: 'Станислав Лем' }),
      row('b'.repeat(32), {
        title: 'Dune',
        author: 'Frank Herbert',
        group_name: 'Фантастика/Классика',
      }),
      row('c'.repeat(32), { title: 'Other', author: 'Someone' }),
    ]);
    expect(searchBooks(b, 'СОЛЯ').map((x) => x.title)).toEqual(['Солярис']);
    expect(searchBooks(b, 'лем').map((x) => x.title)).toEqual(['Солярис']);
    expect(searchBooks(b, 'herbert').map((x) => x.title)).toEqual(['Dune']);
    expect(searchBooks(b, 'классика').map((x) => x.title)).toEqual(['Dune']);
    expect(searchBooks(b, 'zzz')).toEqual([]);
  });
});

describe('output', () => {
  const rows = [
    row('a'.repeat(32), {
      title: 'Older',
      author: 'A',
      progress: [3, 10],
      reading_status: 'reading',
      group_id: 'g1',
      group_name: 'Shelf',
      uploaded_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    }),
    row('b'.repeat(32), { title: 'Newer', author: '', updated_at: '2026-02-01T00:00:00.000Z' }),
    row('c'.repeat(32), { title: 'Gone', deleted_at: '2026-03-01T00:00:00.000Z' }),
  ];

  it('booksJson: exact fields, newest first, deleted hidden', async () => {
    const parsed: unknown = JSON.parse(booksJson(await lib(rows)));
    expect(parsed).toEqual([
      {
        hash: 'b'.repeat(32),
        metaHash: `m-${'b'.repeat(32)}`,
        title: 'Newer',
        author: '',
        format: 'EPUB',
        progress: null,
        readingStatus: null,
        groupName: null,
        uploadedAt: null,
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
      {
        hash: 'a'.repeat(32),
        metaHash: `m-${'a'.repeat(32)}`,
        title: 'Older',
        author: 'A',
        format: 'EPUB',
        progress: 30,
        readingStatus: 'reading',
        groupName: 'Shelf',
        uploadedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
    ]);
    expect(JSON.parse(booksJson([]))).toEqual([]);
  });

  it('booksTable: hash7, format, percent, cloud mark, group, author — title', async () => {
    const lines = booksTable(await lib(rows))
      .trimEnd()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^bbbbbbb\s+EPUB\s+-\s+-\s+-\s+Newer$/);
    expect(lines[1]).toMatch(/^aaaaaaa\s+EPUB\s+30%\s+cloud\s+Shelf\s+A — Older$/);
    expect(booksTable([])).toBe('books: none\n');
  });
});
