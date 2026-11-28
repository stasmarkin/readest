import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { zipSync, strToU8 } from 'fflate';
import { DocumentLoader } from '@/libs/document';
import type { BookMetadata } from '@/libs/document';
import { formatAuthors, formatTitle, getMetadataHash, getPrimaryLanguage } from '@/utils/book';
import { getBaseFilename, stripDuplicateMarker } from '@/utils/path';
import {
  detectFormat,
  formatAuthorsLike,
  parseXrefSection,
  primaryLanguage,
  readBookFile,
} from '../../../../../selfhost/cli/lib/metadata.ts';
import type { BookFileInfo } from '../../../../../selfhost/cli/lib/metadata.ts';

vi.mock('foliate-js/paginator.js', () => ({}));

const FIXTURES = resolve(__dirname, '../fixtures/data');
const E2E_BOOKS = resolve(__dirname, '../../../e2e/fixtures/books');
const dir = mkdtempSync(join(tmpdir(), 'readest-cli-meta-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeAll(async () => {
  await import('@pdfjs/pdf.min.mjs');
  const pdfjsLib = (globalThis as Record<string, unknown>)['pdfjsLib'] as {
    GlobalWorkerOptions: { workerSrc: string };
  };
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    `file://${join(process.cwd(), 'public/vendor/pdfjs/pdf.worker.min.mjs')}`,
  ).href;
}, 30_000);

type Expected = {
  format: string;
  metaHash: string;
  title: string;
  sourceTitle: string;
  author: string;
  language: unknown;
  publisher: unknown;
  published: unknown;
  description: unknown;
  subject: unknown;
  series: unknown;
  seriesIndex: unknown;
  cover?: Uint8Array;
  coverType?: string;
};

/** The app's importBook rules over the real DocumentLoader. */
const appExpected = async (bytes: Uint8Array, name: string): Promise<Expected> => {
  const { book, format } = await new DocumentLoader(new File([bytes as BlobPart], name)).open();
  const md = { ...book.metadata } as BookMetadata;
  const filename = stripDuplicateMarker(name);
  const metadataTitle = formatTitle(md.title);
  if (!metadataTitle || !metadataTitle.trim() || metadataTitle === filename) {
    md.title = getBaseFilename(filename);
  }
  const salted = format === 'PDF';
  const primary = getPrimaryLanguage(md.language);
  let series: unknown;
  let seriesIndex: unknown;
  const belongsTo = md.belongsTo?.series;
  if (belongsTo) {
    const s = Array.isArray(belongsTo) ? belongsTo[0] : belongsTo;
    if (s) {
      series = formatTitle(s.name);
      const index = parseFloat(String(s.position ?? ''));
      seriesIndex = Number.isFinite(index) ? index : undefined;
    }
  }
  // A PDF cover is a page render, which needs a canvas jsdom lacks; the CLI uploads none.
  const coverBlob = format === 'PDF' ? null : await book.getCover();
  return {
    format,
    metaHash: getMetadataHash(md, salted ? getBaseFilename(filename) : undefined)!,
    title: format === 'PDF' ? filename.replace(/\.[^.]*$/, '') : formatTitle(md.title),
    sourceTitle: formatTitle(md.title),
    author: formatAuthors(md.author, primary),
    language: md.language,
    publisher: md.publisher,
    published: md.published,
    description: md.description,
    subject: md.subject,
    series,
    seriesIndex,
    cover: coverBlob ? new Uint8Array(await coverBlob.arrayBuffer()) : undefined,
    coverType: coverBlob?.type,
  };
};

let seq = 0;
const cliRead = async (bytes: Uint8Array, name: string): Promise<BookFileInfo> => {
  const sub = join(dir, String(seq++));
  rmSync(sub, { recursive: true, force: true });
  const path = join(sub, name);
  mkdirSync(sub, { recursive: true });
  writeFileSync(path, bytes);
  return readBookFile(path);
};

