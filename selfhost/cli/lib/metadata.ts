// Book-file metadata the way the app's importBook sees it: EPUB follows
// packages/foliate-js/epub.js getMetadata (+ tidy), FB2/FBZ follows fb2.js,
// PDF reads only an uncompressed /Info dictionary. Parity is enforced by
// src/__tests__/selfhost-cli/metadata['test'].ts against the real DocumentLoader.
import { open, readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { inflateSync } from 'node:zlib';
import { CliError } from './errors.ts';
import { langForDisplay, metaHash, partialMD5File } from './hash.ts';
import type { Contributor, HashMeta, LangMap } from './hash.ts';
import { findAll, first, parseXml, textOf } from './xml.ts';
import type { XmlNode } from './xml.ts';
import { openZip, readEntry } from './zip.ts';
import type { ZipEntry } from './zip.ts';

export type BookFormat = 'EPUB' | 'PDF' | 'FB2' | 'FBZ';
export const EXT: Record<BookFormat, string> = { EPUB: 'epub', PDF: 'pdf', FB2: 'fb2', FBZ: 'fbz' };

/** A foliate contributor after tidy(); one that has only a name is collapsed to the name itself. */
export type FullContributor = Contributor & {
  sortAs?: string | LangMap | null;
  role?: string | string[];
  code?: string;
  scheme?: string;
};

export type RowMetadata = HashMeta & {
  language?: string | string[];
  publisher?: string | LangMap | Contributor;
  published?: string;
  description?: string;
  subject?: string | LangMap | Contributor | Array<string | LangMap | Contributor>;
  series?: string;
  seriesIndex?: number;
};

export type BookFileInfo = {
  path: string;
  size: number;
  mtimeMs: number;
  format: BookFormat;
  hash: string;
  metaHash: string;
  title: string;
  sourceTitle: string;
  author: string;
  originalFilename: string;
  metadata: RowMetadata;
  cover?: Uint8Array;
};

const MiB = 1024 * 1024;
const XML_LIMIT = 16 * MiB;
const FB2_LIMIT = 128 * MiB;

// ---------------------------------------------------------------- languages

// iso-639-2 (the app's isValidLang/code6392to6391 data): codes with no other form,
// then `B:T:1` triples for codes that have a terminologic and/or 639-1 form.
const ISO_PLAIN =
  'ace ach ada ady afa afh ain akk ale alg alt ang anp apa arc arn arp art arw ast ath aus awa bad bai bal ban bas bat bej bem ber bho bik bin bla bnt bra btk bua bug byn cad cai car cau ceb cel chb chg chk chm chn cho chp chr chy cmc cnr cop cpe cpf cpp crh crp csb cus dak dar day del den dgr din doi dra dsb dua dum dyu efi egy eka elx enm ewo fan fat fil fiu fon frm fro frr frs fur gaa gay gba gem gez gil gmh goh gon gor got grb grc gwi hai haw hil him hit hmn hsb hup iba ijo ilo inc ine inh ira iro jbo jpr jrb kaa kab kac kam kar kaw kbd kha khi kho kmb kok kos kpe krc krl kro kru kum kut lad lah lam lez lol loz lua lui lun luo lus mad mag mai mak man map mas mdf mdr men mga mic min mis mkh mnc mni mno moh mos mul mun mus mwl mwr myn myv nah nai nap nds new nia nic niu nog non nqo nso nub nwc nym nyn nyo nzi osa ota oto paa pag pal pam pap pau peo phi phn pon pra pro raj rap rar roa rom rup sad sah sai sal sam sas sat scn sco sel sem sga sgn shn sid sio sit sla sma smi smj smn sms snk sog son srn srr ssa suk sus sux syc syr tai tem ter tet tig tiv tkl tlh tli tmh tog tpi tsi tum tup tut tvl tyv udm uga umb und vai vot wak wal war was wen xal yao yap ypk zap zbl zen zgh znd zun zxx zza';
const ISO_MAPPED =
  'aar::aa abk::ab afr::af aka::ak alb:sqi:sq amh::am ara::ar arg::an arm:hye:hy asm::as ava::av ave::ae aym::ay aze::az bak::ba bam::bm baq:eus:eu bel::be ben::bn bih::bh bis::bi bos::bs bre::br bul::bg bur:mya:my cat::ca cha::ch che::ce chi:zho:zh chu::cu chv::cv cor::kw cos::co cre::cr cze:ces:cs dan::da div::dv dut:nld:nl dzo::dz eng::en epo::eo est::et ewe::ee fao::fo fij::fj fin::fi fre:fra:fr fry::fy ful::ff geo:kat:ka ger:deu:de gla::gd gle::ga glg::gl glv::gv gre:ell:el grn::gn guj::gu hat::ht hau::ha heb::he her::hz hin::hi hmo::ho hrv::hr hun::hu ibo::ig ice:isl:is ido::io iii::ii iku::iu ile::ie ina::ia ind::id ipk::ik ita::it jav::jv jpn::ja kal::kl kan::kn kas::ks kau::kr kaz::kk khm::km kik::ki kin::rw kir::ky kom::kv kon::kg kor::ko kua::kj kur::ku lao::lo lat::la lav::lv lim::li lin::ln lit::lt ltz::lb lub::lu lug::lg mac:mkd:mk mah::mh mal::ml mao:mri:mi mar::mr may:msa:ms mlg::mg mlt::mt mon::mn nau::na nav::nv nbl::nr nde::nd ndo::ng nep::ne nno::nn nob::nb nor::no nya::ny oci::oc oji::oj ori::or orm::om oss::os pan::pa per:fas:fa pli::pi pol::pl por::pt pus::ps que::qu roh::rm rum:ron:ro run::rn rus::ru sag::sg san::sa sin::si slo:slk:sk slv::sl sme::se smo::sm sna::sn snd::sd som::so sot::st spa::es srd::sc srp::sr ssw::ss sun::su swa::sw swe::sv tah::ty tam::ta tat::tt tel::te tgk::tg tgl::tl tha::th tib:bod:bo tir::ti ton::to tsn::tn tso::ts tuk::tk tur::tr twi::tw uig::ug ukr::uk urd::ur uzb::uz ven::ve vie::vi vol::vo wel:cym:cy wln::wa wol::wo xho::xh yid::yi yor::yo zha::za zul::zu';

const VALID_CODES = new Set<string>(ISO_PLAIN.split(' '));
const TO_6391 = new Map<string, string>();
for (const triple of ISO_MAPPED.split(' ')) {
  const [b, t, one] = triple.split(':') as [string, string, string];
  VALID_CODES.add(b);
  if (t) VALID_CODES.add(t);
  if (one) {
    VALID_CODES.add(one);
    TO_6391.set(b, one);
    if (t) TO_6391.set(t, one);
  }
}

const baseLangCode = (lang: string): string => lang.split('-')[0]!.toLowerCase();

/** Port of getPrimaryLanguage: a valid code as ISO 639-1 where one exists, else `en`. */
export const primaryLanguage = (lang?: string | string[]): string => {
  const primary = Array.isArray(lang) ? lang[0] : lang;
  if (!primary || typeof primary !== 'string') return 'en';
  if (['und', 'mul', 'mis', 'zxx'].includes(primary)) return 'en';
  const code = baseLangCode(primary);
  if (!VALID_CODES.has(code)) return 'en';
  return TO_6391.get(code) || code;
};

/** Port of formatAuthors(authors, lang) without sortAs, as importBook calls it. */
export const formatAuthorsLike = (
  authors: RowMetadata['author'],
  lang?: string | string[],
): string => {
  const primary = typeof lang === 'string' ? lang : lang?.[0];
  const langCode = (primary ? primary.split('-')[0]! : '') || 'en';
  if (Array.isArray(authors)) {
    const list =
      langCode === 'zh'
        ? new Intl.ListFormat('en', { style: 'narrow', type: 'unit' })
        : new Intl.ListFormat(langCode, { style: 'long', type: 'conjunction' });
    return list.format(authors.map((a) => (typeof a === 'string' ? a : langForDisplay(a?.name))));
  }
  if (typeof authors === 'string') return authors;
  return langForDisplay(authors?.name as string | LangMap);
};

// ---------------------------------------------------------------- shared helpers

const normalizeWhitespace = (s: string | undefined | null): string =>
  s
    ? s
        .replace(/[\t\n\f\r ]+/g, ' ')
        .replace(/^[\t\n\f\r ]+/, '')
        .replace(/[\t\n\f\r ]+$/, '')
    : '';

const elementText = (n: XmlNode | undefined): string => (n ? normalizeWhitespace(textOf(n)) : '');

const DUPLICATE_MARKER = /[\s_-]*\(\d+\)$/;
const stripDuplicateMarker = (name: string) => name.replace(DUPLICATE_MARKER, '');

/** Port of getBaseFilename: drops only the last extension. */
const baseFilename = (filename: string): string => {
  const name = filename.replace(/\\/g, '/').split('/').pop() || '';
  const parts = name.split('.');
  return parts.length <= 1 ? name : parts.slice(0, -1).join('.');
};

const UNSUPPORTED = 'upload it from the Readest app';

const startsWith = (b: Uint8Array, s: string): boolean => {
  if (b.length < s.length) return false;
  for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
  return true;
};

const isFbzName = (name: string) =>
  name.endsWith('.fb.zip') || name.endsWith('.fb2.zip') || name.endsWith('.fbz');

export const detectFormat = (path: string, head: Uint8Array): BookFormat => {
  const name = stripDuplicateMarker(basename(path)).toLowerCase();
  const isZip = startsWith(head, 'PK\x03\x04');
  if (isZip && isFbzName(name)) return 'FBZ';
  if (isZip && !name.endsWith('.cbz')) return 'EPUB';
  if (!isZip && startsWith(head, '%PDF-')) return 'PDF';
  if (!isZip && name.endsWith('.fb2')) return 'FB2';
  throw new CliError(`${basename(path)}: format is not supported by the CLI; ${UNSUPPORTED}`);
};

// ---------------------------------------------------------------- EPUB

const NS_DC = 'http://purl.org/dc/elements/1.1/';
const NS_OPF = 'http://www.idpf.org/2007/opf';

const PREFIX: Record<string, string> = {
  a11y: 'http://www.idpf.org/epub/vocab/package/a11y/#',
  dcterms: 'http://purl.org/dc/terms/',
  marc: 'http://id.loc.gov/vocabulary/',
  media: 'http://www.idpf.org/epub/vocab/overlays/#',
  onix: 'http://www.editeur.org/ONIX/book/codelists/current.html#',
  rendition: 'http://www.idpf.org/vocab/rendition/#',
  schema: 'http://schema.org/',
  xsd: 'http://www.w3.org/2001/XMLSchema#',
  msv: 'http://www.idpf.org/epub/vocab/structure/magazine/#',
  prism: 'http://www.prismstandard.org/specifications/3.0/PRISM_CV_Spec_3.0.htm#',
};

const RELATORS: Record<string, string> = {
  art: 'artist',
  aut: 'author',
  clr: 'colorist',
  edt: 'editor',
  ill: 'illustrator',
  nrt: 'narrator',
  trl: 'translator',
  pbl: 'publisher',
};

type Parsed = {
  property: string | null;
  scheme: string | null;
  lang: string | null;
  value: string;
  props: Record<string, Parsed[]> | null;
  attrs: Record<string, string>;
};

type Scope = Record<string, string>;

const withScope = (scope: Scope, n: XmlNode): Scope => {
  let out = scope;
  for (const [k, v] of Object.entries(n.attrs)) {
    if (k === 'xmlns' || k.startsWith('xmlns:')) {
      if (out === scope) out = { ...scope };
      out[k === 'xmlns' ? '' : k.slice(6)] = v;
    }
  }
  return out;
};

const nsOf = (scope: Scope, qname: string): string | undefined => {
  const at = qname.indexOf(':');
  return scope[at < 0 ? '' : qname.slice(0, at)];
};

const getPrefixes = (pkg: XmlNode): Map<string, string> => {
  const map = new Map(Object.entries(PREFIX));
  const value = pkg.attrs['epub:prefix'] || pkg.attrs['prefix'];
  if (value)
    for (const [, prefix, url] of value.matchAll(/(.+): +(.+)[ \t\r\n]*/g)) map.set(prefix!, url!);
  return map;
};

const propertyURL = (value: string | undefined, prefixes: Map<string, string>): string | null => {
  if (!value) return null;
  const [a, b] = value.split(':');
  const prefix = b ? a : null;
  const reference = b ? b : a;
  const base = prefix === null ? undefined : prefixes.get(prefix!);
  return base ? base + reference : null;
};

type Json = string | number | null | undefined | Json[] | { [k: string]: Json };

/** Port of foliate's tidy(): drops empties, unwraps 1-element arrays and name-only objects. */
const tidy = (obj: { [k: string]: Json }): Json => {
  for (const [key, val] of Object.entries(obj)) {
    if (val == null) delete obj[key];
    else if (Array.isArray(val)) {
      const arr = val
        .filter((x) => x)
        .map((x) => (typeof x === 'object' && x !== null && !Array.isArray(x) ? tidy(x) : x));
      if (!arr.length) delete obj[key];
      else obj[key] = arr.length === 1 ? arr[0] : arr;
    } else if (typeof val === 'object') {
      obj[key] = tidy(val);
      if (!Object.keys(val).length) delete obj[key];
    }
  }
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'name') return obj['name'];
  return obj;
};

