import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { transformBookToDB } from '@/utils/transform';
import { ApiClient } from '../../../../../selfhost/cli/lib/api.ts';
import type { DbBookRow, WireBook } from '../../../../../selfhost/cli/lib/api.ts';
import { loadLibrary } from '../../../../../selfhost/cli/lib/books.ts';
import type { LibraryBook } from '../../../../../selfhost/cli/lib/books.ts';
import { CliError, UsageError } from '../../../../../selfhost/cli/lib/errors.ts';
import { md5Fingerprint, partialMD5Bytes } from '../../../../../selfhost/cli/lib/hash.ts';
import { readBookFile } from '../../../../../selfhost/cli/lib/metadata.ts';
import type { BookFileInfo } from '../../../../../selfhost/cli/lib/metadata.ts';
import {
  bookFromDbRow,
  buildRow,
  decide,
  groupFields,
  probeBook,
  runUpload,
  uploadText,
} from '../../../../../selfhost/cli/lib/upload.ts';
import type { Decision, Probe } from '../../../../../selfhost/cli/lib/upload.ts';
import { fakeDeps, fakeServer, json, PROFILE, UID, writeFreshSession } from './fake-server';
import type { Call, FakeServer } from './fake-server';

// ------------------------------------------------------------------ fixtures

let home: string;
let books: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'readest-cli-up-'));
  books = mkdtempSync(join(tmpdir(), 'readest-cli-up-books-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(books, { recursive: true, force: true });
});

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const PNG = new Uint8Array(300).map((_, i) =>
  i < 8 ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][i]! : (i * 7) & 0xff,
);

const makeEpub = (title: string, opts: { cover?: boolean; author?: string } = {}) => {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${title}</dc:title>
    <dc:creator>${opts.author ?? 'Stanisław Lem'}</dc:creator>
    <dc:language>ru</dc:language>
    <dc:identifier id="uid">urn:uuid:${md5Fingerprint(title)}-0000</dc:identifier>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    ${opts.cover === false ? '' : '<item id="c" href="cover.png" media-type="image/png" properties="cover-image"/>'}
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(CONTAINER),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/ch1.xhtml': strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>${title}</p></body></html>`,
    ),
    ...(opts.cover === false ? {} : { 'OEBPS/cover.png': PNG }),
  });
};

const bookFile = (title: string, opts: { cover?: boolean; name?: string } = {}) => {
  const path = join(books, opts.name ?? `${title}.epub`);
  writeFileSync(path, makeEpub(title, opts));
  return path;
};

const pdfFile = (name: string) => {
  const path = join(books, name);
  writeFileSync(path, '%PDF-1.4\n%%EOF\n');
  return path;
};

