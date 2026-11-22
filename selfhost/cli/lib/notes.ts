import type { DbNoteRow } from './api.ts';
import type { LibraryBook } from './books.ts';
import { isValidCfi } from './cfi.ts';
import type { CfiModule } from './deps.ts';

export type Note = {
  id: string;
  type: string;
  cfi: string | null;
  page: number | null;
  text: string | null;
  note: string | null;
  style: string | null;
  color: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const toNote = (r: DbNoteRow): Note => ({
  id: r.id,
  type: r.type,
  cfi: r.cfi ?? null,
  page: r.page ?? null,
  text: r.text ?? null,
  note: r.note ?? null,
  style: r.style ?? null,
  color: r.color ?? null,
  createdAt: r.created_at ?? null,
  updatedAt: r.updated_at ?? null,
});

const byId = (a: Note, b: Note) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const time = (s: string | null) => (s ? Date.parse(s) || 0 : 0);

/**
 * Live notes in reading order: valid CFIs by foliate's compare (a pair it
 * throws on counts as equal), then the rest by page, created_at and id.
 */
export const prepareNotes = (rows: DbNoteRow[], mod: CfiModule): Note[] => {
  const notes = rows.filter((r) => !r.deleted_at && r.type !== 'ink').map(toNote);
  const valid = notes.filter((n) => n.cfi !== null && isValidCfi(n.cfi, mod));
  const rest = notes.filter((n) => !valid.includes(n));
  valid.sort((a, b) => {
    let c = 0;
    try {
      c = mod.compare(a.cfi!, b.cfi!);
    } catch {
      c = 0;
    }
    return c || byId(a, b);
  });
  rest.sort(
    (a, b) =>
      (a.page ?? Number.POSITIVE_INFINITY) - (b.page ?? Number.POSITIVE_INFINITY) ||
      time(a.createdAt) - time(b.createdAt) ||
      byId(a, b),
  );
  return [...valid, ...rest];
};

const quote = (text: string) =>
  text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');

const entry = (n: Note): string => {
  const parts: string[] = [];
  if (n.text) parts.push(quote(n.text));
  if (n.note) parts.push(`**Note**: ${n.note}`);
  const info = [n.page ? `Page: ${n.page}` : '', n.updatedAt ? `Time: ${n.updatedAt}` : '']
    .filter(Boolean)
    .join(' · ');
  if (info) parts.push(`*${info}*`);
  return parts.join('\n\n');
};

const SECTIONS: Array<[string, string[]]> = [
  ['Highlights & Annotations', ['annotation', 'excerpt']],
  ['Notes', ['notebook']],
  ['Bookmarks', ['bookmark']],
];

/** The layout of the app's Markdown export (ExportMarkdownDialog), without chapter headings. */
export const renderNotesMarkdown = (book: LibraryBook, notes: Note[], now: number): string => {
  const lines = [`# ${book.title}`];
  if (book.author) lines.push(`**Author**: ${book.author}`, '');
  lines.push(`**Exported from Readest**: ${new Date(now).toISOString().slice(0, 10)}`, '');
  lines.push('---', '');
  const blocks: string[] = [];
  for (const [title, types] of SECTIONS) {
    const items = notes
      .filter((n) => types.includes(n.type))
      .map(entry)
      .filter(Boolean);
    if (items.length) blocks.push(`## ${title}\n\n${items.join('\n\n')}\n`);
  }
  if (blocks.length === 0) blocks.push('no notes\n');
  return `${lines.join('\n')}\n${blocks.join('\n')}`;
};

export const renderNotesJson = (book: LibraryBook, notes: Note[]): string =>
  `${JSON.stringify(
    {
      book: {
        hash: book.hash,
        metaHash: book.metaHash,
        title: book.title,
        author: book.author,
        format: book.format,
      },
      notes,
    },
    null,
    2,
  )}\n`;