const resolveHref = (url: string, relativeTo: string): string => {
  if (/^(?!blob)\w+:/i.test(url)) return url;
  try {
    const root = 'https://invalid.invalid/';
    const u = new URL(url, root + relativeTo);
    u.search = '';
    const path = u.href.replace(root, '');
    try {
      return decodeURIComponent(path.replace(/%(2f|23)/gi, '%25$1'));
    } catch {
      return path;
    }
  } catch {
    return url;
  }
};

const UNDECLARED_COVER = /(?:cover|couv)\.(?:jpe?g|png|gif|webp|svg)$/i;

const imageTypeOf = (path: string): string => {
  const ext = path.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return map[ext] || 'image/jpeg';
};

type Archive = { bytes: Uint8Array; entries: ZipEntry[]; byName: Map<string, ZipEntry> };

const openArchive = (bytes: Uint8Array): Archive => {
  const entries = openZip(bytes);
  return { bytes, entries, byName: new Map(entries.map((e) => [e.name, e])) };
};

const readText = (a: Archive, name: string, limit: number): string | null => {
  const e = a.byName.get(name);
  return e ? new TextDecoder().decode(readEntry(a.bytes, e, limit)) : null;
};

type Parts = { metadata: RowMetadata; cover?: Uint8Array };

const seriesFields = (belongsTo: Json): Pick<RowMetadata, 'series' | 'seriesIndex'> => {
  // Mirrors importBook: a tidied series may have collapsed to a bare string,
  // whose `.name` is undefined, so the series reads as ''.
  if (!belongsTo || typeof belongsTo !== 'object' || Array.isArray(belongsTo)) return {};
  const raw = belongsTo['series'];
  const s = Array.isArray(raw) ? raw[0] : raw;
  if (!s) return {};
  const obj = typeof s === 'object' && !Array.isArray(s) ? s : {};
  const name = obj['name'] as string | LangMap | undefined;
  const position = obj['position'];
  const index = parseFloat(String(position ?? ''));
  const out: Pick<RowMetadata, 'series' | 'seriesIndex'> = {
    series: name ? langForDisplay(name) : '',
  };
  if (Number.isFinite(index)) out.seriesIndex = index;
  return out;
};

