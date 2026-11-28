import { describe, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { openZip, readEntry } from '../../../../../selfhost/cli/lib/zip.ts';
import { parseXml, findAll, first, textOf } from '../../../../../selfhost/cli/lib/xml.ts';

const MB = 1024 * 1024;

const pseudo = (size: number): Uint8Array => {
  const out = new Uint8Array(size);
  let s = 12345;
  for (let i = 0; i < size; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    out[i] = s >>> 24;
  }
  return out;
};

describe('zip', () => {
  it('reads stored and deflated entries byte for byte', () => {
    const stored = strToU8('application/epub+zip');
    const text = strToU8('hello '.repeat(2000));
    const bin = pseudo(5000);
    const zip = zipSync({
      mimetype: [stored, { level: 0 }],
      'a/text.txt': [text, { level: 9 }],
      'b/bin.dat': [bin, { level: 6 }],
    });
    const entries = openZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['mimetype', 'a/text.txt', 'b/bin.dat']);
    expect(entries[0]!.method).toBe(0);
    expect(entries[1]!.method).toBe(8);
    expect(Buffer.from(readEntry(zip, entries[0]!, MB))).toEqual(Buffer.from(stored));
    expect(Buffer.from(readEntry(zip, entries[1]!, MB))).toEqual(Buffer.from(text));
    expect(Buffer.from(readEntry(zip, entries[2]!, MB))).toEqual(Buffer.from(bin));
  });

  it('rejects an entry larger than the limit', () => {
    const zip = zipSync({ big: [new Uint8Array(2 * MB), { level: 6 }] });
    const [e] = openZip(zip);
    expect(() => readEntry(zip, e!, MB)).toThrow(/exceeds limit/);
  });

  it('rejects a stored entry larger than the limit', () => {
    const zip = zipSync({ big: [new Uint8Array(2 * MB), { level: 0 }] });
    const [e] = openZip(zip);
    expect(() => readEntry(zip, e!, MB)).toThrow(/exceeds limit/);
  });

  it('a forged uncompressedSize in the central directory does not bypass the limit', () => {
    const zip = zipSync({ big: [new Uint8Array(2 * MB), { level: 6 }] });
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Central directory header: signature 0x02014b50, uncompressed size at +24.
    for (let i = zip.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 10, true);
        break;
      }
    }
    // Local header: uncompressed size at +22.
    view.setUint32(22, 10, true);
    const [e] = openZip(zip);
    expect(() => readEntry(zip, e!, MB)).toThrow(/exceeds limit/);
  });

  it('rejects non-zip data', () => {
    expect(() => openZip(strToU8('definitely not a zip file'))).toThrow();
    expect(() => openZip(new Uint8Array(0))).toThrow();
  });
});

describe('xml', () => {
  it('decodes entities and CDATA', () => {
    const root = parseXml(
      '<r a="x&amp;y">A &amp; B &#1046;&#x416;&lt;&gt;&quot;&apos;<![CDATA[<raw & text>]]></r>',
    );
    expect(root.attrs['a']).toBe('x&y');
    expect(textOf(root)).toBe('A & B ЖЖ<>"\'<raw & text>');
  });

  it('handles prefixes, quotes, comments, declarations and doctype', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE package [ <!ENTITY x "y"> ]>
<!-- comment <dc:title>no</dc:title> -->
<package xmlns:dc="http://purl.org/dc/elements/1.1/">
  <metadata>
    <dc:title id='t1' xml:lang="en">Title</dc:title>
    <!-- another -->
    <dc:creator opf:role="aut">Author</dc:creator>
    <meta name="cover" content="img"/>
  </metadata>
</package>`;
    const root = parseXml(xml);
    expect(root.local).toBe('package');
    const title = first(root, 'title')!;
    expect(title.name).toBe('dc:title');
    expect(title.local).toBe('title');
    expect(title.attrs['id']).toBe('t1');
    expect(title.attrs['xml:lang']).toBe('en');
    expect(textOf(title)).toBe('Title');
    expect(findAll(root, 'creator')[0]!.attrs['opf:role']).toBe('aut');
    expect(first(root, 'meta')!.attrs['content']).toBe('img');
    expect(findAll(root, 'title')).toHaveLength(1);
  });

  it('rejects excessive depth', () => {
    const deep = (n: number) => '<a>'.repeat(n) + '</a>'.repeat(n);
    expect(() => parseXml(deep(256))).not.toThrow();
    expect(() => parseXml(deep(257))).toThrow(/depth/);
  });

  it('rejects an unclosed tag', () => {
    expect(() => parseXml('<a><b></a>')).toThrow();
    expect(() => parseXml('<a><b>')).toThrow();
  });
});
