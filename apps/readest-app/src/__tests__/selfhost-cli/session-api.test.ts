import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Deps } from '../../../../../selfhost/cli/lib/deps.ts';
import { AuthRequiredError, CliError, UsageError } from '../../../../../selfhost/cli/lib/errors.ts';
import { resolveProfile } from '../../../../../selfhost/cli/lib/config.ts';
import type { Profile } from '../../../../../selfhost/cli/lib/config.ts';
import { withLock } from '../../../../../selfhost/cli/lib/lock.ts';
import {
  ensureSession,
  login,
  logout,
  refresh,
  sessionPath,
} from '../../../../../selfhost/cli/lib/session.ts';
import type { Session } from '../../../../../selfhost/cli/lib/session.ts';
import { ApiClient, HttpError } from '../../../../../selfhost/cli/lib/api.ts';
import type { WireBook } from '../../../../../selfhost/cli/lib/api.ts';
import {
  API as FAKE_API,
  PROFILE as FAKE_PROFILE,
  UID as FAKE_UID,
  fakeDeps as serverDeps,
  fakeServer,
  writeFreshSession,
} from './fake-server';

// ------------------------------------------------------------------ fakes

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
type Call = { method: string; url: URL; init: RequestInit };

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'readest-cli-sess-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * `timeFlows`: sleep advances the fake clock (lock-timing tests). Otherwise sleep
 * only yields, so a lock's heartbeat cannot age a session while a test runs.
 */
const fakeDeps = (
  handler: Handler = () => json(404, { error: 'no route' }),
  over: Partial<Deps> = {},
  timeFlows = false,
) => {
  // Whole seconds keep expires_at arithmetic exact.
  let clock = Math.floor(Date.now() / 1000) * 1000;
  const calls: Call[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: Deps = {
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ method: init.method ?? 'GET', url, init });
      return handler(url, init);
    }) as typeof fetch,
    now: () => clock,
    env: {},
    homeDir: home,
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    isTTY: false,
    readSecret: async () => '',
    sleep: async (ms) => {
      if (timeFlows) clock += ms;
      await new Promise((r) => setImmediate(r));
    },
    isAlive: (pid) => pid === process.pid,
    processStart: async (pid) => (pid === process.pid ? 'Mon Jan  1 00:00:00 2024' : null),
    loadCfi: async () => {
      throw new CliError('no cfi');
    },
    ...over,
  };
  return {
    deps,
    calls,
    out,
    err,
    advance: (ms: number) => {
      clock += ms;
    },
    setClock: (ms: number) => {
      clock = ms;
    },
  };
};

const PROFILE: Profile = {
  apiBase: 'http://localhost:3000',
  supabaseUrl: 'http://localhost:8000',
  anonKey: 'anon',
  key: 'localhost_3000-deadbeef',
};

const session = (nowMs: number, over: Partial<Session> = {}): Session => ({
  access_token: 'at-1',
  refresh_token: 'rt-1',
  expires_in: 3600,
  expires_at: Math.floor(nowMs / 1000) + 3600,
  user: { id: 'uid-1', email: 'me@example.com' },
  ...over,
});

const writeSession = (deps: Deps, s: Session) => {
  const path = sessionPath(deps, PROFILE);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(s), { mode: 0o600 });
  return path;
};

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const tokenResponse = (n: number, nowMs: number) =>
  json(200, {
    access_token: `at-${n}`,
    refresh_token: `rt-${n}`,
    expires_in: 3600,
    expires_at: Math.floor(nowMs / 1000) + 3600,
    user: { id: 'uid-1', email: 'me@example.com' },
  });

// ------------------------------------------------------------------ profile

describe('resolveProfile', () => {
  it('three variables give a profile without network, http allowed', async () => {
    const f = fakeDeps();
    f.deps.env = {
      READEST_API_URL: 'http://localhost:3000/',
      READEST_SUPABASE_URL: 'http://127.0.0.1:8000',
      READEST_ANON_KEY: 'anon',
    };
    const p = await resolveProfile(f.deps);
    expect(p.apiBase).toBe('http://localhost:3000');
    expect(p.supabaseUrl).toBe('http://127.0.0.1:8000');
    expect(p.anonKey).toBe('anon');
    expect(p.key).toMatch(/^localhost_3000-[0-9a-f]{8}$/);
    expect(f.calls).toHaveLength(0);
  });

  it('two of three variables is an error', async () => {
    const f = fakeDeps();
    f.deps.env = { READEST_API_URL: 'http://a', READEST_ANON_KEY: 'k' };
    await expect(resolveProfile(f.deps)).rejects.toThrow(CliError);
    expect(f.calls).toHaveLength(0);
  });

  const wellKnown = (body: unknown, raw?: string) =>
    fakeDeps(() => new Response(raw ?? JSON.stringify(body), { status: 200 }));

  it('reads the well-known config from the default server', async () => {
    const f = wellKnown({
      apiBaseUrl: 'https://readest.stasmarkin.ru',
      supabaseUrl: 'https://readest.stasmarkin.ru/',
      supabaseAnonKey: 'anon',
    });
    const p = await resolveProfile(f.deps);
    expect(f.calls[0]!.url.href).toBe(
      'https://readest.stasmarkin.ru/.well-known/readest-client-config.json',
    );
    expect(p).toEqual({
      apiBase: 'https://readest.stasmarkin.ru',
      supabaseUrl: 'https://readest.stasmarkin.ru',
      anonKey: 'anon',
      key: expect.stringMatching(/^readest\.stasmarkin\.ru-[0-9a-f]{8}$/),
    });
  });

  it.each([
    [
      'foreign apiBaseUrl',
      {
        apiBaseUrl: 'https://evil.example.org',
        supabaseUrl: 'https://r.example.org',
        supabaseAnonKey: 'k',
      },
    ],
    [
      'foreign supabaseUrl',
      {
        apiBaseUrl: 'https://r.example.org',
        supabaseUrl: 'https://x.supabase.co',
        supabaseAnonKey: 'k',
      },
    ],
    [
      'http apiBaseUrl',
      {
        apiBaseUrl: 'http://r.example.org',
        supabaseUrl: 'https://r.example.org',
        supabaseAnonKey: 'k',
      },
    ],
    [
      'empty anon key',
      {
        apiBaseUrl: 'https://r.example.org',
        supabaseUrl: 'https://r.example.org',
        supabaseAnonKey: '  ',
      },
    ],
    ['missing field', { apiBaseUrl: 'https://r.example.org', supabaseAnonKey: 'k' }],
  ])('rejects %s', async (_name, body) => {
    const f = wellKnown(body);
    f.deps.env = { READEST_URL: 'https://r.example.org' };
    await expect(resolveProfile(f.deps)).rejects.toThrow(CliError);
  });

  it('rejects READEST_URL over http', async () => {
    const f = wellKnown({
      apiBaseUrl: 'http://r.example.org',
      supabaseUrl: 'http://r.example.org',
      supabaseAnonKey: 'k',
    });
    f.deps.env = { READEST_URL: 'http://r.example.org' };
    await expect(resolveProfile(f.deps)).rejects.toThrow(/https/);
    expect(f.calls).toHaveLength(0);
  });

  it('rejects a non-JSON well-known response', async () => {
    const f = wellKnown(null, '<html>not json</html>');
    await expect(resolveProfile(f.deps)).rejects.toThrow(/readest-client-config/);
  });

  it('different supabaseUrl on one host gives different keys', async () => {
    const f = fakeDeps();
    f.deps.env = {
      READEST_API_URL: 'http://h:1',
      READEST_SUPABASE_URL: 'http://h:2',
      READEST_ANON_KEY: 'k',
    };
    const a = await resolveProfile(f.deps);
    f.deps.env = {
      READEST_API_URL: 'http://h:1',
      READEST_SUPABASE_URL: 'http://h:3',
      READEST_ANON_KEY: 'k',
    };
    const b = await resolveProfile(f.deps);
    expect(a.key).not.toBe(b.key);
  });
});

