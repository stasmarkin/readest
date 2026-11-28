#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ApiClient, isBookHash } from './lib/api.ts';
import { booksJson, booksTable, findBook, loadLibrary, searchBooks } from './lib/books.ts';
import { resolveProfile } from './lib/config.ts';
import { realDeps } from './lib/deps.ts';
import type { Deps } from './lib/deps.ts';
import { AuthRequiredError, CliError, UsageError } from './lib/errors.ts';
import { prepareNotes, renderNotesJson, renderNotesMarkdown } from './lib/notes.ts';
import { login, logout, readSession } from './lib/session.ts';
import { deleteText, runDelete } from './lib/delete.ts';
import type { DeleteResult } from './lib/delete.ts';
import { runReplace } from './lib/replace.ts';
import { runUpload, uploadText } from './lib/upload.ts';
import type { UploadResult } from './lib/upload.ts';

const USAGE = `Usage: readest <command> [options]

Commands:
  login [--email E]      sign in (password from READEST_PASSWORD or a hidden prompt)
  logout                 sign out and forget the session
  whoami [--json]        show the signed-in account, checked by the server
  books [--search S] [--json]
  notes <book> [--format md|json] [--out FILE]
                         <book>: full hash, hash prefix (6+), or part of the title
  upload <files...> [--group PATH] [--dry-run] [--allow-duplicate] [--expect-meta M] [--json]
                         EPUB, PDF, FB2, FBZ; never prompts
  upload <file> --replace HASH [--resume] [--expect-meta M] [--json]
                         a new version of the book HASH: its group and progress move over
  delete <hashes...> [--json]
                         tombstone the books and remove their files from storage

Options:
  --expect-user ID       books, upload, delete: exit 3 if the session is another account
  --help                 show this help
  --version              show the CLI version

Exit codes: 0 ok, 1 failed, 2 usage error, 3 login required.
`;

type Values = Record<string, string | boolean | undefined>;
type Command = {
  options: NonNullable<ParseArgsConfig['options']>;
  run: (values: Values, positionals: string[], deps: Deps) => Promise<number>;
};

const str = (v: Values, k: string) => (typeof v[k] === 'string' ? (v[k] as string) : undefined);

/** `--expect-user`: the account the caller saw; a session of another one exits 3. */
const apiFor = async (v: Values, deps: Deps) => {
  const expectUserId = str(v, 'expect-user');
  if (expectUserId === '') throw new UsageError('--expect-user needs a user id');
  const profile = await resolveProfile(deps);
  return {
    profile,
    api: new ApiClient(deps, profile, expectUserId !== undefined ? { expectUserId } : {}),
  };
};

/** A script parsing --json still gets an array; codes 2 and 3 keep stdout empty. */
const jsonArrayRun = async <T>(v: Values, deps: Deps, fn: () => Promise<T[]>): Promise<T[]> => {
  try {
    return await fn();
  } catch (e) {
    if (v['json'] && !(e instanceof UsageError) && !(e instanceof AuthRequiredError)) {
      deps.stdout('[]\n');
    }
    throw e;
  }
};

const noArgs = (positionals: string[]) => {
  if (positionals.length) throw new UsageError(`unexpected argument: ${positionals[0]}`);
};

