import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { loadCfi } from './cfi.ts';
import { CliError } from './errors.ts';

export type CfiModule = {
  isCFI: RegExp;
  parse: (s: string) => unknown;
  compare: (a: string, b: string) => number;
};

export type Deps = {
  fetch: typeof fetch;
  now: () => number;
  env: Record<string, string | undefined>;
  homeDir: string;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  isTTY: boolean;
  readSecret: (prompt: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  isAlive: (pid: number) => boolean;
  processStart: (pid: number) => Promise<string | null>;
  loadCfi: () => Promise<CfiModule>;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to another user.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const processStart = (pid: number): Promise<string | null> =>
  new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], (err, out) => {
      const s = String(out ?? '').trim();
      resolve(err || !s ? null : s);
    });
  });

type TtyInput = NodeJS.ReadableStream & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

/**
 * Reads a line without echo: readline writes into a sink muted after the
 * prompt. `terminal: true` makes readline see Ctrl-C (raw mode turns it into
 * a `SIGINT` event of the interface, not a signal), so we restore the terminal
 * and exit 130 ourselves.
 */
export const secretReader =
  (input: TtyInput, output: NodeJS.WritableStream, exit: (code: number) => void) =>
  (prompt: string): Promise<string> =>
    new Promise((resolve, reject) => {
      let muted = false;
      const sink = new Writable({
        write(chunk, _enc, cb) {
          if (!muted) output.write(chunk);
          cb();
        },
      });
      const rl = createInterface({ input, output: sink, terminal: true });
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        try {
          rl.close();
        } finally {
          input.setRawMode?.(false);
          output.write('\n');
        }
        return true;
      };
      input.setRawMode?.(true);
      rl.on('SIGINT', () => {
        if (!finish()) return;
        exit(130);
        reject(new CliError('interrupted', 130));
      });
      rl.on('close', () => {
        if (finish()) reject(new CliError('no input'));
      });
      rl.question(prompt, (answer) => {
        if (finish()) resolve(answer);
      });
      muted = true;
    });

export const realDeps = (): Deps => ({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  env: process.env,
  homeDir: homedir(),
  stdout: (s) => {
    process.stdout.write(s);
  },
  stderr: (s) => {
    process.stderr.write(s);
  },
  isTTY: Boolean(process.stdin.isTTY),
  readSecret: secretReader(process.stdin, process.stderr, (code) => process.exit(code)),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isAlive,
  processStart,
  loadCfi: () => loadCfi(),
});