const expectParity = async (
  bytes: Uint8Array,
  name: string,
  opts: { metadataFields?: boolean } = {},
) => {
  const ref = await appExpected(bytes, name);
  const cli = await cliRead(bytes, name);
  expect(cli.format, 'format').toBe(ref.format);
  expect(cli.metaHash, 'metaHash').toBe(ref.metaHash);
  expect(cli.title, 'title').toBe(ref.title);
  expect(cli.sourceTitle, 'sourceTitle').toBe(ref.sourceTitle);
  expect(cli.author, 'author').toBe(ref.author);
  expect(cli.originalFilename, 'originalFilename').toBe(name);
  if (opts.metadataFields !== false) {
    const m = cli.metadata;
    expect(m.language, 'language').toEqual(ref.language);
    expect(m.publisher, 'publisher').toEqual(ref.publisher);
    expect(m.published, 'published').toEqual(ref.published);
    expect(m.description, 'description').toEqual(ref.description);
    expect(m.subject, 'subject').toEqual(ref.subject);
    expect(m.series, 'series').toEqual(ref.series);
    expect(m.seriesIndex, 'seriesIndex').toEqual(ref.seriesIndex);
  }
  return { ref, cli };
};

// ------------------------------------------------------------------ builders

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

type EpubOpts = {
  version?: string;
  pkgAttrs?: string;
  metaAttrs?: string;
  manifest?: string;
  files?: Record<string, Uint8Array>;
  noMimetype?: boolean;
};

const makeEpub = (metadata: string, opts: EpubOpts = {}): Uint8Array => {
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${opts.version ?? '3.0'}" unique-identifier="uid" ${opts.pkgAttrs ?? ''}>
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf" ${opts.metaAttrs ?? ''}>
    ${metadata}
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    ${opts.manifest ?? ''}
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;
  return zipSync({
    ...(opts.noMimetype ? {} : { mimetype: [strToU8('application/epub+zip'), { level: 0 }] }),
    'META-INF/container.xml': strToU8(CONTAINER),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/ch1.xhtml': strToU8(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body><p>x</p></body></html>',
    ),
    ...opts.files,
  });
};

const image = (seed: number, header: number[]): Uint8Array => {
  const out = new Uint8Array(300);
  out.set(header);
  for (let i = header.length; i < out.length; i++) out[i] = (i * 31 + seed) & 0xff;
  return out;
};
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff, 0xe0];

// ------------------------------------------------------------------ EPUB

