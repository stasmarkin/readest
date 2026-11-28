import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { DocumentLoader } from '@/libs/document';
import type { BookMetadata } from '@/libs/document';
import { getMetadataHash } from '@/utils/book';
import {
  buildEpub,
  checkAst,
  collectImageUrls,
  parseBody,
  slugOf,
} from '../../../../../selfhost/clippings/lib/epub.ts';
import type { PandocDoc } from '../../../../../selfhost/clippings/lib/epub.ts';
import { spawnRun } from '../../../../../selfhost/clippings/lib/deps.ts';
import type { RunOpts, RunResult } from '../../../../../selfhost/clippings/lib/deps.ts';
import { loadImageCache } from '../../../../../selfhost/clippings/lib/images.ts';
import type { ImageCache } from '../../../../../selfhost/clippings/lib/images.ts';
import { buildMeta } from '../../../../../selfhost/clippings/lib/meta.ts';
import { sha256, srcKeyOf } from '../../../../../selfhost/clippings/lib/scan.ts';
import type { LocalImage, ScannedFile } from '../../../../../selfhost/clippings/lib/scan.ts';
import { partialMD5Bytes } from '../../../../../selfhost/cli/lib/hash.ts';
import { syncDeps } from './helpers';
import type { RunCall } from './helpers';
import { DAY, world } from './world';

vi.mock('foliate-js/paginator.js', () => ({}));

const pandocVersion = (() => {
  try {
    return execFileSync('pandoc', ['--version'], { encoding: 'utf8' }).split('\n')[0]!;
  } catch {
    return '';
  }
})();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clip-epub-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const setup = async (
  over: {
    run?: (c: string, a: string[], o: RunOpts) => Promise<RunResult>;
    now?: () => number;
  } = {},
) => {
  const s = syncDeps(dir, { run: over.run ?? spawnRun, ...(over.now ? { now: over.now } : {}) });
  const cache = await loadImageCache(s.deps, join(dir, 'images'));
  return { ...s, cache };
};

const scannedOf = (md: string, local: Record<string, Uint8Array | null> = {}): ScannedFile => {
  const bytes = new TextEncoder().encode(md);
  const localImages = new Map<string, LocalImage | null>(
    Object.entries(local).map(([k, v]) => [k, v ? { sha256: sha256(v), bytes: v } : null]),
  );
  return { bytes, localImages, srcKey: srcKeyOf(bytes, localImages) };
};

const build = async (
  s: { deps: ReturnType<typeof syncDeps>['deps']; cache: ImageCache },
  relpath: string,
  md: string,
  local: Record<string, Uint8Array | null> = {},
) => {
  const scanned = scannedOf(md, local);
  const built = buildMeta(relpath, md, scanned.srcKey);
  const doc = await parseBody(s.deps, built.body);
  const epub = await buildEpub({
    relpath,
    scanned,
    built,
    doc,
    cache: s.cache,
    tmpDir: join(dir, 'tmp'),
    deps: s.deps,
  });
  return { ...epub, doc };
};

const epubInput = (calls: RunCall[]): PandocDoc =>
  JSON.parse(calls.find((c) => c.args.includes('epub3'))!.opts.input!) as PandocDoc;

const nodesOf = (doc: PandocDoc, t: string) => {
  const out: Array<{ t: string; c: unknown }> = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object' && 't' in v) {
      const n = v as { t: string; c: unknown };
      if (n.t === t) out.push(n);
      walk(n.c);
    }
  };
  walk(doc.blocks);
  return out;
};
const strs = (doc: PandocDoc) => nodesOf(doc, 'Str').map((n) => n.c as string);
const urlOf = (n: { c: unknown }) => ((n.c as unknown[])[2] as string[])[0]!;

const DATED = '---\ntitle: Dated\npublished: 2026-11-11\n---\nOne word here.\n';

