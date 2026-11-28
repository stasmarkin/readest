import type { SyncDeps } from './deps.ts';
import { classifyResponse, fetchPublic, isIntranet, MAX_IMAGE_BYTES } from './images.ts';
import type { ImageCache, Outcome } from './images.ts';

export const WEB_SESSION = 'clippings-sync';
const WEB_TIMEOUT_MS = 60_000;

/** A same-origin fetch in the signed-in tab; the page answers in base64, a failure as `error`. */
export const evalScript = (url: string): string => `(async () => {
  try {
    const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.length > ${MAX_IMAGE_BYTES}) return JSON.stringify({ status: r.status, finalUrl: r.url, tooLarge: true });
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return JSON.stringify({ status: r.status, type: r.headers.get('content-type'), finalUrl: r.url, b64: btoa(s) });
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
})()`;

type EvalAnswer = {
  status?: number;
  finalUrl?: string;
  b64?: string;
  tooLarge?: boolean;
  error?: string;
};

/** `web eval` prints the script's value; a string value may come JSON-quoted or bare. */
const parseAnswer = (stdout: string): EvalAnswer | null => {
  try {
    let v: unknown = JSON.parse(stdout.trim());
    if (typeof v === 'string') v = JSON.parse(v);
    return typeof v === 'object' && v !== null ? (v as EvalAnswer) : null;
  } catch {
    return null;
  }
};

export type WebSession = {
  fetchIntranet: (urls: string[]) => Promise<Map<string, Outcome>>;
  close: () => Promise<void>;
};

export const webSession = (deps: Pick<SyncDeps, 'run'>): WebSession => {
  let used = false;
  let unavailable = false;
  const web = (args: string[]) => {
    used = true;
    return deps.run('web', args, { env: { WEB_SESSION }, timeoutMs: WEB_TIMEOUT_MS });
  };
  const notCounted: Outcome = { kind: 'temp', counts: false };

  return {
    fetchIntranet: async (urls) => {
      const out = new Map<string, Outcome>();
      const byOrigin = new Map<string, string[]>();
      for (const url of urls) {
        const origin = new URL(url).origin;
        byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), url]);
      }
      for (const [origin, list] of byOrigin) {
        if (unavailable) {
          for (const u of list) out.set(u, notCounted);
          continue;
        }
        const opened = await web(['open', `${origin}/`]);
        const at = opened.code === 0 ? await web(['get', 'url']) : opened;
        if (opened.code === 2 || at.code === 2) unavailable = true;
        let sameOrigin = false;
        try {
          sameOrigin = at.code === 0 && new URL(at.stdout.trim()).origin === origin;
        } catch {
          sameOrigin = false;
        }
        // Sent to passport (or anywhere else): no login for this host in this run.
        if (!sameOrigin) {
          for (const u of list) out.set(u, notCounted);
          continue;
        }
        for (const url of list) {
          if (unavailable) {
            out.set(url, notCounted);
            continue;
          }
          const r = await web(['eval', '-b', Buffer.from(evalScript(url)).toString('base64')]);
          if (r.code === 2) {
            unavailable = true;
            out.set(url, notCounted);
            continue;
          }
          const a = r.code === 0 ? parseAnswer(r.stdout) : null;
          if (!a || a.error !== undefined || typeof a.status !== 'number') {
            out.set(url, { kind: 'temp', counts: true });
            continue;
          }
          out.set(
            url,
            classifyResponse({
              status: a.status,
              finalUrl: a.finalUrl ?? url,
              bytes: a.tooLarge ? null : new Uint8Array(Buffer.from(a.b64 ?? '', 'base64')),
            }),
          );
        }
      }
      return out;
    },
    close: async () => {
      if (used) await web(['close']);
    },
  };
};

/** Fetches what the cache still lacks; an intranet hop is fetched in the browser but cached under the URL the article uses. */
export const downloadImages = async (
  deps: Pick<SyncDeps, 'fetch'>,
  cache: ImageCache,
  session: WebSession,
  urls: string[],
  now: number,
  checkpoint: () => Promise<void> = async () => {},
) => {
  // Saved as it goes: a run killed on its time limit keeps what it downloaded.
  const CHECKPOINT_EVERY = 10;
  let since = 0;
  const tick = async () => {
    if (++since < CHECKPOINT_EVERY) return;
    since = 0;
    await checkpoint();
  };
  const viaBrowser = new Map<string, string[]>();
  for (const url of new Set(urls)) {
    if (!cache.needsFetch(url)) continue;
    if (isIntranet(url)) {
      viaBrowser.set(url, [...(viaBrowser.get(url) ?? []), url]);
      continue;
    }
    const r = await fetchPublic(url, deps);
    if (r.kind === 'intranet') viaBrowser.set(r.url, [...(viaBrowser.get(r.url) ?? []), url]);
    else {
      cache.record(url, r, now);
      await tick();
    }
  }
  const byOrigin = new Map<string, string[]>();
  for (const target of viaBrowser.keys()) {
    const origin = new URL(target).origin;
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), target]);
  }
  for (const targets of byOrigin.values()) {
    const got = await session.fetchIntranet(targets);
    for (const target of targets) {
      for (const url of viaBrowser.get(target)!) {
        cache.record(url, got.get(target) ?? { kind: 'temp', counts: false }, now);
      }
    }
    await checkpoint();
  }
  await checkpoint();
};
