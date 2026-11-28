import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { Profile } from './config.ts';
import type { Deps } from './deps.ts';
import { AuthRequiredError, CliError, markUncertain, UsageError } from './errors.ts';
import { refresh } from './session.ts';

/** A `books` row as the sync API returns it (src/types/records.ts DBBook). */
export type DbBookRow = {
  user_id?: string;
  book_hash: string;
  meta_hash?: string | null;
  format: string;
  title: string;
  source_title?: string | null;
  original_filename?: string | null;
  author: string;
  group_id?: string | null;
  group_name?: string | null;
  group_updated_at?: string | null;
  tags?: string[] | null;
  progress?: [number, number] | null;
  reading_status?: string | null;
  reading_status_updated_at?: string | null;
  cover_hash?: string | null;
  cover_updated_at?: string | null;
  page_count?: number | null;
  metadata?: string | Record<string, unknown> | null;
  metadata_updated_at?: string | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  uploaded_at?: string | null;
  synced_at?: string | null;
};

/** A `book_notes` row (src/types/records.ts DBBookNote). */
export type DbNoteRow = {
  user_id?: string;
  book_hash: string;
  meta_hash?: string | null;
  id: string;
  type: string;
  cfi?: string | null;
  xpointer0?: string | null;
  xpointer1?: string | null;
  page?: number | null;
  text?: string | null;
  style?: string | null;
  color?: string | null;
  note?: string | null;
  global?: boolean | null;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
};

/** A `files` row from GET /api/storage/list. */
export type FileRow = {
  file_key: string;
  file_size: number;
  book_hash: string | null;
  replica_kind?: string | null;
  replica_id?: string | null;
  created_at?: string;
  updated_at?: string | null;
};

/** A book as POST /api/sync takes it: the fields transformBookToDB reads. */
export type WireBook = {
  hash: string;
  metaHash?: string | null;
  format: string;
  title: string;
  sourceTitle?: string | null;
  originalFilename?: string | null;
  author: string;
  groupId?: string | null;
  groupName?: string | null;
  groupUpdatedAt?: number | null;
  tags?: string[] | null;
  progress?: [number, number] | null;
  readingStatus?: string | null;
  readingStatusUpdatedAt?: number | null;
  coverHash?: string | null;
  coverUpdatedAt?: number | null;
  pageCount?: number | null;
  metadata?: Record<string, unknown> | null;
  metadataUpdatedAt?: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  uploadedAt: number | null;
};

/** An HTTP error response; `body` is the parsed JSON, e.g. `usage` of a quota refusal. */
export class HttpError extends CliError {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const TIMEOUT_MS = 30_000;
const PUT_TIMEOUT_MS = 600_000;

const errorField = (body: unknown): string => {
  const v = (body as Record<string, unknown> | null)?.['error'];
  return typeof v === 'string' ? v : '';
};

const parseJson = async (res: Response): Promise<unknown> => {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const arrayField = <T>(body: unknown, key: string, what: string): T[] => {
  const v = (body as Record<string, unknown> | null)?.[key];
  if (!Array.isArray(v)) throw new CliError(`unexpected response from ${what}: no ${key} array`);
  return v as T[];
};

const stringField = (body: unknown, key: string, what: string): string => {
  const v = (body as Record<string, unknown> | null)?.[key];
  if (typeof v !== 'string' || !v)
    throw new CliError(`unexpected response from ${what}: no ${key}`);
  return v;
};

export type SessionInfo = { email: string; userId: string; expiresAt: number };

export const isBookHash = (s: string) => /^[0-9a-f]{32}$/.test(s);

export class ApiClient {
  deps: Deps;
  profile: Profile;
  #token: Promise<string> | undefined;
  /** The account the run started with: a session of another one is never used. */
  #userId: string | undefined;
  #infos = new Map<string, SessionInfo>();
  #verified: SessionInfo | undefined;

  constructor(deps: Deps, profile: Profile, opts: { expectUserId?: string } = {}) {
    this.deps = deps;
    this.profile = profile;
    this.#userId = opts.expectUserId;
  }

  #session(rejectedToken?: string): Promise<string> {
    const p = refresh(this.deps, this.profile, {
      ...(rejectedToken !== undefined ? { rejectedToken } : {}),
      ...(this.#userId !== undefined ? { userId: this.#userId } : {}),
    }).then((s) => {
      this.#userId ??= s.user.id;
      this.#infos.set(s.access_token, {
        email: s.user.email,
        userId: s.user.id,
        expiresAt: s.expires_at,
      });
      return s.access_token;
    });
    this.#token = p;
    p.catch(() => {
      if (this.#token === p) this.#token = undefined;
    });
    return p;
  }

  #currentToken(): Promise<string> {
    return this.#token ?? this.#session();
  }

