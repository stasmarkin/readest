import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanVault } from '../../../../../selfhost/clippings/lib/scan.ts';
import { fsDeps } from '../../../../../selfhost/clippings/lib/deps.ts';
import { syncDeps } from './helpers';

let root: string;
let vault: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clip-scan-'));
  vault = join(root, 'vault');
  mkdirSync(vault);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, data: string | Uint8Array) => {
  mkdirSync(join(vault, rel, '..'), { recursive: true });
  writeFileSync(join(vault, rel), data);
};
const scan = () => scanVault(syncDeps(root).deps, vault);

describe('scanVault', () => {
  it('skips hidden files and directories, sees nested ones, keeps empty files apart', async () => {
    put('a.md', 'a');
    put('sub/deep/b.md', 'b');
    put('.obsidian/c.md', 'c');
    put('.trash/d.md', 'd');
    put('.hidden.md', 'h');
    put('notes.txt', 't');
    put('zero.md', '');
    const s = await scan();
    expect([...s.files.keys()].sort()).toEqual(['a.md', 'sub/deep/b.md']);
    expect([...s.empty]).toEqual(['zero.md']);
  });

  it('srcKey changes with the .md, with a replaced local image and when it appears', async () => {
    put('a.md', 'x ![](img/p.png) <img src="q.png">');
    const k1 = (await scan()).files.get('a.md')!;
    expect([...k1.localImages.keys()].sort()).toEqual(['img/p.png', 'q.png']);
    expect(k1.localImages.get('img/p.png'), 'missing image').toBeNull();
    put('img/p.png', 'one');
    const k2 = (await scan()).files.get('a.md')!;
    expect(k2.srcKey, 'image appeared').not.toBe(k1.srcKey);
    expect(new TextDecoder().decode(k2.localImages.get('img/p.png')!.bytes)).toBe('one');
    put('img/p.png', 'two');
    const k3 = (await scan()).files.get('a.md')!;
    expect(k3.srcKey, 'image replaced').not.toBe(k2.srcKey);
    put('a.md', 'y ![](img/p.png) <img src="q.png">');
    expect((await scan()).files.get('a.md')!.srcKey, '.md edited').not.toBe(k3.srcKey);
    expect((await scan()).files.get('a.md')!.srcKey, 'stable').toBe(
      (await scan()).files.get('a.md')!.srcKey,
    );
  });

  it('a reference out of the vault is not read; nor is a symlink leading out', async () => {
    writeFileSync(join(root, 'secret.png'), 'secret');
    put('a.md', '![](../secret.png) ![](link.png)');
    symlinkSync(join(root, 'secret.png'), join(vault, 'link.png'));
    const f = (await scan()).files.get('a.md')!;
    expect([...f.localImages.keys()], 'climbing ref is dropped').toEqual(['link.png']);
    expect(f.localImages.get('link.png'), 'symlink out of the vault').toBeNull();
  });

  it('a .md symlink out of the vault is neither published nor missing', async () => {
    writeFileSync(join(root, 'outside.md'), 'secret');
    put('in.md', 'x');
    symlinkSync(join(root, 'outside.md'), join(vault, 'link.md'));
    symlinkSync(join(vault, 'in.md'), join(vault, 'alias.md'));
    const s = await scan();
    expect([...s.files.keys()].sort()).toEqual(['alias.md', 'in.md']);
    expect([...s.empty]).toEqual(['link.md']);
  });

  it('a broken .md symlink is kept apart, not missing', async () => {
    put('in.md', 'x');
    symlinkSync(join(root, 'nowhere.md'), join(vault, 'dead.md'));
    const s = await scan();
    expect([...s.files.keys()]).toEqual(['in.md']);
    expect([...s.empty]).toEqual(['dead.md']);
  });

  it('a reference definition in <…> with a space', async () => {
    put('a.md', '![x][p]\n\n[p]: <my pic.png>');
    put('my pic.png', 'q');
    const f = (await scan()).files.get('a.md')!;
    expect(new TextDecoder().decode(f.localImages.get('my pic.png')!.bytes)).toBe('q');
  });

  it('a stat failure other than ENOENT stops the scan (exit 2), not a deletion', async () => {
    put('a.md', 'a');
    const deps = syncDeps(root, {
      stat: async (p) => {
        if (p.endsWith('a.md')) throw Object.assign(new Error('EIO'), { code: 'EIO' });
        return fsDeps.stat(p);
      },
    }).deps;
    await expect(scanVault(deps, vault)).rejects.toMatchObject({ exitCode: 2 });
  });

  it('an image path in <…> with a space', async () => {
    put('a.md', '![](<my photo.png>)');
    put('my photo.png', 'p');
    const f = (await scan()).files.get('a.md')!;
    expect(new TextDecoder().decode(f.localImages.get('my photo.png')!.bytes)).toBe('p');
  });

  it('an unreadable vault: exit 2', async () => {
    await expect(scanVault(syncDeps(root).deps, join(root, 'nope'))).rejects.toMatchObject({
      exitCode: 2,
    });
  });
});
