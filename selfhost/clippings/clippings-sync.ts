#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { CliError, UsageError } from '../cli/lib/errors.ts';
import { realSyncDeps } from './lib/deps.ts';
import type { SyncDeps } from './lib/deps.ts';
import { runSync } from './lib/run.ts';

const USAGE = `Usage: readest-clippings-sync [--dry-run] [--allow-mass-delete] [--notify] [--vault DIR] [--state DIR]

Mirrors the Obsidian clippings folder into the Readest group Clippings as EPUB books.

  --dry-run            print the plan; write nothing, download nothing
  --allow-mass-delete  delete even when the vault is empty or many files are gone
  --notify             on a login problem, tell the user once through levi notify
  --vault DIR          default /Users/stasmarkin/Workspace/Obsidian/06_Clippings
  --state DIR          default ~/.local/state/readest-clippings

Exit codes: 0 ok, 1 a file failed, 2 usage, environment or a guard stop, 3 readest login needed.
`;

export const DEFAULT_VAULT = '/Users/stasmarkin/Workspace/Obsidian/06_Clippings';

export const main = async (argv: string[], deps: SyncDeps): Promise<number> => {
  try {
    let values: Record<string, string | boolean | undefined>;
    try {
      ({ values } = parseArgs({
        args: argv,
        options: {
          'dry-run': { type: 'boolean' },
          'allow-mass-delete': { type: 'boolean' },
          notify: { type: 'boolean' },
          vault: { type: 'string' },
          state: { type: 'string' },
          help: { type: 'boolean', short: 'h' },
        },
        allowPositionals: false,
        strict: true,
      }));
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    if (values['help']) {
      deps.stdout(USAGE);
      return 0;
    }
    const dir = (k: string, fallback: string) => {
      const v = values[k];
      if (v === '') throw new UsageError(`--${k} needs a directory`);
      return typeof v === 'string' ? v : fallback;
    };
    return await runSync(
      {
        dryRun: !!values['dry-run'],
        allowMassDelete: !!values['allow-mass-delete'],
        notify: !!values['notify'],
        vault: dir('vault', DEFAULT_VAULT),
        stateDir: dir('state', join(deps.homeDir, '.local', 'state', 'readest-clippings')),
      },
      deps,
    );
  } catch (e) {
    deps.stderr(`clippings-sync: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof UsageError) deps.stderr(USAGE);
    return e instanceof CliError ? e.exitCode : 1;
  }
};

const isDirectRun = (): boolean => {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
};

if (isDirectRun()) {
  main(process.argv.slice(2), realSyncDeps()).then((code) => {
    // Exit explicitly once output is flushed: a lock heartbeat timer may still be pending.
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  });
}