const pickRow = (m: { [k: string]: Json }): RowMetadata => {
  const out: RowMetadata = { title: (m['title'] as string | LangMap | undefined) ?? '' };
  const keys = [
    'author',
    'identifier',
    'altIdentifier',
    'language',
    'publisher',
    'published',
    'description',
    'subject',
  ];
  const target = out as Record<string, unknown>;
  for (const k of keys) if (m[k] !== undefined) target[k] = m[k];
  Object.assign(out, seriesFields(m['belongsTo']));
  if (m['title'] === undefined) delete (out as Partial<RowMetadata>).title;
  return out;
};

const parseEpub = (bytes: Uint8Array): Parts => {
  const a = openArchive(bytes);
  const mimetype = readText(a, 'mimetype', 1024);
  if (mimetype?.trim() !== 'application/epub+zip')
    throw new CliError('not an EPUB: missing mimetype');
  const containerText = readText(a, 'META-INF/container.xml', XML_LIMIT);
  if (!containerText) throw new CliError('EPUB has no META-INF/container.xml');
  const opfPath = findAll(parseXml(containerText), 'rootfile').find(
    (r) => r.attrs['media-type'] === 'application/oebps-package+xml',
  )?.attrs['full-path'];
  if (!opfPath) throw new CliError('No package document defined in container');
  const opfText = readText(a, opfPath, XML_LIMIT);
  if (!opfText) throw new CliError('Failed to load package document');
  const pkg = parseXml(opfText);
  const pkgScope = withScope({}, pkg);
  const metaEl = pkg.children.find((c) => c.local === 'metadata');
  if (!metaEl) throw new CliError('package document has no metadata');
  const metaScope = withScope(pkgScope, metaEl);
  const prefixes = getPrefixes(pkg);
  const baseLang = metaEl.attrs['xml:lang'] ?? pkg.attrs['xml:lang'] ?? 'und';

  const dcEls: Array<[XmlNode, Scope]> = [];
  const metaEls: XmlNode[] = [];
  const legacy: Record<string, string> = {};
  for (const el of metaEl.children) {
    if (el.name === '#text') continue;
    const scope = withScope(metaScope, el);
    const ns = nsOf(scope, el.name);
    if (ns === NS_DC) dcEls.push([el, scope]);
    else if (ns === NS_OPF && el.local === 'meta') {
      if ('name' in el.attrs) legacy[el.attrs['name']!] = el.attrs['content']!;
      else metaEls.push(el);
    }
  }
  const refines = new Map<string | undefined, XmlNode[]>();
  for (const el of metaEls) {
    const key = el.attrs['refines'];
    refines.set(key, [...(refines.get(key) ?? []), el]);
  }
  const parse = (el: XmlNode, scope: Scope): Parsed => {
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(el.attrs)) {
      if (k.includes(':') && nsOf(scope, k) === NS_OPF) attrs[k.slice(k.indexOf(':') + 1)] = v;
    }
    return {
      property: propertyURL(el.attrs['property'], prefixes) ?? el.attrs['property'] ?? null,
      scheme: propertyURL(el.attrs['scheme'], prefixes) ?? el.attrs['scheme'] ?? null,
      lang: el.attrs['xml:lang'] ?? null,
      value: elementText(el),
      props: propsOf(el),
      attrs,
    };
  };
  const propsOf = (el: XmlNode | undefined): Record<string, Parsed[]> | null => {
    const els = refines.get(el ? `#${el.attrs['id'] ?? null}` : undefined);
    if (!els) return null;
    const out: Record<string, Parsed[]> = {};
    for (const m of els) {
      const p = parse(m, withScope(metaScope, m));
      const key = String(p.property);
      (out[key] ??= []).push(p);
    }
    return out;
  };
  const dc: Record<string, Parsed[]> = {};
  for (const [el, scope] of dcEls) (dc[el.local] ??= []).push(parse(el, scope));
  const properties = propsOf(undefined) ?? {};

  const one = (x: Parsed[] | undefined) => x?.[0]?.value;
  const prop = (x: Parsed | undefined, p: string) => one(x?.props?.[p] ?? undefined);
  const langMap = (x: Parsed | undefined): string | LangMap | null => {
    if (!x) return null;
    const alts = x.props?.['alternate-script'] ?? [];
    const altRep = x.attrs['alt-rep'];
    if (!alts.length && (!x.lang || x.lang === baseLang) && !altRep) return x.value;
    const map: LangMap = { [x.lang ?? baseLang]: x.value };
    if (altRep) map[String(x.attrs['alt-rep-lang'])] = altRep;
    for (const y of alts) map[String(y.lang)] ??= y.value;
    return map;
  };
  const makeContributor = (x: Parsed | undefined): { [k: string]: Json } | null =>
    x
      ? {
          name: langMap(x),
          sortAs: langMap(x.props?.['file-as']?.[0]) ?? x.attrs['file-as'],
          role: x.props?.['role']
            ? x.props['role']
                .filter((r) => r.scheme === `${PREFIX['marc']}relators`)
                .map((r) => r.value)
            : [x.attrs['role']],
          code: prop(x, 'term') ?? x.attrs['term'],
          scheme: prop(x, 'authority') ?? x.attrs['authority'],
        }
      : null;
  const makeAltIdentifier = (x: Parsed): Json => {
    const { value } = x;
    if (/^urn:/i.test(value)) return value;
    if (/^doi:/i.test(value)) return `urn:${value}`;
    const type = x.props?.['identifier-type'];
    if (!type) {
      const scheme = x.attrs['scheme'];
      if (!scheme) return value;
      if (/^(doi|isbn|uuid)$/i.test(scheme)) return `urn:${scheme}:${value}`;
      return { scheme, value };
    }
    // foliate reads `type.scheme`/`type.value` off the array, which are undefined.
    return value;
  };

  const uid = pkg.attrs['unique-identifier'];
  const byId = uid ? findById(pkg, uid) : undefined;
  const identifier = elementText(byId ?? firstDcIdentifier(pkg, pkgScope));

  const belongsTo: Record<string, Parsed[]> = {};
  for (const x of properties['belongs-to-collection'] ?? []) {
    (belongsTo[prop(x, 'collection-type') === 'series' ? 'series' : 'collection'] ??= []).push(x);
  }
  const mainTitle = dc['title']?.find((x) => prop(x, 'title-type') === 'main') ?? dc['title']?.[0];
  const calibreSeries = legacy['calibre:series'];
  const metadata: { [k: string]: Json } = {
    identifier,
    title: langMap(mainTitle),
    language: dc['language']?.map((x) => x.value),
    description: one(dc['description']),
    publisher: makeContributor(dc['publisher']?.[0]),
    published:
      dc['date']?.find((x) => x.attrs['event'] === 'publication')?.value ?? one(dc['date']),
    subject: dc['subject']?.map(makeContributor),
    belongsTo: {
      collection: belongsTo['collection']?.map((x) => ({
        name: langMap(x),
        position: one(x.props?.['group-position']),
      })),
      series:
        belongsTo['series']?.map((x) => ({
          name: x.value,
          position: one(x.props?.['group-position']),
        })) ??
        (calibreSeries
          ? { name: calibreSeries, position: parseFloat(legacy['calibre:series_index']!) }
          : null),
    },
    altIdentifier: dc['identifier']?.map(makeAltIdentifier),
  };
  const remap =
    (defaultKey: string) =>
    (x: { [k: string]: Json }): [string[], { [k: string]: Json }] => {
      const roles = x['role'] as Array<string | undefined>;
      const keys = new Set(roles.map((r) => (r !== undefined && RELATORS[r]) || defaultKey));
      return [keys.size ? [...keys] : [defaultKey], x];
    };
  const contributors = [
    ...(dc['creator']?.map((x) => makeContributor(x)!).map(remap('author')) ?? []),
    ...(dc['contributor']?.map((x) => makeContributor(x)!).map(remap('contributor')) ?? []),
  ];
  for (const [keys, val] of contributors) {
    for (const key of keys) {
      if (key === 'publisher' && metadata['publisher']) continue;
      const cur = metadata[key];
      if (Array.isArray(cur)) cur.push(val);
      else metadata[key] = [val];
    }
  }
  tidy(metadata);
  if (metadata['altIdentifier'] === metadata['identifier']) delete metadata['altIdentifier'];

  return { metadata: pickRow(metadata), cover: epubCover(a, pkg, opfPath) };
};

