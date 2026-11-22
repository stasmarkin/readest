import { join } from 'node:path';
import { CliError } from '../../cli/lib/errors.ts';
import { readBookFile } from '../../cli/lib/metadata.ts';
import type { SyncDeps } from './deps.ts';
import type { ImageCache } from './images.ts';
import { sniffExt } from './images.ts';
import type { BuiltMeta, PandocMeta } from './meta.ts';
import { resolveLocal, sha256 } from './scan.ts';
import type { ScannedFile } from './scan.ts';

export type Node = { t: string; c?: unknown };
export type PandocDoc = {
  'pandoc-api-version': unknown;
  meta: Record<string, unknown>;
  blocks: unknown[];
};

export const PANDOC_TIMEOUT_MS = 120_000;
const DEAD_PROXY = 'http://127.0.0.1:9';
// A fetch pandoc should never make fails on a dead proxy instead of leaving the machine.
export const NO_NETWORK_ENV = {
  HTTP_PROXY: DEAD_PROXY,
  HTTPS_PROXY: DEAD_PROXY,
  ALL_PROXY: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
  all_proxy: DEAD_PROXY,
  NO_PROXY: '',
  no_proxy: '',
};

export const slugOf = (relpath: string): string =>
  `${relpath
    .replace(/\.md$/, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 100)}-${sha256(relpath).slice(0, 8)}`;

const isNode = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as Node).t === 'string';

const isRawHtml = (n: Node) =>
  (n.t === 'RawBlock' || n.t === 'RawInline') &&
  Array.isArray(n.c) &&
  ['html', 'html4', 'html5'].includes(String(n.c[0]).toLowerCase());

/** Every node of the tree, depth first. */
const visit = (v: unknown, fn: (n: Node) => void) => {
  if (Array.isArray(v)) {
    for (const x of v) visit(x, fn);
    return;
  }
  if (!isNode(v)) return;
  fn(v);
  visit(v.c, fn);
};

/** Lists of nodes rebuilt with `fn`: a node may be replaced by any number of nodes. */
const flatMapNodes = (v: unknown, fn: (n: Node) => unknown[] | null): unknown => {
  if (Array.isArray(v)) {
    return v.flatMap((x) => {
      const replaced = isNode(x) ? fn(x) : null;
      return replaced ?? [flatMapNodes(x, fn)];
    });
  }
  if (isNode(v) && v.c !== undefined) return { ...v, c: flatMapNodes(v.c, fn) };
  return v;
};

const attr = (tag: string, name: string): string | undefined => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  const v = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  return v?.replace(/&amp;/g, '&');
};

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The HTML reader fetches an iframe's src to inline its page: a link instead, or its fallback content. */
const iframesToLinks = (html: string): string =>
  html
    // Dropped by the reader anyway; a literal <iframe> in one must not open a match.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<iframe\b[^>]*>(?:([\s\S]*?)<\/iframe\s*>)?/gi, (tag, inner?: string) => {
      const src = attr(tag.slice(0, tag.indexOf('>') + 1), 'src')
        ?.trim()
        .replace(/^\/\//, 'https://');
      return src && /^https?:\/\//i.test(src)
        ? `<a href="${escapeAttr(src)}">[встроенное содержимое]</a>`
        : iframesToLinks(inner ?? '');
    });

const imageNode = (src: string, alt = ''): Node => ({
  t: 'Image',
  c: [['', [], []], alt ? [{ t: 'Str', c: alt }] : [], [src, '']],
});

const pandoc = async (
  deps: SyncDeps,
  args: string[],
  input: string,
  extra: { env?: Record<string, string>; cwd?: string } = {},
) => {
  const r = await deps.run('pandoc', args, {
    input,
    timeoutMs: PANDOC_TIMEOUT_MS,
    env: { ...NO_NETWORK_ENV, ...extra.env },
    ...(extra.cwd ? { cwd: extra.cwd } : {}),
  });
  if (r.code !== 0) {
    throw new CliError(`pandoc failed (${r.code ?? 'timeout'}): ${r.stderr.trim().slice(0, 300)}`);
  }
  if (/Could not fetch/i.test(r.stderr)) {
    throw new CliError(`pandoc tried the network: ${r.stderr.trim().slice(0, 300)}`);
  }
  return r.stdout;
};

const parseDoc = (json: string): PandocDoc => {
  const v = JSON.parse(json) as PandocDoc;
  if (!Array.isArray(v.blocks)) throw new CliError('pandoc returned no blocks');
  return v;
};

/**
 * The body as a pandoc tree with no raw HTML left: an HTML block is read again as
 * HTML (text around images stays), an inline <img> becomes an Image, other inline tags go.
 */