// ------------------------------------------------------------------ lock

describe('withLock', () => {
  const lockPath = () => join(home, 'x.lock');

  it('serializes two holders in one process', async () => {
    const f = fakeDeps(undefined, {}, true);
    const events: string[] = [];
    const gate = deferred<void>();
    const aStarted = deferred<void>();
    const a = withLock(
      lockPath(),
      { waitMs: null },
      async () => {
        events.push('a:start');
        aStarted.resolve();
        await gate.promise;
        events.push('a:end');
      },
      f.deps,
    );
    await aStarted.promise;
    const b = withLock(
      lockPath(),
      { waitMs: null },
      async () => {
        events.push('b:start');
        events.push('b:end');
      },
      f.deps,
    );
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(events).toEqual(['a:start']);
    gate.resolve();
    await Promise.all([a, b]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    expect(existsSync(lockPath())).toBe(false);
  });

  it('publishes {pid, started, token} by link and removes orphan tmp files', async () => {
    const f = fakeDeps(undefined, {}, true);
    const orphan = `${lockPath()}.999999.dead.tmp`;
    writeFileSync(orphan, '{}');
    await withLock(
      lockPath(),
      { waitMs: 0 },
      async () => {
        const content = JSON.parse(readFileSync(lockPath(), 'utf8'));
        expect(content.pid).toBe(process.pid);
        expect(content.started).toBe('Mon Jan  1 00:00:00 2024');
        expect(content.token).toMatch(/^[0-9a-f-]{36}$/);
        expect(statSync(lockPath()).nlink).toBe(1);
        expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
      },
      f.deps,
    );
  });

  const staleLock = (pid: number, started: string | null, token = 'stale-token') =>
    writeFileSync(lockPath(), JSON.stringify({ pid, started, token }));

  it('takes over a lock of a dead pid', async () => {
    const f = fakeDeps(undefined, {}, true);
    staleLock(424242, 'whenever');
    let ran = false;
    await withLock(
      lockPath(),
      { waitMs: 0 },
      async () => {
        ran = true;
      },
      f.deps,
    );
    expect(ran).toBe(true);
  });

  it('takes over a lock of a reused pid with another start time', async () => {
    const f = fakeDeps(
      undefined,
      {
        isAlive: () => true,
        processStart: async (pid) =>
          pid === 777 ? 'Tue Feb  2 00:00:00 2024' : 'Mon Jan  1 00:00:00 2024',
      },
      true,
    );
    staleLock(777, 'Sun Dec 31 00:00:00 2023');
    await expect(withLock(lockPath(), { waitMs: 0 }, async () => 'ok', f.deps)).resolves.toBe('ok');
  });

  it('takes over a live but hung owner whose mtime is older than 30 s', async () => {
    const f = fakeDeps(
      undefined,
      {
        isAlive: () => true,
        processStart: async () => 'Mon Jan  1 00:00:00 2024',
      },
      true,
    );
    staleLock(777, 'Mon Jan  1 00:00:00 2024');
    const t = (f.deps.now() - 31_000) / 1000;
    utimesSync(lockPath(), t, t);
    await expect(withLock(lockPath(), { waitMs: 0 }, async () => 'ok', f.deps)).resolves.toBe('ok');
  });

  it('does not take the lock from a live owner that keeps a heartbeat', async () => {
    const f = fakeDeps(undefined, {}, true);
    const gate = deferred<void>();
    const ownerIn = deferred<void>();
    const owner = withLock(
      lockPath(),
      { waitMs: null },
      () => {
        ownerIn.resolve();
        return gate.promise;
      },
      f.deps,
    );
    await ownerIn.promise;
    const start = f.deps.now();
    let waiterRan = false;
    const waiter = withLock(
      lockPath(),
      { waitMs: 60_000 },
      async () => {
        waiterRan = true;
      },
      f.deps,
    );
    await expect(waiter).rejects.toThrow(/held by/);
    expect(f.deps.now() - start).toBeGreaterThanOrEqual(60_000);
    expect(waiterRan).toBe(false);
    gate.resolve();
    await owner;
  });

  it('a stale lock removed under the first claimant makes its assertHeld fail', async () => {
    const f = fakeDeps(undefined, {}, true);
    staleLock(424242, 'x', 'stale-token');
    // The second claimant read the stale token, then was delayed before unlink.
    const seen = JSON.parse(readFileSync(lockPath(), 'utf8')).token;
    expect(seen).toBe('stale-token');
    const writes: string[] = [];
    const run = withLock(
      lockPath(),
      { waitMs: 0 },
      async (held) => {
        // ...it now wakes up, unlinks what it thinks is the stale lock and publishes its own.
        unlinkSync(lockPath());
        writeFileSync(
          `${lockPath()}.2.tmp`,
          JSON.stringify({ pid: 2, started: 'y', token: 'second' }),
        );
        linkSync(`${lockPath()}.2.tmp`, lockPath());
        unlinkSync(`${lockPath()}.2.tmp`);
        held.assertHeld();
        writes.push('write');
      },
      f.deps,
    );
    await expect(run).rejects.toThrow(/lock lost/);
    expect(writes).toEqual([]);
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('second');
  });

  it('a lock taken over after fn succeeded: warns, keeps the result and the other lock', async () => {
    const f = fakeDeps(undefined, {}, true);
    const run = withLock(
      lockPath(),
      { waitMs: 0, label: 'upload lock' },
      async () => {
        writeFileSync(lockPath(), JSON.stringify({ pid: 2, started: 'y', token: 'other' }));
        return 'done';
      },
      f.deps,
    );
    await expect(run).resolves.toBe('done');
    expect(f.err.join('')).toContain('upload lock was taken over by another process');
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('other');
  });

  it('a claimant that sees a fresh token on re-read does not unlink it', async () => {
    const replaced = deferred<void>();
    const f = fakeDeps(
      undefined,
      {
        isAlive: () => true,
        processStart: async (pid) => {
          if (
            pid === 424242 &&
            existsSync(lockPath()) &&
            readFileSync(lockPath(), 'utf8').includes('424242')
          ) {
            // While this claimant checks the stale owner, another one takes over.
            unlinkSync(lockPath());
            writeFileSync(
              lockPath(),
              JSON.stringify({
                pid: process.pid,
                started: 'Mon Jan  1 00:00:00 2024',
                token: 'other',
              }),
            );
            replaced.resolve();
            return 'reused pid';
          }
          return 'Mon Jan  1 00:00:00 2024';
        },
      },
      true,
    );
    staleLock(424242, 'x');
    await expect(withLock(lockPath(), { waitMs: 1000 }, async () => 'ran', f.deps)).rejects.toThrow(
      /held by/,
    );
    await replaced.promise;
    expect(JSON.parse(readFileSync(lockPath(), 'utf8')).token).toBe('other');
  });

  it('gives up after waitMs on a live owner', async () => {
    const f = fakeDeps(undefined, { isAlive: () => true, processStart: async () => 'same' }, true);
    staleLock(31337, 'same');
    const p = withLock(lockPath(), { waitMs: 15_000 }, async () => 'never', f.deps);
    await expect(p).rejects.toThrow(`held by 31337 (${lockPath()})`);
  });

  it('waitMs null waits and calls onWait every 30 s', async () => {
    const f = fakeDeps(
      undefined,
      {
        isAlive: (pid) => {
          // The foreign owner is alive and keeps its heartbeat.
          if (pid === 31337 && existsSync(lockPath())) {
            const t = f.deps.now() / 1000;
            utimesSync(lockPath(), t, t);
          }
          return true;
        },
        processStart: async () => 'same',
      },
      true,
    );
    staleLock(31337, 'same');
    const waits: number[] = [];
    const start = f.deps.now();
    const p = withLock(
      lockPath(),
      {
        waitMs: null,
        onWait: (pid) => {
          waits.push(pid);
          if (f.deps.now() - start >= 90_000) unlinkSync(lockPath());
        },
      },
      async () => 'got it',
      f.deps,
    );
    await expect(p).resolves.toBe('got it');
    expect(waits).toEqual([31337, 31337, 31337, 31337]);
  });
});

// ------------------------------------------------------------------ session

const authRoutes = (opts: { onRefresh?: () => Response | Promise<Response> } = {}) => {
  let n = 1;
  const handler: Handler = (url, init) => {
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      return tokenResponse(n++, Date.now());
    }
    if (
      url.pathname === '/auth/v1/token' &&
      url.searchParams.get('grant_type') === 'refresh_token'
    ) {
      if (opts.onRefresh) return opts.onRefresh();
      return tokenResponse(++n, Date.now());
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    void init;
    return json(404, { error: 'no route' });
  };
  return handler;
};

describe('session', () => {
  it('login writes a 600 file in a 700 directory, atomically', async () => {
    const f = fakeDeps(authRoutes());
    const s = await login(f.deps, PROFILE, 'me@example.com', 'secret');
    const path = sessionPath(f.deps, PROFILE);
    expect(path).toBe(join(home, '.config', 'readest-cli', `session-${PROFILE.key}.json`));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(path)).filter((n) => n.includes('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(s);
    const call = f.calls[0]!;
    expect(call.url.href).toBe('http://localhost:8000/auth/v1/token?grant_type=password');
    expect(call.init.redirect).toBe('error');
    expect(new Headers(call.init.headers).get('apikey')).toBe('anon');
    expect(JSON.parse(String(call.init.body))).toEqual({
      email: 'me@example.com',
      password: 'secret',
    });
    expect(readFileSync(path, 'utf8')).not.toContain('secret');
  });

  it('wrong password → AuthRequiredError', async () => {
    const f = fakeDeps(() =>
      json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' }),
    );
    await expect(login(f.deps, PROFILE, 'me@example.com', 'bad')).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it('refreshes only when less than half the TTL remains', async () => {
    const f = fakeDeps(authRoutes());
    const now = f.deps.now();
    writeSession(
      f.deps,
      session(f.deps.now(), { expires_at: now / 1000 + 1800, expires_in: 3600 }),
    );
    const same = await ensureSession(f.deps, PROFILE);
    expect(same.access_token).toBe('at-1');
    expect(f.calls).toHaveLength(0);

    writeSession(
      f.deps,
      session(f.deps.now(), { expires_at: now / 1000 + 1799, expires_in: 3600 }),
    );
    const fresh = await ensureSession(f.deps, PROFILE);
    expect(fresh.access_token).not.toBe('at-1');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.init.redirect).toBe('error');
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ refresh_token: 'rt-1' });
    const saved = JSON.parse(readFileSync(sessionPath(f.deps, PROFILE), 'utf8'));
    expect(saved.access_token).toBe(fresh.access_token);
    expect(saved.refresh_token).toBe(fresh.refresh_token);
  });

  it('two parallel ensureSession calls refresh once', async () => {
    const f = fakeDeps(authRoutes());
    writeSession(f.deps, session(f.deps.now(), { expires_at: f.deps.now() / 1000 + 10 }));
    const [a, b] = await Promise.all([
      ensureSession(f.deps, PROFILE),
      ensureSession(f.deps, PROFILE),
    ]);
    expect(f.calls.filter((c) => c.url.pathname === '/auth/v1/token')).toHaveLength(1);
    expect(a.access_token).toBe(b.access_token);
  });

  it('refresh 400 → AuthRequiredError', async () => {
    const f = fakeDeps(authRoutes({ onRefresh: () => json(400, { error: 'invalid_grant' }) }));
    writeSession(f.deps, session(f.deps.now(), { expires_at: f.deps.now() / 1000 + 10 }));
    await expect(ensureSession(f.deps, PROFILE)).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('refresh network error → CliError(1), file untouched', async () => {
    const f = fakeDeps(
      authRoutes({
        onRefresh: () => {
          throw new TypeError('fetch failed');
        },
      }),
    );
    const path = writeSession(
      f.deps,
      session(f.deps.now(), { expires_at: f.deps.now() / 1000 + 10 }),
    );
    const before = readFileSync(path, 'utf8');
    const err = await ensureSession(f.deps, PROFILE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect(err).not.toBeInstanceOf(AuthRequiredError);
    expect((err as CliError).exitCode).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('refresh 500 → CliError(1)', async () => {
    const f = fakeDeps(authRoutes({ onRefresh: () => json(502, { error: 'bad gateway' }) }));
    writeSession(f.deps, session(f.deps.now(), { expires_at: f.deps.now() / 1000 + 10 }));
    const err = await ensureSession(f.deps, PROFILE).catch((e: unknown) => e);
    expect((err as CliError).exitCode).toBe(1);
  });

  it('logout waiting behind a refresh removes the file; the next ensureSession needs login', async () => {
    const gate = deferred<Response>();
    const refreshStarted = deferred<void>();
    const f = fakeDeps(
      authRoutes({
        onRefresh: () => {
          refreshStarted.resolve();
          return gate.promise;
        },
      }),
    );
    writeSession(f.deps, session(f.deps.now(), { expires_at: f.deps.now() / 1000 + 10 }));
    const r = ensureSession(f.deps, PROFILE);
    await refreshStarted.promise;
    const out = logout(f.deps, PROFILE);
    gate.resolve(tokenResponse(9, Date.now()));
    await r;
    await out;
    expect(existsSync(sessionPath(f.deps, PROFILE))).toBe(false);
    await expect(ensureSession(f.deps, PROFILE)).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('logout with a failing fetch still removes the file', async () => {
    const f = fakeDeps(() => {
      throw new TypeError('fetch failed');
    });
    writeSession(f.deps, session(f.deps.now()));
    await expect(logout(f.deps, PROFILE)).resolves.toBeUndefined();
    expect(existsSync(sessionPath(f.deps, PROFILE))).toBe(false);
  });

  it('logout posts to GoTrue with the bearer token, without redirects', async () => {
    const f = fakeDeps(authRoutes());
    writeSession(f.deps, session(f.deps.now()));
    await logout(f.deps, PROFILE);
    const call = f.calls.find((c) => c.url.pathname === '/auth/v1/logout')!;
    expect(call.method).toBe('POST');
    expect(call.url.origin).toBe('http://localhost:8000');
    expect(call.url.searchParams.get('scope'), 'signs out this device only').toBe('local');
    expect(new Headers(call.init.headers).get('authorization')).toBe('Bearer at-1');
    expect(call.init.redirect).toBe('error');
  });

  it('refresh with rejectedToken refreshes only if the token is still current', async () => {
    const f = fakeDeps(authRoutes());
    writeSession(f.deps, session(f.deps.now()));
    const kept = await refresh(f.deps, PROFILE, { rejectedToken: 'at-old' });
    expect(kept.access_token).toBe('at-1');
    expect(f.calls).toHaveLength(0);
    const fresh = await refresh(f.deps, PROFILE, { rejectedToken: 'at-1' });
    expect(fresh.access_token).not.toBe('at-1');
    expect(f.calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ ApiClient

const apiDeps = (api: Handler, onRefresh?: () => Response | Promise<Response>) => {
  const auth = authRoutes(onRefresh ? { onRefresh } : {});
  const f = fakeDeps((url, init) => (url.port === '8000' ? auth(url, init) : api(url, init)));
  writeSession(f.deps, session(f.deps.now()));
  return f;
};

const bearer = (init: RequestInit) => new Headers(init.headers).get('authorization');

describe('ApiClient', () => {
  it('403 Not authenticated → refresh and retry; a second 403 → AuthRequiredError', async () => {
    const f = apiDeps((_url, init) =>
      bearer(init) === 'Bearer at-1'
        ? json(403, { error: 'Not authenticated' })
        : json(200, { books: [] }),
    );
    const api = new ApiClient(f.deps, PROFILE);
    await expect(api.pullBooks()).resolves.toEqual([]);
    expect(f.calls.filter((c) => c.url.pathname === '/auth/v1/token')).toHaveLength(1);

    const g = apiDeps(() => json(403, { error: 'Not authenticated' }));
    await expect(new ApiClient(g.deps, PROFILE).pullBooks()).rejects.toBeInstanceOf(
      AuthRequiredError,
    );
  });

  it('two parallel 403s on one token refresh once and both retry with the new token', async () => {
    const f = apiDeps((_url, init) =>
      bearer(init) === 'Bearer at-1'
        ? json(403, { error: 'Not authenticated' })
        : json(200, { books: [] }),
    );
    const api = new ApiClient(f.deps, PROFILE);
    await Promise.all([api.pullBooks(), api.pullBooks()]);
    expect(f.calls.filter((c) => c.url.pathname === '/auth/v1/token')).toHaveLength(1);
    const retried = f.calls.filter(
      (c) => c.url.pathname === '/api/sync' && bearer(c.init) !== 'Bearer at-1',
    );
    expect(retried).toHaveLength(2);
  });

  it('GET 502 is retried once; POST 502 is not', async () => {
    let gets = 0;
    let posts = 0;
    const f = apiDeps((_url, init) => {
      if ((init.method ?? 'GET') === 'GET')
        return ++gets === 1 ? json(502, { error: 'bad' }) : json(200, { books: [] });
      posts++;
      return json(502, { error: 'bad gateway' });
    });
    const api = new ApiClient(f.deps, PROFILE);
    await expect(api.pullBooks()).resolves.toEqual([]);
    expect(gets).toBe(2);
    await expect(api.pushBooks([])).rejects.toThrow(CliError);
    expect(posts).toBe(1);
  });

  it('a GET that keeps failing is retried only once', async () => {
    let gets = 0;
    const f = apiDeps(() => {
      gets++;
      throw new TypeError('fetch failed');
    });
    await expect(new ApiClient(f.deps, PROFILE).pullBooks()).rejects.toThrow(CliError);
    expect(gets).toBe(2);
  });

  it('passes a 30 s timeout to requests and 10 min to put', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');
    const f = apiDeps(() => json(200, { books: [] }));
    const api = new ApiClient(f.deps, PROFILE);
    await api.pullBooks();
    const syncCall = f.calls.find((c) => c.url.pathname === '/api/sync')!;
    const idx30 = spy.mock.calls.findIndex((c) => c[0] === 30_000);
    expect(idx30).toBeGreaterThanOrEqual(0);
    expect(syncCall.init.signal).toBe(spy.mock.results[idx30]!.value);
    expect(syncCall.init.redirect).toBe('error');

    const g = fakeDeps(() => new Response(null, { status: 200 }));
    await new ApiClient(g.deps, PROFILE).put(
      'https://s3.example/obj?sig=1',
      { bytes: new Uint8Array(3) },
      3,
    );
    const idx600 = spy.mock.calls.findIndex((c) => c[0] === 600_000);
    expect(idx600).toBeGreaterThanOrEqual(0);
    expect(g.calls[0]!.init.signal).toBe(spy.mock.results[idx600]!.value);
  });

  it('put streams a file or sends bytes with an exact Content-Length and no Authorization', async () => {
    const path = join(home, 'book.epub');
    writeFileSync(path, 'x'.repeat(1234));
    const received: Array<{
      len: string | null;
      auth: string | null;
      body: unknown;
      duplex: unknown;
    }> = [];
    const f = fakeDeps((_url, init) => {
      const h = new Headers(init.headers);
      received.push({
        len: h.get('content-length'),
        auth: h.get('authorization'),
        body: init.body,
        duplex: (init as RequestInit & { duplex?: string }).duplex,
      });
      return new Response(null, { status: 200 });
    });
    writeSession(f.deps, session(f.deps.now()));
    const api = new ApiClient(f.deps, PROFILE);
    await api.put('https://s3.example/a', { path }, 1234);
    await api.put('https://s3.example/b', { bytes: new Uint8Array([1, 2, 3]) }, 3);
    expect(received[0]!.len).toBe('1234');
    expect(received[0]!.auth).toBeNull();
    expect(received[0]!.duplex).toBe('half');
    expect(typeof (received[0]!.body as ReadableStream).getReader).toBe('function');
    const chunks: Uint8Array[] = [];
    for await (const c of received[0]!.body as ReadableStream<Uint8Array>) chunks.push(c);
    expect(Buffer.concat(chunks).toString()).toBe('x'.repeat(1234));
    expect(received[1]!.len).toBe('3');
    expect(received[1]!.auth).toBeNull();
    expect(Array.from(received[1]!.body as Uint8Array)).toEqual([1, 2, 3]);
    expect(f.calls.every((c) => c.url.hostname === 's3.example')).toBe(true);
  });

  it('error messages carry method, path without query, status and error, never the token', async () => {
    const f = apiDeps(() => json(500, { error: 'database exploded' }));
    const err = await new ApiClient(f.deps, PROFILE)
      .request('POST', '/storage/upload', { query: { secret: 'q' }, body: { a: 1 } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    const msg = (err as Error).message;
    expect(msg).toContain('POST');
    expect(msg).toContain('/api/storage/upload');
    expect(msg).toContain('500');
    expect(msg).toContain('database exploded');
    expect(msg).not.toContain('secret');
    expect(msg).not.toContain('at-1');
  });

  it.each([
    [200, 'present'],
    [206, 'present'],
    [404, 'missing'],
  ])('probeObject %i → %s', async (status, expected) => {
    const f = fakeDeps(
      () => new Response(status === 206 || status === 200 ? 'x' : null, { status }),
    );
    const r = await new ApiClient(f.deps, PROFILE).probeObject('https://s3.example/obj?sig=1');
    expect(r).toBe(expected);
    expect(new Headers(f.calls[0]!.init.headers).get('range')).toBe('bytes=0-0');
    expect(new Headers(f.calls[0]!.init.headers).get('authorization')).toBeNull();
  });

  it.each([403, 500])('probeObject %i → CliError, not "missing"', async (status) => {
    const f = fakeDeps(() => new Response(null, { status }));
    await expect(
      new ApiClient(f.deps, PROFILE).probeObject('https://s3.example/o'),
    ).rejects.toThrow(CliError);
  });

  it('a 403 after another account logged in → exit 3, never retried as that account', async () => {
    const f = apiDeps((_url, init) => {
      if (bearer(init) !== 'Bearer at-1') return json(200, { books: [] });
      writeSession(
        f.deps,
        session(f.deps.now(), {
          access_token: 'at-2',
          refresh_token: 'rt-2',
          user: { id: 'uid-2', email: 'other@example.com' },
        }),
      );
      return json(403, { error: 'Not authenticated' });
    });
    const err = await new ApiClient(f.deps, PROFILE).pullBooks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).exitCode).toBe(3);
    expect((err as Error).message).toMatch(/another account/);
    const asOther = f.calls.filter(
      (c) => c.url.pathname === '/api/sync' && bearer(c.init) === 'Bearer at-2',
    );
    expect(asOther, 'no request as the other account').toHaveLength(0);
  });

  it('a failed token refresh is not reused by later requests', async () => {
    let fail = true;
    const f = apiDeps(
      () => json(200, { books: [] }),
      () => (fail ? json(502, { error: 'bad gateway' }) : tokenResponse(2, Date.now())),
    );
    writeSession(f.deps, session(f.deps.now(), { expires_at: f.deps.now() / 1000 + 10 }));
    const api = new ApiClient(f.deps, PROFILE);
    await expect(api.pullBooks()).rejects.toThrow(CliError);
    fail = false;
    await expect(api.pullBooks(), 'the second call refreshes again').resolves.toEqual([]);
  });

  it('pullBookRows reads only the rows of one book', async () => {
    const f = apiDeps(() => json(200, { books: [] }));
    const api = new ApiClient(f.deps, PROFILE);
    await api.pullBookRows('h1', 'm1');
    await api.pullBookRows('h1', '');
    const qs = f.calls
      .filter((c) => c.url.pathname === '/api/sync')
      .map((c) => Object.fromEntries(c.url.searchParams));
    expect(qs).toEqual([
      { type: 'books', since: '0', book: 'h1', meta_hash: 'm1' },
      { type: 'books', since: '0', book: 'h1' },
    ]);
  });

  it('probeObject network error → CliError', async () => {
    const g = fakeDeps(() => {
      throw new TypeError('fetch failed');
    });
    await expect(
      new ApiClient(g.deps, PROFILE).probeObject('https://s3.example/o'),
    ).rejects.toThrow(CliError);
  });

  it('pullBooks is one type=books&since=0 request without limit', async () => {
    const rows = [{ book_hash: 'a', title: 'A', author: '', format: 'EPUB' }];
    const f = apiDeps(() => json(200, { books: rows, notes: [], configs: [] }));
    await expect(new ApiClient(f.deps, PROFILE).pullBooks()).resolves.toEqual(rows);
    const calls = f.calls.filter((c) => c.url.pathname === '/api/sync');
    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ type: 'books', since: '0' });
    expect(bearer(calls[0]!.init)).toBe('Bearer at-1');
  });

  it('pullNotes adds meta_hash only when it is non-empty', async () => {
    const f = apiDeps(() => json(200, { notes: [] }));
    const api = new ApiClient(f.deps, PROFILE);
    await api.pullNotes('h1', '');
    await api.pullNotes('h1', undefined);
    await api.pullNotes('h1', 'm1');
    const qs = f.calls
      .filter((c) => c.url.pathname === '/api/sync')
      .map((c) => Object.fromEntries(c.url.searchParams));
    expect(qs).toEqual([
      { type: 'notes', since: '0', book: 'h1' },
      { type: 'notes', since: '0', book: 'h1' },
      { type: 'notes', since: '0', book: 'h1', meta_hash: 'm1' },
    ]);
  });

  it('storage endpoints', async () => {
    const f = apiDeps((url, init) => {
      if (url.pathname === '/api/storage/list')
        return json(200, { files: [{ file_key: 'k', file_size: 1, book_hash: 'h' }] });
      if (url.pathname === '/api/storage/upload') {
        expect(JSON.parse(String(init.body))).toEqual({
          fileName: 'Readest/Books/h/h.epub',
          fileSize: 10,
          bookHash: 'h',
        });
        return json(200, {
          uploadUrl: 'https://s3.example/up',
          fileKey: 'uid/Readest/Books/h/h.epub',
        });
      }
      if (url.pathname === '/api/storage/download')
        return json(200, {
          downloadUrl: `https://s3.example/dl?k=${url.searchParams.get('fileKey')}`,
        });
      if (url.pathname === '/api/sync' && init.method === 'POST')
        return json(200, { books: JSON.parse(String(init.body)).books });
      return json(404, {});
    });
    const api = new ApiClient(f.deps, PROFILE);
    expect(await api.storageList('h')).toEqual([{ file_key: 'k', file_size: 1, book_hash: 'h' }]);
    expect(await api.uploadUrl('Readest/Books/h/h.epub', 10, 'h')).toEqual({
      uploadUrl: 'https://s3.example/up',
      fileKey: 'uid/Readest/Books/h/h.epub',
    });
    expect(await api.downloadUrl('uid/a&b.epub')).toBe('https://s3.example/dl?k=uid/a&b.epub');
    const pushed = await api.pushBooks([
      {
        hash: 'h',
        format: 'EPUB',
        title: 't',
        author: '',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        uploadedAt: 1,
      },
    ]);
    expect(pushed).toEqual([
      {
        hash: 'h',
        format: 'EPUB',
        title: 't',
        author: '',
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        uploadedAt: 1,
      },
    ]);
    const post = f.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/sync')!;
    expect(JSON.parse(String(post.init.body))).toMatchObject({ notes: [], configs: [] });
  });
});

describe('ApiClient: expected user, ping, objects', () => {
  it('expectUserId seeds the account: a session of another one is never used', async () => {
    const f = apiDeps(() => json(200, { books: [] }));
    const api = new ApiClient(f.deps, PROFILE, { expectUserId: 'uid-2' });
    const err = await api.ensureAuth().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthRequiredError);
    expect((err as CliError).exitCode).toBe(3);
    expect(f.calls.filter((c) => c.url.pathname.startsWith('/api/'))).toHaveLength(0);
    await expect(
      new ApiClient(f.deps, PROFILE, { expectUserId: 'uid-1' }).ensureAuth(),
    ).resolves.toBeUndefined();
  });

  it('ping hits the server and sessionInfo names the session it passed with', async () => {
    const f = apiDeps(() => json(200, { books: [] }));
    const api = new ApiClient(f.deps, PROFILE);
    await api.ping();
    const calls = f.calls.filter((c) => c.url.pathname === '/api/sync');
    expect(calls.map((c) => [c.method, Object.fromEntries(c.url.searchParams)])).toEqual([
      ['GET', { type: 'books', since: String(f.deps.now()) }],
    ]);
    expect(api.sessionInfo()).toEqual({
      email: 'me@example.com',
      userId: 'uid-1',
      expiresAt: Math.floor(f.deps.now() / 1000) + 3600,
    });

    // Every Date.now() lands in a new second, so any wall-clock dependence in the expectation fails here.
    let tick = Math.floor(Date.now() / 1000) * 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1000));
    onTestFinished(() => nowSpy.mockRestore());
    const issuedMs = Date.UTC(2030, 0, 1);
    const g = apiDeps(
      (_url, init) =>
        bearer(init) === 'Bearer at-1'
          ? json(401, { error: 'Not authenticated' })
          : json(200, { books: [] }),
      () => tokenResponse(2, issuedMs),
    );
    writeSession(
      g.deps,
      session(g.deps.now(), { expires_at: Math.floor(g.deps.now() / 1000) + 2000 }),
    );
    const refreshed = new ApiClient(g.deps, PROFILE);
    await refreshed.ping();
    expect(refreshed.sessionInfo().expiresAt, 'the refreshed session, not the rejected one').toBe(
      issuedMs / 1000 + 3600,
    );

    const h = apiDeps(() => json(401, { error: 'Not authenticated' }));
    await expect(new ApiClient(h.deps, PROFILE).ping()).rejects.toBeInstanceOf(AuthRequiredError);
  });

  it('ping wants a sync answer: a 200 page from a proxy is an error', async () => {
    const f = apiDeps(() => new Response('<html>login</html>', { status: 200 }));
    await expect(new ApiClient(f.deps, PROFILE).ping()).rejects.toThrow(/no books array/);
  });

  it('a write whose answer breaks off or is malformed is uncertain', async () => {
    let broken = true;
    const f = apiDeps(() =>
      broken
        ? new Response(
            new ReadableStream({
              start(c) {
                c.error(new Error('connection reset'));
              },
            }),
            { status: 200 },
          )
        : json(200, { nope: true }),
    );
    const api = new ApiClient(f.deps, PROFILE);
    const fail = () =>
      api.pushBooks([]).then(
        () => null,
        (e: unknown) => e as CliError,
      );
    expect((await fail())!.uncertain).toBe(true);
    broken = false;
    expect((await fail())!.uncertain).toBe(true);
  });

  it('deleteObject: 200 → deleted, 404 → missing, 500 → HttpError', async () => {
    const f = apiDeps((url) => {
      const key = url.searchParams.get('fileKey');
      if (key === 'uid-1/a.epub') return json(200, { message: 'File deleted successfully' });
      if (key === 'uid-1/b.epub') return json(404, { error: 'File not found' });
      return json(500, { error: 'Could not delete file from storage' });
    });
    const api = new ApiClient(f.deps, PROFILE);
    expect(await api.deleteObject('uid-1/a.epub')).toBe('deleted');
    expect(await api.deleteObject('uid-1/b.epub')).toBe('missing');
    const err = await api.deleteObject('uid-1/c.epub').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(500);
    const dels = f.calls.filter((c) => c.url.pathname === '/api/storage/delete');
    expect(dels.map((c) => [c.method, c.url.searchParams.get('fileKey')])).toEqual([
      ['DELETE', 'uid-1/a.epub'],
      ['DELETE', 'uid-1/b.epub'],
      ['DELETE', 'uid-1/c.epub'],
    ]);
  });

  it('a write that failed on the network or with a 5xx is uncertain; a read or a 4xx is not', async () => {
    let mode: 'throw' | 500 | 403 = 'throw';
    const f = apiDeps(() => {
      if (mode === 'throw') throw new TypeError('fetch failed');
      return json(mode, { error: 'nope' });
    });
    const api = new ApiClient(f.deps, PROFILE);
    const fail = (p: Promise<unknown>) =>
      p.then(
        () => null,
        (e: unknown) => e as CliError,
      );
    expect((await fail(api.deleteObject('k')))!.uncertain).toBe(true);
    expect((await fail(api.pushBooks([])))!.uncertain).toBe(true);
    expect((await fail(api.pullBooks()))!.uncertain).toBe(false);
    mode = 500;
    expect((await fail(api.request('POST', '/sync', { body: {} })))!.uncertain).toBe(true);
    expect((await fail(api.pullBooks()))!.uncertain).toBe(false);
    mode = 403;
    expect((await fail(api.request('POST', '/sync', { body: {} })))!.uncertain).toBe(false);
  });

  it('a failed or 5xx PUT to storage is uncertain', async () => {
    let status = 0;
    const f = fakeDeps(() => {
      if (!status) throw new TypeError('fetch failed');
      return new Response(null, { status });
    });
    const api = new ApiClient(f.deps, PROFILE);
    const put = () =>
      api.put('https://s3.example/up', { bytes: new Uint8Array([1]) }, 1).then(
        () => null,
        (e: unknown) => e as CliError,
      );
    expect((await put())!.uncertain).toBe(true);
    status = 503;
    expect((await put())!.uncertain).toBe(true);
    status = 403;
    expect((await put())!.uncertain).toBe(false);
  });

  it('bookObjects: a non-hex or empty hash is a usage error without a request', async () => {
    const f = apiDeps(() => json(200, { files: [] }));
    const api = new ApiClient(f.deps, PROFILE);
    for (const h of ['', 'xyz', 'A'.repeat(32), 'a'.repeat(31)]) {
      await expect(api.bookObjects(h)).rejects.toBeInstanceOf(UsageError);
    }
    expect(f.calls.filter((c) => c.url.pathname.startsWith('/api/'))).toHaveLength(0);
  });

  it('bookObjects keeps only the rows of this book', async () => {
    const h = 'a'.repeat(32);
    const f = apiDeps(() =>
      json(200, {
        files: [
          { file_key: `uid-1/Readest/Books/${h}/${h}.epub`, file_size: 1, book_hash: h },
          { file_key: 'uid-1/Readest/Books/other/x.epub', file_size: 1, book_hash: 'b'.repeat(32) },
          { file_key: 'uid-1/replica/r.mdd', file_size: 1, book_hash: null },
        ],
      }),
    );
    const rows = await new ApiClient(f.deps, PROFILE).bookObjects(h);
    expect(rows.map((r) => r.file_key)).toEqual([`uid-1/Readest/Books/${h}/${h}.epub`]);
    const list = f.calls.find((c) => c.url.pathname === '/api/storage/list')!;
    expect(list.url.searchParams.get('bookHash')).toBe(h);
  });
});

describe('fake server', () => {
  const H = 'a'.repeat(32);
  const serverSetup = () => {
    const server = fakeServer();
    const f = serverDeps(server.handler, home);
    writeFreshSession(f.deps);
    return { server, api: new ApiClient(f.deps, FAKE_PROFILE) };
  };

  it('DELETE /api/storage/delete removes the record and the object, with the hash and extension fallback', async () => {
    const { server, api } = serverSetup();
    const key = `${FAKE_UID}/Readest/Books/${H}/Title.epub`;
    server.addFile(key, H, new Uint8Array([1]));
    server.addFile(`${FAKE_UID}/Readest/Books/${H}/cover.png`, H, new Uint8Array([2]));
    expect(await api.deleteObject(`${FAKE_UID}/Readest/Books/${H}/${H}.epub`)).toBe('deleted');
    expect(server.files.map((f) => f.file_key)).toEqual([
      `${FAKE_UID}/Readest/Books/${H}/cover.png`,
    ]);
    expect(server.objects.has(key)).toBe(false);
    expect(await api.deleteObject(`${FAKE_UID}/Readest/Books/${H}/cover.png`)).toBe('deleted');
    expect(await api.deleteObject(`${FAKE_UID}/Readest/Books/${H}/cover.png`)).toBe('missing');
    expect(server.files).toHaveLength(0);
  });

  it('storage list without a hash returns every file of the user, like the server', async () => {
    const { server } = serverSetup();
    server.addFile('k1', H);
    server.addFile('k2', 'b'.repeat(32));
    const res = await server.handler(new URL(`${FAKE_API}/api/storage/list?bookHash=`), {});
    expect(((await res.json()) as { files: unknown[] }).files).toHaveLength(2);
  });

  // Fixtures of src/__tests__/pages/api/sync-*-merge tests, run through the whole POST.
  const wire = (over: Partial<WireBook> = {}): WireBook => ({
    hash: H,
    metaHash: 'm',
    format: 'EPUB',
    title: 'T',
    author: 'A',
    createdAt: Date.parse('2026-01-01T00:00:00.000Z'),
    updatedAt: Date.parse('2026-01-02T00:00:00.000Z'),
    deletedAt: null,
    uploadedAt: null,
    ...over,
  });
  const iso = (s: string) => new Date(Date.parse(s)).toISOString();

  it('merge: the server wins the row but a fresher client group is grafted, updated_at kept', async () => {
    const { server, api } = serverSetup();
    server.addBook({
      book_hash: H,
      updated_at: iso('2026-02-01'),
      group_id: 'g1',
      group_name: 'Old',
      group_updated_at: iso('2026-01-01'),
      synced_at: iso('2026-02-01'),
    });
    await api.pushBooks([
      wire({
        groupId: 'g2',
        groupName: 'New',
        groupUpdatedAt: Date.parse('2026-01-05'),
        progress: [1, 2],
      }),
    ]);
    const row = server.books.get(H)!;
    expect([row.group_id, row.group_name, row.updated_at]).toEqual([
      'g2',
      'New',
      iso('2026-02-01'),
    ]);
    expect(row.progress ?? null, 'the row itself stays the server one').toBeNull();
    expect(Date.parse(row.synced_at!)).toBeGreaterThan(Date.parse('2026-02-01'));
  });

  it('merge: the client wins the row but keeps a fresher server status and group', async () => {
    const { server, api } = serverSetup();
    server.addBook({
      book_hash: H,
      updated_at: iso('2026-01-01'),
      reading_status: 'finished',
      reading_status_updated_at: iso('2026-03-01'),
      group_id: 'g1',
      group_name: 'Kept',
      group_updated_at: iso('2026-03-01'),
      page_count: 321,
    });
    await api.pushBooks([
      wire({
        updatedAt: Date.parse('2026-02-01'),
        progress: [3, 10],
        readingStatus: 'reading',
        readingStatusUpdatedAt: Date.parse('2026-02-01'),
        groupId: null,
        groupName: null,
        groupUpdatedAt: Date.parse('2026-02-01'),
      }),
    ]);
    const row = server.books.get(H)!;
    expect(row.progress).toEqual([3, 10]);
    expect([row.reading_status, row.group_name, row.page_count]).toEqual(['finished', 'Kept', 321]);
  });

  it('merge: a tombstone with an older updated_at still wins; an older plain row is a no-op', async () => {
    const { server, api } = serverSetup();
    server.addBook({ book_hash: H, updated_at: iso('2026-02-01'), synced_at: iso('2026-02-01') });
    await api.pushBooks([wire({ updatedAt: Date.parse('2026-01-15') })]);
    expect(server.books.get(H)!.synced_at, 'nothing fresher: not written').toBe(iso('2026-02-01'));
    await api.pushBooks([
      wire({ updatedAt: Date.parse('2026-01-15'), deletedAt: Date.parse('2026-03-01') }),
    ]);
    expect(server.books.get(H)!.deleted_at).toBe(iso('2026-03-01'));
  });
});
