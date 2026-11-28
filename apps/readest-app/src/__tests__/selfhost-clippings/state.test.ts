import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkIdentity,
  emptyState,
  loadState,
  saveState,
} from '../../../../../selfhost/clippings/lib/state.ts';
import type { State } from '../../../../../selfhost/clippings/lib/state.ts';
import { AuthRequiredError, CliError } from '../../../../../selfhost/cli/lib/errors.ts';
import { held, lost, syncDeps } from './helpers';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clip-state-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sample = (): State => ({
  ...emptyState(),
  identity: { vault: '/v', server: 'https://s', userId: 'u1' },
  files: {
    'a.md': {
      srcKey: 'k',
      epubSha256: 'e',
      bookHash: 'b'.repeat(32),
      metaHash: 'm',
      title: 'A',
      syncedAt: 1,
      imagesComplete: true,
      missingImages: [],
    },
  },
  history: { ['b'.repeat(32)]: 'a.md', ['c'.repeat(32)]: 'x.md' },
  ops: [{ kind: 'delete', relpath: 'x.md', oldHash: 'c'.repeat(32) }],
});

describe('state', () => {
  it('no file: an empty version 1 state', async () => {
    const { deps } = syncDeps(dir);
    expect(await loadState(deps, dir)).toEqual(emptyState());
  });

  it('round trip', async () => {
    const { deps } = syncDeps(dir);
    await saveState(deps, dir, sample(), held);
    expect(await loadState(deps, dir)).toEqual(sample());
    expect(readdirSync(dir), 'no tmp left').toEqual(['state.json']);
  });

  it('broken JSON or unknown version: exit 2', async () => {
    const { deps } = syncDeps(dir);
    writeFileSync(join(dir, 'state.json'), '{');
    await expect(loadState(deps, dir)).rejects.toMatchObject({ exitCode: 2 });
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ ...emptyState(), version: 2 }));
    await expect(loadState(deps, dir)).rejects.toMatchObject({ exitCode: 2 });
  });

  it('a journal entry that could steer paths or uploads is refused: exit 2', async () => {
    const { deps } = syncDeps(dir);
    const h = 'b'.repeat(32);
    const rec = { ...sample().files['a.md']!, bookHash: h, epubSha256: 'e'.repeat(64) };
    const good = {
      kind: 'upload',
      relpath: 'a.md',
      epub: `outbox/${h}/a.epub`,
      newHash: h,
      record: rec,
    };
    const history = { [h]: 'a.md', ['d'.repeat(32)]: 'a.md', ['f'.repeat(32)]: 'other.md' };
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ ...emptyState(), history, ops: [good] }),
    );
    await expect(loadState(deps, dir), 'a well-formed entry loads').resolves.toBeTruthy();
    const bad: unknown[] = [
      { ...good, newHash: '' },
      { ...good, epub: '../../x.epub' },
      { ...good, epub: `outbox/${'c'.repeat(32)}/a.epub` },
      { ...good, epub: `outbox/${h}/../a.epub` },
      { ...good, relpath: '../a.md' },
      { ...good, relpath: '/etc/a.md' },
      { ...good, record: { ...rec, bookHash: 'c'.repeat(32) } },
      { ...good, record: { ...rec, epubSha256: 'e' } },
      { ...good, kind: 'replace' },
      { ...good, kind: 'rm' },
      { kind: 'delete', relpath: 'a.md', oldHash: 'x' },
      'upload',
      { kind: 'delete', relpath: 'a.md', oldHash: 'e'.repeat(32) },
      { kind: 'delete', relpath: 'a.md', oldHash: 'f'.repeat(32) },
      { ...good, kind: 'replace', oldHash: 'e'.repeat(32) },
      {
        ...good,
        newHash: 'e'.repeat(32),
        epub: `outbox/${'e'.repeat(32)}/a.epub`,
        record: { ...rec, bookHash: 'e'.repeat(32) },
      },
      { ...good, record: { ...rec, title: undefined } },
      { ...good, record: { ...rec, missingImages: [1] } },
    ];
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        ...emptyState(),
        history,
        ops: [{ ...good, kind: 'replace', oldHash: 'd'.repeat(32) }],
      }),
    );
    await expect(loadState(deps, dir), 'a replace of our own book loads').resolves.toBeTruthy();
    for (const op of bad) {
      writeFileSync(
        join(dir, 'state.json'),
        JSON.stringify({ ...emptyState(), history, ops: [op] }),
      );
      await expect(loadState(deps, dir), JSON.stringify(op)).rejects.toMatchObject({ exitCode: 2 });
    }
  });

  it('a crash between tmp and rename keeps the old state', async () => {
    const { deps } = syncDeps(dir);
    await saveState(deps, dir, sample(), held);
    const before = readFileSync(join(dir, 'state.json'), 'utf8');
    const crashing = syncDeps(dir, {
      rename: async () => {
        throw new Error('crash');
      },
    }).deps;
    await expect(saveState(crashing, dir, emptyState(), held)).rejects.toThrow('crash');
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(before);
  });

  it('lock taken after the tmp is written: no rename, the file is unchanged', async () => {
    const { deps } = syncDeps(dir);
    await saveState(deps, dir, sample(), held);
    const before = readFileSync(join(dir, 'state.json'), 'utf8');
    await expect(saveState(deps, dir, emptyState(), lost)).rejects.toThrow('lock lost');
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['state.json']);
    expect(existsSync(join(dir, 'state.json'))).toBe(true);
  });

  it('checkIdentity: first, ok, vault and server exit 2, user exit 3', () => {
    const seen = { vault: '/v', server: 'https://s', userId: 'u1' };
    expect(checkIdentity(emptyState(), seen)).toBe('first');
    expect(checkIdentity(sample(), seen)).toBe('ok');
    const vault = () => checkIdentity(sample(), { ...seen, vault: '/w' });
    expect(vault).toThrow(CliError);
    expect(vault).toThrow(expect.objectContaining({ exitCode: 2 }));
    expect(() => checkIdentity(sample(), { ...seen, server: 'https://t' })).toThrow(
      expect.objectContaining({ exitCode: 2 }),
    );
    const user = () => checkIdentity(sample(), { ...seen, userId: 'u2' });
    expect(user).toThrow(AuthRequiredError);
    expect(user).toThrow(expect.objectContaining({ exitCode: 3 }));
  });
});
