// A stand-in for pandoc in the sync tests: instant and deterministic. It reads the plain
// paragraphs and `![alt](url)` images the tests write and builds a minimal EPUB that
// readBookFile parses; the real pandoc is exercised by epub.test only.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import type { RunOpts, RunResult } from '../../../../../selfhost/clippings/lib/deps.ts';

type Inline = { t: string; c?: unknown };
type Meta = { t: 'MetaString'; c: string } | { t: 'MetaList'; c: Array<{ c: string }> };

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const IMAGE = /(!\[[^\]]*\]\([^)\s<>]+\))/;
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const fail = (stderr: string): RunResult => ({ code: 1, stdout: '', stderr });

const inlines = (text: string): Inline[] => {
  const out: Inline[] = [];
  for (const part of text.split(IMAGE)) {
    const img = part.match(/^!\[([^\]]*)\]\(([^)\s<>]+)\)$/);
    if (img) {
      const alt = img[1] ? [{ t: 'Str', c: img[1] }] : [];
      out.push({ t: 'Image', c: [['', [], []], alt, [img[2], '']] });
      continue;
    }
    for (const tok of part.split(/(\s+)/)) {
      if (!tok) continue;
      if (!/^\s+$/.test(tok)) out.push({ t: 'Str', c: tok });
      else out.push({ t: tok.includes('\n') ? 'SoftBreak' : 'Space' });
    }
  }
  return out;
};

const markdownToJson = (md: string): RunResult => {
  // Anything richer would need the real reader: a test that writes it belongs in epub.test.
  const text = md.split(IMAGE).filter((_, i) => i % 2 === 0);
  if (text.some((t) => /[<>`*_#|]|\]\[|\]:|\]\(|^\s*([-+]|\d+\.)\s/m.test(t)))
    return fail(`fake pandoc: unsupported markdown: ${md}`);
  const blocks = md
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => ({ t: 'Para', c: inlines(p) }));
  return ok(JSON.stringify({ 'pandoc-api-version': [1, 23, 1], meta: {}, blocks }));
};

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const metaValues = (m: Meta | undefined): string[] =>
  m === undefined ? [] : m.t === 'MetaString' ? [m.c] : m.c.map((x) => x.c);

/** A stored (uncompressed) zip: what a reader of the EPUB container needs, nothing more. */
const zip = (files: Array<[string, Uint8Array]>): Uint8Array => {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + n.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    local.set(data, 30 + n.length);
    const cd = new Uint8Array(46 + n.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    cd.set(n, 46);
    locals.push(local);
    central.push(cd);
    offset += local.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...central, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
};

const jsonToEpub = (args: string[], input: string): RunResult => {
  const resources = flag(args, '--resource-path');
  const outPath = flag(args, '-o');
  if (!resources || !outPath)
    return fail(`fake pandoc: no --resource-path or -o: ${args.join(' ')}`);
  const doc = JSON.parse(input) as { meta: Record<string, Meta>; blocks: unknown[] };
  const text: string[] = [];
  const images: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (typeof v !== 'object' || v === null || !('t' in v)) return;
    const n = v as Inline;
    if (n.t === 'Str') text.push(xml(String(n.c)));
    else if (n.t === 'Space' || n.t === 'SoftBreak') text.push(' ');
    else if (n.t === 'Image') {
      const src = String(((n.c as unknown[])[2] as unknown[])[0]);
      images.push(src);
      text.push(`<img src="${xml(src)}" alt=""/>`);
    } else if (n.t === 'Para') {
      text.push('<p>');
      walk(n.c);
      text.push('</p>');
    } else walk(n.c);
  };
  walk(doc.blocks);
  const m = (k: string) => metaValues(doc.meta[k]);
  const dc = (k: string, tag = k) => m(k).map((v) => `<dc:${tag}>${xml(v)}</dc:${tag}>`);
  const opf = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">',
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<dc:identifier id="id">${xml(m('identifier')[0] ?? '')}</dc:identifier>`,
    ...dc('title'),
    ...dc('author', 'creator'),
    ...dc('lang', 'language'),
    ...dc('relation'),
    '</metadata>',
    '<manifest><item id="t" href="t.xhtml" media-type="application/xhtml+xml"/></manifest>',
    '<spine><itemref idref="t"/></spine>',
    '</package>',
  ].join('\n');
  const body = `<html xmlns="http://www.w3.org/1999/xhtml"><body>${text.join('')}</body></html>`;
  const enc = new TextEncoder();
  const files: Array<[string, Uint8Array]> = [
    ['mimetype', enc.encode('application/epub+zip')],
    [
      'META-INF/container.xml',
      enc.encode(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
    ],
    ['content.opf', enc.encode(opf)],
    ['t.xhtml', enc.encode(body)],
  ];
  for (const src of new Set(images)) {
    try {
      files.push([src, new Uint8Array(readFileSync(join(resources, src)))]);
    } catch {
      return fail(`fake pandoc: missing resource ${src}`);
    }
  }
  writeFileSync(outPath, zip(files));
  return ok();
};

/** Answers md→json, json→epub and `--version`; HTML input is refused (only epub.test has it). */
export const fakePandoc = async (args: string[], opts: RunOpts): Promise<RunResult> => {
  if (args[0] === '--version') return ok('pandoc fake\n');
  const from = flag(args, '--from');
  const to = flag(args, '--to');
  if (from === 'gfm' && to === 'json') return markdownToJson(opts.input ?? '');
  if (from === 'json' && to === 'epub3') return jsonToEpub(args, opts.input ?? '');
  return fail(`fake pandoc: unsupported call: ${args.join(' ')}`);
};
