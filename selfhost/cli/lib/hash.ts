// Ports of src/utils/md5.ts and getMetadataHash (src/utils/book.ts); parity is
// enforced by src/__tests__/selfhost-cli/hash.test.ts against the app code.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

export type Identifier = { scheme: string; value: string };
export type LangMap = Record<string, string>;
export type Contributor = { name: string | LangMap };
export type HashMeta = {
  title: string | LangMap;
  author?: string | Contributor | Array<string | Contributor>;
  identifier?: string;
  altIdentifier?: string | Identifier | Array<string | Identifier>;
};

export const md5Hex = (data: string | Uint8Array): string =>
  createHash('md5').update(data).digest('hex');

export const md5Fingerprint = (s: string): string => md5Hex(s).slice(0, 7);

const partialRanges = (fileSize: number): Array<[number, number]> => {
  const ranges: Array<[number, number]> = [];
  for (let i = -1; i <= 10; i++) {
    // `1024 << -2` is 0 in JS, which is what makes i = -1 read the file head.
    const start = Math.min(fileSize, 1024 << (2 * i));
    const end = Math.min(start + 1024, fileSize);
    if (start >= fileSize) break;
    ranges.push([start, end]);
  }
  return ranges;
};

export const partialMD5Bytes = (b: Uint8Array): string => {
  const h = createHash('md5');
  for (const [start, end] of partialRanges(b.length)) h.update(b.subarray(start, end));
  return h.digest('hex');
};

export const partialMD5File = async (path: string): Promise<string> => {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const h = createHash('md5');
    for (const [start, end] of partialRanges(size)) {
      const buf = Buffer.alloc(end - start);
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      h.update(buf.subarray(0, bytesRead));
    }
    return h.digest('hex');
  } finally {
    await fh.close();
  }
};

/** `formatLanguageMap(x, true)`: a map yields its first key's value. */
export const langForHash = (x: string | LangMap): string => {
  if (!x) return '';
  if (typeof x === 'string') return x;
  const keys = Object.keys(x);
  return x[keys[0]!]!;
};

/** `formatLanguageMap(x)` with the user language `en`. */
export const langForDisplay = (x: string | LangMap): string => {
  if (!x) return '';
  if (typeof x === 'string') return x;
  const keys = Object.keys(x);
  return x['en'] || x[keys[0]!]!;
};

const authorsList = (a: HashMeta['author']): string[] => {
  if (!a) return [];
  if (Array.isArray(a)) {
    return a.map((c) => (typeof c === 'string' ? c : langForHash(c?.name))).filter(Boolean);
  }
  return [typeof a === 'string' ? a : langForHash(a?.name)];
};

const normalizeIdentifier = (id: string): string => {
  if (id.includes('urn:')) return id.match(/[^:]+$/)?.[0] || '';
  if (id.includes(':')) return id.match(/^[^:]+:(.+)$/)?.[1] || '';
  return id;
};

const preferredIdentifier = (ids: Array<string | Identifier>): string | undefined => {
  for (const scheme of ['uuid', 'calibre', 'isbn']) {
    const found = ids.find((id) =>
      typeof id === 'string'
        ? id.toLowerCase().includes(scheme)
        : id.scheme.toLowerCase() === scheme,
    );
    if (found) return typeof found === 'string' ? normalizeIdentifier(found) : found.value;
  }
  return undefined;
};

const identifiersList = (ids: HashMeta['altIdentifier']): string[] => {
  if (!ids) return [];
  if (Array.isArray(ids)) {
    const preferred = preferredIdentifier(ids);
    if (preferred) return [preferred];
    return ids
      .map((id) => (typeof id === 'string' ? normalizeIdentifier(id) : id.value))
      .filter(Boolean);
  }
  return typeof ids === 'string' ? [normalizeIdentifier(ids)] : [ids.value];
};

export const metaHash = (m: HashMeta, filenameSalt?: string): string => {
  const title = typeof m.title === 'string' ? m.title : langForHash(m.title);
  const authors = authorsList(m.author);
  const identifiers = identifiersList(m.altIdentifier || m.identifier);
  let source = `${title}|${authors.join(',')}|${identifiers.join(',')}`;
  if (filenameSalt) source += `|${filenameSalt}`;
  return md5Hex(source.normalize('NFC'));
};