  /** Fails with exit 3 before any per-file work when there is no usable session. */
  async ensureAuth(): Promise<void> {
    await this.#currentToken();
  }

  /** The account of the last token the server accepted. */
  sessionInfo(): SessionInfo {
    if (!this.#verified) throw new CliError('internal: no request has passed yet');
    return this.#verified;
  }

  /** A cheap authenticated read: proves the session works on the server. */
  async ping(): Promise<void> {
    const body = await this.request('GET', '/sync', {
      query: { type: 'books', since: String(this.deps.now()) },
    });
    // A proxy's 200 page is no proof the server took the token.
    arrayField<DbBookRow>(body, 'books', 'GET /api/sync');
  }

  async request(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; retryGet?: boolean } = {},
  ): Promise<unknown> {
    const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
    const url = `${this.profile.apiBase}/api${path}${qs}`;
    const label = `${method} /api${path}`;
    const canRetry = method === 'GET' && opts.retryGet !== false;
    let refreshed = false;
    let retried = false;
    for (;;) {
      const token = await this.#currentToken();
      let res: Response;
      try {
        res = await this.deps.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          redirect: 'error',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        if (canRetry && !retried) {
          retried = true;
          continue;
        }
        const err = new CliError(`${label} failed: ${(e as Error).message}`);
        err.uncertain = method !== 'GET';
        throw err;
      }
      let body: unknown;
      try {
        body = await parseJson(res);
      } catch (e) {
        const err = new CliError(`${label} failed reading the response: ${(e as Error).message}`);
        err.uncertain = method !== 'GET';
        throw err;
      }
      if ((res.status === 401 || res.status === 403) && errorField(body) === 'Not authenticated') {
        if (refreshed) throw new AuthRequiredError();
        refreshed = true;
        await this.#session(token);
        continue;
      }
      if (res.status >= 500 && canRetry && !retried) {
        retried = true;
        continue;
      }
      if (!res.ok) {
        const detail = errorField(body);
        const err = new HttpError(
          `${label} → ${res.status}${detail ? `: ${detail}` : ''}`,
          res.status,
          body,
        );
        err.uncertain = method !== 'GET' && res.status >= 500;
        throw err;
      }
      this.#verified = this.#infos.get(token);
      return body;
    }
  }

  async pullBooks(): Promise<DbBookRow[]> {
    // No `limit`: the server pages its table itself and returns every row at once.
    const body = await this.request('GET', '/sync', { query: { type: 'books', since: '0' } });
    return arrayField<DbBookRow>(body, 'books', 'GET /api/sync');
  }

  /** The rows with this hash or, when given, this metaHash (queryTables ORs the two). */
  async pullBookRows(hash: string, metaHash?: string): Promise<DbBookRow[]> {
    const query: Record<string, string> = { type: 'books', since: '0', book: hash };
    if (metaHash) query['meta_hash'] = metaHash;
    const body = await this.request('GET', '/sync', { query });
    return arrayField<DbBookRow>(body, 'books', 'GET /api/sync');
  }

  async pullNotes(hash: string, metaHash?: string): Promise<DbNoteRow[]> {
    const query: Record<string, string> = { type: 'notes', since: '0', book: hash };
    if (metaHash) query['meta_hash'] = metaHash;
    const body = await this.request('GET', '/sync', { query });
    return arrayField<DbNoteRow>(body, 'notes', 'GET /api/sync');
  }

