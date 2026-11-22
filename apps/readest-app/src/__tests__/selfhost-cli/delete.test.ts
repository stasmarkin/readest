import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiClient } from '../../../../../selfhost/cli/lib/api.ts';
import type { DbBookRow } from '../../../../../selfhost/cli/lib/api.ts';
import { UsageError } from '../../../../../selfhost/cli/lib/errors.ts';
import { purgeBookObjects, runDelete } from '../../../../../selfhost/cli/lib/delete.ts';
import { fakeDeps, fakeServer, json, PROFILE, UID, writeFreshSession } from './fake-server';
import type { FakeServer } from './fake-server';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'readest-cli-del-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const setup = () => {
  const server = fakeServer();
  const f = fakeDeps(server.handler, home);
  writeFreshSession(f.deps);
  return { server, api: new ApiClient(f.deps, PROFILE), ...f };
};

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const bookKey = (h: string) => `${UID}/Readest/Books/${h}/${h}.epub`;
const coverKey = (h: string) => `${UID}/Readest/Books/${h}/cover.png`;
const lockPath = () => join(home, '.config', 'readest-cli', `upload-${PROFILE.key}.lock`);
const stealLock = () =>
  writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, started: null, token: 'stolen' }));
const held = { assertHeld: () => {} };

const run = (s: ReturnType<typeof setup>, hashes: string[]) =>
  runDelete(s.deps, s.api, PROFILE, hashes);
const posts = (s: FakeServer) =>
  s.calls.filter((c) => c.method === 'POST' && c.path === '/api/sync');
const deletes = (s: FakeServer) => s.calls.filter((c) => c.method === 'DELETE');

const seedLive = (s: FakeServer, h = A) => {
  s.addBook({
    book_hash: h,
    meta_hash: 'm',
    group_id: 'g',
    group_name: 'Shelf',
    group_updated_at: '2026-01-01T00:00:00.000Z',
    progress: [3, 10],
    reading_status: 'reading',
    reading_status_updated_at: '2026-01-01T00:00:00.000Z',
    metadata: JSON.stringify({ title: 'Server title', language: 'en' }),
    uploaded_at: '2026-01-02T00:00:00.000Z',
    page_count: 12,
  });
  s.addFile(bookKey(h), h, new Uint8Array([1]));
  s.addFile(coverKey(h), h, new Uint8Array([2]));
};

/** The columns a tombstone keeps: all but its own stamps. */
const kept = (r: DbBookRow) => {
  const { deleted_at: _d, synced_at: _s, updated_at: _u, user_id: _id, ...rest } = r;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v === null || v === undefined) continue;
    out[k] = k === 'metadata' && typeof v === 'string' ? JSON.parse(v) : v;
  }
  return out;
};

