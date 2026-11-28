// Shared fakes for the clippings-sync tests: SyncDeps over real tmp directories.
import { fsDeps } from '../../../../../selfhost/clippings/lib/deps.ts';
import type { RunOpts, RunResult, SyncDeps } from '../../../../../selfhost/clippings/lib/deps.ts';
import { fakeDeps } from '../selfhost-cli/fake-server';

export type RunCall = { cmd: string; args: string[]; opts: RunOpts };
export type RunFn = (cmd: string, args: string[], opts: RunOpts) => Promise<RunResult>;

export const noRun: RunFn = async (cmd) => {
  throw new Error(`unexpected process: ${cmd}`);
};

export const syncDeps = (home: string, over: Partial<SyncDeps> = {}) => {
  const f = fakeDeps(async () => {
    throw new Error('no network in clippings tests');
  }, home);
  const calls: RunCall[] = [];
  const inner = over.run ?? noRun;
  const deps: SyncDeps = {
    ...f.deps,
    ...fsDeps,
    ...over,
    run: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return inner(cmd, args, opts);
    },
  };
  return { deps, calls, stdout: f.stdout, stderr: f.stderr };
};

export const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
export const held = { assertHeld: () => {} };
export const lost = {
  assertHeld: () => {
    throw new Error('lock lost');
  },
};
