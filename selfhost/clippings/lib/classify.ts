import type { Scan } from './scan.ts';
import type { State } from './state.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

export type Plan = {
  upload: string[];
  replace: string[];
  delete: string[];
  rebuild: string[];
  toOptOut: string[];
  massDeleteStop?: 'empty' | 'threshold';
};

/** Removing more than this many registered files in one run needs --allow-mass-delete. */
export const massDeleteLimit = (registered: number) => Math.max(10, 0.2 * registered);

export const classify = (state: State, scan: Scan, liveHashes: Set<string>, now: number): Plan => {
  const plan: Plan = { upload: [], replace: [], delete: [], rebuild: [], toOptOut: [] };
  const registered = Object.keys(state.files).sort();
  for (const relpath of registered) {
    // Gone from the library while we still own it: the user deleted it by hand.
    if (!liveHashes.has(state.files[relpath]!.bookHash)) plan.toOptOut.push(relpath);
  }
  const optedOut = new Set([...Object.keys(state.optOut), ...plan.toOptOut]);
  for (const [relpath, f] of [...scan.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (optedOut.has(relpath)) continue;
    const rec = state.files[relpath];
    if (!rec) plan.upload.push(relpath);
    else if (rec.srcKey !== f.srcKey) plan.replace.push(relpath);
    else if (!rec.imagesComplete && now - (rec.rebuildAttemptAt ?? rec.syncedAt) > DAY_MS) {
      plan.rebuild.push(relpath);
    }
  }
  for (const relpath of registered) {
    if (optedOut.has(relpath) || scan.files.has(relpath) || scan.empty.has(relpath)) continue;
    plan.delete.push(relpath);
  }
  if (plan.delete.length) {
    if (scan.files.size + scan.empty.size === 0) plan.massDeleteStop = 'empty';
    else if (plan.delete.length > massDeleteLimit(registered.length)) {
      plan.massDeleteStop = 'threshold';
    }
  }
  return plan;
};