describe('runDelete', () => {
  it('live book: tombstones the row as it is and removes its objects', async () => {
    const s = setup();
    seedLive(s.server);
    s.server.notes.push({ book_hash: A, id: 'n1', type: 'annotation', text: 'kept' });
    const before = kept(s.server.books.get(A)!);
    expect(await run(s, [A])).toEqual([{ hash: A, status: 'deleted' }]);
    const row = s.server.books.get(A)!;
    expect(row.deleted_at).toBeTruthy();
    expect(kept(row)).toEqual(before);
    expect(s.server.files).toEqual([]);
    expect(s.server.objects.size).toBe(0);
    expect(s.server.notes, 'notes stay').toHaveLength(1);
  });

  it('already tombstoned with objects left: removes them; a repeat writes no row', async () => {
    const s = setup();
    seedLive(s.server);
    s.server.books.set(A, { ...s.server.books.get(A)!, deleted_at: '2026-02-01T00:00:00.000Z' });
    expect(await run(s, [A])).toEqual([{ hash: A, status: 'deleted' }]);
    expect(s.server.files).toEqual([]);
    expect(posts(s.server)).toHaveLength(0);
    expect(await run(s, [A])).toEqual([{ hash: A, status: 'deleted' }]);
    expect(posts(s.server)).toHaveLength(0);
    expect(deletes(s.server)).toHaveLength(2);
  });

  it('no row but orphan objects of an interrupted upload: removed; nothing at all → skipped: missing', async () => {
    const s = setup();
    s.server.addFile(bookKey(A), A, new Uint8Array([1]));
    expect(await run(s, [A, B])).toEqual([
      { hash: A, status: 'deleted' },
      { hash: B, status: 'skipped', reason: 'missing' },
    ]);
    expect(s.server.files).toEqual([]);
    expect(posts(s.server)).toHaveLength(0);
  });

  it('a false 404 that leaves the object is an error', async () => {
    const s = setup();
    seedLive(s.server);
    s.server.setIntercept((c) =>
      c.method === 'DELETE' && c.url.searchParams.get('fileKey') === bookKey(A)
        ? json(404, { error: 'File not found' })
        : undefined,
    );
    const [r] = await run(s, [A]);
    expect(r).toMatchObject({ hash: A, status: 'error', uncertain: true });
    expect(r!.reason).toContain(bookKey(A));
  });

  it('a storage list naming another book: its file is not deleted', async () => {
    const s = setup();
    seedLive(s.server);
    s.server.addFile(bookKey(B), B, new Uint8Array([3]));
    s.server.setIntercept((c) => {
      if (c.method !== 'GET' || c.path !== '/api/storage/list') return undefined;
      return json(200, { files: s.server.files });
    });
    expect((await run(s, [A]))[0]!.status).toBe('deleted');
    expect(s.server.files.map((f) => f.file_key)).toEqual([bookKey(B)]);
  });

  it('every hash is checked before any request', async () => {
    const s = setup();
    await expect(run(s, [A, 'nope'])).rejects.toBeInstanceOf(UsageError);
    expect(s.server.calls).toHaveLength(0);
  });

  it('a lock lost between two DELETEs: the item is an uncertain error, no second DELETE', async () => {
    const s = setup();
    seedLive(s.server);
    seedLive(s.server, B);
    s.server.setIntercept((c) => {
      if (c.method === 'DELETE') stealLock();
      return undefined;
    });
    const results = await run(s, [A, B]);
    expect(results).toEqual([
      { hash: A, status: 'error', reason: expect.stringMatching(/lock lost/), uncertain: true },
    ]);
    expect(deletes(s.server)).toHaveLength(1);
  });

  it('a POST lost on the network but applied is a success; one that did not apply is uncertain', async () => {
    const s = setup();
    seedLive(s.server);
    s.server.setIntercept((c) => {
      if (c.method !== 'POST' || c.path !== '/api/sync') return undefined;
      const row = s.server.books.get(A)!;
      s.server.books.set(A, { ...row, deleted_at: new Date().toISOString() });
      return 'throw';
    });
    expect(await run(s, [A])).toEqual([{ hash: A, status: 'deleted' }]);

    const t = setup();
    seedLive(t.server);
    t.server.setIntercept((c) =>
      c.method === 'POST' && c.path === '/api/sync' ? 'throw' : undefined,
    );
    const [r] = await run(t, [A]);
    expect(r).toMatchObject({ status: 'error', uncertain: true });
    expect(r!.reason).toMatch(/sync not confirmed/);
    expect(t.server.files, 'objects stay while the row is live').toHaveLength(2);
  });
});

describe('runDelete after the tombstone', () => {
  it('a POST answer without the row is checked by a read', async () => {
    const s = setup();
    seedLive(s.server);
    s.server.setIntercept((c) => {
      if (c.method !== 'POST' || c.path !== '/api/sync') return undefined;
      s.server.books.set(A, { ...s.server.books.get(A)!, deleted_at: new Date().toISOString() });
      return json(200, { books: [], notes: [], configs: [] });
    });
    expect(await run(s, [A])).toEqual([{ hash: A, status: 'deleted' }]);
  });

  it('a failed cleanup after the row is tombstoned is uncertain', async () => {
    const s = setup();
    seedLive(s.server);
    s.server.setIntercept((c) =>
      c.method === 'GET' && c.path === '/api/storage/list'
        ? json(500, { error: 'db down' })
        : undefined,
    );
    const [r] = await run(s, [A]);
    expect(s.server.books.get(A)!.deleted_at).toBeTruthy();
    expect(r).toMatchObject({ status: 'error', uncertain: true });
  });
});

describe('purgeBookObjects', () => {
  it('checks the lock before every DELETE', async () => {
    const s = setup();
    seedLive(s.server);
    let checks = 0;
    await purgeBookObjects(s.api, A, {
      assertHeld: () => {
        checks++;
      },
    });
    expect(checks).toBe(2);
    await expect(purgeBookObjects(s.api, A, held)).resolves.toBeUndefined();
  });
});
