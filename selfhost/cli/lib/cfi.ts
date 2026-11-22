import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CfiModule } from './deps.ts';
import { CliError } from './errors.ts';

const MISSING =
  'notes needs the foliate-js submodule: git submodule update --init -- packages/foliate-js';

/**
 * foliate-js's epubcfi.js is the app's own comparator; it is loaded lazily so
 * every other command works in a checkout without the submodule.
 */
export const loadCfi = async (
  base: URL = new URL('../../../packages/foliate-js/', import.meta.url),
): Promise<CfiModule> => {
  const url = new URL('epubcfi.js', base);
  if (!existsSync(fileURLToPath(url))) throw new CliError(MISSING);
  let mod: unknown;
  try {
    mod = await import(url.href);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') throw new CliError(MISSING);
    throw e;
  }
  const m = mod as Partial<CfiModule>;
  if (
    !(m.isCFI instanceof RegExp) ||
    typeof m.parse !== 'function' ||
    typeof m.compare !== 'function'
  ) {
    throw new CliError(`${fileURLToPath(url)} does not look like foliate-js epubcfi.js`);
  }
  return m as CfiModule;
};

type Step = { index?: unknown };

const hasSteps = (path: unknown): boolean =>
  Array.isArray(path) &&
  path.some(
    (part) =>
      Array.isArray(part) &&
      part.some((s: Step) => typeof s?.index === 'number' && !Number.isNaN(s.index)),
  );

/** A point needs at least one indexed step; a range needs them in parent, start and end. */
export const isValidCfi = (cfi: string, mod: CfiModule): boolean => {
  if (!cfi || !mod.isCFI.test(cfi)) return false;
  let parsed: unknown;
  try {
    parsed = mod.parse(cfi);
  } catch {
    return false;
  }
  if (Array.isArray(parsed)) return hasSteps(parsed);
  const r = parsed as { parent?: unknown; start?: unknown; end?: unknown } | null;
  return !!r && hasSteps(r.parent) && hasSteps(r.start) && hasSteps(r.end);
};
