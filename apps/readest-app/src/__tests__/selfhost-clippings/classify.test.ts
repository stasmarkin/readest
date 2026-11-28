import { describe, it, expect } from 'vitest';
import { classify, DAY_MS } from '../../../../../selfhost/clippings/lib/classify.ts';
import type { Scan, ScannedFile } from '../../../../../selfhost/clippings/lib/scan.ts';
import { emptyState } from '../../../../../selfhost/clippings/lib/state.ts';
import type { FileRecord, State } from '../../../../../selfhost/clippings/lib/state.ts';

const NOW = Date.UTC(2026, 10, 22);
const h = (n: number) => n.toString(16).padStart(32, '0');
const rec = (n: number, over: Partial<FileRecord> = {}): FileRecord => ({
  srcKey: `k${n}`,
  epubSha256: 'e',
  bookHash: h(n),
  metaHash: 'm',
  title: 't',
  syncedAt: NOW - 1000,
  imagesComplete: true,
  missingImages: [],
  ...over,
});
const file = (srcKey: string): ScannedFile => ({
  bytes: new Uint8Array([1]),
  localImages: new Map(),
  srcKey,
});
const scanOf = (files: Record<string, string>, empty: string[] = []): Scan => ({
  files: new Map(Object.entries(files).map(([k, v]) => [k, file(v)])),
  empty: new Set(empty),
});
const stateWith = (n: number, over: Partial<State> = {}): State => {
  const s = { ...emptyState(), ...over };
  for (let i = 0; i < n; i++) s.files[`f${i}.md`] = rec(i);
  return s;
};
const live = (s: State) => new Set(Object.values(s.files).map((r) => r.bookHash));
const allOf = (n: number, skip: number[] = []) =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => i)
      .filter((i) => !skip.includes(i))
      .map((i) => [`f${i}.md`, `k${i}`]),
  );

describe('classify', () => {
  it('new, changed, gone, rebuild due, unchanged', () => {
    const s = stateWith(4);
    s.files['f2.md'] = rec(2, { imagesComplete: false, syncedAt: NOW - DAY_MS - 1 });
    s.files['f3.md'] = rec(3, {
      imagesComplete: false,
      syncedAt: NOW - 3 * DAY_MS,
      rebuildAttemptAt: NOW - DAY_MS + 1000,
    });
    const p = classify(
      s,
      scanOf({ 'new.md': 'x', 'f0.md': 'changed', 'f2.md': 'k2', 'f3.md': 'k3' }),
      live(s),
      NOW,
    );
    expect(p).toEqual({
      upload: ['new.md'],
      replace: ['f0.md'],
      delete: ['f1.md'],
      rebuild: ['f2.md'],
      toOptOut: [],
    });
    s.files['f2.md'] = rec(2, { imagesComplete: false, syncedAt: NOW - DAY_MS + 1000 });
    expect(classify(s, scanOf(allOf(4)), live(s), NOW).rebuild, 'within 24 h of syncedAt').toEqual(
      [],
    );
  });

  it('a registered file now empty is in no list', () => {
    const s = stateWith(2);
    const p = classify(s, scanOf({ 'f0.md': 'k0' }, ['f1.md']), live(s), NOW);
    expect(p).toEqual({ upload: [], replace: [], delete: [], rebuild: [], toOptOut: [] });
    const n = classify(emptyState(), scanOf({}, ['new.md']), new Set(), NOW);
    expect(n.upload, 'new empty file').toEqual([]);
  });

  it('a book missing from the library goes to optOut and nowhere else', () => {
    const s = stateWith(2);
    const p = classify(s, scanOf({ 'f0.md': 'changed', 'f1.md': 'k1' }), new Set([h(1)]), NOW);
    expect(p.toOptOut).toEqual(['f0.md']);
    expect(p.replace).toEqual([]);
    const gone = classify(s, scanOf({ 'f1.md': 'k1' }), new Set([h(1)]), NOW);
    expect(gone.toOptOut).toEqual(['f0.md']);
    expect(gone.delete, 'no delete of an opted-out book').toEqual([]);
  });

  it('an optOut file is in no list, edited, gone or back', () => {
    const s = stateWith(1, { optOut: { 'x.md': h(9) } });
    for (const sc of [scanOf({ 'f0.md': 'k0', 'x.md': 'edited' }), scanOf({ 'f0.md': 'k0' })]) {
      expect(classify(s, sc, live(s), NOW)).toEqual({
        upload: [],
        replace: [],
        delete: [],
        rebuild: [],
        toOptOut: [],
      });
    }
  });

  it('mass delete: 10 of 50 passes, 11 stops; 12 of 60 passes, 13 stops', () => {
    const s50 = stateWith(50);
    const del = (s: State, n: number) =>
      classify(
        s,
        scanOf(
          allOf(
            Object.keys(s.files).length,
            Array.from({ length: n }, (_, i) => i),
          ),
        ),
        live(s),
        NOW,
      );
    expect(del(s50, 10).massDeleteStop).toBeUndefined();
    expect(del(s50, 10).delete).toHaveLength(10);
    expect(del(s50, 11).massDeleteStop).toBe('threshold');
    const s60 = stateWith(60);
    expect(del(s60, 12).massDeleteStop).toBeUndefined();
    expect(del(s60, 13).massDeleteStop).toBe('threshold');
  });

  it('an empty vault with 1 and with 7 records stops as empty', () => {
    for (const n of [1, 7]) {
      const s = stateWith(n);
      const p = classify(s, scanOf({}), live(s), NOW);
      expect(p.massDeleteStop).toBe('empty');
      expect(p.delete).toHaveLength(n);
    }
  });
});
