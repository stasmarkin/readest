import { createHash } from 'node:crypto';
import type { Deps } from './deps.ts';
import { CliError } from './errors.ts';

export type Profile = { apiBase: string; supabaseUrl: string; anonKey: string; key: string };

const DEFAULT_SERVER = 'https://readest.stasmarkin.ru';
const TIMEOUT_MS = 30_000;

const trimSlash = (s: string) => s.trim().replace(/\/+$/, '');

const parseUrl = (value: string, what: string): URL => {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('not http(s)');
    return u;
  } catch {
    throw new CliError(`${what} is not a valid URL: ${value}`);
  }
};

const makeProfile = (apiBase: string, supabaseUrl: string, anonKey: string): Profile => {
  const host = parseUrl(apiBase, 'API URL').host.replace(/:/g, '_');
  parseUrl(supabaseUrl, 'Supabase URL');
  const digest = createHash('sha256').update(`${apiBase}|${supabaseUrl}`).digest('hex').slice(0, 8);
  return { apiBase, supabaseUrl, anonKey, key: `${host}-${digest}` };
};

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * Exactly one source: all three READEST_API_URL/READEST_SUPABASE_URL/READEST_ANON_KEY
 * (test stacks, http allowed), or none of them and the server's well-known config,
 * which must be https and same-origin so a tampered file cannot redirect credentials.
 */
export const resolveProfile = async (deps: Deps): Promise<Profile> => {
  const vars = [
    deps.env['READEST_API_URL'],
    deps.env['READEST_SUPABASE_URL'],
    deps.env['READEST_ANON_KEY'],
  ];
  const set = vars.filter(nonEmpty).length;
  if (set === 3) {
    const [api, sb, key] = vars as [string, string, string];
    return makeProfile(trimSlash(api), trimSlash(sb), key.trim());
  }
  if (set > 0) {
    throw new CliError(
      'set all of READEST_API_URL, READEST_SUPABASE_URL, READEST_ANON_KEY, or none of them',
    );
  }

  const server = trimSlash(deps.env['READEST_URL'] || DEFAULT_SERVER);
  const serverUrl = parseUrl(server, 'READEST_URL');
  if (serverUrl.protocol !== 'https:') throw new CliError(`READEST_URL must use https: ${server}`);
  const url = `${server}/.well-known/readest-client-config.json`;
  let text: string;
  try {
    const res = await deps.fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new CliError(`GET ${url} → ${res.status}`);
    text = await res.text();
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`GET ${url} failed: ${(e as Error).message}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CliError(`${url} is not JSON`);
  }
  const c = (body ?? {}) as Record<string, unknown>;
  const fields = [c['apiBaseUrl'], c['supabaseUrl'], c['supabaseAnonKey']];
  if (!fields.every(nonEmpty)) {
    throw new CliError(
      `${url}: apiBaseUrl, supabaseUrl and supabaseAnonKey must be non-empty strings`,
    );
  }
  const [api, sb, key] = (fields as string[]).map((f) => f.trim()) as [string, string, string];
  for (const [name, value] of [
    ['apiBaseUrl', api],
    ['supabaseUrl', sb],
  ] as const) {
    const u = parseUrl(value, `${url}: ${name}`);
    if (u.protocol !== 'https:') throw new CliError(`${url}: ${name} must use https`);
    if (u.origin !== serverUrl.origin)
      throw new CliError(`${url}: ${name} is not on ${serverUrl.origin}`);
  }
  return makeProfile(trimSlash(api), trimSlash(sb), key);
};