const findById = (n: XmlNode, id: string): XmlNode | undefined => {
  for (const c of n.children) {
    if (c.name === '#text') continue;
    if (c.attrs['id'] === id) return c;
    const found = findById(c, id);
    if (found) return found;
  }
  return undefined;
};

const firstDcIdentifier = (n: XmlNode, scope: Scope): XmlNode | undefined => {
  for (const c of n.children) {
    if (c.name === '#text') continue;
    const s = withScope(scope, c);
    if (c.local === 'identifier' && nsOf(s, c.name) === NS_DC) return c;
    const found = firstDcIdentifier(c, s);
    if (found) return found;
  }
  return undefined;
};

type ManifestItem = { href: string | null; id?: string; mediaType: string; properties?: string[] };

const epubCover = (a: Archive, pkg: XmlNode, opfPath: string): Uint8Array | undefined => {
  const resolve = (url: string | undefined) => (url ? resolveHref(url, opfPath) : null);
  const manifestEl = pkg.children.find((c) => c.local === 'manifest');
  const manifest: ManifestItem[] = (manifestEl?.children ?? [])
    .filter((c) => c.local === 'item')
    .map((c) => ({
      href: resolve(c.attrs['href']),
      id: c.attrs['id'],
      mediaType: (c.attrs['media-type'] ?? '').split(';')[0]!.trim().toLowerCase(),
      properties: c.attrs['properties']?.split(/\s/),
    }));
  const byHref = (href: string | null | undefined) => manifest.find((i) => i.href === href);
  const guideEl = pkg.children.find((c) => c.local === 'guide');
  const guide = (guideEl?.children ?? [])
    .filter((c) => c.local === 'reference')
    .map((c) => ({ type: (c.attrs['type'] ?? '').split(/\s/), href: resolve(c.attrs['href']) }));
  const coverMeta = findAll(pkg, 'meta').find((m) => m.attrs['name'] === 'cover')?.attrs['content'];
  const item =
    manifest.find((i) => i.properties?.includes('cover-image')) ??
    manifest.find((i) => coverMeta !== undefined && i.id === coverMeta) ??
    (coverMeta ? byHref(resolve(coverMeta)) : undefined) ??
    manifest.find((i) => i.id === 'cover' && i.mediaType.startsWith('image')) ??
    manifest.find((i) => i.href?.includes('cover') && i.mediaType.startsWith('image')) ??
    byHref(guide.find((r) => r.type.includes('cover'))?.href) ??
    manifest.find((i) => i.mediaType.startsWith('image'));
  let href: string | null | undefined = item?.href;
  let mediaType = item?.mediaType ?? '';
  if (!href) {
    href = a.entries.map((e) => e.name).find((n) => UNDECLARED_COVER.test(n));
    if (!href) return undefined;
    mediaType = imageTypeOf(href);
  }
  // SVG covers are not uploaded: the cover slot holds raster bytes.
  if (mediaType === 'image/svg+xml') return undefined;
  const entry = a.byName.get(href);
  return entry ? readEntry(a.bytes, entry, XML_LIMIT) : undefined;
};