describe('EPUB parity', () => {
  it.each([
    ['sample-alice.epub', FIXTURES],
    ['repro-duokan-cover-percent.epub', FIXTURES],
    ['orientation-bilingual.epub', E2E_BOOKS],
  ])('fixture %s', async (name, base) => {
    const { ref, cli } = await expectParity(new Uint8Array(readFileSync(join(base, name))), name);
    expect(cli.cover).toEqual(ref.coverType === 'image/svg+xml' ? undefined : ref.cover);
  });

  const cases: Array<[string, string, EpubOpts?]> = [
    [
      'refines title-type, file-as, alternate-script',
      `<dc:identifier id="uid">urn:uuid:0b6f2f6e-1111-2222-3333-444455556666</dc:identifier>
       <dc:title id="t2">Роман</dc:title><meta refines="#t2" property="title-type">subtitle</meta>
       <dc:title id="t1">Солярис</dc:title><meta refines="#t1" property="title-type">main</meta>
       <meta refines="#t1" property="file-as">Солярис</meta>
       <meta refines="#t1" property="alternate-script" xml:lang="en">Solaris</meta>
       <dc:creator id="c1">Станислав Лем</dc:creator>
       <meta refines="#c1" property="file-as">Лем, Станислав</meta>
       <meta refines="#c1" property="alternate-script" xml:lang="en">Stanisław Lem</meta>
       <dc:language>ru</dc:language>`,
    ],
    [
      'refines role with and without marc:relators scheme',
      `<dc:title>Roles</dc:title>
       <dc:creator id="c1">Ed Itor</dc:creator><meta refines="#c1" property="role" scheme="marc:relators">edt</meta>
       <dc:creator id="c2">Real Author</dc:creator><meta refines="#c2" property="role">edt</meta>
       <dc:creator id="c3">Third Writer</dc:creator><meta refines="#c3" property="role" scheme="marc:relators">aut</meta>`,
    ],
    [
      'opf:role edt on creator (EPUB 2)',
      `<dc:title>Edited</dc:title>
       <dc:creator opf:role="edt" opf:file-as="Itor, Ed">Ed Itor</dc:creator>
       <dc:creator opf:role="aut">Main Author</dc:creator>`,
      { version: '2.0' },
    ],
    [
      'unknown creator role and contributor roles',
      `<dc:title>Contributors</dc:title>
       <dc:creator opf:role="xyz">Odd Role</dc:creator>
       <dc:contributor opf:role="aut">Contrib Author</dc:contributor>
       <dc:contributor opf:role="trl">Some Translator</dc:contributor>
       <dc:contributor>Plain Contributor</dc:contributor>`,
    ],
    ...['ru', 'rus', 'und', 'zho', 'en-US', 'xx'].map((lang): [string, string] => [
      `two authors with dc:language ${lang}`,
      `<dc:title>Двое</dc:title><dc:creator>Анна Иванова</dc:creator><dc:creator>Борис Петров</dc:creator>
         <dc:language>${lang}</dc:language>`,
    ]),
    [
      'three authors, two languages',
      `<dc:title>Trio</dc:title><dc:creator>A</dc:creator><dc:creator>B</dc:creator><dc:creator>C</dc:creator>
       <dc:language>de</dc:language><dc:language>en</dc:language>`,
    ],
    [
      'identifiers with opf:scheme, doi and ONIX refines',
      `<dc:title>Ids</dc:title><dc:creator>X</dc:creator>
       <dc:identifier id="uid" opf:scheme="calibre">1234</dc:identifier>
       <dc:identifier opf:scheme="ISBN">9780000000002</dc:identifier>
       <dc:identifier opf:scheme="uuid">aaaa-bbbb</dc:identifier>
       <dc:identifier>doi:10.1000/182</dc:identifier>
       <dc:identifier id="i5">9781234567897</dc:identifier>
       <meta refines="#i5" property="identifier-type" scheme="onix:codelist5">15</meta>
       <dc:identifier opf:scheme="AMAZON">B00X</dc:identifier>`,
    ],
    [
      'ONIX 15 and doi without a preferred scheme',
      `<dc:title>Onix</dc:title><dc:creator>X</dc:creator>
       <dc:identifier id="uid">9781234567897</dc:identifier>
       <meta refines="#uid" property="identifier-type" scheme="onix:codelist5">15</meta>
       <dc:identifier>doi:10.1000/182</dc:identifier>`,
    ],
    [
      'single uuid identifier with opf:scheme',
      `<dc:title>Uuid</dc:title><dc:creator>X</dc:creator><dc:identifier id="uid" opf:scheme="uuid">abc-def</dc:identifier>`,
    ],
    [
      'single urn identifier equal to the unique identifier',
      `<dc:title>Urn</dc:title><dc:creator>X</dc:creator><dc:identifier id="uid">urn:isbn:9780000000002</dc:identifier>`,
    ],
    [
      'calibre:series with index',
      `<dc:title>Saga 2</dc:title><dc:creator>X</dc:creator>
       <meta name="calibre:series" content="Saga"/><meta name="calibre:series_index" content="2.5"/>`,
    ],
    [
      'calibre:series without index',
      `<dc:title>Saga</dc:title><dc:creator>X</dc:creator><meta name="calibre:series" content="Saga"/>`,
    ],
    [
      'belongs-to-collection series with position',
      `<dc:title>Cycle 3</dc:title><dc:creator>X</dc:creator>
       <meta property="belongs-to-collection" id="s1">Cycle</meta>
       <meta refines="#s1" property="collection-type">series</meta>
       <meta refines="#s1" property="group-position">3</meta>`,
    ],
    [
      'belongs-to-collection series without position',
      `<dc:title>Cycle</dc:title><dc:creator>X</dc:creator>
       <meta property="belongs-to-collection" id="s1">Cycle</meta>
       <meta refines="#s1" property="collection-type">series</meta>`,
    ],
    ['single dc:subject', `<dc:title>Subj</dc:title><dc:subject>Fiction</dc:subject>`],
    [
      'several dc:subject, one with authority and term',
      `<dc:title>Subjs</dc:title><dc:subject>Fiction</dc:subject>
       <dc:subject id="sb">Science fiction</dc:subject>
       <meta refines="#sb" property="authority">BISAC</meta><meta refines="#sb" property="term">FIC028000</meta>
       <dc:subject opf:authority="X" opf:term="1">Space</dc:subject>`,
    ],
    [
      'publisher and subject with alternate-script and foreign xml:lang',
      `<dc:title>Пикник</dc:title><dc:creator>Стругацкие</dc:creator><dc:language>ru</dc:language>
       <dc:publisher id="p1">Мир</dc:publisher>
       <meta refines="#p1" property="alternate-script" xml:lang="en">Mir</meta>
       <dc:subject xml:lang="de">Roman</dc:subject>
       <dc:subject>Фантастика</dc:subject>`,
      { metaAttrs: 'xml:lang="ru"' },
    ],
    [
      'publisher with foreign xml:lang, no package language',
      `<dc:title>Lang</dc:title><dc:publisher xml:lang="fr">Gallimard</dc:publisher>`,
    ],
    [
      'creator with role pbl and no dc:publisher',
      `<dc:title>Pub</dc:title><dc:creator opf:role="pbl">Self Press</dc:creator><dc:creator>Writer</dc:creator>`,
    ],
    [
      'dates, description and entities',
      `<dc:title>Dates &amp; Things</dc:title><dc:creator>A &#x416; B</dc:creator>
       <dc:date opf:event="modification">2020-01-01</dc:date><dc:date opf:event="publication">1999-05-05</dc:date>
       <dc:description>  &lt;p&gt;Some   &amp; more&lt;/p&gt;&nbsp;text </dc:description>`,
    ],
    [
      'no dc:title and no dc:creator',
      `<dc:identifier id="uid">urn:uuid:12345678-0000-0000-0000-000000000000</dc:identifier>`,
    ],
    ['title equal to the file name', `<dc:title>same.epub</dc:title><dc:creator>X</dc:creator>`],
  ];

  it.each(cases)('synthetic: %s', async (_name, metadata, opts) => {
    const fileName = _name.startsWith('title equal') ? 'same.epub' : 'book.epub';
    await expectParity(makeEpub(metadata, opts), fileName);
  });

  it('duplicate marker in the file name is stripped like importBook', async () => {
    const { cli } = await expectParity(makeEpub('<dc:creator>X</dc:creator>'), 'novel.epub (1)');
    expect(cli.title).toBe('novel');
  });
});