const fb2File = (name: string, opts: { imageBytes?: number; title?: string } = {}) => {
  const img = opts.imageBytes ? Buffer.alloc(opts.imageBytes, 7).toString('base64') : '';
  const path = join(books, `${name}.fb2`);
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><author><first-name>A</first-name><last-name>B</last-name></author>
<book-title>${opts.title ?? name}</book-title>
<annotation><p>About</p>${img ? '<image l:href="#pic"/>' : ''}</annotation><lang>en</lang></title-info>
<document-info><id>${name}</id></document-info></description>
<body><section><p>Text</p></section></body>
${img ? `<binary id="pic" content-type="image/png">${img}</binary>` : ''}
</FictionBook>`,
  );
  return path;
};

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};

const uploadLock = () => join(home, '.config', 'readest-cli', `upload-${PROFILE.key}.lock`);
const stealLock = () =>
  writeFileSync(uploadLock(), JSON.stringify({ pid: process.pid, started: null, token: 'stolen' }));

const setup = (opts: { quota?: number } = {}) => {
  const server = fakeServer(opts);
  const f = fakeDeps(server.handler, home);
  writeFreshSession(f.deps);
  const api = new ApiClient(f.deps, PROFILE);
  return { server, api, ...f };
};

const libOf = (rows: DbBookRow[]) => loadLibrary({ pullBooks: async () => rows });

const dbRow = (hash: string, over: Partial<DbBookRow> = {}): DbBookRow => ({
  user_id: UID,
  book_hash: hash,
  meta_hash: 'server-meta',
  format: 'EPUB',
  title: 'Server title',
  source_title: 'Server source',
  original_filename: 'server.epub',
  author: 'Server author',
  group_id: 'g0',
  group_name: 'Old/Shelf',
  group_updated_at: '2026-01-01T00:00:00.000Z',
  tags: ['t1', 't2'],
  progress: [5, 50],
  reading_status: 'reading',
  reading_status_updated_at: '2026-01-03T00:00:00.000Z',
  cover_hash: null,
  cover_updated_at: null,
  page_count: 321,
  metadata: JSON.stringify({ title: 'Server title', language: 'en' }),
  metadata_updated_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-04T00:00:00.000Z',
  deleted_at: null,
  uploaded_at: null,
  ...over,
});

const NOW = Date.parse('2026-11-22T10:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const bookKey = (h: string) => `Readest/Books/${h}/${h}.epub`;
const putKeys = (s: FakeServer) =>
  s.calls.filter((c) => c.method === 'PUT').map((c) => decodeURIComponent(c.url.pathname.slice(5)));
const syncPosts = (s: FakeServer) =>
  s.calls.filter((c) => c.method === 'POST' && c.path === '/api/sync');
const bookGets = (s: FakeServer) =>
  s.calls.filter((c) => c.method === 'GET' && c.path === '/api/sync');
const postedRow = (c: Call) => (c.body as { books: WireBook[] }).books[0]!;

// ------------------------------------------------------------------ decide

describe('decide', () => {
  let info: BookFileInfo;
  beforeEach(async () => {
    info = await readBookFile(bookFile('Solaris'));
  });
  const probeOf =
    (p: Probe): ((h: string) => Promise<Probe>) =>
    async () =>
      p;
  const record = (key: string) => ({ file_key: key, file_size: 1, book_hash: info.hash });

  it('live, uploaded and present → skipped: already', async () => {
    const lib = await libOf([dbRow(info.hash, { uploaded_at: '2026-01-04T00:00:00.000Z' })]);
    const d = await decide(
      info,
      lib,
      probeOf({ record: record(`${UID}/${bookKey(info.hash)}`), present: true }),
      {
        allowDuplicate: false,
      },
    );
    expect(d).toMatchObject({ kind: 'skipped', reason: 'already' });
    expect(d.server?.hash).toBe(info.hash);
  });

  it('live but never uploaded → reuploaded under the default key without a record', async () => {
    const lib = await libOf([dbRow(info.hash)]);
    const d = await decide(info, lib, probeOf({ present: false }), { allowDuplicate: false });
    expect(d).toMatchObject({ kind: 'reuploaded', bookFileName: bookKey(info.hash) });
  });

  it('live with a files record but no object → reuploaded under the record key', async () => {
    const lib = await libOf([dbRow(info.hash, { uploaded_at: '2026-01-04T00:00:00.000Z' })]);
    const key = `${UID}/Readest/Books/${info.hash}/Alice.epub`;
    const d = await decide(info, lib, probeOf({ record: record(key), present: false }), {
      allowDuplicate: false,
    });
    expect(d).toMatchObject({
      kind: 'reuploaded',
      bookFileName: `Readest/Books/${info.hash}/Alice.epub`,
    });
  });

  it('deleted row → revived', async () => {
    const lib = await libOf([dbRow(info.hash, { deleted_at: '2026-01-05T00:00:00.000Z' })]);
    const d = await decide(info, lib, probeOf({ present: false }), { allowDuplicate: false });
    expect(d).toMatchObject({ kind: 'revived', bookFileName: bookKey(info.hash) });
  });

  it('no row but a live book with the same metaHash → skipped: duplicate, unless allowed', async () => {
    const other = 'f'.repeat(32);
    const lib = await libOf([dbRow(other, { meta_hash: info.metaHash, title: 'Other copy' })]);
    const d = await decide(info, lib, probeOf({ present: false }), { allowDuplicate: false });
    expect(d).toMatchObject({ kind: 'skipped', reason: 'duplicate' });
    expect(d.dup?.hash).toBe(other);
    const allowed = await decide(info, lib, probeOf({ present: false }), { allowDuplicate: true });
    expect(allowed.kind).toBe('uploaded');
  });

  it('a deleted book with the same metaHash is no duplicate', async () => {
    const lib = await libOf([
      dbRow('f'.repeat(32), { meta_hash: info.metaHash, deleted_at: '2026-01-05T00:00:00.000Z' }),
    ]);
    const d = await decide(info, lib, probeOf({ present: false }), { allowDuplicate: false });
    expect(d.kind).toBe('uploaded');
  });

  it('nothing → uploaded; a leftover record from a failed PUT keeps its key', async () => {
    const d = await decide(info, [], probeOf({ present: false }), { allowDuplicate: false });
    expect(d).toMatchObject({ kind: 'uploaded', bookFileName: bookKey(info.hash) });
    const key = `${UID}/Readest/Books/${info.hash}/Solaris.epub`;
    const d2 = await decide(info, [], probeOf({ record: record(key), present: false }), {
      allowDuplicate: false,
    });
    expect(d2).toMatchObject({
      kind: 'uploaded',
      bookFileName: `Readest/Books/${info.hash}/Solaris.epub`,
    });
  });

  it('uploadCover: always for uploaded and revived, for reuploaded only without a server cover', async () => {
    const none = probeOf({ present: false });
    const o = { allowDuplicate: false };
    expect((await decide(info, [], none, o)).uploadCover).toBe(true);
    const revived = await libOf([
      dbRow(info.hash, { deleted_at: '2026-01-05T00:00:00.000Z', cover_hash: 'old' }),
    ]);
    expect((await decide(info, revived, none, o)).uploadCover).toBe(true);
    expect((await decide(info, await libOf([dbRow(info.hash)]), none, o)).uploadCover).toBe(true);
    const covered = await libOf([dbRow(info.hash, { cover_hash: 'old' })]);
    expect((await decide(info, covered, none, o)).uploadCover).toBe(false);
    const bare = await readBookFile(bookFile('Bare', { cover: false }));
    expect((await decide(bare, [], none, o)).uploadCover).toBe(false);
  });

  it('a failing object check fails the decision', async () => {
    const lib = await libOf([dbRow(info.hash)]);
    await expect(
      decide(info, lib, () => Promise.reject(new CliError('storage check → 500')), {
        allowDuplicate: false,
      }),
    ).rejects.toThrow('storage check → 500');
  });
});

describe('probeBook', () => {
  it('takes the book record, not cover.png, and checks the object', async () => {
    const { server, api } = setup();
    const h = 'a'.repeat(32);
    server.addFile(`${UID}/Readest/Books/${h}/cover.png`, h, new Uint8Array([1]));
    server.addFile(`${UID}/Readest/Books/${h}/Alice.epub`, h);
    const p = await probeBook(api, h, 'epub');
    expect(p).toEqual({
      record: expect.objectContaining({ file_key: `${UID}/Readest/Books/${h}/Alice.epub` }),
      present: false,
    });
    server.objects.set(`${UID}/Readest/Books/${h}/Alice.epub`, new Uint8Array([1, 2]));
    expect((await probeBook(api, h, 'epub')).present).toBe(true);
    expect(await probeBook(api, 'b'.repeat(32), 'epub')).toEqual({ present: false });
  });

  it.each([500, 403])('a %i from the object store is an error, not a decision', async (status) => {
    const { server, api } = setup();
    const h = 'a'.repeat(32);
    server.addFile(`${UID}/${bookKey(h)}`, h);
    server.setIntercept((c) =>
      c.url.origin === 'http://s3.test' ? new Response('', { status }) : undefined,
    );
    await expect(probeBook(api, h, 'epub')).rejects.toThrow(CliError);
  });
});

// ------------------------------------------------------------------ rows

const decision = (kind: Decision['kind'], server?: LibraryBook, bookFileName = 'x'): Decision => ({
  kind,
  ...(server ? { server } : {}),
  bookFileName,
  uploadCover: true,
});

const CLIENT_COLUMNS = [
  'book_hash',
  'meta_hash',
  'format',
  'title',
  'author',
  'group_id',
  'group_name',
  'group_updated_at',
  'tags',
  'progress',
  'reading_status',
  'reading_status_updated_at',
  'cover_hash',
  'cover_updated_at',
  'page_count',
  'source_title',
  'original_filename',
  'metadata',
  'metadata_updated_at',
  'created_at',
  'updated_at',
  'deleted_at',
  'uploaded_at',
] as const;

const normalize = (r: Record<string, unknown>) => {
  const out: Record<string, unknown> = {};
  for (const k of CLIENT_COLUMNS) {
    const v = r[k];
    if (k === 'metadata') out[k] = typeof v === 'string' ? JSON.parse(v) : (v ?? null);
    else if (k.endsWith('_at')) out[k] = v ? Date.parse(String(v)) : null;
    else out[k] = v ?? null;
  }
  return out;
};

describe('buildRow × transformBookToDB', () => {
  it('uploaded: every column of a new book', async () => {
    const info = await readBookFile(bookFile('Солярис'));
    const row = buildRow(info, decision('uploaded'), { group: 'Фантастика/Лем' }, NOW, {
      hash: 'coverhash',
    });
    const db = transformBookToDB(row, 'uid') as unknown as Record<string, unknown>;
    expect({
      book_hash: db['book_hash'],
      meta_hash: db['meta_hash'],
      format: db['format'],
      title: db['title'],
      author: db['author'],
      source_title: db['source_title'],
      original_filename: db['original_filename'],
      group_id: db['group_id'],
      group_name: db['group_name'],
      group_updated_at: db['group_updated_at'],
      cover_hash: db['cover_hash'],
      cover_updated_at: db['cover_updated_at'],
      created_at: db['created_at'],
      updated_at: db['updated_at'],
      uploaded_at: db['uploaded_at'],
      metadata_updated_at: db['metadata_updated_at'],
      deleted_at: db['deleted_at'],
      progress: db['progress'] ?? null,
      reading_status: db['reading_status'] ?? null,
    }).toEqual({
      book_hash: info.hash,
      meta_hash: info.metaHash,
      format: 'EPUB',
      title: 'Солярис',
      author: 'Stanisław Lem',
      source_title: 'Солярис',
      original_filename: 'Солярис.epub',
      group_id: md5Fingerprint('Фантастика/Лем'),
      group_name: 'Фантастика/Лем',
      group_updated_at: ISO,
      cover_hash: 'coverhash',
      cover_updated_at: ISO,
      created_at: ISO,
      updated_at: ISO,
      uploaded_at: ISO,
      metadata_updated_at: ISO,
      deleted_at: null,
      progress: null,
      reading_status: null,
    });
    const metadata = JSON.parse(String(db['metadata'])) as Record<string, unknown>;
    expect(metadata['language']).toBe('ru');
    expect(metadata['title']).toBe('Солярис');
    expect('primaryLanguage' in metadata).toBe(false);
  });

  it('uploaded without group or cover: those columns are null', async () => {
    const info = await readBookFile(bookFile('Plain'));
    const db = transformBookToDB(buildRow(info, decision('uploaded'), {}, NOW), 'uid');
    expect([
      db.group_id,
      db.group_name,
      db.group_updated_at,
      db.cover_hash,
      db.cover_updated_at,
    ]).toEqual([null, null, null, null, null]);
  });

  it('bookFromDbRow round-trips every client column of a server row', async () => {
    const server = dbRow('a'.repeat(32), {
      cover_hash: 'c0',
      cover_updated_at: '2026-01-02T00:00:00.000Z',
      uploaded_at: '2026-01-02T00:00:00.000Z',
      synced_at: '2026-01-04T00:00:00.000Z',
    });
    expect(
      normalize(
        transformBookToDB(bookFromDbRow(server), 'uid') as unknown as Record<string, unknown>,
      ),
    ).toEqual(normalize(server as unknown as Record<string, unknown>));
  });

  it('reuploaded: the server row whole, plus uploadedAt/updatedAt and a new cover', async () => {
    const info = await readBookFile(bookFile('Re'));
    const server = dbRow(info.hash);
    const [lb] = await libOf([server]);
    const db = transformBookToDB(
      buildRow(info, decision('reuploaded', lb), { group: 'Ignored' }, NOW, { hash: 'newcover' }),
      'uid',
    );
    expect(normalize(db as unknown as Record<string, unknown>)).toEqual({
      ...normalize(server as unknown as Record<string, unknown>),
      uploaded_at: NOW,
      updated_at: NOW,
      cover_hash: 'newcover',
      cover_updated_at: NOW,
    });
  });

  it('revived: the server row whole, undeleted, file metadata, new group', async () => {
    const info = await readBookFile(bookFile('Back'));
    const server = dbRow(info.hash, {
      deleted_at: '2026-01-05T00:00:00.000Z',
      cover_hash: 'oldcover',
      cover_updated_at: '2026-01-02T00:00:00.000Z',
    });
    const [lb] = await libOf([server]);
    const withGroup = transformBookToDB(
      buildRow(info, decision('revived', lb), { group: 'New' }, NOW, { hash: 'fresh' }),
      'uid',
    );
    expect(normalize(withGroup as unknown as Record<string, unknown>)).toEqual({
      ...normalize(server as unknown as Record<string, unknown>),
      meta_hash: info.metaHash,
      title: info.title,
      source_title: info.sourceTitle,
      author: info.author,
      original_filename: info.originalFilename,
      metadata: JSON.parse(JSON.stringify(info.metadata)),
      metadata_updated_at: NOW,
      group_id: md5Fingerprint('New'),
      group_name: 'New',
      group_updated_at: NOW,
      cover_hash: 'fresh',
      cover_updated_at: NOW,
      deleted_at: null,
      uploaded_at: NOW,
      updated_at: NOW,
    });
    const noGroup = transformBookToDB(buildRow(info, decision('revived', lb), {}, NOW), 'uid');
    expect([noGroup.group_id, noGroup.group_name, noGroup.group_updated_at]).toEqual([
      'g0',
      'Old/Shelf',
      '2026-01-01T00:00:00.000Z',
    ]);
    expect([noGroup.cover_hash, noGroup.cover_updated_at]).toEqual([
      'oldcover',
      '2026-01-02T00:00:00.000Z',
    ]);
  });
});

describe('buildRow timestamps and PDF metaHash', () => {
  it('reuploaded/revived over a server row from a clock ahead: updatedAt beats it, uploadedAt is now', async () => {
    const info = await readBookFile(bookFile('Ahead'));
    const ahead = NOW + 3_600_000;
    const [live] = await libOf([dbRow(info.hash, { updated_at: new Date(ahead).toISOString() })]);
    const re = buildRow(info, decision('reuploaded', live), {}, NOW);
    expect(re.updatedAt).toBe(ahead + 1);
    expect(re.uploadedAt).toBe(NOW);
    const [dead] = await libOf([
      dbRow(info.hash, { deleted_at: new Date(ahead + 5).toISOString() }),
    ]);
    const rv = buildRow(info, decision('revived', dead), {}, NOW);
    expect(rv.updatedAt).toBe(ahead + 6);
    expect(rv.uploadedAt).toBe(NOW);
  });

  it('revived PDF keeps the server metaHash (filename-salted); EPUB takes the file one', async () => {
    const pdf = await readBookFile(pdfFile('renamed.pdf'));
    const del = { deleted_at: '2026-01-05T00:00:00.000Z' };
    const [lb] = await libOf([
      dbRow(pdf.hash, { ...del, format: 'PDF', meta_hash: 'server-meta' }),
    ]);
    expect(buildRow(pdf, decision('revived', lb), {}, NOW).metaHash).toBe('server-meta');
    const [empty] = await libOf([dbRow(pdf.hash, { ...del, format: 'PDF', meta_hash: '' })]);
    expect(buildRow(pdf, decision('revived', empty), {}, NOW).metaHash).toBe(pdf.metaHash);
    const epub = await readBookFile(bookFile('Salt'));
    const [eb] = await libOf([dbRow(epub.hash, del)]);
    expect(buildRow(epub, decision('revived', eb), {}, NOW).metaHash).toBe(epub.metaHash);
  });
});

describe('groupFields', () => {
  it('trims segments and fingerprints the path', () => {
    expect(groupFields(' Фантастика / Лем ')).toEqual({
      groupId: md5Fingerprint('Фантастика/Лем'),
      groupName: 'Фантастика/Лем',
    });
    expect(groupFields(undefined)).toEqual({ groupId: null, groupName: null });
  });
  it.each(['A//B', '/A', 'A/', ' ', ''])('%j is a usage error', (g) => {
    expect(() => groupFields(g)).toThrow(UsageError);
  });
});

// ------------------------------------------------------------------ runUpload

const run = (
  s: ReturnType<typeof setup>,
  files: string[],
  opts: Partial<{ group: string; dryRun: boolean; allowDuplicate: boolean }> = {},
) => runUpload(s.deps, s.api, PROFILE, files, { dryRun: false, allowDuplicate: false, ...opts });

describe('runUpload', () => {
  it('uploads book, then cover, re-reads, then posts the row; a re-run is skipped: already', async () => {
    const s = setup();
    const path = bookFile('Order');
    const info = await readBookFile(path);
    const [r] = await run(s, [path], { group: 'Shelf' });
    expect(r).toEqual({
      file: path,
      status: 'uploaded',
      hash: info.hash,
      title: 'Order',
      group: 'Shelf',
    });
    expect(s.server.apiLog()).toEqual([
      'GET /api/sync',
      'GET /api/storage/list',
      'POST /api/storage/upload',
      'PUT s3',
      'POST /api/storage/upload',
      'PUT s3',
      'GET /api/sync',
      'POST /api/sync',
    ]);
    expect(putKeys(s.server)).toEqual([
      `${UID}/${bookKey(info.hash)}`,
      `${UID}/Readest/Books/${info.hash}/cover.png`,
    ]);
    const row = postedRow(syncPosts(s.server)[0]!);
    expect(row.coverHash).toBe(partialMD5Bytes(info.cover!));
    expect(s.server.objects.get(`${UID}/${bookKey(info.hash)}`)!.length).toBe(info.size);

    const again = await run(s, [path]);
    expect(again).toEqual([
      {
        file: path,
        status: 'skipped',
        reason: 'already',
        hash: info.hash,
        title: 'Order',
        group: 'Shelf',
      },
    ]);
    expect(syncPosts(s.server)).toHaveLength(1);
    expect(putKeys(s.server)).toHaveLength(2);
  });

  it('a quota refusal on the book reports usage, no retry advice, no cover, no sync', async () => {
    const s = setup({ quota: 10 });
    const path = bookFile('Big');
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('error');
    expect(r!.reason).toMatch(/storage quota/);
    expect(r!.reason).toMatch(/usage/);
    expect(r!.reason).not.toMatch(/retry|again/i);
    expect(s.server.calls.filter((c) => c.path === '/api/storage/upload')).toHaveLength(1);
    expect(syncPosts(s.server)).toHaveLength(0);
    expect(s.server.files).toHaveLength(0);
  });

  it('a failed book PUT names the reservation; the re-run continues under the same key', async () => {
    const s = setup();
    const path = bookFile('Flaky');
    const info = await readBookFile(path);
    s.server.setIntercept((c) =>
      c.method === 'PUT' && c.url.pathname.endsWith('.epub')
        ? new Response('', { status: 500 })
        : undefined,
    );
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('error');
    expect(r!.reason).toContain(`${UID}/${bookKey(info.hash)}`);
    expect(r!.reason).toContain(`readest upload ${path}`);
    expect(syncPosts(s.server)).toHaveLength(0);

    s.server.setIntercept(undefined);
    const [r2] = await run(s, [path]);
    expect(r2!.status).toBe('uploaded');
    expect(
      s.server.files.filter((f) => f.file_key === `${UID}/${bookKey(info.hash)}`),
    ).toHaveLength(1);
    expect(s.server.books.get(info.hash)?.uploaded_at).toBeTruthy();
  });

  it('reuploaded with no server cover uploads one; with a server cover it does not', async () => {
    const s = setup();
    const path = bookFile('Again');
    const info = await readBookFile(path);
    s.server.addBook(dbRow(info.hash));
    const [r] = await run(s, [path], { group: 'Ignored' });
    expect(r).toMatchObject({ status: 'reuploaded', group: 'Old/Shelf' });
    expect(s.stderr()).toMatch(/--group/);
    const row = postedRow(syncPosts(s.server)[0]!);
    expect(row.coverHash).toBe(partialMD5Bytes(info.cover!));
    expect(row.coverUpdatedAt).toBeGreaterThan(0);
    expect(row.groupName).toBe('Old/Shelf');
    expect(row.progress).toEqual([5, 50]);

    const s2 = setup();
    s2.server.addBook(dbRow(info.hash, { cover_hash: 'have' }));
    await run(s2, [path]);
    expect(putKeys(s2.server).some((k) => k.endsWith('cover.png'))).toBe(false);
    expect(postedRow(syncPosts(s2.server)[0]!).coverHash).toBe('have');
  });

  it('a failed cover PUT warns and posts the row without coverHash', async () => {
    const s = setup();
    const path = bookFile('NoCover');
    s.server.setIntercept((c) =>
      c.method === 'PUT' && c.url.pathname.endsWith('cover.png')
        ? new Response('', { status: 500 })
        : undefined,
    );
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('uploaded');
    expect(s.stderr()).toMatch(/warning: .*cover/);
    const row = postedRow(syncPosts(s.server)[0]!);
    expect(row.coverHash ?? null).toBeNull();
    expect(row.coverUpdatedAt ?? null).toBeNull();
  });

  it('revived replaces an old cover; a failed cover PUT keeps the server cover', async () => {
    const path = bookFile('Phoenix');
    const info = await readBookFile(path);
    const s = setup();
    s.server.addBook(
      dbRow(info.hash, {
        deleted_at: '2026-01-05T00:00:00.000Z',
        cover_hash: 'old',
        cover_updated_at: '2026-01-02T00:00:00.000Z',
      }),
    );
    expect((await run(s, [path]))[0]!.status).toBe('revived');
    const row = postedRow(syncPosts(s.server)[0]!);
    expect(row.coverHash).toBe(partialMD5Bytes(info.cover!));
    expect(row.coverUpdatedAt).toBeGreaterThan(Date.parse('2026-01-02T00:00:00.000Z'));
    expect(row.deletedAt).toBeNull();

    const s2 = setup();
    s2.server.addBook(
      dbRow(info.hash, {
        deleted_at: '2026-01-05T00:00:00.000Z',
        cover_hash: 'old',
        cover_updated_at: '2026-01-02T00:00:00.000Z',
      }),
    );
    s2.server.setIntercept((c) =>
      c.method === 'PUT' && c.url.pathname.endsWith('cover.png')
        ? new Response('', { status: 500 })
        : undefined,
    );
    expect((await run(s2, [path]))[0]!.status).toBe('revived');
    const row2 = postedRow(syncPosts(s2.server)[0]!);
    expect(row2.coverHash).toBe('old');
    expect(row2.coverUpdatedAt).toBe(Date.parse('2026-01-02T00:00:00.000Z'));
  });

  it.each([
    ['a tombstone', { deleted_at: '2027-01-01T00:00:00.000Z' }],
    ['another uploaded_at', { uploaded_at: '2020-01-01T00:00:00.000Z' }],
  ])('a sync response with %s is a conflict', async (_, over) => {
    const s = setup();
    const path = bookFile('Conflict');
    s.server.setIntercept((c) => {
      if (c.method !== 'POST' || c.path !== '/api/sync') return undefined;
      const row = transformBookToDB(postedRow(c), UID);
      return json(200, { books: [{ ...row, ...over }], notes: [], configs: [] });
    });
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('error');
    expect(r!.reason).toMatch(/conflict/);
  });

  it('a row that appeared before the re-read is decided again without a second PUT', async () => {
    const s = setup();
    const path = bookFile('Race');
    const info = await readBookFile(path);
    let gets = 0;
    s.server.setIntercept((c) => {
      if (c.method === 'GET' && c.path === '/api/sync' && ++gets === 2) {
        s.server.addBook(dbRow(info.hash, { progress: [7, 70] }));
      }
      return undefined;
    });
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('reuploaded');
    expect(putKeys(s.server).filter((k) => k.endsWith('.epub'))).toHaveLength(1);
    expect(syncPosts(s.server)).toHaveLength(1);
    expect(postedRow(syncPosts(s.server)[0]!).progress).toEqual([7, 70]);
  });

  it('a POST timeout with the remote row unchanged is "sync not confirmed", one POST', async () => {
    const s = setup();
    const path = bookFile('Timeout');
    const info = await readBookFile(path);
    s.server.addBook(dbRow(info.hash, { deleted_at: '2026-01-05T00:00:00.000Z' }));
    s.server.setIntercept((c) =>
      c.method === 'POST' && c.path === '/api/sync' ? 'throw' : undefined,
    );
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('error');
    expect(r!.reason).toMatch(/sync not confirmed/);
    expect(r!.reason).toContain('readest upload');
    expect(syncPosts(s.server)).toHaveLength(1);
    expect(bookGets(s.server)).toHaveLength(3);
  });

  it('a new book with no row before or after a failed POST is "sync not confirmed"', async () => {
    const s = setup();
    const path = bookFile('Lost');
    s.server.setIntercept((c) =>
      c.method === 'POST' && c.path === '/api/sync'
        ? json(502, { error: 'bad gateway' })
        : undefined,
    );
    const [r] = await run(s, [path]);
    expect(r!.reason).toMatch(/sync not confirmed/);
    expect(syncPosts(s.server)).toHaveLength(1);
  });

  it('a POST whose response was lost but which applied is a success', async () => {
    const s = setup();
    const path = bookFile('Applied');
    const info = await readBookFile(path);
    s.server.setIntercept((c) => {
      if (c.method !== 'POST' || c.path !== '/api/sync') return undefined;
      s.server.books.set(info.hash, transformBookToDB(postedRow(c), UID) as unknown as DbBookRow);
      return 'throw';
    });
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('uploaded');
    expect(syncPosts(s.server)).toHaveLength(1);
  });

  it('another client uploading the book during a failed POST → skipped: already, no second POST', async () => {
    const s = setup();
    const path = bookFile('Rival');
    const info = await readBookFile(path);
    s.server.setIntercept((c) => {
      if (c.method !== 'POST' || c.path !== '/api/sync') return undefined;
      s.server.addBook(dbRow(info.hash, { uploaded_at: '2026-11-01T00:00:00.000Z' }));
      return json(500, { error: 'duplicate key value violates unique constraint' });
    });
    const [r] = await run(s, [path]);
    expect(r).toMatchObject({ status: 'skipped', reason: 'already' });
    expect(syncPosts(s.server)).toHaveLength(1);
  });

  it('another client changing the row during a failed POST → decided again and posted once more', async () => {
    const s = setup();
    const path = bookFile('Changed');
    const info = await readBookFile(path);
    s.server.addBook(dbRow(info.hash, { deleted_at: '2026-01-05T00:00:00.000Z' }));
    let posts = 0;
    s.server.setIntercept((c) => {
      if (c.method !== 'POST' || c.path !== '/api/sync' || ++posts > 1) return undefined;
      s.server.addBook(
        dbRow(info.hash, {
          deleted_at: '2026-01-05T00:00:00.000Z',
          progress: [9, 90],
          updated_at: '2026-11-01T00:00:00.000Z',
        }),
      );
      return 'throw';
    });
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('revived');
    expect(syncPosts(s.server)).toHaveLength(2);
    expect(postedRow(syncPosts(s.server)[1]!).progress).toEqual([9, 90]);
    expect(putKeys(s.server).filter((k) => k.endsWith('.epub'))).toHaveLength(1);
  });

  it('checks the lock right before the POST: a lost lock writes nothing', async () => {
    const s = setup();
    const path = bookFile('Lock');
    const lock = join(home, '.config', 'readest-cli', `upload-${PROFILE.key}.lock`);
    let gets = 0;
    s.server.setIntercept((c) => {
      if (c.method === 'GET' && c.path === '/api/sync' && ++gets === 2) {
        expect(existsSync(lock)).toBe(true);
        writeFileSync(lock, JSON.stringify({ pid: process.pid, started: null, token: 'stolen' }));
      }
      return undefined;
    });
    await expect(run(s, [path])).rejects.toThrow(/lock lost/);
    expect(syncPosts(s.server)).toHaveLength(0);
  });

  it('--dry-run reads like a real run and writes nothing', async () => {
    const path = bookFile('Dry');
    const info = await readBookFile(path);
    const seed = (s: ReturnType<typeof setup>) => {
      s.server.addBook(dbRow(info.hash, { deleted_at: '2026-01-05T00:00:00.000Z' }));
      s.server.addFile(`${UID}/Readest/Books/${info.hash}/Dry.epub`, info.hash);
    };
    const dry = setup();
    seed(dry);
    const results = await run(dry, [path], { dryRun: true, group: 'G' });
    expect(results[0]).toMatchObject({ status: 'revived', dryRun: true });
    expect(dry.server.calls.some((c) => c.method !== 'GET')).toBe(false);
    const text = uploadText(results);
    for (const s of [
      'EPUB',
      info.hash,
      info.metaHash,
      'Dry',
      info.author,
      'G',
      'revived',
      `Readest/Books/${info.hash}/Dry.epub`,
      `Readest/Books/${info.hash}/cover.png`,
    ]) {
      expect(text).toContain(s);
    }

    const real = setup();
    seed(real);
    expect((await run(real, [path], { group: 'G' }))[0]!.status).toBe('revived');
    expect(putKeys(real.server)).toEqual([
      `${UID}/Readest/Books/${info.hash}/Dry.epub`,
      `${UID}/Readest/Books/${info.hash}/cover.png`,
    ]);
  });

  it('a broken first file does not stop the second', async () => {
    const s = setup();
    const broken = join(books, 'broken.epub');
    writeFileSync(broken, 'not a zip');
    const good = bookFile('Good');
    const results = await run(s, [broken, good]);
    expect(results.map((r) => r.status)).toEqual(['error', 'uploaded']);
    expect(results[0]!.file).toBe(broken);
    expect(uploadText(results)).toMatch(/^error\s+.*broken\.epub/m);
  });

  it('a server row from a device clock ahead is still overwritten: reuploaded, not a conflict', async () => {
    const s = setup();
    const path = bookFile('Ahead');
    const info = await readBookFile(path);
    const ahead = Date.now() + 3_600_000;
    s.server.addBook(dbRow(info.hash, { updated_at: new Date(ahead).toISOString() }));
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('reuploaded');
    const row = postedRow(syncPosts(s.server)[0]!);
    expect(row.updatedAt).toBe(ahead + 1);
    expect(row.uploadedAt).toBeLessThan(ahead);
  });

  it('revives a renamed PDF under the server metaHash', async () => {
    const s = setup();
    const path = pdfFile('renamed.pdf');
    const info = await readBookFile(path);
    s.server.addBook(
      dbRow(info.hash, {
        format: 'PDF',
        meta_hash: 'server-meta',
        deleted_at: '2026-01-05T00:00:00.000Z',
      }),
    );
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('revived');
    expect(postedRow(syncPosts(s.server)[0]!).metaHash).toBe('server-meta');
    expect(putKeys(s.server)).toEqual([`${UID}/Readest/Books/${info.hash}/${info.hash}.pdf`]);
  });

  it('a live copy with the same metaHash that appeared after the PUTs → error naming the objects, no POST', async () => {
    const s = setup();
    const path = bookFile('Twin');
    const info = await readBookFile(path);
    const other = 'f'.repeat(32);
    let gets = 0;
    s.server.setIntercept((c) => {
      if (c.method === 'GET' && c.path === '/api/sync' && ++gets === 2) {
        s.server.addBook(dbRow(other, { meta_hash: info.metaHash, title: 'Twin copy' }));
      }
      return undefined;
    });
    const [r] = await run(s, [path]);
    expect(r).toEqual({
      file: path,
      status: 'error',
      reason:
        `duplicate appeared during upload; uploaded objects left at ${UID}/${bookKey(info.hash)}, ` +
        `${UID}/Readest/Books/${info.hash}/cover.png, re-run with --allow-duplicate to finish or remove them in the app`,
    });
    expect(syncPosts(s.server)).toHaveLength(0);
    const allowed = setup();
    allowed.server.setIntercept((c) => {
      if (c.method === 'GET' && c.path === '/api/sync' && c.url.searchParams.has('book')) {
        allowed.server.addBook(dbRow(other, { meta_hash: info.metaHash }));
      }
      return undefined;
    });
    expect((await run(allowed, [path], { allowDuplicate: true }))[0]!.status).toBe('uploaded');
  });

  it('--dry-run of a revived renamed PDF prints the server metaHash', async () => {
    const s = setup();
    const path = pdfFile('renamed.pdf');
    const info = await readBookFile(path);
    s.server.addBook(
      dbRow(info.hash, {
        format: 'PDF',
        meta_hash: 'server-meta',
        deleted_at: '2026-01-05T00:00:00.000Z',
      }),
    );
    const results = await run(s, [path], { dryRun: true });
    expect(results[0]).toMatchObject({ status: 'revived', metaHash: 'server-meta' });
    expect(uploadText(results)).toContain('metaHash: server-meta\n');
  });

  it('a duplicate from the start snapshot removed by another client before this file → uploaded', async () => {
    const s = setup();
    const first = bookFile('First');
    const second = bookFile('Second');
    const info = await readBookFile(second);
    const other = 'f'.repeat(32);
    s.server.addBook(dbRow(other, { meta_hash: info.metaHash, title: 'Second copy' }));
    s.server.setIntercept((c) => {
      if (c.method === 'POST' && c.path === '/api/sync') {
        const dup = s.server.books.get(other)!;
        const now = new Date().toISOString();
        s.server.books.set(other, { ...dup, deleted_at: now, updated_at: now });
      }
      return undefined;
    });
    const results = await run(s, [first, second]);
    expect(results.map((r) => r.status)).toEqual(['uploaded', 'uploaded']);
    expect(s.server.books.get(info.hash)?.uploaded_at).toBeTruthy();
  });

  it('revived prints the group the server kept, not the requested one', async () => {
    const s = setup();
    const path = bookFile('Kept group');
    const info = await readBookFile(path);
    s.server.addBook(dbRow(info.hash, { deleted_at: '2026-01-05T00:00:00.000Z' }));
    s.server.setIntercept((c) => {
      if (c.method !== 'POST' || c.path !== '/api/sync') return undefined;
      const row = transformBookToDB(postedRow(c), UID);
      return json(200, {
        books: [{ ...row, group_id: 'g0', group_name: 'Old/Shelf' }],
        notes: [],
        configs: [],
      });
    });
    const [r] = await run(s, [path], { group: 'New' });
    expect(r).toMatchObject({ status: 'revived', group: 'Old/Shelf' });
  });

  it('reads only the rows of this book: before deciding, before the POST and after an uncertain POST', async () => {
    const s = setup();
    const path = bookFile('Narrow');
    const info = await readBookFile(path);
    s.server.addBook(dbRow('e'.repeat(32), { title: 'Unrelated' }));
    s.server.setIntercept((c) =>
      c.method === 'POST' && c.path === '/api/sync' ? 'throw' : undefined,
    );
    const [r] = await run(s, [path]);
    expect(r!.reason).toMatch(/sync not confirmed/);
    const one = { type: 'books', since: '0', book: info.hash, meta_hash: info.metaHash };
    expect(bookGets(s.server).map((c) => Object.fromEntries(c.url.searchParams))).toEqual([
      one,
      one,
      one,
    ]);
  });

  it('the fake server filters books by book OR meta_hash like queryTables', async () => {
    const s = setup();
    s.server.addBook(dbRow('a'.repeat(32), { meta_hash: 'm1' }));
    s.server.addBook(dbRow('b'.repeat(32), { meta_hash: 'm2' }));
    s.server.addBook(dbRow('c'.repeat(32), { meta_hash: 'm3' }));
    const hashes = (rows: DbBookRow[]) => rows.map((r) => r.book_hash).sort();
    expect(hashes(await s.api.pullBookRows('a'.repeat(32), 'm2'))).toEqual([
      'a'.repeat(32),
      'b'.repeat(32),
    ]);
    expect(hashes(await s.api.pullBookRows('c'.repeat(32)))).toEqual(['c'.repeat(32)]);
  });

  it.each([
    [
      'the book reservation',
      (c: Call) => c.method === 'GET' && c.path === '/api/storage/list',
      0,
      0,
    ],
    ['the book PUT', (c: Call) => c.method === 'POST' && c.path === '/api/storage/upload', 1, 0],
    ['the cover reservation', (c: Call) => c.method === 'PUT', 1, 1],
  ])('checks the lock before %s', async (_name, when, reservations, puts) => {
    const s = setup();
    const path = bookFile('Steal');
    let stolen = false;
    s.server.setIntercept((c) => {
      if (!stolen && when(c)) {
        stolen = true;
        stealLock();
      }
      return undefined;
    });
    await expect(run(s, [path])).rejects.toThrow(/lock lost/);
    expect(s.server.calls.filter((c) => c.path === '/api/storage/upload')).toHaveLength(
      reservations,
    );
    expect(putKeys(s.server)).toHaveLength(puts);
    expect(syncPosts(s.server)).toHaveLength(0);
  });

  it('a file changed after hashing is not uploaded', async () => {
    const s = setup();
    const path = bookFile('Moving');
    s.server.setIntercept((c) => {
      if (c.method === 'POST' && c.path === '/api/storage/upload') appendFileSync(path, 'x');
      return undefined;
    });
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('error');
    expect(r!.reason).toMatch(/file changed during upload/);
    expect(putKeys(s.server)).toHaveLength(0);
    expect(syncPosts(s.server)).toHaveLength(0);
  });

  it('a sync row over 900 KiB drops metadata.description with a warning', async () => {
    const s = setup();
    const path = fb2File('Pictured', { imageBytes: 720 * 1024 });
    const info = await readBookFile(path);
    expect(String(info.metadata.description).length).toBeGreaterThan(900 * 1024);
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('uploaded');
    expect(s.stderr()).toMatch(/warning: .*description/);
    const post = syncPosts(s.server)[0]!;
    expect(postedRow(post).metadata?.['description']).toBeUndefined();
    expect(JSON.stringify(post.body).length).toBeLessThan(900 * 1024);
  });

  it('a sync row between 512 and 900 KiB keeps its description', async () => {
    const s = setup();
    const path = fb2File('Mid', { imageBytes: 600 * 1024 });
    const info = await readBookFile(path);
    expect(String(info.metadata.description).length).toBeGreaterThan(512 * 1024);
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('uploaded');
    expect(s.stderr()).not.toMatch(/description/);
    expect(postedRow(syncPosts(s.server)[0]!).metadata?.['description']).toBe(
      info.metadata.description,
    );
  });

  it('a row that grows past 900 KiB on the re-decision before the POST is an error, no POST', async () => {
    const s = setup();
    const path = bookFile('Grow');
    const info = await readBookFile(path);
    let gets = 0;
    s.server.setIntercept((c) => {
      if (c.method === 'GET' && c.path === '/api/sync' && ++gets === 2) {
        s.server.addBook(
          dbRow(info.hash, {
            metadata: JSON.stringify({ title: 'Grow', description: 'D'.repeat(950 * 1024) }),
          }),
        );
      }
      return undefined;
    });
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('error');
    expect(r!.reason).toMatch(/too large/);
    expect(syncPosts(s.server)).toHaveLength(0);
  });

  it('--dry-run of an oversized row reports the same error as a real run', async () => {
    const path = fb2File('Huge', { title: 'T'.repeat(400 * 1024) });
    const [real] = await run(setup(), [path]);
    expect(real!.status).toBe('error');
    const dry = setup();
    const [r] = await run(dry, [path], { dryRun: true });
    expect(r).toEqual(real);
    expect(dry.server.calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('a sync row over 900 KiB without description is a file error before any reservation', async () => {
    const s = setup();
    const path = fb2File('Huge', { title: 'T'.repeat(400 * 1024) });
    const [r] = await run(s, [path]);
    expect(r!.status).toBe('error');
    expect(r!.reason).toMatch(/too large/);
    expect(s.server.calls.filter((c) => c.path === '/api/storage/upload')).toHaveLength(0);
    expect(syncPosts(s.server)).toHaveLength(0);
  });

  it('--group on a skipped book warns that its group is not changed', async () => {
    const s = setup();
    const path = bookFile('Kept');
    const info = await readBookFile(path);
    await run(s, [path]);
    s.err.length = 0;
    const [r] = await run(s, [path], { group: 'New' });
    expect(r).toMatchObject({ status: 'skipped', reason: 'already' });
    expect(s.stderr()).toMatch(/--group is not applied/);

    const d = setup();
    d.server.addBook(dbRow('f'.repeat(32), { meta_hash: info.metaHash, group_name: 'Shelf' }));
    const [r2] = await run(d, [path], { group: 'New' });
    expect(r2).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(d.stderr()).toMatch(/--group is not applied.*"Shelf"/);
  });

  it('a later book whose meta_hash changed while an earlier one was processed → skipped: already, no reservation or PUT', async () => {
    const s = setup();
    const a = bookFile('Alpha');
    const b = bookFile('Beta');
    const infoA = await readBookFile(a);
    const infoB = await readBookFile(b);
    s.server.addBook(
      dbRow(infoB.hash, { meta_hash: infoA.metaHash, uploaded_at: '2026-01-04T00:00:00.000Z' }),
    );
    s.server.addFile(`${UID}/${bookKey(infoB.hash)}`, infoB.hash, new Uint8Array([1, 2, 3]));
    let changed = false;
    s.server.setIntercept((c) => {
      if (!changed && c.method === 'GET' && c.url.searchParams.get('book') === infoA.hash) {
        changed = true;
        const row = s.server.books.get(infoB.hash)!;
        s.server.books.set(infoB.hash, {
          ...row,
          meta_hash: 'changed-meta',
          updated_at: new Date().toISOString(),
        });
      }
      return undefined;
    });
    const results = await run(s, [a, b]);
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ['uploaded', undefined],
      ['skipped', 'already'],
    ]);
    const forB = s.server.calls.filter(
      (c) =>
        (c.method === 'POST' &&
          c.path === '/api/storage/upload' &&
          (c.body as { bookHash?: string }).bookHash === infoB.hash) ||
        (c.method === 'PUT' && decodeURIComponent(c.url.pathname).includes(infoB.hash)),
    );
    expect(forB, 'reservations and PUTs for the skipped book').toEqual([]);
  });

  it('--dry-run of a reuploaded book whose server metaHash is null prints null, not the file hash', async () => {
    const s = setup();
    const path = bookFile('No meta');
    const info = await readBookFile(path);
    s.server.addBook(dbRow(info.hash, { meta_hash: null }));
    const results = await run(s, [path], { dryRun: true });
    expect(results[0]).toMatchObject({ status: 'reuploaded', metaHash: null });
    expect(JSON.stringify(results[0])).toContain('"metaHash":null');
    expect(uploadText(results)).toContain('  metaHash: -\n');
  });

  it.each([
    ['in the POST response', false],
    ['after an applied POST whose response was lost', true],
  ])('--group on reuploaded warns with the group the server kept %s', async (_, lost) => {
    const s = setup();
    const path = bookFile(`Moved ${lost}`);
    const info = await readBookFile(path);
    s.server.addBook(dbRow(info.hash));
    s.server.setIntercept((c) => {
      if (c.method !== 'POST' || c.path !== '/api/sync') return undefined;
      const row = {
        ...(transformBookToDB(postedRow(c), UID) as unknown as DbBookRow),
        group_id: 'g1',
        group_name: 'Moved/Elsewhere',
      };
      if (!lost) return json(200, { books: [row], notes: [], configs: [] });
      s.server.books.set(info.hash, row);
      return 'throw';
    });
    const [r] = await run(s, [path], { group: 'New' });
    expect(r).toMatchObject({ status: 'reuploaded', group: 'Moved/Elsewhere' });
    expect(s.stderr()).toMatch(/--group is not applied.*stays in "Moved\/Elsewhere"/);
  });

  it('runs under the profile upload lock; a second run waits for the first', async () => {
    const s = setup();
    const path = bookFile('Serial');
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let reached!: () => void;
    const atPost = new Promise<void>((r) => {
      reached = r;
    });
    let posts = 0;
    s.server.setIntercept(async (c) => {
      if (c.method === 'POST' && c.path === '/api/sync' && ++posts === 1) {
        reached();
        await gate;
      }
      return undefined;
    });
    const first = run(s, [path]);
    let second: ReturnType<typeof run> | undefined;
    try {
      await atPost;
      second = run(s, [path]);
      await waitFor(() => s.stderr().includes('waiting for upload'));
      expect(s.stderr()).toContain(`waiting for upload process ${process.pid}`);
      expect(bookGets(s.server)).toHaveLength(2);
    } finally {
      release();
      await Promise.allSettled([first, second]);
    }
    const [a, b] = await Promise.all([first, second]);
    expect(a![0]!.status).toBe('uploaded');
    expect(b![0]).toMatchObject({ status: 'skipped', reason: 'already' });
    expect(existsSync(uploadLock())).toBe(false);
  });
});