// ---------------------------------------------------------------- FB2

const NS_XLINK = 'http://www.w3.org/1999/xlink';

const decodeFb2 = (bytes: Uint8Array): string => {
  const str = new TextDecoder('utf-8').decode(bytes);
  const encoding = str.match(
    /^<\?xml\s+version\s*=\s*["']1.\d+"\s+encoding\s*=\s*["']([A-Za-z0-9._-]*)["']/,
  )?.[1];
  if (encoding && encoding.toLowerCase() !== 'utf-8') {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      throw new CliError(`unsupported FB2 encoding ${encoding}`);
    }
  }
  return str;
};

/** querySelector('a b'): the first b with an a ancestor, in document order. */
const firstIn = (root: XmlNode, outer: string, inner: string): XmlNode | undefined => {
  for (const o of findAll(root, outer)) {
    const found = first(o, inner);
    if (found) return found;
  }
  return undefined;
};
const allIn = (root: XmlNode, outer: string, inner: string): XmlNode[] =>
  findAll(root, outer).flatMap((o) => findAll(o, inner));

type DefEntry = 'image' | 'anchor' | [string, Def | 'self' | undefined, string[]?];
type Def = { [name: string]: DefEntry };

const STYLE: Def = {
  strong: ['strong', 'self'],
  emphasis: ['em', 'self'],
  style: ['span', 'self'],
  a: 'anchor',
  strikethrough: ['s', 'self'],
  sub: ['sub', 'self'],
  sup: ['sup', 'self'],
  code: ['code', 'self'],
  image: 'image',
};
const TABLE: Def = {
  tr: [
    'tr',
    {
      th: ['th', STYLE, ['colspan', 'rowspan', 'align', 'valign']],
      td: ['td', STYLE, ['colspan', 'rowspan', 'align', 'valign']],
    },
    ['align'],
  ],
};
const POEM: Def = {
  epigraph: ['blockquote', undefined],
  subtitle: ['h2', STYLE],
  'text-author': ['p', STYLE],
  date: ['p', STYLE],
  stanza: ['div', 'self'],
  v: ['div', STYLE],
};
const SECTION: Def = {
  title: ['header', { p: ['h1', STYLE], 'empty-line': ['br', undefined] }],
  epigraph: ['blockquote', 'self'],
  image: 'image',
  annotation: ['aside', undefined],
  section: ['section', 'self'],
  p: ['p', STYLE],
  poem: ['blockquote', POEM],
  subtitle: ['h2', STYLE],
  cite: ['blockquote', 'self'],
  'empty-line': ['br', undefined],
  table: ['table', TABLE],
  'text-author': ['p', STYLE],
};
POEM['epigraph'] = ['blockquote', SECTION];

const VOID = new Set(['br', 'img', 'hr']);
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');

const xlinkHref = (n: XmlNode, scope: Scope): string | null => {
  for (const [k, v] of Object.entries(n.attrs)) {
    if (k.endsWith(':href') && nsOf(scope, k) === NS_XLINK) return v;
  }
  return null;
};

/**
 * Port of fb2.js FB2Converter.convert serialized as the jsdom innerHTML of the
 * result: the annotation becomes the book description.
 */
const makeFb2Converter = (root: XmlNode, rootScope: Scope) => {
  const bins = new Map<string, XmlNode>();
  for (const b of findAll(root, 'binary'))
    if (b.attrs['id'] !== undefined) bins.set(b.attrs['id'], b);
  const imageSrc = (n: XmlNode, scope: Scope): string => {
    const href = xlinkHref(n, scope);
    if (!href) return 'data:,';
    const id = href.split('#')[1];
    if (!id) return href;
    const bin = bins.get(id);
    return bin ? `data:${bin.attrs['content-type'] ?? null};base64,${textOf(bin)}` : href;
  };
  const el = (name: string, attrs: Array<[string, string]>, inner: string) => {
    const a = attrs['map'](([k, v]) => ` ${k}="${escAttr(v)}"`).join('');
    return inner || !VOID.has(name) ? `<${name}${a}>${inner}</${name}>` : `<${name}${a}/>`;
  };
  const convert = (n: XmlNode, def: Def | undefined, scope: Scope): string | null => {
    if (n.name === '#text') return escText(n.text);
    const d = def?.[n.name];
    if (!d) return null;
    const s = withScope(scope, n);
    if (d === 'image') {
      return el(
        'img',
        [
          ['alt', String(n.attrs['alt'] ?? null)],
          ['title', String(n.attrs['title'] ?? null)],
          ['src', imageSrc(n, s)],
        ],
        '',
      );
    }
    if (d === 'anchor') {
      const inner = convertChildren(n, { a: ['a', STYLE] }.a as [string, Def], s);
      return el('a', [...baseAttrs(n), ['href', String(xlinkHref(n, s))]], inner);
    }
    return el(
      d[0],
      [
        ...baseAttrs(n),
        ...(d[2] ?? []).filter((k) => n.attrs[k]).map((k): [string, string] => [k, n.attrs[k]!]),
      ],
      convertChildren(n, d, s, def),
    );
  };
  const baseAttrs = (n: XmlNode): Array<[string, string]> => [
    ...(n.attrs['id'] ? ([['id', n.attrs['id']]] as Array<[string, string]>) : []),
    ['class', n.name],
  ];
  const convertChildren = (
    n: XmlNode,
    d: [string, Def | 'self' | undefined, string[]?],
    scope: Scope,
    self?: Def,
  ): string => {
    const childDef = d[1] === 'self' ? self : d[1];
    return n.children.map((c) => convert(c, childDef, scope) ?? '').join('');
  };
  return {
    imageSrc,
    annotation: (n: XmlNode, scope: Scope) => convertChildren(n, ['div', SECTION], scope),
    rootScope,
  };
};

const parseFb2 = (bytes: Uint8Array): Parts => {
  const root = parseXml(decodeFb2(bytes));
  if (root.local !== 'FictionBook') throw new CliError('not an FB2 file: root is not FictionBook');
  const rootScope = withScope({}, root);
  const conv = makeFb2Converter(root, rootScope);
  const person = (el: XmlNode): string | FullContributor => {
    const nick = elementText(first(el, 'nickname'));
    if (nick) return nick;
    const f = elementText(first(el, 'first-name'));
    const m = elementText(first(el, 'middle-name'));
    const l = elementText(first(el, 'last-name'));
    const name = [f, m, l].filter((x) => x).join(' ');
    const sortAs = l ? [l, [f, m].filter((x) => x).join(' ')].join(', ') : null;
    return { name, sortAs };
  };
  const date = (el: XmlNode | undefined) => el?.attrs['value'] ?? elementText(el);
  const titleInfo = findAll(root, 'title-info');
  const series = titleInfo
    .flatMap((t) => t.children.filter((c) => c.local === 'sequence'))
    .map((el) => ({
      name: normalizeWhitespace(el.attrs['name']),
      position: el.attrs['number'] || undefined,
    }))
    .filter((x) => x.name);
  const annotation = firstIn(root, 'title-info', 'annotation');
  const metadata: RowMetadata = {
    title: elementText(firstIn(root, 'title-info', 'book-title')),
    identifier: elementText(firstIn(root, 'document-info', 'id')),
    language: elementText(firstIn(root, 'title-info', 'lang')),
    author: allIn(root, 'title-info', 'author').map(person),
    publisher: elementText(firstIn(root, 'publish-info', 'publisher')),
    published: date(firstIn(root, 'title-info', 'date')),
    subject: allIn(root, 'title-info', 'genre').map(elementText),
  };
  if (annotation) metadata['description'] = conv.annotation(annotation, rootScope);
  if (series[0]) {
    metadata['series'] = series[0].name;
    const index = parseFloat(String(series[0].position ?? ''));
    if (Number.isFinite(index)) metadata['seriesIndex'] = index;
  }
  let cover: Uint8Array | undefined;
  const img = firstIn(root, 'coverpage', 'image');
  if (img) {
    const src = conv.imageSrc(img, rootScope);
    const m = src.match(/^data:([^;,]*);base64,([\s\S]*)$/);
    if (m && m[1] !== 'image/svg+xml') cover = new Uint8Array(Buffer.from(m[2]!, 'base64'));
  }
  return { metadata, cover };
};

// ---------------------------------------------------------------- PDF

const PDF_DOC_TABLE: number[] = [
  ...new Array<number>(24).fill(0),
  0x2d8,
  0x2c7,
  0x2c6,
  0x2d9,
  0x2dd,
  0x2db,
  0x2da,
  0x2dc,
  ...new Array<number>(96).fill(0),
  0x2022,
  0x2020,
  0x2021,
  0x2026,
  0x2014,
  0x2013,
  0x192,
  0x2044,
  0x2039,
  0x203a,
  0x2212,
  0x2030,
  0x201e,
  0x201c,
  0x201d,
  0x2018,
  0x2019,
  0x201a,
  0x2122,
  0xfb01,
  0xfb02,
  0x141,
  0x152,
  0x160,
  0x178,
  0x17d,
  0x131,
  0x142,
  0x153,
  0x161,
  0x17e,
  0,
  0x20ac,
];

/** Port of foliate's decodePDFString. */
const decodePdfString = (input: Uint8Array): string => {
  let bytes = input;
  let encoding: string | undefined;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) encoding = 'utf-8';
  if (encoding) {
    if (encoding.startsWith('utf-16') && bytes.length % 2 === 1) bytes = bytes.slice(0, -1);
    try {
      const s = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      let out = '';
      let escaping = false;
      for (const ch of s) {
        if (ch.charCodeAt(0) === 0x1b) escaping = !escaping;
        else if (!escaping) out += ch;
      }
      return out;
    } catch {
      // fall through to PDFDocEncoding, as pdf.js does
    }
  }
  const chars: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (b === 0x1b) {
      while (++i < bytes.length && bytes[i] !== 0x1b) {
        // skip the escape sequence
      }
      continue;
    }
    chars.push(String.fromCharCode(PDF_DOC_TABLE[b] || b));
  }
  return chars.join('');
};