// ------------------------------------------------------------------ cover

describe('cover', () => {
  const png = image(1, PNG);
  const jpg = image(2, JPG);
  const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');

  it.each([
    [
      'cover-image property',
      {
        manifest: `<item id="other" href="images/a.jpg" media-type="image/jpeg"/>
                   <item id="img" href="images/c.png" media-type="image/png" properties="cover-image"/>`,
        files: { 'OEBPS/images/a.jpg': jpg, 'OEBPS/images/c.png': png },
      },
      png,
    ],
    [
      '<meta name="cover">',
      {
        manifest: `<item id="other" href="images/a.png" media-type="image/png"/>
                   <item id="cimg" href="images/front.jpg" media-type="image/jpeg"/>`,
        files: { 'OEBPS/images/a.png': png, 'OEBPS/images/front.jpg': jpg },
      },
      jpg,
      '<meta name="cover" content="cimg"/>',
    ],
    [
      'cover.jpg without any marks',
      {
        manifest: `<item id="pic" href="images/cover.jpg" media-type="image/jpeg"/>`,
        files: { 'OEBPS/images/cover.jpg': jpg },
      },
      jpg,
    ],
    ['undeclared cover file in the archive', { files: { 'OEBPS/images/Cover.png': png } }, png],
    [
      'SVG cover',
      {
        manifest: `<item id="img" href="images/c.svg" media-type="image/svg+xml" properties="cover-image"/>`,
        files: { 'OEBPS/images/c.svg': svg },
      },
      undefined,
    ],
  ])('%s', async (_name, opts: EpubOpts, expected, extraMeta?: string) => {
    const bytes = makeEpub(`<dc:title>Cover</dc:title>${extraMeta ?? ''}`, opts);
    const { ref, cli } = await expectParity(bytes, 'cover.epub');
    expect(cli.cover).toEqual(expected);
    if (expected) expect(ref.cover).toEqual(expected);
    else expect(ref.coverType).toBe('image/svg+xml');
  });
});

