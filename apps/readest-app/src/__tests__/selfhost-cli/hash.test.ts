import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { partialMD5, md5Fingerprint as appFingerprint } from '@/utils/md5';
import { getMetadataHash } from '@/utils/book';
import type { BookMetadata } from '@/libs/document';
import {
  md5Fingerprint,
  metaHash,
  partialMD5Bytes,
  partialMD5File,
} from '../../../../../selfhost/cli/lib/hash.ts';
import type { HashMeta } from '../../../../../selfhost/cli/lib/hash.ts';

const seeded = (size: number, seed: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(size);
  let s = seed >>> 0;
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
};

const dir = mkdtempSync(join(tmpdir(), 'readest-cli-hash-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('partialMD5', () => {
  const sizes = [0, 1, 1023, 1024, 1025, 5000, 70_000, 3 * 1024 * 1024];
  it.each(sizes)('partialMD5 matches app for %i bytes', async (size) => {
    const buf = seeded(size, size + 7);
    const expected = await partialMD5(new File([buf], 'x'));
    expect(partialMD5Bytes(buf)).toBe(expected);
    const path = join(dir, `f-${size}`);
    writeFileSync(path, buf);
    expect(await partialMD5File(path)).toBe(expected);
  });
});

describe('md5Fingerprint', () => {
  it.each([
    'Fiction',
    'Фантастика/Лем',
    'A/B/C',
    ' spaced ',
  ])('md5Fingerprint matches app for %j', (s) => {
    expect(md5Fingerprint(s)).toBe(appFingerprint(s));
  });
});

describe('metaHash matches getMetadataHash', () => {
  const nfd = 'Ёжик й'.normalize('NFD');
  const cases: Array<[string, HashMeta, string?]> = [
    ['author string', { title: 'Book', author: 'Jane Doe' }],
    ['single contributor', { title: 'Book', author: { name: 'Jane Doe' } }],
    ['author string array', { title: 'Book', author: ['A One', 'B Two'] }],
    ['mixed author array', { title: 'Book', author: ['A One', { name: 'B Two' }, { name: '' }] }],
    [
      'contributor with LangMap name',
      { title: 'Book', author: { name: { ru: 'Лем', en: 'Lem' } } },
    ],
    ['title LangMap', { title: { ru: 'Мир', en: 'World' }, author: 'X' }],
    ['identifier string', { title: 'Book', author: 'X', identifier: 'urn:isbn:9780000000001' }],
    ['altIdentifier string', { title: 'Book', identifier: 'ignored', altIdentifier: 'doi:10.1/x' }],
    [
      'calibre identifier object',
      { title: 'Book', altIdentifier: { scheme: 'calibre', value: '42' } },
    ],
    [
      'mixed identifier array',
      {
        title: 'Book',
        author: 'X',
        altIdentifier: ['urn:isbn:9780000000001', { scheme: 'calibre', value: '42' }],
      },
    ],
    [
      'array without preferred scheme',
      { title: 'Book', altIdentifier: ['doi:10.1/x', { scheme: 'foo', value: 'bar' }, 'plain'] },
    ],
    [
      'uuid A',
      {
        title: 'Same',
        author: 'Same',
        altIdentifier: ['urn:uuid:11111111-1111-1111-1111-111111111111'],
      },
    ],
    [
      'uuid B',
      {
        title: 'Same',
        author: 'Same',
        altIdentifier: ['urn:uuid:22222222-2222-2222-2222-222222222222'],
      },
    ],
    ['no identifiers', { title: 'Book', author: 'X' }],
    ['NFD cyrillic', { title: nfd, author: nfd }],
    ['pdf salt', { title: 'Report', author: 'X' }, 'my file'],
    ['empty title', { title: '' }],
  ];

  it.each(cases)('%s', (_name, meta, salt) => {
    const expected = getMetadataHash(meta as unknown as BookMetadata, salt);
    expect(expected).toBeTruthy();
    expect(metaHash(meta, salt)).toBe(expected);
  });

  it('two different urn:uuid give different hashes', () => {
    const a = cases.find((c) => c[0] === 'uuid A')![1];
    const b = cases.find((c) => c[0] === 'uuid B')![1];
    expect(metaHash(a)).not.toBe(metaHash(b));
  });

  it('title LangMap hashes the first key', () => {
    expect(metaHash({ title: { ru: 'Мир', en: 'World' }, author: 'X' })).toBe(
      metaHash({ title: 'Мир', author: 'X' }),
    );
  });
});
