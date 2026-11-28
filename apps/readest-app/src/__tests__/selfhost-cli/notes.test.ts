import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CfiModule } from '../../../../../selfhost/cli/lib/deps.ts';
import type { DbNoteRow } from '../../../../../selfhost/cli/lib/api.ts';
import { ApiClient } from '../../../../../selfhost/cli/lib/api.ts';
import type { LibraryBook } from '../../../../../selfhost/cli/lib/books.ts';
import { CliError } from '../../../../../selfhost/cli/lib/errors.ts';
import { isValidCfi, loadCfi } from '../../../../../selfhost/cli/lib/cfi.ts';
import {
  prepareNotes,
  renderNotesJson,
  renderNotesMarkdown,
} from '../../../../../selfhost/cli/lib/notes.ts';
import { fakeDeps, fakeServer, writeFreshSession, PROFILE } from './fake-server';

// jsdom gives modules a non-file import.meta.url, so the default base is checked by the direct-run test.
const FOLIATE = pathToFileURL(`${resolve(__dirname, '../../../../../packages/foliate-js')}/`);
let cfi: CfiModule;
beforeAll(async () => {
  cfi = await loadCfi(FOLIATE);
});

const note = (id: string, over: Partial<DbNoteRow> = {}): DbNoteRow => ({
  book_hash: 'h',
  id,
  type: 'annotation',
  cfi: null,
  page: null,
  text: `text ${id}`,
  note: '',
  style: 'highlight',
  color: 'yellow',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  deleted_at: null,
  ...over,
});

const BOOK: LibraryBook = {
  hash: '4a0cf9f3c21ec5497839ecad2209d76b',
  metaHash: '205ace800743c689396a675894733999',
  title: "Alice's Adventures in Wonderland",
  author: 'Lewis Carroll',
  format: 'EPUB',
  progress: null,
  readingStatus: null,
  groupId: null,
  groupName: null,
  uploadedAt: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  deleted: false,
  metadata: null,
  raw: { book_hash: '4a0cf9f3c21ec5497839ecad2209d76b', format: 'EPUB', title: '', author: '' },
};

describe('isValidCfi', () => {
  it.each([
    ['epubcfi(/6/4!/4/2/1:0)', true],
    ['epubcfi(/6/4!/4/2,/1:0,/1:10)', true],
    ['garbage', false],
    ['/6/2', false],
    ['epubcfi()', false],
    ['epubcfi(/6,/2)', false],
    ['', false],
  ])('%s → %s', (s, ok) => {
    expect(isValidCfi(s, cfi)).toBe(ok);
  });
});

describe('prepareNotes', () => {
  it('sorts valid CFIs by compare, ties by id, then invalid ones by page, created_at, id', () => {
    const rows = [
      note('inv-nocfi-p2', { page: 2 }),
      note('c', { cfi: 'epubcfi(/6/10!/4/2/1:0)' }),
      note('inv-garbage-p1', { cfi: 'garbage', page: 1 }),
      note('b2', { cfi: 'epubcfi(/6/4!/4/2/1:5)' }),
      note('inv-bare-p3', { cfi: '/6/2', page: 3 }),
      note('a', { cfi: 'epubcfi(/6/4!/4/2,/1:0,/1:10)' }),
      note('b1', { cfi: 'epubcfi(/6/4!/4/2/1:5)' }),
      note('inv-empty-z', { cfi: 'epubcfi()', page: 4, created_at: '2026-01-01T00:00:00.000Z' }),
      note('inv-empty-y', {
        cfi: 'epubcfi(/6,/2)',
        page: 4,
        created_at: '2026-01-01T00:00:00.000Z',
      }),
      note('inv-p4-early', { page: 4, created_at: '2025-01-01T00:00:00.000Z' }),
    ];
    const ids = prepareNotes(rows, cfi).map((n) => n.id);
    expect(ids).toEqual([
      'a',
      'b1',
      'b2',
      'c',
      'inv-garbage-p1',
      'inv-nocfi-p2',
      'inv-bare-p3',
      'inv-p4-early',
      'inv-empty-y',
      'inv-empty-z',
    ]);
    const valid = rows.filter((r) => isValidCfi(r.cfi ?? '', cfi));
    const byCompare = [...valid]
      .sort((x, y) => cfi.compare(x.cfi!, y.cfi!) || (x.id < y.id ? -1 : 1))
      .map((r) => r.id);
    expect(ids.slice(0, valid.length)).toEqual(byCompare);
  });

  it('a compare that throws on a pair keeps both notes, ordered by the tie-break', () => {
    const throwing: CfiModule = {
      ...cfi,
      compare: (a, b) => {
        if (a.includes('/6/8') || b.includes('/6/8')) throw new Error('boom');
        return cfi.compare(a, b);
      },
    };
    const rows = [
      note('z', { cfi: 'epubcfi(/6/8!/4/2/1:0)' }),
      note('m', { cfi: 'epubcfi(/6/2!/4/2/1:0)' }),
      note('a', { cfi: 'epubcfi(/6/8!/4/2/1:3)' }),
    ];
    const out = prepareNotes(rows, throwing);
    expect(out).toHaveLength(3);
    expect(out.map((n) => n.id).sort()).toEqual(['a', 'm', 'z']);
    expect(out.findIndex((n) => n.id === 'a')).toBeLessThan(out.findIndex((n) => n.id === 'z'));
  });

  it('drops deleted and ink notes and keeps every other one', () => {
    const rows = [
      note('1'),
      note('2', { deleted_at: '2026-01-03T00:00:00.000Z' }),
      note('3', { type: 'ink' }),
      note('4', { type: 'bookmark', cfi: 'epubcfi(/6/4!/4/2/1:0)' }),
      note('5', { type: 'notebook' }),
    ];
    expect(
      prepareNotes(rows, cfi)
        .map((n) => n.id)
        .sort(),
    ).toEqual(['1', '4', '5']);
  });
});

