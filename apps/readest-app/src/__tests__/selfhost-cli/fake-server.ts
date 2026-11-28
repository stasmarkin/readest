// Shared fakes for the CLI tests: Deps over a temporary home and an in-memory
// Readest server (sync, storage, presigned object store).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { transformBookToDB } from '@/utils/transform';
import type { Deps } from '../../../../../selfhost/cli/lib/deps.ts';
import type { Profile } from '../../../../../selfhost/cli/lib/config.ts';
import type { DbBookRow, DbNoteRow, FileRow } from '../../../../../selfhost/cli/lib/api.ts';
import { sessionPath } from '../../../../../selfhost/cli/lib/session.ts';
import { CliError } from '../../../../../selfhost/cli/lib/errors.ts';

export const UID = 'uid-1';
export const API = 'http://api.test';
export const SB = 'http://sb.test';
export const S3 = 'http://s3.test';

export const PROFILE: Profile = {
  apiBase: API,
  supabaseUrl: SB,
  anonKey: 'anon',
  key: 'api.test-deadbeef',
};

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export type Call = { method: string; url: URL; path: string; body: unknown };
export type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

export const fakeDeps = (handler: Handler, home: string, over: Partial<Deps> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) =>
      handler(new URL(String(input)), init)) as typeof fetch,
    now: () => Date.now(),
    env: {},
    homeDir: home,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    isTTY: false,
    readSecret: async () => {
      throw new Error('readSecret must not be called');
    },
    // Yield only: a lock heartbeat must not spin the fake clock.
    sleep: () => new Promise((r) => setImmediate(r)),
    isAlive: (pid) => pid === process.pid,
    processStart: async (pid) => (pid === process.pid ? 'Mon Jan  1 00:00:00 2024' : null),
    loadCfi: async () => {
      throw new CliError('no cfi');
    },
    ...over,
  };
  return { deps, out, err, stdout: () => out.join(''), stderr: () => err.join('') };
};

export const writeFreshSession = (deps: Deps, profile: Profile = PROFILE) => {
  const path = sessionPath(deps, profile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    JSON.stringify({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: UID, email: 'me@example.com' },
    }),
    { mode: 0o600 },
  );
};

const bodyBytes = async (init: RequestInit): Promise<Uint8Array> =>
  new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());

/**
 * `intercept` runs first for every request: return a Response to answer it,
 * `'throw'` to fail it like a network error, or undefined to let the fake serve it.
 */
export type Intercept = (
  c: Call,
) => Response | 'throw' | undefined | Promise<Response | 'throw' | undefined>;

