import { join } from 'node:path';
import { CliError } from '../../cli/lib/errors.ts';
import type { SyncDeps } from './deps.ts';
import { sha256 } from './scan.ts';
import type { Held } from './state.ts';

export type Ext = 'png' | 'jpg' | 'gif' | 'webp' | 'svg';
/** `counts: false` — no Chromium or no login: not the image's fault, so not an attempt. */
export type Outcome =
  | { kind: 'ok'; bytes: Uint8Array; ext: Ext }
  | { kind: 'gone' }
  | { kind: 'temp'; counts: boolean };
export type ImageEntry = {
  file?: string;
  status: 'ok' | 'gone' | 'temp';
  failures: number;
  firstFailureAt?: number;
  checkedAt: number;
};

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;
const GONE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const GONE_AFTER_FAILURES = 3;

export const MEDIA_TYPE: Record<Ext, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

export const sniffExt = (b: Uint8Array): Ext | null => {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'gif';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'webp';
  const head = new TextDecoder()
    .decode(b.subarray(0, 1024))
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) {
    return 'svg';
  }
  return null;
};

export const isIntranet = (url: string): boolean => {
  try {
    const host = new URL(url).hostname;
    return host === 'yandex-team.ru' || host.endsWith('.yandex-team.ru');
  } catch {
    return false;
  }
};

const isLoginPage = (finalUrl: string, bytes: Uint8Array) => {
  try {
    if (new URL(finalUrl).hostname.startsWith('passport.')) return true;
  } catch {
    // no usable final URL: judge by the body
  }
  const text = new TextDecoder().decode(bytes.subarray(0, 256 * 1024));
  return /<form\b[\s\S]*?type\s*=\s*["']?password/i.test(text);
};

/** One response, public or fetched in the browser; `bytes` null means over the size limit. */
export const classifyResponse = (r: {
  status: number;
  finalUrl: string;
  bytes: Uint8Array | null;
}): Outcome => {
  if (r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500) {
    return { kind: 'temp', counts: true };
  }
  if (r.status < 200 || r.status >= 300) return { kind: 'gone' };
  if (r.bytes === null || r.bytes.length > MAX_IMAGE_BYTES) return { kind: 'gone' };
  const ext = sniffExt(r.bytes);
  if (ext) return { kind: 'ok', bytes: r.bytes, ext };
  // A sign-in page is a missing login, not a missing image.
  if (isLoginPage(r.finalUrl, r.bytes)) return { kind: 'temp', counts: true };
  return { kind: 'gone' };
};

const readCapped = async (res: Response): Promise<Uint8Array | null> => {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/** A public image with redirects followed by hand: a hop into the intranet goes to the browser. */
export const fetchPublic = async (
  url: string,
  deps: Pick<SyncDeps, 'fetch'>,
): Promise<Outcome | { kind: 'intranet'; url: string }> => {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let current = url;
  try {
    for (let hops = 0; ; hops++) {
      const res = await deps.fetch(current, { redirect: 'manual', signal });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        const next = new URL(location, current).href;
        if (isIntranet(next)) return { kind: 'intranet', url: next };
        if (hops + 1 > MAX_REDIRECTS) return { kind: 'temp', counts: true };
        current = next;
        continue;
      }
      const bytes =
        res.status >= 200 && res.status < 300 ? await readCapped(res) : new Uint8Array();
      return classifyResponse({ status: res.status, finalUrl: current, bytes });
    }
  } catch {
    return { kind: 'temp', counts: true };
  }
};

export type ImageCache = {
  get: (url: string) => ImageEntry | undefined;
  /** Not downloaded yet, or failed for now: `ok` and `gone` are final. */
  needsFetch: (url: string) => boolean;
  record: (url: string, outcome: Outcome, now: number) => void;
  bytes: (url: string) => Promise<{ bytes: Uint8Array; ext: Ext } | null>;
  save: (held: Held) => Promise<void>;
};

const INDEX = 'images.json';

export const loadImageCache = async (deps: SyncDeps, dir: string): Promise<ImageCache> => {
  let index: Record<string, ImageEntry> = {};
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(await deps.readFile(join(dir, INDEX))));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
    index = v as Record<string, ImageEntry>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CliError(`image cache index is damaged: ${join(dir, INDEX)}`, 2);
    }
  }
  const fresh = new Map<string, Uint8Array>();
  let dirty = false;
  for (const [url, e] of Object.entries(index)) {
    if (e.status !== 'ok' || !e.file) continue;
    // A lost cache file is downloaded again rather than built as a link for good.
    const there = await deps.stat(join(dir, e.file)).then(
      () => true,
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return false;
        throw err;
      },
    );
    if (!there) {
      delete index[url];
      dirty = true;
    }
  }

  const write = async (name: string, data: string | Uint8Array, held: Held) => {
    const tmp = join(dir, `${name}.${process.pid}.tmp`);
    await deps.writeFile(tmp, data);
    held.assertHeld();
    await deps.rename(tmp, join(dir, name));
  };

  return {
    get: (url) => index[url],
    needsFetch: (url) => {
      const e = index[url];
      return !e || e.status === 'temp';
    },
    record: (url, outcome, now) => {
      const prev = index[url];
      dirty = true;
      if (outcome.kind === 'ok') {
        const file = `${sha256(url)}.${outcome.ext}`;
        fresh.set(file, outcome.bytes);
        index[url] = { file, status: 'ok', failures: 0, checkedAt: now };
        return;
      }
      if (outcome.kind === 'gone') {
        index[url] = { status: 'gone', failures: prev?.failures ?? 0, checkedAt: now };
        return;
      }
      const e: ImageEntry = {
        status: 'temp',
        failures: prev?.failures ?? 0,
        checkedAt: now,
        ...(prev?.firstFailureAt !== undefined ? { firstFailureAt: prev.firstFailureAt } : {}),
      };
      if (outcome.counts) {
        e.failures += 1;
        e.firstFailureAt ??= now;
        // A hotlink guard answers 403 forever: give up after three days and three tries.
        if (e.failures >= GONE_AFTER_FAILURES && now - e.firstFailureAt > GONE_AFTER_MS) {
          e.status = 'gone';
        }
      }
      index[url] = e;
    },
    bytes: async (url) => {
      const e = index[url];
      if (e?.status !== 'ok' || !e.file) return null;
      const ext = e.file.slice(e.file.lastIndexOf('.') + 1) as Ext;
      const mem = fresh.get(e.file);
      if (mem) return { bytes: mem, ext };
      try {
        return { bytes: await deps.readFile(join(dir, e.file)), ext };
      } catch {
        return null;
      }
    },
    save: async (held) => {
      if (!dirty) return;
      await deps.mkdir(dir);
      for (const [name, data] of fresh) await write(name, data, held);
      fresh.clear();
      await write(INDEX, `${JSON.stringify(index, null, 2)}\n`, held);
      dirty = false;
    },
  };
};