describe.skipIf(!pandocVersion)(
  `buildEpub on real pandoc (${pandocVersion || 'pandoc not installed'})`,
  // Up to 6 pandoc processes a test: a loaded machine slows each spawn, not the code under test.
  { timeout: 30_000 },
  () => {
    it('every kind of image becomes a local Image; no raw HTML; a missing one a link', async () => {
      const s = await setup();
      const ok = (u: string, b = PNG) =>
        s.cache.record(u, { kind: 'ok', bytes: b, ext: b === JPG ? 'jpg' : 'png' }, 1);
      for (const u of ['a', 'r', 'd', 'd2', 'p']) ok(`https://x.test/${u}.png`);
      s.cache.record('https://x.test/gone.png', { kind: 'gone' }, 1);
      const md = [
        'Text ![alt](https://x.test/a.png) and <img src="https://x.test/a.png"> <span>s</span>end',
        '',
        '![ref][r]',
        '',
        '[r]: https://x.test/r.png',
        '',
        '<div>до<img src="https://x.test/d.png">после<img src="https://x.test/d2.png"></div>',
        '',
        '<picture><source srcset="https://x.test/p.webp 2x"><img src="https://x.test/p.png"></picture>',
        '',
        '![](img/local.png) ![](https://x.test/gone.png)',
      ].join('\n');
      const r = await build(s, 'sub/a.md', md, { 'sub/img/local.png': PNG });
      const doc = epubInput(s.calls);
      expect(nodesOf(doc, 'RawBlock'), 'no raw block').toEqual([]);
      expect(nodesOf(doc, 'RawInline'), 'no raw inline').toEqual([]);
      const images = nodesOf(doc, 'Image').map(urlOf);
      expect(images).toHaveLength(7);
      for (const u of images) expect(u).toMatch(/^(img|loc)-[0-9a-f]{16}\.png$/);
      expect(strs(doc)).toEqual(expect.arrayContaining(['до', 'после', 's', 'end', '[картинка]']));
      const links = nodesOf(doc, 'Link').map(urlOf);
      expect(links).toEqual(['https://x.test/gone.png']);
      expect(r.missingImages).toEqual(['https://x.test/gone.png']);
      expect(r.imagesComplete, 'gone does not count').toBe(true);
      expect(collectImageUrls(r.doc)).toEqual([
        'https://x.test/a.png',
        'https://x.test/r.png',
        'https://x.test/d.png',
        'https://x.test/d2.png',
        'https://x.test/p.png',
        'https://x.test/gone.png',
      ]);
    });

    it('a not yet downloaded image is a link and a temp URL', async () => {
      const s = await setup();
      const r = await build(s, 'a.md', '![](https://x.test/later.png)');
      expect(r.imagesComplete).toBe(false);
      expect(r.tempUrls).toEqual(['https://x.test/later.png']);
      expect(nodesOf(epubInput(s.calls), 'Image')).toEqual([]);
    });

    it('same input at another time: the same bytes; SOURCE_DATE_EPOCH from the date, else 0', async () => {
      let t = Date.UTC(2026, 10, 22);
      const s = await setup({ now: () => t });
      const a = await build(s, 'a.md', DATED);
      t += 24 * 60 * 60 * 1000;
      await new Promise((r) => setTimeout(r, 1100));
      const b = await build(s, 'a.md', DATED);
      expect(b.epubSha256).toBe(a.epubSha256);
      expect(Buffer.from(b.bytes).equals(Buffer.from(a.bytes))).toBe(true);
      await build(s, 'b.md', 'no date');
      const epochs = s.calls
        .filter((c) => c.args.includes('epub3'))
        .map((c) => c.opts.env?.['SOURCE_DATE_EPOCH']);
      expect(epochs).toEqual([
        String(Date.UTC(2026, 10, 11) / 1000),
        String(Date.UTC(2026, 10, 11) / 1000),
        '0',
      ]);
      for (const c of s.calls) {
        for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) {
          expect(c.opts.env?.[k], `${k} of every pandoc call`).toBe('http://127.0.0.1:9');
        }
      }
    });

    it('one word changed: another partialMD5', async () => {
      const s = await setup();
      const a = await build(s, 'a.md', DATED);
      const b = await build(s, 'a.md', DATED.replace('word', 'Word'));
      expect(partialMD5Bytes(b.bytes)).not.toBe(partialMD5Bytes(a.bytes));
    });

    it('one word changed: another book hash with an image over 1 MiB', async () => {
      const s = await setup();
      const big = new Uint8Array(randomBytes(1536 * 1024));
      big.set(PNG);
      s.cache.record('https://x.test/big.png', { kind: 'ok', bytes: big, ext: 'png' }, 1);
      const withImg = `${DATED}\n![](https://x.test/big.png)\n`;
      const c = await build(s, 'a.md', withImg);
      const d = await build(s, 'a.md', withImg.replace('word', 'Word'));
      expect(c.bytes.length).toBeGreaterThan(1024 * 1024);
      expect(d.bookHash).not.toBe(c.bookHash);
    });

    it('the file is <slug>.epub; the build directory is gone on success and on a pandoc failure', async () => {
      expect(slugOf('Папка/Статья: тест.md')).toBe(
        `${'_'.repeat(18)}-${sha256('Папка/Статья: тест.md').slice(0, 8)}`,
      );
      expect(slugOf('a b/c.md')).toMatch(/^a_b_c-[0-9a-f]{8}$/);
      const s = await setup();
      const r = await build(s, 'dir/x y.md', 'hi');
      expect(r.fileName).toBe(`${slugOf('dir/x y.md')}.epub`);
      expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
      const failing = await setup({
        run: async (c, a, o) =>
          a.includes('epub3') ? { code: 64, stdout: '', stderr: 'boom' } : spawnRun(c, a, o),
      });
      await expect(build(failing, 'dir/x y.md', 'hi')).rejects.toThrow(/pandoc failed/);
      expect(readdirSync(join(dir, 'tmp'))).toEqual([]);
    });

    it("OPF metadata and media types; metaHash equals the app's getMetadataHash", async () => {
      const s = await setup();
      s.cache.record('https://x.test/j', { kind: 'ok', bytes: JPG, ext: 'jpg' }, 1);
      const md = `---\ntitle: "T _x_"\nauthor:\n  - "[[Addy Osmani]]"\n---\nПривет ![](https://x.test/j) ![](p.png)\n`;
      const r = await build(s, 'dir/a_b_.md', md, { 'dir/p.png': PNG });
      const zip = unzipSync(r.bytes);
      const opf = strFromU8(zip['EPUB/content.opf']!);
      expect(opf).toContain(
        '<dc:identifier id="epub-id-1">obsidian-clipping:dir/a_b_.md</dc:identifier>',
      );
      expect(opf).toMatch(/<dc:relation>src:[0-9a-f]{64}<\/dc:relation>/);
      expect(opf).toContain('<dc:language>ru</dc:language>');
      expect(opf).toContain('<dc:title id="epub-title-1">T _x_</dc:title>');
      expect(opf).toMatch(/media-type="image\/jpeg"/);
      expect(opf).toMatch(/media-type="image\/png"/);
      const { book } = await new DocumentLoader(new File([r.bytes as BlobPart], r.fileName)).open();
      expect(r.metaHash).toBe(getMetadataHash({ ...book.metadata } as BookMetadata));
      expect(r.title).toBe('T _x_');
    });

    it('an iframe becomes a link to its src: pandoc must not fetch it', async () => {
      const s = await setup();
      const md = [
        'До',
        '',
        '<iframe allowfullscreen="true" src="https://video.test/player?a=1&amp;b=2" width="315"></iframe>',
        '',
        'После',
      ].join('\n');
      const doc = await parseBody(s.deps, md);
      expect(nodesOf(doc, 'Link').map(urlOf)).toEqual(['https://video.test/player?a=1&b=2']);
      const other = await parseBody(
        s.deps,
        [
          '<div>a <!-- <iframe> --> b <iframe src="//v.test/x"></iframe> c',
          '<iframe><a href="https://v.test/fb">запасная</a></iframe> d',
          '<iframe><iframe src="https://v.test/in">x</iframe></iframe> e',
          '<iframe src="https://v.test/open"> f</div>',
        ].join('\n'),
      );
      expect(nodesOf(other, 'Link').map(urlOf)).toEqual([
        'https://v.test/x',
        'https://v.test/fb',
        'https://v.test/in',
        'https://v.test/open',
      ]);
      expect(strs(other)).toEqual(
        expect.arrayContaining(['a', 'b', 'c', 'запасная', 'd', 'e', 'f']),
      );
      expect(strs(doc)).toEqual(
        expect.arrayContaining(['До', '[встроенное', 'содержимое]', 'После']),
      );
    });

    it('a sync run on real pandoc: uploaded; a rerun a day later does nothing; an edit replaces it', async () => {
      const W = world();
      try {
        W.w.pandoc = (args, opts) => spawnRun('pandoc', args, opts);
        const src = (body: string) => `---\ntitle: A\n---\nText <b>bold</b> ![](p.png) ${body}\n`;
        W.put('a.md', src('v1'));
        writeFileSync(join(W.w.vault, 'p.png'), PNG);
        const r = await W.sync();
        expect(r.code, r.err).toBe(0);
        expect(r.out).toMatch(/^uploaded a\.md — /);
        const h = W.state().files['a.md']!.bookHash;
        expect(W.live().map((b) => b.hash)).toEqual([h]);
        W.w.t += DAY;
        expect((await W.sync()).out).toBe('итог: +0 ~0 -0, отложено 0, ошибок 0\n');
        W.put('a.md', src('v2'));
        const e = await W.sync();
        expect(e.out).toMatch(/^replaced a\.md — /);
        expect(W.live().map((b) => b.hash)).toEqual([W.state().files['a.md']!.bookHash]);
        expect(W.state().files['a.md']!.bookHash).not.toBe(h);
      } finally {
        W.cleanup();
      }
    });

    it('pandoc reporting a fetch is an error of the file', async () => {
      const s = await setup({
        run: async (c, a, o) => {
          const r = await spawnRun(c, a, o);
          return a.includes('epub3') ? { ...r, stderr: '[WARNING] Could not fetch resource x' } : r;
        },
      });
      await expect(build(s, 'a.md', 'hi')).rejects.toThrow(/network/);
    });
  },
);

describe('checkAst', () => {
  it('a remote image slipped past the rewrite, or raw HTML: an error of the file', () => {
    const img = (u: string): PandocDoc => ({
      'pandoc-api-version': [1, 23],
      meta: {},
      blocks: [{ t: 'Para', c: [{ t: 'Image', c: [['', [], []], [], [u, '']] }] }],
    });
    expect(() => checkAst(img('img-1.png'), new Set(['img-1.png']))).not.toThrow();
    expect(() => checkAst(img('https://x.test/a.png'), new Set(['img-1.png']))).toThrow(
      /not local/,
    );
    expect(() =>
      checkAst(
        { 'pandoc-api-version': [1], meta: {}, blocks: [{ t: 'RawBlock', c: ['html', '<b>'] }] },
        new Set(),
      ),
    ).toThrow(/raw HTML/);
  });
});