type PdfVal =
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'str'; v: Uint8Array }
  | { k: 'ref'; n: number; g: number }
  | { k: 'arr'; v: PdfVal[] }
  | { k: 'dict'; v: Map<string, PdfVal> }
  | { k: 'kw'; v: string };

class NeedMore extends Error {}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([...'()<>[]{}/%'].map((c) => c.charCodeAt(0)));

/** A tiny PDF object parser over a byte window; throws NeedMore at the window's end. */
const pdfParser = (b: Uint8Array, start: number, atEof: boolean) => {
  let p = start;
  const peek = () => {
    if (p >= b.length) {
      if (atEof) throw new CliError('unexpected end of PDF');
      throw new NeedMore();
    }
    return b[p]!;
  };
  const skipWs = () => {
    for (;;) {
      const c = peek();
      if (WS.has(c)) p++;
      else if (c === 0x25) {
        while (peek() !== 0x0a && b[p] !== 0x0d) p++;
      } else return;
    }
  };
  const regular = (): string => {
    let s = '';
    while (p < b.length && !WS.has(b[p]!) && !DELIM.has(b[p]!)) s += String.fromCharCode(b[p++]!);
    if (p >= b.length && !atEof) throw new NeedMore();
    return s;
  };
  const literal = (): Uint8Array => {
    const out: number[] = [];
    let depth = 1;
    p++;
    for (;;) {
      const c = peek();
      p++;
      if (c === 0x5c) {
        const e = peek();
        p++;
        // \n \r \t \b \f
        const map: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (map[e] !== undefined) out.push(map[e]!);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let i = 0; i < 2 && peek() >= 0x30 && b[p]! <= 0x37; i++)
            v = v * 8 + (b[p++]! - 0x30);
          out.push(v & 0xff);
        } else if (e === 0x0d) {
          if (peek() === 0x0a) p++;
        } else if (e !== 0x0a) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) return new Uint8Array(out);
        out.push(c);
      } else out.push(c);
    }
  };
  const hex = (): Uint8Array => {
    p++;
    let digits = '';
    for (;;) {
      const c = peek();
      p++;
      if (c === 0x3e) break;
      if (!WS.has(c)) digits += String.fromCharCode(c);
    }
    if (digits.length % 2) digits += '0';
    return new Uint8Array(Buffer.from(digits, 'hex'));
  };
  const value = (): PdfVal => {
    skipWs();
    const c = peek();
    if (c === 0x2f) {
      p++;
      return { k: 'name', v: regular() };
    }
    if (c === 0x28) return { k: 'str', v: literal() };
    if (c === 0x3c) {
      if (b[p + 1] === undefined && !atEof) throw new NeedMore();
      if (b[p + 1] === 0x3c) {
        p += 2;
        const v = new Map<string, PdfVal>();
        for (;;) {
          skipWs();
          if (peek() === 0x3e) {
            p += 2;
            return { k: 'dict', v };
          }
          const key = value();
          if (key.k !== 'name') throw new CliError('malformed PDF dictionary');
          v.set(key.v, value());
        }
      }
      return { k: 'str', v: hex() };
    }
    if (c === 0x5b) {
      p++;
      const v: PdfVal[] = [];
      for (;;) {
        skipWs();
        if (peek() === 0x5d) {
          p++;
          return { k: 'arr', v };
        }
        v.push(value());
      }
    }
    const tok = regular();
    if (!tok) throw new CliError('malformed PDF object');
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      if (/^\d+$/.test(tok)) {
        // Look ahead for an indirect reference `n g R`.
        const save = p;
        try {
          skipWs();
          const g = regular();
          if (/^\d+$/.test(g)) {
            skipWs();
            if (regular() === 'R') return { k: 'ref', n: Number(tok), g: Number(g) };
          }
        } catch (e) {
          if (!(e instanceof CliError)) throw e;
        }
        p = save;
      }
      return { k: 'num', v: Number(tok) };
    }
    return { k: 'kw', v: tok };
  };
  return {
    value,
    skipWs,
    regular,
    get pos() {
      return p;
    },
    set pos(v: number) {
      p = v;
    },
  };
};