// ------------------------------------------------------------------ FB2 / FBZ

const FB2_CYRILLIC = (cover: string) => `<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
  <title-info>
    <genre>sf</genre><genre>prose_classic</genre>
    <author><first-name>Аркадий</first-name><middle-name>Натанович</middle-name><last-name>Стругацкий</last-name></author>
    <author><first-name>Борис</first-name><last-name>Стругацкий</last-name></author>
    <author><nickname>Аноним</nickname></author>
    <book-title>Пикник на обочине</book-title>
    <annotation><p>Первый <emphasis>абзац</emphasis> &amp; ещё.</p><empty-line/><p>Второй</p></annotation>
    <coverpage><image l:href="#cover.jpg"/></coverpage>
    <lang>ru</lang>
    <date value="1972-01-01">1972</date>
    <sequence name="Мир Полудня" number="7"/>
  </title-info>
  <document-info><id>doc-id-42</id></document-info>
  <publish-info><publisher>Молодая гвардия</publisher></publish-info>
</description>
<body><section><p>Текст.</p></section></body>
<binary id="cover.jpg" content-type="image/jpeg">${cover}</binary>
</FictionBook>`;

describe('FB2/FBZ parity', () => {
  const sample = new Uint8Array(readFileSync(join(FIXTURES, 'sample-metadata.fb2')));

  it('sample-metadata.fb2', async () => {
    const { cli } = await expectParity(sample, 'sample-metadata.fb2');
    expect(cli.format).toBe('FB2');
  });

  it.each(['x.fb2.zip', 'x.fb.zip', 'x.fbz'])('sample in %s', async (name) => {
    const zip = zipSync({ 'sample-metadata.fb2': sample });
    const { cli } = await expectParity(zip, name);
    expect(cli.format).toBe('FBZ');
  });

  it('cyrillic FB2 with coverpage', async () => {
    const cover = image(3, JPG);
    const bytes = strToU8(FB2_CYRILLIC(Buffer.from(cover).toString('base64')));
    const { ref, cli } = await expectParity(bytes, 'piknik.fb2');
    expect(cli.cover).toEqual(cover);
    expect(ref.cover).toEqual(cover);
    expect(cli.title).toBe('Пикник на обочине');
  });

  it('windows-1251 FB2', async () => {
    const xml = FB2_CYRILLIC('').replace('encoding="UTF-8"', 'encoding="windows-1251"');
    const bytes = encode1251(xml);
    await expectParity(bytes, 'cp1251.fb2');
  });
});

const encode1251 = (s: string): Uint8Array => {
  const decoder = new TextDecoder('windows-1251');
  const table = new Map<string, number>();
  for (let b = 0; b < 256; b++) table.set(decoder.decode(new Uint8Array([b])), b);
  return Uint8Array.from([...s].map((ch) => table.get(ch) ?? 0x3f));
};

// ------------------------------------------------------------------ PDF

const latin1 = (s: string) => Uint8Array.from(Buffer.from(s, 'latin1'));

type PdfObj = { n: number; body: string };