export const fakeServer = (opts: { quota?: number } = {}) => {
  const books = new Map<string, DbBookRow>();
  const notes: DbNoteRow[] = [];
  const files: Array<FileRow & { user_id: string }> = [];
  const objects = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  let intercept: Intercept | undefined;

  const used = () => files.reduce((n, f) => n + f.file_size, 0);

  /** POST /api/sync as the server does it for one fresh client row: the newer copy wins. */
  const merge = (wire: unknown): DbBookRow => {
    const row = transformBookToDB(wire, UID) as unknown as DbBookRow;
    const server = books.get(row.book_hash);
    if (!server) {
      row.updated_at = new Date().toISOString();
      books.set(row.book_hash, { ...row, synced_at: new Date().toISOString() });
      return books.get(row.book_hash)!;
    }
    const t = (s?: string | null) => (s ? Date.parse(s) : 0);
    const clientIsNewer =
      t(row.deleted_at) > t(server.deleted_at) || t(row.updated_at) > t(server.updated_at);
    if (!clientIsNewer) return server;
    books.set(row.book_hash, { ...row, synced_at: new Date().toISOString() });
    return books.get(row.book_hash)!;
  };

  const serve = async (url: URL, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET';
    let body: unknown;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    const call: Call = { method, url, path: url.pathname, body };
    calls.push(call);
    if (intercept) {
      const r = await intercept(call);
      if (r === 'throw') throw new TypeError('fetch failed');
      if (r) return r;
    }
    if (url.origin === S3) {
      const key = decodeURIComponent(url.pathname.slice(5));
      if (method === 'PUT' && url.pathname.startsWith('/put/')) {
        objects.set(key, await bodyBytes(init));
        return new Response(null, { status: 200 });
      }
      if (method === 'GET' && url.pathname.startsWith('/get/')) {
        return objects.has(key)
          ? new Response(objects.get(key)!.slice(0, 1), { status: 206 })
          : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      }
      return new Response(null, { status: 400 });
    }
    if (url.origin !== API) return json(404, { error: 'no route' });
    const q = url.searchParams;
    const b = (body ?? {}) as Record<string, unknown>;
    switch (`${method} ${url.pathname}`) {
      case 'GET /api/sync':
        if (q.get('type') === 'books') {
          // queryTables: book and meta_hash together match either column.
          const book = q.get('book');
          const meta = q.get('meta_hash');
          const rows = [...books.values()].filter(
            (r) =>
              (!book && !meta) ||
              (!!book && r.book_hash === book) ||
              (!!meta && r.meta_hash === meta),
          );
          return json(200, { books: rows });
        }
        if (q.get('type') === 'notes')
          return json(200, { notes: notes.filter((n) => n.book_hash === q.get('book')) });
        return json(400, { error: 'bad type' });
      case 'POST /api/sync': {
        const rows = (b['books'] as unknown[]).map(merge);
        return json(200, { books: rows, notes: [], configs: [] });
      }
      case 'GET /api/storage/list':
        return json(200, {
          files: files.filter((f) => f.book_hash === q.get('bookHash')),
          total: 0,
        });
      case 'POST /api/storage/upload': {
        const fileKey = `${UID}/${String(b['fileName'])}`;
        const size = Number(b['fileSize']);
        if (!files.some((f) => f.file_key === fileKey)) {
          if (opts.quota !== undefined && used() + size > opts.quota) {
            return json(403, { error: 'Insufficient storage quota', usage: used() });
          }
          files.push({
            user_id: UID,
            file_key: fileKey,
            file_size: size,
            book_hash: (b['bookHash'] as string) ?? null,
          });
        }
        return json(200, {
          uploadUrl: `${S3}/put/${encodeURIComponent(fileKey)}`,
          fileKey,
          usage: used(),
          quota: opts.quota ?? 0,
        });
      }
      case 'GET /api/storage/download': {
        const key = q.get('fileKey') ?? '';
        return files.some((f) => f.file_key === key)
          ? json(200, { downloadUrl: `${S3}/get/${encodeURIComponent(key)}` })
          : json(404, { error: 'File not found' });
      }
    }
    return json(404, { error: 'no route' });
  };

  return {
    books,
    notes,
    files,
    objects,
    calls,
    handler: serve as Handler,
    setIntercept: (f: Intercept | undefined) => {
      intercept = f;
    },
    /** API calls only, as `METHOD /path`, without object-store traffic. */
    apiLog: () => calls.map((c) => `${c.method} ${c.url.origin === S3 ? 's3' : c.path}`),
    addBook: (row: Partial<DbBookRow> & { book_hash: string }) => {
      books.set(row.book_hash, {
        format: 'EPUB',
        title: 'Server title',
        author: 'Server author',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        deleted_at: null,
        uploaded_at: null,
        ...row,
      } as DbBookRow);
    },
    addFile: (fileKey: string, bookHash: string, bytes?: Uint8Array) => {
      files.push({
        user_id: UID,
        file_key: fileKey,
        file_size: bytes?.length ?? 10,
        book_hash: bookHash,
      });
      if (bytes) objects.set(fileKey, bytes);
    },
  };
};

export type FakeServer = ReturnType<typeof fakeServer>;