describe('pullNotes meta_hash', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'readest-cli-notes-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('sends meta_hash only when it is non-empty', async () => {
    const server = fakeServer();
    const { deps } = fakeDeps(server.handler, home);
    writeFreshSession(deps);
    const api = new ApiClient(deps, PROFILE);
    await api.pullNotes('h', '');
    await api.pullNotes('h', undefined);
    await api.pullNotes('h', 'mh');
    const q = server.calls.map((c) => c.url.searchParams.get('meta_hash'));
    expect(q).toEqual([null, null, 'mh']);
  });
});

// ------------------------------------------------------------------ rendering

const FIXTURE = resolve(__dirname, '../fixtures/data/alice-annotations.json');
type FixtureNote = {
  id: string;
  type: string;
  cfi?: string;
  note?: string;
  text?: string;
  style?: string;
  color?: string;
  createdAt: number;
  updatedAt: number;
};
const fixtureRows = (): DbNoteRow[] => {
  const j = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { annotations: FixtureNote[] };
  return j.annotations.map((a, i) => ({
    book_hash: BOOK.hash,
    meta_hash: BOOK.metaHash,
    id: a.id,
    type: a.type,
    cfi: a.cfi ?? null,
    page: i + 1,
    text: a.text ?? null,
    note: a.note ?? null,
    style: a.style ?? null,
    color: a.color ?? null,
    created_at: new Date(a.createdAt).toISOString(),
    updated_at: new Date(a.updatedAt).toISOString(),
    deleted_at: null,
  }));
};
const NOW = Date.parse('2026-11-22T10:00:00.000Z');

describe('renderNotesMarkdown', () => {
  it('lays the export out like the app', () => {
    const md = renderNotesMarkdown(
      BOOK,
      prepareNotes(
        [
          note('h1', {
            cfi: 'epubcfi(/6/4!/4/2/1:0)',
            text: 'line one\nline two',
            note: 'my thought',
            page: 3,
            updated_at: '2026-05-06T07:08:09.000Z',
          }),
          note('n1', { type: 'notebook', text: '', note: 'free note' }),
          note('b1', { type: 'bookmark', cfi: 'epubcfi(/6/6!/4/2/1:0)', text: 'marked', note: '' }),
        ],
        cfi,
      ),
      NOW,
    );
    expect(md).toBe(
      [
        "# Alice's Adventures in Wonderland",
        '**Author**: Lewis Carroll',
        '',
        '**Exported from Readest**: 2026-11-22',
        '',
        '---',
        '',
        '## Highlights & Annotations',
        '',
        '> line one',
        '> line two',
        '',
        '**Note**: my thought',
        '',
        '*Page: 3 · Time: 2026-05-06T07:08:09.000Z*',
        '',
        '## Notes',
        '',
        '**Note**: free note',
        '',
        '*Time: 2026-01-02T00:00:00.000Z*',
        '',
        '## Bookmarks',
        '',
        '> marked',
        '',
        '*Time: 2026-01-02T00:00:00.000Z*',
        '',
      ].join('\n'),
    );
  });

  it('matches the snapshot on the alice fixture', () => {
    expect(renderNotesMarkdown(BOOK, prepareNotes(fixtureRows(), cfi), NOW)).toMatchSnapshot();
  });

  it('an empty list is the header and "no notes"', () => {
    const md = renderNotesMarkdown(BOOK, [], NOW);
    expect(md.startsWith("# Alice's Adventures in Wonderland\n")).toBe(true);
    expect(md.trimEnd().endsWith('no notes')).toBe(true);
    expect(md).not.toContain('## Highlights');
  });
});

describe('renderNotesJson', () => {
  it('has the book and the note fields of the spec', () => {
    const notes = prepareNotes(fixtureRows(), cfi);
    const parsed = JSON.parse(renderNotesJson(BOOK, notes)) as {
      book: unknown;
      notes: Array<Record<string, unknown>>;
    };
    expect(parsed.book).toEqual({
      hash: BOOK.hash,
      metaHash: BOOK.metaHash,
      title: BOOK.title,
      author: BOOK.author,
      format: 'EPUB',
    });
    expect(parsed.notes).toHaveLength(24);
    expect(parsed.notes[0]).toEqual({
      id: expect.any(String),
      type: expect.any(String),
      cfi: expect.any(String),
      page: expect.any(Number),
      text: expect.any(String),
      note: expect.any(String),
      style: expect.anything(),
      color: expect.anything(),
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(Object.keys(parsed.notes[0]!)).toHaveLength(10);
  });
});

describe('loadCfi without the submodule', () => {
  it('fails with the submodule hint', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'readest-cli-nocfi-'));
    try {
      const err = await loadCfi(pathToFileURL(`${empty}/`)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).message).toBe(
        'notes needs the foliate-js submodule: git submodule update --init -- packages/foliate-js',
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
