import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { realDeps } from '../../cli/lib/deps.ts';
import type { Deps } from '../../cli/lib/deps.ts';

export type RunOpts = {
  env?: Record<string, string | undefined>;
  input?: string;
  timeoutMs: number;
  cwd?: string;
};
/** `code` is null when the process was killed on its timeout. */
export type RunResult = { code: number | null; stdout: string; stderr: string };
export type DirEntry = { name: string; kind: 'file' | 'dir' | 'symlink' | 'other' };

export type SyncDeps = Deps & {
  run: (cmd: string, args: string[], opts: RunOpts) => Promise<RunResult>;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  readdir: (path: string) => Promise<DirEntry[]>;
  stat: (path: string) => Promise<{ size: number; isFile: boolean; isDir: boolean }>;
  mkdir: (path: string) => Promise<void>;
  realpath: (path: string) => Promise<string>;
};

/** Spawns without a shell; a missing binary is exit 127, as a shell would report it. */
export const spawnRun = (cmd: string, args: string[], opts: RunOpts): Promise<RunResult> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ code: e.code === 'ENOENT' ? 127 : 1, stdout: '', stderr: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? null : (code ?? 1),
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    // A child that exits before reading its stdin must not crash us with EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input ?? '');
  });

export const fsDeps = {
  readFile: async (p: string) => new Uint8Array(await readFile(p)),
  writeFile: async (p: string, data: string | Uint8Array) => {
    await writeFile(p, data, { mode: 0o600 });
  },
  rename: (a: string, b: string) => rename(a, b),
  rm: (p: string) => rm(p, { recursive: true, force: true }),
  readdir: async (p: string): Promise<DirEntry[]> =>
    (await readdir(p, { withFileTypes: true })).map((d) => ({
      name: d.name,
      kind: d.isSymbolicLink()
        ? 'symlink'
        : d.isDirectory()
          ? 'dir'
          : d.isFile()
            ? 'file'
            : 'other',
    })),
  stat: async (p: string) => {
    const s = await stat(p);
    return { size: s.size, isFile: s.isFile(), isDir: s.isDirectory() };
  },
  mkdir: async (p: string) => {
    await mkdir(p, { recursive: true, mode: 0o700 });
  },
  realpath: (p: string) => realpath(p),
};

export const realSyncDeps = (): SyncDeps => ({ ...realDeps(), ...fsDeps, run: spawnRun });