export const parseBody = async (deps: SyncDeps, body: string): Promise<PandocDoc> => {
  const doc = parseDoc(await pandoc(deps, ['--from', 'gfm', '--to', 'json'], body));
  const htmlBlocks = new Map<string, unknown[]>();
  visit(doc.blocks, (n) => {
    if (n.t === 'RawBlock' && isRawHtml(n)) htmlBlocks.set(String((n.c as unknown[])[1]), []);
  });
  for (const html of htmlBlocks.keys()) {
    htmlBlocks.set(
      html,
      parseDoc(
        await pandoc(deps, ['--from', 'html-raw_html', '--to', 'json'], iframesToLinks(html)),
      ).blocks,
    );
  }
  doc.blocks = flatMapNodes(doc.blocks, (n) => {
    if (!isRawHtml(n)) return null;
    const text = String((n.c as unknown[])[1]);
    if (n.t === 'RawBlock') return htmlBlocks.get(text) ?? [];
    if (/^<img\b/i.test(text)) {
      const src = attr(text, 'src');
      return src ? [imageNode(src, attr(text, 'alt'))] : [];
    }
    return [];
  }) as unknown[];
  return doc;
};

const imageUrl = (n: Node): string => String(((n.c as unknown[])[2] as unknown[])[0]);

/** Remote images of the tree, for the download before the build. */
export const collectImageUrls = (doc: PandocDoc): string[] => {
  const urls = new Set<string>();
  visit(doc.blocks, (n) => {
    if (n.t === 'Image' && /^https?:\/\//i.test(imageUrl(n))) urls.add(imageUrl(n));
  });
  return [...urls];
};

/** The last line of defence: pandoc must not see a remote image or raw HTML. */
export const checkAst = (doc: PandocDoc, local: Set<string>) => {
  visit(doc.blocks, (n) => {
    if (isRawHtml(n)) throw new CliError('raw HTML left in the tree');
    if (n.t === 'Image' && !local.has(imageUrl(n))) {
      throw new CliError(`image is not local: ${imageUrl(n)}`);
    }
  });
};

const metaValue = (v: string | string[]) =>
  Array.isArray(v)
    ? { t: 'MetaList', c: v.map((s) => ({ t: 'MetaString', c: s })) }
    : { t: 'MetaString', c: v };

/** MetaString, not a metadata file: pandoc would read YAML values as Markdown and mangle `_` and `*`. */
export const pandocMeta = (m: PandocMeta): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) if (v !== undefined) out[k] = metaValue(v);
  return out;
};

export type BuiltEpub = {
  bytes: Uint8Array;
  fileName: string;
  epubSha256: string;
  bookHash: string;
  metaHash: string;
  title: string;
  imagesComplete: boolean;
  tempUrls: string[];
  missingImages: string[];
};

export const buildEpub = async (o: {
  relpath: string;
  scanned: ScannedFile;
  built: BuiltMeta;
  doc: PandocDoc;
  cache: ImageCache;
  tmpDir: string;
  deps: SyncDeps;
}): Promise<BuiltEpub> => {
  const { deps, relpath } = o;
  const dir = join(o.tmpDir, sha256(relpath).slice(0, 16));
  await deps.rm(dir);
  await deps.mkdir(dir);
  try {
    const doc: PandocDoc = JSON.parse(JSON.stringify(o.doc));
    const local = new Set<string>();
    const temp = new Set<string>();
    const missing = new Set<string>();
    const images: Node[] = [];
    visit(doc.blocks, (n) => {
      if (n.t === 'Image') images.push(n);
    });
    for (const n of images) {
      const url = imageUrl(n);
      let got: { bytes: Uint8Array; ext: string; name: string } | null = null;
      if (/^https?:\/\//i.test(url)) {
        const c = await o.cache.bytes(url);
        if (c) got = { ...c, name: `img-${sha256(url).slice(0, 16)}.${c.ext}` };
        else {
          missing.add(url);
          if (o.cache.get(url)?.status !== 'gone') temp.add(url);
        }
      } else {
        const key = resolveLocal(relpath, url);
        const li = key === null ? null : (o.scanned.localImages.get(key) ?? null);
        const ext = li ? sniffExt(li.bytes) : null;
        if (li && ext)
          got = { bytes: li.bytes, ext, name: `loc-${sha256(key!).slice(0, 16)}.${ext}` };
      }
      const c = n.c as unknown[];
      if (got) {
        if (!local.has(got.name)) await deps.writeFile(join(dir, got.name), got.bytes);
        local.add(got.name);
        c[2] = [got.name, (c[2] as unknown[])[1]];
      } else {
        // What cannot be had stays reachable as a link to where it was.
        n.t = 'Link';
        n.c = [c[0], [{ t: 'Str', c: '[картинка]' }], [url, '']];
      }
    }
    checkAst(doc, local);
    doc.meta = pandocMeta(o.built.meta);
    const fileName = `${slugOf(relpath)}.epub`;
    const out = join(dir, fileName);
    await pandoc(
      deps,
      ['-', '--from', 'json', '--to', 'epub3', '--resource-path', dir, '-o', out],
      JSON.stringify(doc),
      { env: { SOURCE_DATE_EPOCH: String(o.built.epoch) }, cwd: dir },
    );
    const bytes = await deps.readFile(out);
    const info = await readBookFile(out);
    return {
      bytes,
      fileName,
      epubSha256: sha256(bytes),
      bookHash: info.hash,
      metaHash: info.metaHash,
      title: info.title,
      imagesComplete: temp.size === 0,
      tempUrls: [...temp],
      missingImages: [...missing],
    };
  } finally {
    await deps.rm(dir);
  }
};