type XrefEntry = { type: 1; offset: number } | { type: 2 };

const MAX_SECTIONS = 32;
const MAX_WINDOW = 64 * MiB;
const MAX_XREF_ENTRIES = 1_000_000;

const readPdfInfo = async (path: string, size: number): Promise<Map<string, PdfVal> | null> => {
  const fh = await open(path, 'r');
  try {
    const readAt = async (pos: number, len: number) => {
      const n = Math.max(0, Math.min(len, size - pos));
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, pos);
      return new Uint8Array(buf.buffer, buf.byteOffset, n);
    };
    // Parse with a growing window starting at `pos`.
    const parseAt = async <T>(
      pos: number,
      fn: (b: Uint8Array, atEof: boolean) => T,
    ): Promise<T> => {
      for (let len = 64 * 1024; ; len *= 4) {
        const b = await readAt(pos, len);
        const atEof = pos + b.length >= size;
        try {
          return fn(b, atEof);
        } catch (e) {
          if (!(e instanceof NeedMore) || atEof || len >= MAX_WINDOW) {
            if (e instanceof NeedMore) throw new CliError('PDF structure is too large');
            throw e;
          }
        }
      }
    };

    const tail = await readAt(Math.max(0, size - 2048), 2048);
    const tailText = Buffer.from(tail).toString('latin1');
    const sx = tailText.lastIndexOf('startxref');
    if (sx < 0) return null;
    const first = tailText.slice(sx + 9).match(/^\s*(\d+)/);
    if (!first) return null;

    const xref = new Map<number, XrefEntry>();
    let info: { n: number } | undefined;
    const queue: number[] = [Number(first[1])];
    const seen = new Set<number>();
    while (queue.length && seen.size < MAX_SECTIONS) {
      const offset = queue.shift()!;
      if (seen.has(offset) || offset >= size) continue;
      seen.add(offset);
      const section = await parseAt(offset, (b, atEof) => parseXrefSection(b, atEof));
      if (!section) return null;
      for (const [n, e] of section.entries) if (!xref.has(n)) xref.set(n, e);
      const t = section.trailer;
      if (t.has('Encrypt')) return null;
      // Like pdf.js, /Info counts only in the newest trailer; older sections
      // are walked just to find where that object lives.
      if (seen.size === 1) {
        const infoRef = t.get('Info');
        if (infoRef?.k !== 'ref') return null;
        info = { n: infoRef.n };
      }
      if (info && xref.has(info.n)) break;
      const stm = t.get('XRefStm');
      if (stm?.k === 'num') queue.push(stm.v);
      const prev = t.get('Prev');
      if (prev?.k === 'num') queue.push(prev.v);
    }
    if (!info) return null;
    const entry = xref.get(info.n);
    if (!entry || entry.type !== 1) return null;
    const infoNum = info.n;
    return await parseAt(entry.offset, (b, atEof) => {
      const r = pdfParser(b, 0, atEof);
      r.skipWs();
      const n = r.regular();
      r.skipWs();
      r.regular();
      r.skipWs();
      if (Number(n) !== infoNum || r.regular() !== 'obj') return null;
      const v = r.value();
      return v.k === 'dict' ? v.v : null;
    });
  } finally {
    await fh.close();
  }
};

