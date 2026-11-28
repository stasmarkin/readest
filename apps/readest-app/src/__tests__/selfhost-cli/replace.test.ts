import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { transformBookToDB } from '@/utils/transform';
import { ApiClient } from '../../../../../selfhost/cli/lib/api.ts';
import type { DbBookRow, WireBook } from '../../../../../selfhost/cli/lib/api.ts';
import { md5Fingerprint } from '../../../../../selfhost/cli/lib/hash.ts';
import { readBookFile } from '../../../../../selfhost/cli/lib/metadata.ts';
import { runReplace } from '../../../../../selfhost/cli/lib/replace.ts';
import { runUpload } from '../../../../../selfhost/cli/lib/upload.ts';
import { fakeDeps, fakeServer, json, PROFILE, UID, writeFreshSession } from './fake-server';
import type { Call, Intercept } from './fake-server';

let home: string;
let dir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'readest-cli-rep-'));
  dir = mkdtempSync(join(tmpdir(), 'readest-cli-rep-books-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const CONTAINER =
  '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="o.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';

/** One clipping: the title fixes the metaHash, the body only the file hash. */
const clipping = (name: string, body: string, title = 'Clipping') => {
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>Author</dc:creator><dc:identifier id="u">urn:uuid:${md5Fingerprint(title)}</dc:identifier></metadata>
<manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`;
  const path = join(dir, name);
  writeFileSync(
    path,
    zipSync({
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': strToU8(CONTAINER),
      'o.opf': strToU8(opf),
      'c.xhtml': strToU8(`<html><body><p>${body}</p></body></html>`),
    }),
  );
  return path;
};

const setup = () => {
  const server = fakeServer();
  let clock = Date.now();
  const f = fakeDeps(server.handler, home, { now: () => clock });
  writeFreshSession(f.deps);
  const api = new ApiClient(f.deps, PROFILE);
  return {
    server,
    api,
    ...f,
    advance: (ms: number) => {
      clock += ms;
    },
    replace: (
      file: string,
      oldHash: string,
      opts: { resume?: boolean; expectMeta?: string } = {},
    ) => runReplace(f.deps, api, PROFILE, file, oldHash, { resume: false, ...opts }),
    upload: (file: string, group?: string) =>
      runUpload(f.deps, api, PROFILE, [file], {
        ...(group !== undefined ? { group } : {}),
        dryRun: false,
        allowDuplicate: true,
      }),
  };
};
type S = ReturnType<typeof setup>;

const STATUS_AT = '2026-11-01T00:00:00.000Z';
const setRow = (s: S, hash: string, over: Partial<DbBookRow>) =>
  s.server.books.set(hash, { ...s.server.books.get(hash)!, ...over });

/** A live A in group Clippings, half-read, and a B: the same clipping with an edited body. */
const seed = async (s: S, status = 'reading') => {
  const a = clipping('a.epub', 'Body A');
  const b = clipping('b.epub', 'Body B');
  const [ra] = await s.upload(a, 'Clippings');
  const A = ra!.hash!;
  setRow(s, A, { progress: [3, 10], reading_status: status, reading_status_updated_at: STATUS_AT });
  const infoB = await readBookFile(b);
  expect(infoB.metaHash, 'an edit of the body keeps the metaHash').toBe(ra!.metaHash);
  s.server.calls.length = 0;
  return { a, b, A, B: infoB.hash, meta: infoB.metaHash };
};

const posted = (c: Call) => (c.body as { books: WireBook[] }).books[0]!;
const postsOf = (s: S, hash: string) =>
  s.server.calls.filter(
    (c) => c.method === 'POST' && c.path === '/api/sync' && posted(c).hash === hash,
  );
const writes = (s: S) => s.server.calls.filter((c) => c.method !== 'GET');
const live = (s: S) =>
  [...s.server.books.values()].filter((r) => !r.deleted_at).map((r) => r.book_hash);
const objectsOf = (s: S, hash: string) => s.server.files.filter((f) => f.book_hash === hash);

/** The state a finished replace of A by B leaves. */
const expectReplaced = (s: S, A: string, B: string, status = 'reading') => {
  expect(live(s)).toEqual([B]);
  const b = s.server.books.get(B)!;
  expect([b.group_id, b.group_name]).toEqual([md5Fingerprint('Clippings'), 'Clippings']);
  expect(b.progress).toEqual([3, 10]);
  expect(b.reading_status).toBe(status);
  expect(Date.parse(b.reading_status_updated_at!)).toBeGreaterThan(Date.parse(STATUS_AT));
  expect(b.uploaded_at).toBeTruthy();
  expect(objectsOf(s, B).some((f) => f.file_key.endsWith('.epub'))).toBe(true);
  expect(s.server.books.get(A)!.deleted_at).toBeTruthy();
  expect(objectsOf(s, A), 'no object of the old book').toEqual([]);
};

describe('runReplace', () => {
  it('replaces a live book: one new row with its group, progress and status', async () => {
    const s = setup();
    const { b, A, B, meta } = await seed(s);
    const r = await s.replace(b, A);
    expect(r).toEqual({
      file: b,
      status: 'replaced',
      step: 'uploaded',
      hash: B,
      title: 'Clipping',
      group: 'Clippings',
      metaHash: meta,
      replacedHash: A,
    });
    expectReplaced(s, A, B);
    expect(postsOf(s, B)).toHaveLength(1);
  });

  it('finished becomes unread on the new version', async () => {
    const s = setup();
    const { b, A, B } = await seed(s, 'finished');
    expect((await s.replace(b, A)).status).toBe('replaced');
    expectReplaced(s, A, B, 'unread');
  });

  it('a third live book with the same metaHash is a duplicate: error, nothing written', async () => {
    const s = setup();
    const { b, A } = await seed(s);
    const C = 'c'.repeat(32);
    s.server.addBook({ book_hash: C, meta_hash: (await readBookFile(b)).metaHash, title: 'Copy' });
    s.server.calls.length = 0;
    const r = await s.replace(b, A);
    expect(r).toMatchObject({ status: 'error', duplicateOf: { hash: C } });
    expect(writes(s)).toEqual([]);
  });

  it('a deleted target needs --resume; with it the new book still gets the old fields', async () => {
    const s = setup();
    const { b, A, B } = await seed(s);
    setRow(s, A, { deleted_at: '2026-11-02T00:00:00.000Z' });
    const r = await s.replace(b, A);
    expect(r).toMatchObject({ status: 'error', reason: 'replace target deleted' });
    expect(writes(s)).toEqual([]);
    expect(await s.replace(b, A, { resume: true })).toMatchObject({
      status: 'replaced',
      step: 'uploaded',
    });
    expectReplaced(s, A, B);
  });

  it('an unknown target or the same hash is an error and writes nothing', async () => {
    const s = setup();
    const { a, b, A } = await seed(s);
    expect(await s.replace(b, 'd'.repeat(32))).toMatchObject({
      status: 'error',
      reason: 'replace target not found',
    });
    const same = await s.replace(a, A);
    expect(same.status).toBe('error');
    expect(same.reason).toMatch(/^same hash/);
    expect(writes(s)).toEqual([]);
  });

  const failOnce = (s: S, when: (c: Call) => boolean): void => {
    let failed = false;
    const f: Intercept = (c) => {
      if (failed || !when(c)) return undefined;
      failed = true;
      return 'throw';
    };
    s.server.setIntercept(f);
  };
  const isPost = (c: Call) => c.method === 'POST' && c.path === '/api/sync';

  it.each([
    [
      'between the reservation and the PUT',
      (_A: string) => (c: Call) => c.method === 'PUT',
      'uploaded',
      1,
    ],
    ['after the PUT, before the POST of the new row', (_A: string) => isPost, 'uploaded', 1],
    [
      'after the POST of the new row',
      (A: string) => (c: Call) => isPost(c) && posted(c).hash === A,
      'already',
      0,
    ],
    [
      'after the tombstone of the old row',
      (_A: string) => (c: Call) => c.method === 'DELETE',
      'already',
      0,
    ],
  ])('fails %s: the retry with --resume finishes it, one live book', async (_, when, step, newPosts) => {
    const s = setup();
    const { b, A, B } = await seed(s);
    failOnce(s, when(A));
    const first = await s.replace(b, A);
    expect(first).toMatchObject({ status: 'error', uncertain: true });
    s.server.setIntercept(undefined);
    s.server.calls.length = 0;
    expect(await s.replace(b, A, { resume: true })).toMatchObject({ status: 'replaced', step });
    expect(postsOf(s, B)).toHaveLength(newPosts);
    expectReplaced(s, A, B);
    expect(objectsOf(s, B).filter((f) => f.file_key.endsWith('.epub'))).toHaveLength(1);
  });

  it('any failure after the new row is in is uncertain: only a retry can finish the replace', async () => {
    const s = setup();
    const { b, A } = await seed(s);
    s.server.setIntercept((c) => {
      if (!isPost(c) || posted(c).hash !== A) return undefined;
      const row = transformBookToDB(posted(c), UID);
      return json(200, { books: [{ ...row, deleted_at: null }], notes: [], configs: [] });
    });
    const r = await s.replace(b, A);
    expect(r).toMatchObject({ status: 'error', uncertain: true });
    expect(r.reason).toMatch(/conflict/);
  });

  it('the old book read on during the replace: not retired; --resume carries the new progress', async () => {
    const s = setup();
    const { b, A, B } = await seed(s);
    s.server.setIntercept((c) => {
      if (isPost(c) && posted(c).hash === B) setRow(s, A, { progress: [6, 10] });
      return undefined;
    });
    expect(await s.replace(b, A)).toMatchObject({ status: 'error', uncertain: true });
    expect(s.server.books.get(A)!.deleted_at).toBeNull();
    s.server.setIntercept(undefined);
    expect(await s.replace(b, A, { resume: true })).toMatchObject({
      status: 'replaced',
      step: 'already',
    });
    expect(s.server.books.get(B)!.progress).toEqual([6, 10]);
  });

  it('the old book changed right before its tombstone: not retired', async () => {
    const s = setup();
    const { b, A, B } = await seed(s);
    let reads = 0;
    s.server.setIntercept((c) => {
      // The tombstone's own read of A, after the B row is in.
      if (
        c.method === 'GET' &&
        c.url.searchParams.get('book') === A &&
        postsOf(s, B).length &&
        ++reads === 1
      ) {
        setRow(s, A, { progress: [6, 10] });
      }
      return undefined;
    });
    const r = await s.replace(b, A);
    expect(r).toMatchObject({ status: 'error', uncertain: true });
    expect(s.server.books.get(A)!.deleted_at).toBeNull();
    s.server.setIntercept(undefined);
    expect(await s.replace(b, A, { resume: true })).toMatchObject({
      status: 'replaced',
      step: 'already',
    });
    expect(s.server.books.get(B)!.progress).toEqual([6, 10]);
    expect(s.server.books.get(A)!.deleted_at).toBeTruthy();
  });

  it('fails between two DELETEs of old objects: the retry removes the rest', async () => {
    const s = setup();
    const { b, A, B } = await seed(s);
    s.server.addFile(`${UID}/Readest/Books/${A}/cover.png`, A, new Uint8Array([1]));
    let deletes = 0;
    s.server.setIntercept((c) => (c.method === 'DELETE' && ++deletes === 2 ? 'throw' : undefined));
    expect(await s.replace(b, A)).toMatchObject({ status: 'error', uncertain: true });
    expect(objectsOf(s, A)).toHaveLength(1);
    s.server.setIntercept(undefined);
    expect(await s.replace(b, A, { resume: true })).toMatchObject({
      status: 'replaced',
      step: 'already',
    });
    expectReplaced(s, A, B);
  });

  it('after a finished replace: a repeat needs --resume, which writes no row even if B was read since', async () => {
    const s = setup();
    const { b, A, B } = await seed(s);
    await s.replace(b, A);
    expect(await s.replace(b, A)).toMatchObject({
      status: 'error',
      reason: 'replace target deleted',
    });
    setRow(s, B, { progress: [9, 10] });
    s.server.calls.length = 0;
    expect(await s.replace(b, A, { resume: true })).toMatchObject({
      status: 'replaced',
      step: 'already',
    });
    expect(postsOf(s, B)).toHaveLength(0);
    expect(s.server.books.get(B)!.progress).toEqual([9, 10]);
  });

  it('already, an hour later: B carries the fields, A still live → no POST of B, A retired', async () => {
    const s = setup();
    const { b, A, B } = await seed(s);
    failOnce(s, (c) => isPost(c) && posted(c).hash === A);
    await s.replace(b, A);
    s.server.setIntercept(undefined);
    s.advance(3_600_000);
    s.server.calls.length = 0;
    expect(await s.replace(b, A, { resume: true })).toMatchObject({
      status: 'replaced',
      step: 'already',
    });
    expect(postsOf(s, B)).toHaveLength(0);
    expectReplaced(s, A, B);
  });

  it('already, but the old progress moved on: B is rewritten over a server clock ahead', async () => {
    const s = setup();
    const { b, A, B } = await seed(s);
    failOnce(s, (c) => isPost(c) && posted(c).hash === A);
    await s.replace(b, A);
    s.server.setIntercept(undefined);
    setRow(s, A, { progress: [5, 10] });
    const ahead = new Date(Date.now() + 86_400_000).toISOString();
    setRow(s, B, { updated_at: ahead });
    s.server.calls.length = 0;
    expect(await s.replace(b, A, { resume: true })).toMatchObject({
      status: 'replaced',
      step: 'already',
    });
    expect(postsOf(s, B)).toHaveLength(1);
    expect(posted(postsOf(s, B)[0]!).updatedAt).toBe(Date.parse(ahead) + 1);
    expect(s.server.books.get(B)!.progress).toEqual([5, 10]);
  });

  it('reuploaded: a live B without its object is uploaded again with the old fields', async () => {
    const s = setup();
    const { b, A, B, meta } = await seed(s);
    s.server.addBook({ book_hash: B, meta_hash: meta, title: 'Clipping', author: 'Author' });
    expect(await s.replace(b, A)).toMatchObject({ status: 'replaced', step: 'reuploaded' });
    expectReplaced(s, A, B);
  });

  it("an object of another book in the storage list does not stand for B's file", async () => {
    const s = setup();
    const { b, A, B, meta } = await seed(s);
    s.server.addBook({ book_hash: B, meta_hash: meta, uploaded_at: '2026-01-01T00:00:00.000Z' });
    s.server.setIntercept((c) => {
      if (c.method !== 'GET' || c.path !== '/api/storage/list') return undefined;
      if (c.url.searchParams.get('bookHash') !== B) return undefined;
      return json(200, { files: s.server.files.filter((f) => f.book_hash === A) });
    });
    const r = await s.replace(b, A);
    expect(r.step, 'the file is uploaded, not taken as present').toBe('reuploaded');
  });

  it('--expect-meta: a row of the new hash with another meta_hash is a conflict, nothing written', async () => {
    const s = setup();
    const { b, A, B, meta } = await seed(s);
    s.server.addBook({
      book_hash: B,
      meta_hash: 'foreign',
      deleted_at: '2026-01-05T00:00:00.000Z',
    });
    const r = await s.replace(b, A, { expectMeta: meta });
    expect(r.status).toBe('error');
    expect(r.reason).toMatch(/^conflict/);
    expect(writes(s)).toEqual([]);
    expect(s.server.books.get(B)!.deleted_at).toBeTruthy();
  });
});

describe('A → B → A', () => {
  /** A replaced by B earlier; B since moved to another group and read on. */
  const seedBack = async (s: S, overA: Partial<DbBookRow> = {}) => {
    const { a, b, A, B } = await seed(s);
    await s.replace(b, A);
    setRow(s, B, {
      group_id: md5Fingerprint('Другая'),
      group_name: 'Другая',
      group_updated_at: '2026-11-10T00:00:00.000Z',
      progress: [7, 10],
      reading_status: 'reading',
      reading_status_updated_at: '2026-11-10T00:00:00.000Z',
    });
    setRow(s, A, overA);
    s.server.calls.length = 0;
    return { a, A, B };
  };

  it('A revives with the group and progress of B; B is retired', async () => {
    const s = setup();
    const { a, A, B } = await seedBack(s);
    expect(await s.replace(a, B)).toMatchObject({ status: 'replaced', step: 'revived', hash: A });
    const row = s.server.books.get(A)!;
    expect([row.group_name, row.progress, row.deleted_at]).toEqual(['Другая', [7, 10], null]);
    expect(s.server.books.get(B)!.deleted_at).toBeTruthy();
    expect(live(s)).toEqual([A]);
  });

  it('a deleted A with a newer group stamp still takes the group of B', async () => {
    const s = setup();
    const later = '2026-12-01T00:00:00.000Z';
    const { a, A, B } = await seedBack(s, {
      group_name: 'Stale',
      group_id: 'stale',
      group_updated_at: later,
    });
    expect((await s.replace(a, B)).status).toBe('replaced');
    expect(posted(postsOf(s, A)[0]!).groupUpdatedAt).toBe(Date.parse(later) + 1);
    expect(s.server.books.get(A)!.group_name).toBe('Другая');
  });

  it('a deleted A with a newer status stamp and another status still takes the status of B', async () => {
    const s = setup();
    const later = '2026-12-01T00:00:00.000Z';
    const { a, A, B } = await seedBack(s, {
      reading_status: 'abandoned',
      reading_status_updated_at: later,
    });
    expect((await s.replace(a, B)).status).toBe('replaced');
    const row = s.server.books.get(A)!;
    expect(row.reading_status).toBe('reading');
    expect(Date.parse(row.reading_status_updated_at!)).toBe(Date.parse(later) + 1);
  });

  it('a POST answer without the carried fields is an error and B stays live', async () => {
    const s = setup();
    const { a, A, B } = await seedBack(s);
    s.server.setIntercept((c) => {
      if (c.method !== 'POST' || c.path !== '/api/sync' || posted(c).hash !== A) return undefined;
      const row = transformBookToDB(posted(c), UID);
      return json(200, { books: [{ ...row, group_name: 'Wrong' }], notes: [], configs: [] });
    });
    const r = await s.replace(a, B);
    expect(r).toMatchObject({ status: 'error', uncertain: true });
    expect(r.reason).toMatch(/conflict/);
    expect(s.server.books.get(B)!.deleted_at).toBeNull();
  });
});
