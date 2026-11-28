import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyResponse,
  fetchPublic,
  loadImageCache,
  MAX_IMAGE_BYTES,
  sniffExt,
} from '../../../../../selfhost/clippings/lib/images.ts';
import {
  downloadImages,
  evalScript,
  webSession,
} from '../../../../../selfhost/clippings/lib/web.ts';
import type { RunResult } from '../../../../../selfhost/clippings/lib/deps.ts';
import { held, syncDeps } from './helpers';
import type { RunCall } from './helpers';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const DAY = 24 * 60 * 60 * 1000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clip-img-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const resp = (status: number, body: BodyInit | null = null, headers: Record<string, string> = {}) =>
  new Response(body, { status, headers });
const fetchOf = (routes: Record<string, () => Response>) => {
  const seen: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const r = routes[url];
    if (!r) throw new TypeError('network');
    return r();
  }) as typeof globalThis.fetch;
  return { fetch, seen };
};
const pub = (status: number, body: BodyInit | null = null, headers: Record<string, string> = {}) =>
  fetchPublic(
    'https://p.test/i',
    fetchOf({ 'https://p.test/i': () => resp(status, body, headers) }),
  );

describe('HTTP outcomes', () => {
  it('404 and 410 are gone; 401, 403, 429, 500, 503 and a network error are temp', async () => {
    for (const s of [404, 410]) expect(await pub(s), String(s)).toEqual({ kind: 'gone' });
    for (const s of [401, 403, 429, 500, 503]) {
      expect(await pub(s), String(s)).toEqual({ kind: 'temp', counts: true });
    }
    expect(await fetchPublic('https://p.test/x', fetchOf({}))).toEqual({
      kind: 'temp',
      counts: true,
    });
  });

  it('200 by signature: PNG, JPEG; plain HTML gone; a sign-in page temp', async () => {
    expect(await pub(200, PNG)).toMatchObject({ kind: 'ok', ext: 'png' });
    expect(await pub(200, JPG)).toMatchObject({ kind: 'ok', ext: 'jpg' });
    expect(await pub(200, '<html><body>hi</body></html>')).toEqual({ kind: 'gone' });
    expect(await pub(200, '<form action=/l><input type="password" name=p></form>')).toEqual({
      kind: 'temp',
      counts: true,
    });
    expect(
      classifyResponse({
        status: 200,
        finalUrl: 'https://passport.yandex-team.ru/auth',
        bytes: new Uint8Array([60]),
      }),
    ).toEqual({ kind: 'temp', counts: true });
  });

  it('over 25 MiB is gone, by header and by body', async () => {
    expect(await pub(200, PNG, { 'content-length': String(MAX_IMAGE_BYTES + 1) })).toEqual({
      kind: 'gone',
    });
    const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
    big.set(PNG);
    expect(await pub(200, big)).toEqual({ kind: 'gone' });
  });

  it('sniffExt: gif, webp, svg, unknown', () => {
    expect(sniffExt(new TextEncoder().encode('GIF89a..'))).toBe('gif');
    expect(sniffExt(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8'))).toBe('webp');
    expect(sniffExt(new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="x">'))).toBe(
      'svg',
    );
    expect(sniffExt(new TextEncoder().encode('hello'))).toBeNull();
  });
});

describe('redirects', () => {
  const chain = (n: number) => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < n; i++) {
      routes[`https://p.test/${i}`] = () => resp(302, null, { location: `/${i + 1}` });
    }
    routes[`https://p.test/${n}`] = () => resp(200, PNG);
    return fetchOf(routes);
  };
  it('5 hops are followed, the 6th is temp', async () => {
    expect(await fetchPublic('https://p.test/0', chain(5))).toMatchObject({ kind: 'ok' });
    expect(await fetchPublic('https://p.test/0', chain(6))).toEqual({ kind: 'temp', counts: true });
  });

  it('a hop into wiki.yandex-team.ru goes to the browser, cached under the original URL', async () => {
    const f = fetchOf({
      'https://p.test/r': () =>
        resp(302, null, { location: 'https://wiki.yandex-team.ru/img.png' }),
    });
    expect(await fetchPublic('https://p.test/r', f)).toEqual({
      kind: 'intranet',
      url: 'https://wiki.yandex-team.ru/img.png',
    });
    const asked: string[][] = [];
    const session = {
      fetchIntranet: async (urls: string[]) => {
        asked.push(urls);
        return new Map(
          urls.map((u) => [u, { kind: 'ok' as const, bytes: PNG, ext: 'png' as const }]),
        );
      },
      close: async () => {},
    };
    const { deps } = syncDeps(dir, { fetch: f.fetch });
    const cache = await loadImageCache(deps, dir);
    await downloadImages(deps, cache, session, ['https://p.test/r'], 1);
    expect(asked).toEqual([['https://wiki.yandex-team.ru/img.png']]);
    expect(cache.get('https://p.test/r')?.status).toBe('ok');
    expect(cache.get('https://wiki.yandex-team.ru/img.png')).toBeUndefined();
  });
});

describe('ImageCache', () => {
  it('temp three times over more than 3 days becomes gone; counts: false changes nothing', async () => {
    const { deps } = syncDeps(dir);
    const c = await loadImageCache(deps, dir);
    const u = 'https://p.test/a';
    c.record(u, { kind: 'temp', counts: true }, 0);
    c.record(u, { kind: 'temp', counts: false }, DAY);
    expect(c.get(u)).toMatchObject({ status: 'temp', failures: 1, firstFailureAt: 0 });
    c.record(u, { kind: 'temp', counts: true }, DAY);
    c.record(u, { kind: 'temp', counts: true }, 2 * DAY);
    expect(c.get(u)?.status, 'three tries in 2 days').toBe('temp');
    c.record(u, { kind: 'temp', counts: true }, 3 * DAY + 1);
    expect(c.get(u)?.status).toBe('gone');
    const v = 'https://p.test/b';
    c.record(v, { kind: 'temp', counts: true }, 0);
    c.record(v, { kind: 'temp', counts: true }, 4 * DAY);
    expect(c.get(v)?.status, 'only two tries').toBe('temp');
  });

  it('a reopened cache keeps ok bytes and gone, and fetches nothing again', async () => {
    const f = fetchOf({
      'https://p.test/ok': () => resp(200, PNG),
      'https://p.test/gone': () => resp(404),
    });
    const { deps } = syncDeps(dir, { fetch: f.fetch });
    const c1 = await loadImageCache(deps, dir);
    const noWeb = { fetchIntranet: async () => new Map(), close: async () => {} };
    await downloadImages(deps, c1, noWeb, ['https://p.test/ok', 'https://p.test/gone'], 1);
    await c1.save(held);
    expect(f.seen).toHaveLength(2);
    const file = c1.get('https://p.test/ok')!.file!;
    expect(file).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(new Uint8Array(readFileSync(join(dir, file)))).toEqual(PNG);

    const c2 = await loadImageCache(deps, dir);
    const web: string[][] = [];
    await downloadImages(
      deps,
      c2,
      {
        fetchIntranet: async (u) => {
          web.push(u);
          return new Map();
        },
        close: async () => {},
      },
      ['https://p.test/ok', 'https://p.test/gone'],
      2,
    );
    expect(f.seen, 'no fetch for ok and gone').toHaveLength(2);
    expect(web).toEqual([]);
    expect((await c2.bytes('https://p.test/ok'))?.bytes).toEqual(PNG);
  });
});

describe('ImageCache: lost file', () => {
  it('an ok entry whose file is gone is fetched again', async () => {
    const { deps } = syncDeps(dir);
    const c1 = await loadImageCache(deps, dir);
    c1.record('https://p.test/a', { kind: 'ok', bytes: PNG, ext: 'png' }, 1);
    await c1.save(held);
    rmSync(join(dir, c1.get('https://p.test/a')!.file!));
    const c2 = await loadImageCache(deps, dir);
    expect(c2.needsFetch('https://p.test/a')).toBe(true);
  });
});

describe('downloadImages: checkpoints', () => {
  it('saves after every intranet host and at the end', async () => {
    const { deps } = syncDeps(dir);
    const cache = await loadImageCache(deps, dir);
    const order: string[] = [];
    const session = {
      fetchIntranet: async (urls: string[]) => {
        order.push(`fetch ${new URL(urls[0]!).host}`);
        return new Map(urls.map((u) => [u, { kind: 'gone' as const }]));
      },
      close: async () => {},
    };
    await downloadImages(
      deps,
      cache,
      session,
      ['https://esoc.yandex-team.ru/a', 'https://jing.yandex-team.ru/b'],
      1,
      async () => {
        order.push('save');
      },
    );
    expect(order).toEqual([
      'fetch esoc.yandex-team.ru',
      'save',
      'fetch jing.yandex-team.ru',
      'save',
      'save',
    ]);
  });
});

describe('web session', () => {
  const ESOC = 'https://esoc.yandex-team.ru';
  const JING = 'https://jing.yandex-team.ru';
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  const answer = (o: unknown): RunResult => ({
    code: 0,
    stdout: JSON.stringify(JSON.stringify(o)),
    stderr: '',
  });
  const scripted = (handler: (args: string[]) => RunResult) => {
    const calls: RunCall[] = [];
    const run = async (cmd: string, args: string[], opts: RunCall['opts']) => {
      calls.push({ cmd, args, opts });
      return handler(args);
    };
    return { calls, session: webSession({ run }) };
  };
  const label = (c: RunCall) => (c.args[0] === 'eval' ? 'eval' : c.args.join(' '));

  it('per host: open, get url, eval per URL; WEB_SESSION on every call; close at the end', async () => {
    let at = '';
    const { calls, session } = scripted((args) => {
      if (args[0] === 'open') at = args[1]!;
      if (args[0] === 'get') return { code: 0, stdout: `${at}\n`, stderr: '' };
      if (args[0] === 'eval') return answer({ status: 200, finalUrl: at, b64: b64(PNG) });
      return { code: 0, stdout: '', stderr: '' };
    });
    const got = await session.fetchIntranet([`${ESOC}/a.png`, `${JING}/b.png`, `${ESOC}/c.png`]);
    await session.close();
    expect(calls.map(label)).toEqual([
      `open ${ESOC}/`,
      'get url',
      'eval',
      'eval',
      `open ${JING}/`,
      'get url',
      'eval',
      'close',
    ]);
    for (const c of calls) expect(c.opts.env?.['WEB_SESSION']).toBe('clippings-sync');
    expect(got.get(`${ESOC}/a.png`)).toEqual({ kind: 'ok', bytes: PNG, ext: 'png' });
  });

  it('the tab lands on passport: every URL of that host is temp, not counted, no eval', async () => {
    const { calls, session } = scripted((args) =>
      args[0] === 'get'
        ? { code: 0, stdout: 'https://passport.yandex-team.ru/auth?retpath=x\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    const got = await session.fetchIntranet([`${ESOC}/a.png`, `${ESOC}/b.png`]);
    expect([...got.values()]).toEqual([
      { kind: 'temp', counts: false },
      { kind: 'temp', counts: false },
    ]);
    expect(calls.some((c) => c.args[0] === 'eval')).toBe(false);
  });

  it('another port of the same host is another origin', async () => {
    const { calls, session } = scripted((args) =>
      args[0] === 'get'
        ? { code: 0, stdout: 'https://esoc.yandex-team.ru:8443/\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    );
    expect((await session.fetchIntranet([`${ESOC}/a.png`])).get(`${ESOC}/a.png`)).toEqual({
      kind: 'temp',
      counts: false,
    });
    expect(calls.some((c) => c.args[0] === 'eval')).toBe(false);
  });

  it('web exit 2 (no Chromium): every intranet URL is temp, not counted', async () => {
    const { calls, session } = scripted(() => ({ code: 2, stdout: '', stderr: 'chromium_down' }));
    const got = await session.fetchIntranet([`${ESOC}/a.png`, `${JING}/b.png`]);
    expect([...got.values()]).toEqual([
      { kind: 'temp', counts: false },
      { kind: 'temp', counts: false },
    ]);
    expect(calls.map(label), 'the second host is not tried').toEqual([`open ${ESOC}/`]);
  });

  it('eval answers a TypeError: temp, counted', async () => {
    let at = '';
    const { session } = scripted((args) => {
      if (args[0] === 'open') at = args[1]!;
      if (args[0] === 'get') return { code: 0, stdout: at, stderr: '' };
      return answer({ error: 'TypeError: Failed to fetch' });
    });
    expect((await session.fetchIntranet([`${ESOC}/a.png`])).get(`${ESOC}/a.png`)).toEqual({
      kind: 'temp',
      counts: true,
    });
  });

  it('the generated script: same-origin fetch with credentials, PNG bytes back in base64', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
    };
    const run = new Function('fetch', 'btoa', `return ${evalScript(`${ESOC}/a b.png`)}`) as (
      f: typeof fakeFetch,
      b: typeof btoa,
    ) => Promise<string>;
    const out = JSON.parse(await run(fakeFetch, btoa)) as { status: number; b64: string };
    expect(seen).toEqual([{ url: `${ESOC}/a b.png`, init: { credentials: 'include' } }]);
    expect(out.status).toBe(200);
    expect(new Uint8Array(Buffer.from(out.b64, 'base64'))).toEqual(PNG);
  });
});
