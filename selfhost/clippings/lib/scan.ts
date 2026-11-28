import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { CliError } from '../../cli/lib/errors.ts';
import type { SyncDeps } from './deps.ts';

export type LocalImage = { sha256: string; bytes: Uint8Array };
export type ScannedFile = {
  bytes: Uint8Array;
  /** Keyed by the vault-relative path; null when it is missing, unreadable or outside the vault. */
  localImages: Map<string, LocalImage | null>;
  srcKey: string;
};
export type Scan = { files: Map<string, ScannedFile>; empty: Set<string> };

export const sha256 = (b: string | Uint8Array): string =>
  createHash('sha256').update(b).digest('hex');

export const isRemoteRef = (ref: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#');

/** A relative image reference as a vault-relative path; null when it climbs out of the vault. */
export const resolveLocal = (relpath: string, ref: string): string | null => {
  if (isRemoteRef(ref) || isAbsolute(ref)) return null;
  let path = ref.replace(/[?#].*$/, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    // a stray % is part of the name
  }
  if (!path) return null;
  const rel = normalize(join(dirname(relpath), path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
};

/** Image references as written: inline, reference definitions and HTML <img>. */
export const imageRefs = (md: string): string[] => {
  const refs = new Set<string>();
  for (const m of md.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g))
    refs.add((m[1] ?? m[2])!);
  for (const m of md.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm))
    refs.add((m[1] ?? m[2])!);
  for (const m of md.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.add(m[1]!);
  return [...refs];
};

export const srcKeyOf = (md: Uint8Array, local: Map<string, LocalImage | null>): string => {
  const h = createHash('sha256').update(md);
  for (const key of [...local.keys()].sort()) {
    h.update(`\0${key}\0${local.get(key)?.sha256 ?? 'none'}`);
  }
  return h.digest('hex');
};

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
};

const readLocal = async (
  deps: SyncDeps,
  vaultReal: string,
  rel: string,
): Promise<LocalImage | null> => {
  try {
    const real = await deps.realpath(join(vaultReal, rel));
    // A symlink may lead out of the vault: only files really inside it are read.
    if (!inside(vaultReal, real)) return null;
    const st = await deps.stat(real);
    if (!st.isFile) return null;
    const bytes = await deps.readFile(real);
    return { sha256: sha256(bytes), bytes };
  } catch {
    return null;
  }
};

/** Every *.md of the vault, hidden files and directories skipped; zero-length files are not finished yet. */
export const scanVault = async (deps: SyncDeps, vault: string): Promise<Scan> => {
  let vaultReal: string;
  try {
    vaultReal = await deps.realpath(vault);
    if (!(await deps.stat(vaultReal)).isDir) throw new Error('not a directory');
  } catch (e) {
    throw new CliError(`vault is not readable: ${vault} (${(e as Error).message})`, 2);
  }
  const files = new Map<string, ScannedFile>();
  const empty = new Set<string>();
  const walk = async (dir: string) => {
    const entries = await deps.readdir(join(vaultReal, dir));
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (e.name.startsWith('.')) continue;
      const rel = dir ? join(dir, e.name) : e.name;
      if (e.kind === 'dir') {
        await walk(rel);
        continue;
      }
      if (!e.name.endsWith('.md') || (e.kind !== 'file' && e.kind !== 'symlink')) continue;
      let path = join(vaultReal, rel);
      let st: { isFile: boolean } | null;
      if (e.kind === 'symlink') {
        // A link that is broken or leads out of the vault is neither published nor taken as a deletion.
        const target = await deps.realpath(path).catch(() => null);
        if (target === null || !inside(vaultReal, target)) {
          empty.add(rel);
          continue;
        }
        path = target;
      }
      try {
        st = await deps.stat(path);
      } catch (err) {
        // Only a file gone since the listing is missing; any other failure must not read as a deletion.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        st = null;
      }
      if (!st?.isFile) continue;
      const bytes = await deps.readFile(path);
      if (bytes.length === 0) {
        empty.add(rel);
        continue;
      }
      const localImages = new Map<string, LocalImage | null>();
      for (const ref of imageRefs(new TextDecoder().decode(bytes))) {
        const local = resolveLocal(rel, ref);
        if (local !== null && !localImages.has(local)) {
          localImages.set(local, await readLocal(deps, vaultReal, local));
        }
      }
      files.set(rel, { bytes, localImages, srcKey: srcKeyOf(bytes, localImages) });
    }
  };
  try {
    await walk('');
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError(`vault is not readable: ${vault} (${(e as Error).message})`, 2);
  }
  return { files, empty };
};