const PDF_BASE: PdfObj[] = [
  { n: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { n: 2, body: '<< /Type /Pages /Count 1 /Kids [3 0 R] >>' },
  { n: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>' },
];

const writeObjects = (head: string, objs: PdfObj[]) => {
  let out = head;
  const offsets = new Map<number, number>();
  for (const o of objs) {
    offsets.set(o.n, Buffer.byteLength(out, 'latin1'));
    out += `${o.n} 0 obj\n${o.body}\nendobj\n`;
  }
  return { out, offsets };
};

const xrefTable = (offsets: Map<number, number>, from: number, count: number) => {
  let s = `xref\n${from} ${count}\n`;
  for (let n = from; n < from + count; n++) {
    const off = offsets.get(n);
    s +=
      n === 0
        ? '0000000000 65535 f \n'
        : `${String(off ?? 0).padStart(10, '0')} 00000 ${off === undefined ? 'f' : 'n'} \n`;
  }
  return s;
};

const classicPdf = (info: string | null): Uint8Array => {
  const objs = [...PDF_BASE, ...(info ? [{ n: 4, body: info }] : [])];
  const { out, offsets } = writeObjects('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', objs);
  const xrefAt = Buffer.byteLength(out, 'latin1');
  const size = objs.length + 1;
  const trailer = `trailer\n<< /Size ${size} /Root 1 0 R${info ? ' /Info 4 0 R' : ''} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return latin1(out + xrefTable(offsets, 0, size) + trailer);
};

/** Cross-reference stream with FlateDecode and PNG Up predictor (Predictor 12). */
const xrefStreamPdf = (info: string): Uint8Array => {
  const objs = [...PDF_BASE, { n: 4, body: info }];
  const { out, offsets } = writeObjects('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', objs);
  const xrefAt = Buffer.byteLength(out, 'latin1');
  offsets.set(5, xrefAt);
  const rows: number[][] = [[0, 0, 0, 255]];
  for (let n = 1; n <= 5; n++) {
    const off = offsets.get(n)!;
    rows.push([1, (off >> 8) & 0xff, off & 0xff, 0]);
  }
  const predicted: number[] = [];
  rows.forEach((row, i) => {
    predicted.push(2);
    row.forEach((v, c) => predicted.push((v - (i ? rows[i - 1]![c]! : 0)) & 0xff));
  });
  const data = deflateSync(Uint8Array.from(predicted));
  const dict = `<< /Type /XRef /Size 6 /W [1 2 1] /Root 1 0 R /Info 4 0 R /Filter /FlateDecode /DecodeParms << /Columns 4 /Predictor 12 >> /Length ${data.length} >>`;
  const head = Buffer.from(`${out}5 0 obj\n${dict}\nstream\n`, 'latin1');
  const tail = Buffer.from(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`, 'latin1');
  return new Uint8Array(Buffer.concat([head, data, tail]));
};

/**
 * Incremental update appending object 6. `/Info 4 0 R` is either repeated in the
 * new trailer (object 4 is described only by the /Prev section) or left out.
 */
const incrementalPdf = (
  info: string,
  opts: { infoInNewTrailer: boolean; cycle?: boolean },
): Uint8Array => {
  const base = Buffer.from(classicPdf(info)).toString('latin1');
  const firstXref = Number(base.match(/startxref\n(\d+)/)![1]);
  const objAt = Buffer.byteLength(base, 'latin1');
  const update = `6 0 obj\n<< /Producer (update) >>\nendobj\n`;
  const xrefAt = objAt + Buffer.byteLength(update, 'latin1');
  const prev = opts.cycle ? xrefAt : firstXref;
  const infoRef = opts.infoInNewTrailer ? ' /Info 4 0 R' : '';
  const section = `xref\n6 1\n${String(objAt).padStart(10, '0')} 00000 n \ntrailer\n<< /Size 7 /Root 1 0 R${infoRef} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return latin1(base + update + section);
};

const utf16 = (s: string) =>
  `<FEFF${Buffer.from(s, 'utf16le').swap16().toString('hex').toUpperCase()}>`;

describe('PDF', () => {
  it('sample-metadata.pdf matches the app', async () => {
    const bytes = new Uint8Array(readFileSync(join(FIXTURES, 'sample-metadata.pdf')));
    const { cli } = await expectParity(bytes, 'sample-metadata.pdf', { metadataFields: false });
    expect(cli.metadata.title).toBe('PDF Metadata');
    expect(cli.metadata.author).toBe('Readest');
    expect(cli.title).toBe('sample-metadata');
  });

  it('uncompressed /Info with a UTF-16 string', async () => {
    const info = `<< /Title (Escaped \\(paren\\) \\101 title) /Author ${utf16('Иван Петров')} >>`;
    const { cli } = await expectParity(classicPdf(info), 'report.pdf', { metadataFields: false });
    expect(cli.metadata.title).toBe('Escaped (paren) A title');
    expect(cli.metadata.author).toBe('Иван Петров');
    expect(cli.title).toBe('report');
    expect(cli.sourceTitle).toBe('Escaped (paren) A title');
  });

  it('no /Info: title is the file name', async () => {
    const { cli } = await expectParity(classicPdf(null), 'plain doc.pdf', {
      metadataFields: false,
    });
    expect(cli.metadata.title).toBe('plain doc');
    expect(cli.sourceTitle).toBe('plain doc');
    expect(cli.metadata.author).toBeUndefined();
  });

  it('xref stream with Predictor 12', async () => {
    const info = '<< /Title (Stream Title) /Author (Stream Author) >>';
    const { cli } = await expectParity(xrefStreamPdf(info), 'stream.pdf', {
      metadataFields: false,
    });
    expect(cli.metadata.title).toBe('Stream Title');
    expect(cli.metadata.author).toBe('Stream Author');
  });

  it('incremental update: /Info object described only by the /Prev section', async () => {
    const info = '<< /Title (Old Title) /Author (Old Author) >>';
    const pdf = incrementalPdf(info, { infoInNewTrailer: true });
    const { cli } = await expectParity(pdf, 'inc.pdf', { metadataFields: false });
    expect(cli.metadata.title).toBe('Old Title');
    expect(cli.metadata.author).toBe('Old Author');
  });

  it('incremental update without /Info in the newest trailer: no metadata, like pdf.js', async () => {
    const pdf = incrementalPdf('<< /Title (Old Title) >>', { infoInNewTrailer: false });
    const { cli } = await expectParity(pdf, 'stale.pdf', { metadataFields: false });
    expect(cli.metadata.title).toBe('stale');
  });

  const xrefObj = (dict: string, data: Uint8Array) =>
    new Uint8Array(
      Buffer.concat([
        Buffer.from(
          `5 0 obj\n<< /Type /XRef ${dict} /Length ${data.length} >>\nstream\n`,
          'latin1',
        ),
        data,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]),
    );

  it.each([
    ['W [0 0 0] with a huge Index', '/W [0 0 0] /Index [0 1000000]'],
    ['a field wider than 8 bytes', '/W [1 9 1] /Size 1'],
  ])('xref stream with %s is rejected', (_name, dict) => {
    expect(parseXrefSection(xrefObj(dict, new Uint8Array(11)), true)).toBeNull();
  });

  it('xref stream entries are capped by the stream length, whatever Index claims', () => {
    const rows = Uint8Array.from([1, 0, 10, 0, 1, 0, 20, 0]);
    const section = parseXrefSection(
      xrefObj('/W [1 2 1] /Index [0 1000000000 5 1000000000]', rows),
      true,
    );
    expect(section?.entries.size).toBe(2);
    expect([...section!.entries.keys()]).toEqual([0, 1]);
  });

  it('/Prev cycle gives empty metadata without hanging', async () => {
    const cli = await cliRead(
      incrementalPdf('<< /Title (Lost) >>', { infoInNewTrailer: true, cycle: true }),
      'cycle.pdf',
    );
    expect(cli.metadata.title).toBe('cycle');
    expect(cli.metadata.author).toBeUndefined();
  });
});

// ------------------------------------------------------------------ format and limits

describe('detectFormat and limits', () => {
  const zipHead = strToU8('PK\x03\x04rest');

  it.each([
    ['book.mobi', strToU8('\0\0\0\0BOOKMOBI')],
    ['comic.cbz', zipHead],
    ['notes.txt', strToU8('plain text')],
  ])('%s is rejected with a hint', (name, head) => {
    expect(() => detectFormat(name, head)).toThrow(/upload it from the Readest app/);
  });

  it('detects supported formats', () => {
    expect(detectFormat('a.epub', zipHead)).toBe('EPUB');
    expect(detectFormat('a.fbz', zipHead)).toBe('FBZ');
    expect(detectFormat('a.fb2.zip', zipHead)).toBe('FBZ');
    expect(detectFormat('a.FB.ZIP', zipHead)).toBe('FBZ');
    expect(detectFormat('a.pdf', strToU8('%PDF-1.7'))).toBe('PDF');
    expect(detectFormat('a.fb2', strToU8('<?xml'))).toBe('FB2');
  });

  it('rejects an .epub without mimetype', async () => {
    await expect(
      cliRead(makeEpub('<dc:title>T</dc:title>', { noMimetype: true }), 'x.epub'),
    ).rejects.toThrow(/mimetype/);
  });

  const big = new Uint8Array(16 * 1024 * 1024 + 1);

  it('rejects an oversized container.xml', async () => {
    const zip = zipSync({
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': [big, { level: 1 }],
    });
    await expect(cliRead(zip, 'c.epub')).rejects.toThrow(/exceeds limit/);
  });

  it('rejects an oversized OPF', async () => {
    const zip = zipSync({
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': strToU8(CONTAINER),
      'OEBPS/content.opf': [big, { level: 1 }],
    });
    await expect(cliRead(zip, 'o.epub')).rejects.toThrow(/exceeds limit/);
  });

  it('rejects an oversized cover', async () => {
    const zip = makeEpub('<dc:title>T</dc:title>', {
      manifest: '<item id="img" href="c.png" media-type="image/png" properties="cover-image"/>',
      files: { 'OEBPS/c.png': big },
    });
    await expect(cliRead(zip, 'cv.epub')).rejects.toThrow(/exceeds limit/);
  });

  it('rejects an oversized fb2 inside FBZ', async () => {
    const zip = zipSync({ 'big.fb2': [new Uint8Array(128 * 1024 * 1024 + 1), { level: 1 }] });
    await expect(cliRead(zip, 'big.fbz')).rejects.toThrow(/exceeds limit/);
  }, 60_000);

  it('rejects an FB2 file over 128 MiB', async () => {
    const path = join(dir, 'huge.fb2');
    const fd = openSync(path, 'w');
    ftruncateSync(fd, 128 * 1024 * 1024 + 1);
    closeSync(fd);
    await expect(readBookFile(path)).rejects.toThrow(/exceeds limit/);
  });
});

describe('language helpers', () => {
  it.each([
    undefined,
    '',
    'en',
    'ru',
    'rus',
    'RU-ru',
    'zho',
    'zh-CN',
    'ger',
    'deu',
    'und',
    'mul',
    'xx',
    'ace',
    ['fr', 'en'],
  ])('primaryLanguage(%j) matches getPrimaryLanguage', (lang) => {
    expect(primaryLanguage(lang)).toBe(getPrimaryLanguage(lang));
  });

  it('formatAuthorsLike matches formatAuthors', () => {
    const names = ['A', 'B', 'C'];
    const contributors: Array<{ name: Record<string, string> }> = [
      { name: { ru: 'А', en: 'A' } },
      { name: { ru: 'Б' } },
      { name: { en: 'C' } },
    ];
    for (const lang of ['en', 'ru', 'zh', 'de']) {
      expect(formatAuthorsLike(names, lang)).toBe(formatAuthors(names, lang));
      expect(formatAuthorsLike(contributors, lang)).toBe(formatAuthors(contributors, lang));
    }
    expect(formatAuthorsLike('Solo', 'en')).toBe('Solo');
    expect(formatAuthorsLike(undefined, 'en')).toBe('');
  });
});
