import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Profile } from './config.ts';
import type { Deps } from './deps.ts';
import { AuthRequiredError, CliError } from './errors.ts';
import { withLock } from './lock.ts';

export type Session = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  user: { id: string; email: string };
};

const TIMEOUT_MS = 30_000;
const LOCK_WAIT_MS = 15_000;

export const configDir = (deps: Deps): string => join(deps.homeDir, '.config', 'readest-cli');

export const sessionPath = (deps: Deps, profile: Profile): string =>
  join(configDir(deps), `session-${profile.key}.json`);

const isSession = (v: unknown): v is Session => {
  const s = v as Partial<Session> | null;
  return (
    !!s &&
    typeof s.access_token === 'string' &&
    typeof s.refresh_token === 'string' &&
    typeof s.expires_at === 'number' &&
    typeof s.expires_in === 'number' &&
    typeof s.user?.id === 'string' &&
    typeof s.user?.email === 'string'
  );
};

export const readSession = async (deps: Deps, profile: Profile): Promise<Session | null> => {
  let text: string;
  try {
    text = await readFile(sessionPath(deps, profile), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const v: unknown = JSON.parse(text);
    return isSession(v) ? v : null;
  } catch {
    return null;
  }
};

const writeSession = async (deps: Deps, profile: Profile, s: Session) => {
  const path = sessionPath(deps, profile);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await rename(tmp, path);
};

const lockOf = (deps: Deps, profile: Profile) => `${sessionPath(deps, profile)}.lock`;

const lockSession = async <T>(
  deps: Deps,
  profile: Profile,
  fn: (held: { assertHeld: () => void }) => Promise<T>,
) => {
  await mkdir(configDir(deps), { recursive: true, mode: 0o700 });
  try {
    return await withLock(
      lockOf(deps, profile),
      { waitMs: LOCK_WAIT_MS, label: 'session lock' },
      fn,
      deps,
    );
  } catch (e) {
    if (e instanceof CliError && e.message.startsWith('held by ')) {
      throw new CliError(`the session is held by process ${e.message.slice('held by '.length)}`);
    }
    throw e;
  }
};

const errorText = (body: unknown): string => {
  const b = (body ?? {}) as Record<string, unknown>;
  for (const k of ['error_description', 'msg', 'message', 'error']) {
    const v = b[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
};

/** POST to GoTrue's token endpoint; 400/401/403 mean the credentials are no good. */
const tokenRequest = async (
  deps: Deps,
  profile: Profile,
  grant: 'password' | 'refresh_token',
  body: Record<string, string>,
  fallbackUser?: Session['user'],
): Promise<Session> => {
  const what = grant === 'password' ? 'login' : 'token refresh';
  let res: Response;
  try {
    res = await deps.fetch(`${profile.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
      method: 'POST',
      headers: {
        apikey: profile.anonKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new CliError(`${what} failed: ${(e as Error).message}`);
  }
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    const detail = errorText(parsed);
    if (grant === 'password') {
      const p = (parsed ?? {}) as Record<string, unknown>;
      if (
        res.status === 400 &&
        (p['error'] === 'invalid_grant' || p['error_code'] === 'invalid_credentials')
      ) {
        throw new AuthRequiredError('login failed: invalid email or password');
      }
      throw new AuthRequiredError(`login rejected${detail ? `: ${detail}` : ''}`);
    }
    throw new AuthRequiredError(
      `${what} rejected${detail ? `: ${detail}` : ''}; run readest login`,
    );
  }
  if (!res.ok) {
    const detail = errorText(parsed);
    throw new CliError(
      `${what} failed: POST /auth/v1/token → ${res.status}${detail ? ` ${detail}` : ''}`,
    );
  }
  const p = (parsed ?? {}) as Record<string, unknown>;
  const user = (p['user'] ?? {}) as Record<string, unknown>;
  const expiresIn = typeof p['expires_in'] === 'number' ? p['expires_in'] : 3600;
  const session: Session = {
    access_token: String(p['access_token'] ?? ''),
    refresh_token: String(p['refresh_token'] ?? ''),
    expires_in: expiresIn,
    expires_at:
      typeof p['expires_at'] === 'number'
        ? p['expires_at']
        : Math.floor(deps.now() / 1000) + expiresIn,
    user: {
      id: typeof user['id'] === 'string' ? user['id'] : (fallbackUser?.id ?? ''),
      email: typeof user['email'] === 'string' ? user['email'] : (fallbackUser?.email ?? ''),
    },
  };
  if (!isSession(session) || !session.access_token || !session.refresh_token) {
    throw new CliError(`${what} failed: unexpected response from /auth/v1/token`);
  }
  return session;
};

export const login = (
  deps: Deps,
  profile: Profile,
  email: string,
  password: string,
): Promise<Session> =>
  lockSession(deps, profile, async (held) => {
    const s = await tokenRequest(deps, profile, 'password', { email, password });
    held.assertHeld();
    await writeSession(deps, profile, s);
    return s;
  });

/**
 * Re-reads the session under the lock. With `rejectedToken` it refreshes only
 * if that token is still the current one (otherwise another process already
 * did); without it, only when less than half the token lifetime remains.
 * With `userId`, a session of another account (a login meanwhile) is an error.
 */
export const refresh = (
  deps: Deps,
  profile: Profile,
  opts: { rejectedToken?: string; userId?: string },
): Promise<Session> =>
  lockSession(deps, profile, async (held) => {
    const s = await readSession(deps, profile);
    if (!s) throw new AuthRequiredError();
    if (opts.userId !== undefined && s.user.id !== opts.userId) {
      throw new AuthRequiredError('session changed to another account; re-run');
    }
    const due =
      opts.rejectedToken !== undefined
        ? s.access_token === opts.rejectedToken
        : s.expires_at - deps.now() / 1000 < s.expires_in / 2;
    if (!due) return s;
    const next = await tokenRequest(
      deps,
      profile,
      'refresh_token',
      { refresh_token: s.refresh_token },
      s.user,
    );
    held.assertHeld();
    // GoTrue rotates the refresh token: the new pair must be saved before anything else.
    await writeSession(deps, profile, next);
    return next;
  });

export const ensureSession = (deps: Deps, profile: Profile): Promise<Session> =>
  refresh(deps, profile, {});

export const logout = (deps: Deps, profile: Profile): Promise<void> =>
  lockSession(deps, profile, async () => {
    const s = await readSession(deps, profile);
    try {
      await unlink(sessionPath(deps, profile));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (!s) return;
    try {
      // GoTrue's default scope is global: it would sign the user out on every device.
      await deps.fetch(`${profile.supabaseUrl}/auth/v1/logout?scope=local`, {
        method: 'POST',
        headers: {
          apikey: profile.anonKey,
          Authorization: `Bearer ${s.access_token}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // best effort: the local session is gone either way
    }
  });