export const parseXrefSection = (
  b: Uint8Array,
  atEof: boolean,
): { entries: Map<number, XrefEntry>; trailer: Map<string, PdfVal> } | null => {
  const r = pdfParser(b, 0, atEof);
  r.skipWs();
  const entries = new Map<number, XrefEntry>();
  const save = r.pos;
  if (r.regular() === 'xref') {
    for (;;) {
      r.skipWs();
      const tok = r.regular();
      if (tok === 'trailer') {
        const t = r.value();
        return t.k === 'dict' ? { entries, trailer: t.v } : null;
      }
      if (!/^\d+$/.test(tok)) return null;
      r.skipWs();
      const count = Number(r.regular());
      for (let i = 0; i < count; i++) {
        r.skipWs();
        const off = Number(r.regular());
        r.skipWs();
        r.regular();
        r.skipWs();
        const kind = r.regular();
        if (kind === 'n' && !entries.has(Number(tok) + i))
          entries.set(Number(tok) + i, { type: 1, offset: off });
      }
    }
  }
  // Cross-reference stream: `n g obj << /Type /XRef ... >> stream ... endstream`.
  r.pos = save;
  r.regular();
  r.skipWs();
  r.regular();
  r.skipWs();
  if (r.regular() !== 'obj') return null;
  const d = r.value();
  if (
    d.k !== 'dict' ||
    d.v.get('Type')?.k !== 'name' ||
    (d.v.get('Type') as { v: string }).v !== 'XRef'
  )
    return null;
  const dict = d.v;
  r.skipWs();
  if (r.regular() !== 'stream') return null;
  let p = r.pos;
  if (b[p] === 0x0d) p++;
  if (b[p] === 0x0a) p++;
  const lenVal = dict.get('Length');
  if (lenVal?.k !== 'num') return null;
  if (p + lenVal.v > b.length) {
    if (atEof) return null;
    throw new NeedMore();
  }
  let data = b.subarray(p, p + lenVal.v);
  const filter = dict.get('Filter');
  const filterName =
    filter?.k === 'name'
      ? filter.v
      : filter?.k === 'arr' && filter.v[0]?.k === 'name'
        ? filter.v[0].v
        : undefined;
  if (filter && (filterName !== 'FlateDecode' || (filter.k === 'arr' && filter.v.length > 1)))
    return null;
  if (filterName) {
    const out = inflateSync(data, { maxOutputLength: MAX_WINDOW });
    data = new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  }
  const w = dict.get('W');
  if (w?.k !== 'arr') return null;
  const widths = w.v.map((x) => (x.k === 'num' ? x.v : -1));
  if (widths.some((x) => !Number.isInteger(x) || x < 0 || x > 8)) return null;
  const rowLen = widths.reduce((s, x) => s + x, 0);
  if (rowLen === 0) return null;
  const parms = dict.get('DecodeParms');
  if (parms?.k === 'dict') {
    const pred = parms.v.get('Predictor');
    if (pred?.k === 'num' && pred.v >= 10) {
      const cols = parms.v.get('Columns');
      data = unpredictPng(data, cols?.k === 'num' ? cols.v : 1);
    }
  }
  const sizeVal = dict.get('Size');
  const index = dict.get('Index');
  const ranges: number[] =
    index?.k === 'arr'
      ? index.v.map((x) => (x.k === 'num' ? x.v : 0))
      : [0, sizeVal?.k === 'num' ? sizeVal.v : 0];
  const field = (row: number, col: number, def: number) => {
    if (!widths[col]) return def;
    let start = row * rowLen;
    for (let i = 0; i < col; i++) start += widths[i]!;
    let v = 0;
    for (let i = 0; i < widths[col]!; i++) v = v * 256 + (data[start + i] ?? 0);
    return v;
  };
  // /Index may claim any count: the rows actually in the stream bound the loop.
  const maxRows = Math.min(Math.floor(data.length / rowLen), MAX_XREF_ENTRIES);
  let row = 0;
  for (let i = 0; i + 1 < ranges.length && row < maxRows; i += 2) {
    const count = Math.min(ranges[i + 1]!, maxRows - row);
    for (let j = 0; j < count; j++, row++) {
      const n = ranges[i]! + j;
      const type = field(row, 0, 1);
      if (entries.has(n)) continue;
      if (type === 1) entries.set(n, { type: 1, offset: field(row, 1, 0) });
      else if (type === 2) entries.set(n, { type: 2 });
    }
  }
  return { entries, trailer: dict };
};

const unpredictPng = (data: Uint8Array, columns: number): Uint8Array => {
  const rowLen = columns + 1;
  const rows = Math.floor(data.length / rowLen);
  const out = new Uint8Array(rows * columns);
  for (let r = 0; r < rows; r++) {
    const type = data[r * rowLen]!;
    for (let c = 0; c < columns; c++) {
      const x = data[r * rowLen + 1 + c]!;
      const left = c > 0 ? out[r * columns + c - 1]! : 0;
      const up = r > 0 ? out[(r - 1) * columns + c]! : 0;
      const upLeft = r > 0 && c > 0 ? out[(r - 1) * columns + c - 1]! : 0;
      let v = x;
      if (type === 1) v = x + left;
      else if (type === 2) v = x + up;
      else if (type === 3) v = x + ((left + up) >> 1);
      else if (type === 4) {
        const pa = Math.abs(up - upLeft);
        const pb = Math.abs(left - upLeft);
        const pc = Math.abs(left + up - 2 * upLeft);
        v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
      out[r * columns + c] = v & 0xff;
    }
  }
  return out;
};

const parsePdf = async (path: string, size: number): Promise<Parts> => {
  const info = await readPdfInfo(path, size);
  const str = (key: string): string | undefined => {
    const v = info?.get(key);
    return v?.k === 'str' ? decodePdfString(v.v) : undefined;
  };
  const metadata: RowMetadata = { title: str('Title') ?? '' };
  const author = str('Author');
  if (author !== undefined) metadata['author'] = author;
  return { metadata };
};

// ---------------------------------------------------------------- entry point

export const readBookFile = async (path: string): Promise<BookFileInfo> => {
  const { size, mtimeMs } = await stat(path);
  const fh = await open(path, 'r');
  const head = new Uint8Array(64);
  try {
    await fh.read(head, 0, 64, 0);
  } finally {
    await fh.close();
  }
  const format = detectFormat(path, head);
  let parts: Parts;
  if (format === 'PDF') {
    parts = await parsePdf(path, size);
  } else if (format === 'FB2') {
    if (size > FB2_LIMIT) throw new CliError(`FB2 file exceeds limit of ${FB2_LIMIT} bytes`);
    parts = parseFb2(await readFile(path));
  } else {
    const bytes = new Uint8Array(await readFile(path));
    if (format === 'EPUB') parts = parseEpub(bytes);
    else {
      const a = openArchive(bytes);
      const entry = a.entries.find((e) => e.name.endsWith('.fb2')) ?? a.entries[0];
      if (!entry) throw new CliError('FBZ archive is empty');
      parts = parseFb2(readEntry(bytes, entry, FB2_LIMIT));
    }
  }
  const originalFilename = basename(path);
  const filename = stripDuplicateMarker(originalFilename);
  const metadata = parts.metadata;
  const current = metadata['title'] ? langForDisplay(metadata['title']) : '';
  if (!current || !current.trim() || current === filename)
    metadata['title'] = baseFilename(filename);
  const sourceTitle = langForDisplay(metadata['title']);
  return {
    path,
    size,
    mtimeMs,
    format,
    hash: await partialMD5File(path),
    metaHash: metaHash(metadata, format === 'PDF' ? baseFilename(filename) : undefined),
    title: format === 'PDF' ? filename.replace(/\.[^.]*$/, '') : sourceTitle,
    sourceTitle,
    author: formatAuthorsLike(metadata['author'], primaryLanguage(metadata['language'])),
    originalFilename,
    metadata,
    ...(parts.cover ? { cover: parts.cover } : {}),
  };
};