const COMMANDS: Record<string, Command> = {
  login: {
    options: { email: { type: 'string' } },
    run: async (v, positionals, deps) => {
      noArgs(positionals);
      const profile = await resolveProfile(deps);
      const email =
        str(v, 'email') ||
        deps.env['READEST_EMAIL'] ||
        (await readSession(deps, profile))?.user.email;
      if (!email)
        throw new UsageError('login needs --email E (run it yourself: ! readest login --email E)');
      let password = deps.env['READEST_PASSWORD'];
      if (!password) {
        if (!deps.isTTY) {
          throw new UsageError(
            'no terminal to ask for the password: set READEST_PASSWORD, or run it yourself: ! readest login',
          );
        }
        password = await deps.readSecret('Password: ');
      }
      if (!password) throw new UsageError('empty password');
      const s = await login(deps, profile, email, password);
      deps.stdout(`signed in as ${s.user.email} (${profile.apiBase})\n`);
      return 0;
    },
  },
  logout: {
    options: {},
    run: async (_v, positionals, deps) => {
      noArgs(positionals);
      await logout(deps, await resolveProfile(deps));
      deps.stdout('signed out\n');
      return 0;
    },
  },
  whoami: {
    options: { json: { type: 'boolean' } },
    run: async (v, positionals, deps) => {
      noArgs(positionals);
      const profile = await resolveProfile(deps);
      const api = new ApiClient(deps, profile);
      // A local session file proves nothing: the server may have revoked it.
      await api.ping();
      const s = api.sessionInfo();
      deps.stdout(
        v['json']
          ? `${JSON.stringify({ email: s.email, userId: s.userId, server: profile.apiBase })}\n`
          : `email:   ${s.email}\nuser id: ${s.userId}\nserver:  ${profile.apiBase}\n` +
              `token expires: ${new Date(s.expiresAt * 1000).toISOString()}\n`,
      );
      return 0;
    },
  },
  books: {
    options: {
      search: { type: 'string' },
      json: { type: 'boolean' },
      'expect-user': { type: 'string' },
    },
    run: async (v, positionals, deps) => {
      noArgs(positionals);
      const { api } = await apiFor(v, deps);
      let books = await loadLibrary(api);
      const search = str(v, 'search');
      if (search !== undefined) books = searchBooks(books, search);
      deps.stdout(v['json'] ? booksJson(books) : booksTable(books));
      return 0;
    },
  },
  notes: {
    options: { format: { type: 'string' }, out: { type: 'string' } },
    run: async (v, positionals, deps) => {
      if (positionals.length !== 1) throw new UsageError('notes takes exactly one <book>');
      const format = str(v, 'format') ?? 'md';
      if (format !== 'md' && format !== 'json')
        throw new UsageError(`--format must be md or json: ${format}`);
      const cfi = await deps.loadCfi();
      const api = new ApiClient(deps, await resolveProfile(deps));
      const book = findBook(await loadLibrary(api), positionals[0]!);
      const notes = prepareNotes(await api.pullNotes(book.hash, book.metaHash ?? undefined), cfi);
      const text =
        format === 'json'
          ? renderNotesJson(book, notes)
          : renderNotesMarkdown(book, notes, deps.now());
      const out = str(v, 'out');
      if (out === undefined) {
        deps.stdout(text);
      } else {
        await writeFile(out, text);
        deps.stderr(`wrote ${notes.length} notes to ${out}\n`);
      }
      return 0;
    },
  },
  upload: {
    options: {
      group: { type: 'string' },
      'dry-run': { type: 'boolean' },
      'allow-duplicate': { type: 'boolean' },
      json: { type: 'boolean' },
      'expect-user': { type: 'string' },
      'expect-meta': { type: 'string' },
      replace: { type: 'string' },
      resume: { type: 'boolean' },
    },
    run: async (v, positionals, deps) => {
      if (positionals.length === 0) throw new UsageError('upload needs at least one file');
      const group = str(v, 'group');
      const replace = str(v, 'replace');
      const expectMeta = str(v, 'expect-meta');
      if (expectMeta === '') throw new UsageError('--expect-meta needs a metaHash');
      if (replace !== undefined) {
        // The group comes from the old row; a dry run cannot show a replace's later steps.
        for (const flag of ['group', 'dry-run', 'allow-duplicate']) {
          if (v[flag] !== undefined) throw new UsageError(`--${flag} does not go with --replace`);
        }
        if (positionals.length !== 1) throw new UsageError('--replace takes exactly one file');
        if (!isBookHash(replace)) throw new UsageError(`--replace needs a book hash: "${replace}"`);
      } else if (v['resume']) {
        throw new UsageError('--resume goes only with --replace');
      }
      const results: UploadResult[] = await jsonArrayRun(v, deps, async () => {
        const { api, profile } = await apiFor(v, deps);
        const meta = expectMeta !== undefined ? { expectMeta } : {};
        if (replace !== undefined) {
          return [
            await runReplace(deps, api, profile, positionals[0]!, replace, {
              resume: !!v['resume'],
              ...meta,
            }),
          ];
        }
        return runUpload(deps, api, profile, positionals, {
          ...(group !== undefined ? { group } : {}),
          dryRun: !!v['dry-run'],
          allowDuplicate: !!v['allow-duplicate'],
          ...meta,
        });
      });
      deps.stdout(v['json'] ? `${JSON.stringify(results, null, 2)}\n` : uploadText(results));
      return results.some((r) => r.status === 'error') ? 1 : 0;
    },
  },
  delete: {
    options: { json: { type: 'boolean' }, 'expect-user': { type: 'string' } },
    run: async (v, positionals, deps) => {
      if (positionals.length === 0) throw new UsageError('delete needs at least one book hash');
      const bad = positionals.find((h) => !isBookHash(h));
      if (bad !== undefined) throw new UsageError(`not a book hash: "${bad}"`);
      const results: DeleteResult[] = await jsonArrayRun(v, deps, async () => {
        const { api, profile } = await apiFor(v, deps);
        return runDelete(deps, api, profile, positionals);
      });
      deps.stdout(v['json'] ? `${JSON.stringify(results, null, 2)}\n` : deleteText(results));
      return results.some((r) => r.status === 'error') ? 1 : 0;
    },
  },
};

const version = (): string => {
  try {
    const dir = dirname(realpathSync(fileURLToPath(import.meta.url)));
    const sha = execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || 'dev';
  } catch {
    return 'dev';
  }
};

export const main = async (argv: string[], deps: Deps): Promise<number> => {
  try {
    const [name, ...rest] = argv;
    if (!name || name === '--help' || name === '-h' || name === 'help') {
      deps.stdout(USAGE);
      return 0;
    }
    if (name === '--version') {
      deps.stdout(`${version()}\n`);
      return 0;
    }
    const command = COMMANDS[name];
    if (!command) throw new UsageError(`unknown command: ${name}`);
    let parsed: { values: Values; positionals: string[] };
    try {
      parsed = parseArgs({
        args: rest,
        options: { ...command.options, help: { type: 'boolean', short: 'h' } },
        allowPositionals: true,
        strict: true,
      }) as { values: Values; positionals: string[] };
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    if (parsed.values['help']) {
      deps.stdout(USAGE);
      return 0;
    }
    return await command.run(parsed.values, parsed.positionals, deps);
  } catch (e) {
    if (e instanceof CliError) {
      deps.stderr(`readest: ${e.message}\n`);
      if (e instanceof UsageError) deps.stderr(USAGE);
      return e.exitCode;
    }
    deps.stderr(`readest: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
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
  main(process.argv.slice(2), realDeps()).then((code) => {
    // Exit explicitly once output is flushed: a lock heartbeat timer may still be pending.
    process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
  });
}
