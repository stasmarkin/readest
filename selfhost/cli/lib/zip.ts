import { inflateRawSync } from 'node:zlib';
import { CliError } from './errors.ts';

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
};

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export const openZip = (bytes: Uint8Array): ZipEntry[] => {
  const v = view(bytes);
  // EOCD is 22 bytes plus a comment of at most 64 KiB.
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (v.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new CliError('not a zip archive');
  const count = v.getUint16(eocd + 10, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || v.getUint32(p, true) !== CDIR_SIG) {
      throw new CliError('corrupted zip central directory');
    }
    const method = v.getUint16(p + 10, true);
    const compressedSize = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localOffset = v.getUint32(p + 42, true);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new CliError('zip64 archives are not supported');
    }
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
};

export const readEntry = (bytes: Uint8Array, e: ZipEntry, maxBytes: number): Uint8Array => {
  const v = view(bytes);
  const p = e.localOffset;
  if (p + 30 > bytes.length || v.getUint32(p, true) !== LOCAL_SIG) {
    throw new CliError(`corrupted zip entry ${e.name}`);
  }
  const start = p + 30 + v.getUint16(p + 26, true) + v.getUint16(p + 28, true);
  const end = start + e.compressedSize;
  if (end > bytes.length) throw new CliError(`truncated zip entry ${e.name}`);
  const src = bytes.subarray(start, end);
  if (e.method === 0) {
    if (src.length > maxBytes) throw new CliError(`zip entry ${e.name} exceeds limit`);
    return src.slice();
  }
  if (e.method !== 8) throw new CliError(`unsupported zip compression in ${e.name}`);
  try {
    // The declared uncompressed size is not trusted: the cap is on actual output.
    const out = inflateRawSync(src, { maxOutputLength: Math.max(1, maxBytes) });
    // A view only when it spans its whole buffer, so callers never see pool bytes.
    return out.byteOffset === 0 && out.buffer.byteLength === out.length
      ? new Uint8Array(out.buffer)
      : new Uint8Array(out);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new CliError(`zip entry ${e.name} exceeds limit`);
    }
    throw new CliError(`corrupted zip entry ${e.name}: ${(err as Error).message}`);
  }
};