  async pushBooks(rows: WireBook[]): Promise<DbBookRow[]> {
    const body = await this.request('POST', '/sync', {
      body: { books: rows, notes: [], configs: [] },
    });
    try {
      return arrayField<DbBookRow>(body, 'books', 'POST /api/sync');
    } catch (e) {
      // The write was answered, but not as the server does: it may have applied.
      throw markUncertain(e);
    }
  }

  async storageList(bookHash: string): Promise<FileRow[]> {
    const body = await this.request('GET', '/storage/list', { query: { bookHash } });
    return arrayField<FileRow>(body, 'files', 'GET /api/storage/list');
  }

  /** The book's own objects: an empty bookHash would make the server list every file of the user. */
  async bookObjects(hash: string): Promise<FileRow[]> {
    if (!isBookHash(hash)) throw new UsageError(`not a book hash: "${hash}"`);
    return (await this.storageList(hash)).filter((f) => f.book_hash === hash);
  }

  /** 404 is not proof of absence: the caller re-lists to check. */
  async deleteObject(fileKey: string): Promise<'deleted' | 'missing'> {
    try {
      await this.request('DELETE', '/storage/delete', { query: { fileKey } });
      return 'deleted';
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return 'missing';
      throw e;
    }
  }

  async uploadUrl(
    fileName: string,
    fileSize: number,
    bookHash: string,
  ): Promise<{ uploadUrl: string; fileKey: string }> {
    const body = await this.request('POST', '/storage/upload', {
      body: { fileName, fileSize, bookHash },
    });
    const what = 'POST /api/storage/upload';
    return {
      uploadUrl: stringField(body, 'uploadUrl', what),
      fileKey: stringField(body, 'fileKey', what),
    };
  }

  async downloadUrl(fileKey: string): Promise<string> {
    const body = await this.request('GET', '/storage/download', { query: { fileKey } });
    return stringField(body, 'downloadUrl', 'GET /api/storage/download');
  }

  /** PUT to a presigned URL: no credentials of ours, so redirects are allowed. */
  async put(
    url: string,
    body: { path: string } | { bytes: Uint8Array },
    size: number,
  ): Promise<void> {
    const payload =
      'path' in body
        ? {
            body: Readable.toWeb(createReadStream(body.path)) as ReadableStream<Uint8Array>,
            duplex: 'half' as const,
          }
        : { body: body.bytes as Uint8Array<ArrayBuffer> };
    let res: Response;
    try {
      res = await this.deps.fetch(url, {
        method: 'PUT',
        headers: { 'Content-Length': String(size) },
        ...payload,
        signal: AbortSignal.timeout(PUT_TIMEOUT_MS),
      } as RequestInit);
    } catch (e) {
      const err = new CliError(`upload to storage failed: ${(e as Error).message}`);
      err.uncertain = true;
      throw err;
    }
    if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
      const text = await res.text().catch(() => '');
      const code = text.match(/<Code>([^<]*)<\/Code>/)?.[1];
      const err = new HttpError(
        `upload to storage → ${res.status}${code ? `: ${code}` : ''}`,
        res.status,
        text,
      );
      err.uncertain = res.status >= 500;
      throw err;
    }
    await res.body?.cancel();
  }

  /** Whether a presigned download URL serves the object, reading one byte. */
  async probeObject(url: string): Promise<'present' | 'missing'> {
    let res: Response;
    try {
      res = await this.deps.fetch(url, {
        headers: { Range: 'bytes=0-0' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new CliError(`storage check failed: ${(e as Error).message}`);
    }
    await res.body?.cancel();
    if (res.status === 200 || res.status === 206) return 'present';
    // MinIO answers 404 NoSuchKey for a missing key; a 403 may be a bad signature, not absence.
    if (res.status === 404) return 'missing';
    throw new HttpError(`storage check → ${res.status}`, res.status, null);
  }
}
