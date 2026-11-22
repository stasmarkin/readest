import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { main } from '../../../../../selfhost/cli/readest.ts';
import type { Deps } from '../../../../../selfhost/cli/lib/deps.ts';
import { secretReader } from '../../../../../selfhost/cli/lib/deps.ts';
import { loadCfi } from '../../../../../selfhost/cli/lib/cfi.ts';
import { CliError } from '../../../../../selfhost/cli/lib/errors.ts';
import { sessionPath } from '../../../../../selfhost/cli/lib/session.ts';
import {
  API,
  fakeDeps,
  fakeServer,
  json,
  PROFILE,
  SB,
  UID,
  writeFreshSession,
} from './fake-server';

const ENV = {
  READEST_API_URL: PROFILE.apiBase,
  READEST_SUPABASE_URL: PROFILE.supabaseUrl,
  READEST_ANON_KEY: PROFILE.anonKey,
};
const FOLIATE = pathToFileURL(`${resolve(__dirname, '../../../../../packages/foliate-js')}/`);
const PASSWORD = 'S3cret-pw-42';

let home: string;
let dir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'readest-cli-main-'));
  dir = mkdtempSync(join(tmpdir(), 'readest-cli-main-files-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const setup = (over: Partial<Deps> = {}, opts: { session?: boolean } = {}) => {
  const server = fakeServer();
  const f = fakeDeps(server.handler, home, { env: { ...ENV }, ...over });
  // The env profile's key, derived exactly as resolveProfile does it.
  if (opts.session !== false) writeFreshSession(f.deps, profileOf());
  const cli = (...argv: string[]) => main(argv, f.deps);
  return { server, cli, ...f };
};

// The key resolveProfile derives for the ENV profile.
const profileOf = () => ({
  ...PROFILE,
  key: `api.test-${createHash('sha256').update(`${API}|${SB}`).digest('hex').slice(0, 8)}`,
});

const epub = (title: string) => {
  const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title><dc:creator>A</dc:creator><dc:identifier id="u">x-${title}</dc:identifier></metadata>
<manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>`;
  const path = join(dir, `${title}.epub`);
  writeFileSync(
    path,
    zipSync({
      mimetype: [strToU8('application/epub+zip'), { level: 0 }],
      'META-INF/container.xml': strToU8(
        '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="o.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
      ),
      'o.opf': strToU8(opf),
      'c.xhtml': strToU8(`<html><body>${title}</body></html>`),
    }),
  );
  return path;
};

describe('usage', () => {
  it.each([
    [['bogus']],
    [['books', '--bogus']],
    [['notes']],
    [['upload']],
    [['whoami', 'extra']],
    [['notes', 'x', '--format', 'xml']],
  ])('%j → 2 with usage on stderr', async (argv) => {
    const s = setup();
    expect(await s.cli(...argv)).toBe(2);
    expect(s.stderr()).toContain('Usage: readest');
    expect(s.stdout()).toBe('');
  });

  it('--help works without a session and without the network', async () => {
    const s = setup({}, { session: false });
    expect(await s.cli('--help')).toBe(0);
    expect(s.stdout()).toContain('Usage: readest');
    expect(s.server.calls).toHaveLength(0);
    expect(await s.cli('books', '--help')).toBe(0);
  });

  it('upload --group with an empty segment → 2 before any request', async () => {
    const s = setup();
    expect(await s.cli('upload', epub('G'), '--group', 'A//B')).toBe(2);
    expect(s.server.calls).toHaveLength(0);
  });
});

describe('whoami', () => {
  it('without a session → 3 and the login hint', async () => {
    const s = setup({}, { session: false });
    expect(await s.cli('whoami')).toBe(3);
    expect(s.stderr()).toContain('login required: run readest login');
  });

  it('prints email, id, server and token expiry', async () => {
    const s = setup();
    expect(await s.cli('whoami')).toBe(0);
    const out = s.stdout();
    expect(out).toContain('me@example.com');
    expect(out).toContain(UID);
    expect(out).toContain(PROFILE.apiBase);
    expect(out).toMatch(/expires.*\d{4}-\d\d-\d\dT/);
  });

  it('works when the foliate-js submodule is missing', async () => {
    const s = setup({ loadCfi: () => Promise.reject(new CliError('no submodule')) });
    expect(await s.cli('whoami')).toBe(0);
    expect(await s.cli('books')).toBe(0);
  });
});

describe('books', () => {
  it('--json prints the library', async () => {
    const s = setup();
    s.server.addBook({ book_hash: 'a'.repeat(32), title: 'Solaris', meta_hash: 'm' });
    expect(await s.cli('books', '--json')).toBe(0);
    const parsed = JSON.parse(s.stdout()) as Array<{ title: string }>;
    expect(parsed.map((b) => b.title)).toEqual(['Solaris']);
  });

  it('--search filters the table; an empty library says so', async () => {
    const s = setup();
    expect(await s.cli('books')).toBe(0);
    expect(s.stdout()).toBe('books: none\n');
    s.server.addBook({ book_hash: 'a'.repeat(32), title: 'Solaris' });
    s.server.addBook({ book_hash: 'b'.repeat(32), title: 'Dune' });
    s.out.length = 0;
    expect(await s.cli('books', '--search', 'dun')).toBe(0);
    expect(s.stdout()).toMatch(/^bbbbbbb .*Dune\n$/);
  });
});

describe('notes', () => {
  const seed = (s: ReturnType<typeof setup>) => {
    s.server.addBook({ book_hash: 'a'.repeat(32), title: 'Solaris', author: 'Lem', meta_hash: '' });
    s.server.notes.push({
      book_hash: 'a'.repeat(32),
      id: 'n1',
      type: 'annotation',
      cfi: 'epubcfi(/6/4!/4/2/1:0)',
      text: 'the ocean',
      note: 'mimoid',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deleted_at: null,
    });
  };

  it('prints markdown to stdout, json with --format json', async () => {
    const s = setup({ loadCfi: () => loadCfi(FOLIATE) });
    seed(s);
    expect(await s.cli('notes', 'solaris')).toBe(0);
    expect(s.stdout()).toContain('# Solaris');
    expect(s.stdout()).toContain('> the ocean');
    expect(
      s.server.calls
        .find((c) => c.url.searchParams.get('type') === 'notes')!
        .url.searchParams.has('meta_hash'),
    ).toBe(false);
    s.out.length = 0;
    expect(await s.cli('notes', 'aaaaaa', '--format', 'json')).toBe(0);
    expect((JSON.parse(s.stdout()) as { notes: unknown[] }).notes).toHaveLength(1);
  });

  it('--out overwrites an existing file and leaves stdout empty', async () => {
    const s = setup({ loadCfi: () => loadCfi(FOLIATE) });
    seed(s);
    const out = join(dir, 'notes.md');
    writeFileSync(out, 'old content that is longer than nothing');
    expect(await s.cli('notes', 'solaris', '--out', out)).toBe(0);
    expect(s.stdout()).toBe('');
    expect(readFileSync(out, 'utf8')).toMatch(/^# Solaris\n/);
  });

  it('without the submodule fails with its hint', async () => {
    const s = setup({ loadCfi: () => loadCfi(pathToFileURL(`${dir}/`)) });
    seed(s);
    expect(await s.cli('notes', 'solaris')).toBe(1);
    expect(s.stderr()).toContain('git submodule update --init -- packages/foliate-js');
  });
});

describe('upload', () => {
  it('--json: one array on stdout, exit 1 when a file failed', async () => {
    const s = setup();
    const broken = join(dir, 'broken.epub');
    writeFileSync(broken, 'nope');
    const good = epub('Good');
    expect(await s.cli('upload', broken, good, '--json')).toBe(1);
    const parsed = JSON.parse(s.stdout()) as Array<{ file: string; status: string }>;
    expect(parsed.map((r) => [r.file, r.status])).toEqual([
      [broken, 'error'],
      [good, 'uploaded'],
    ]);
    expect(s.out).toHaveLength(1);
  });

  it('is idempotent: a re-run exits 0 with skipped: already', async () => {
    const s = setup();
    const good = epub('Twice');
    expect(await s.cli('upload', good, '--json')).toBe(0);
    s.out.length = 0;
    expect(await s.cli('upload', good, '--json')).toBe(0);
    expect(JSON.parse(s.stdout())).toEqual([
      expect.objectContaining({ file: good, status: 'skipped', reason: 'already' }),
    ]);
  });

  it('a re-run after a failed PUT continues and exits 0', async () => {
    const s = setup();
    const good = epub('Resume');
    s.server.setIntercept((c) =>
      c.method === 'PUT' ? new Response('', { status: 503 }) : undefined,
    );
    expect(await s.cli('upload', good)).toBe(1);
    expect(s.stdout()).toMatch(/^error .*readest upload/m);
    s.server.setIntercept(undefined);
    s.out.length = 0;
    expect(await s.cli('upload', good)).toBe(0);
    expect(s.stdout()).toMatch(/^uploaded\s+\w{7}\s+Resume\n$/);
  });

  it('--json with the sync endpoint down reports the file as an error and exits 1', async () => {
    const s = setup();
    s.server.setIntercept((c) =>
      c.method === 'GET' && c.path === '/api/sync' ? json(500, { error: 'db down' }) : undefined,
    );
    const path = epub('Down');
    expect(await s.cli('upload', path, '--json')).toBe(1);
    const out = JSON.parse(s.stdout()) as Array<{ file: string; status: string; reason: string }>;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: path, status: 'error' });
    expect(out[0]!.reason).toContain('db down');
  });

  it('--json with a failing server discovery prints [] and exits 1', async () => {
    const s = setup({ env: { READEST_URL: 'https://readest.example' } }, { session: false });
    expect(await s.cli('upload', epub('Nowhere'), '--json')).toBe(1);
    expect(s.stdout()).toBe('[]\n');
    expect(s.stderr()).toContain('readest-client-config.json');
  });

  it('never prompts: an expired session it cannot refresh exits 3', async () => {
    const readSecret = vi.fn(async () => PASSWORD);
    const s = setup({ readSecret, isTTY: true }, { session: false });
    const path = sessionPath(s.deps, profileOf());
    writeFreshSession(s.deps, profileOf());
    const stale = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    writeFileSync(path, JSON.stringify({ ...stale, expires_at: 1 }));
    s.server.setIntercept((c) =>
      c.url.origin === SB ? json(400, { error: 'invalid_grant' }) : undefined,
    );
    expect(await s.cli('upload', epub('Stale'), '--json')).toBe(3);
    expect(readSecret).not.toHaveBeenCalled();
    expect(s.stdout()).toBe('');
  });
});

describe('login', () => {
  const tokenRoute = (s: ReturnType<typeof setup>) =>
    s.server.setIntercept((c) =>
      c.url.origin === SB
        ? json(200, {
            access_token: 'at-9',
            refresh_token: 'rt-9',
            expires_in: 3600,
            user: { id: UID, email: 'me@example.com' },
          })
        : undefined,
    );

  it('without a TTY or READEST_PASSWORD → 2 and the "! readest login" hint', async () => {
    const s = setup({}, { session: false });
    expect(await s.cli('login', '--email', 'me@example.com')).toBe(2);
    expect(s.stderr()).toContain('! readest login');
    expect(s.server.calls).toHaveLength(0);
  });

  it('READEST_PASSWORD is used and never printed', async () => {
    const s = setup({ env: { ...ENV, READEST_PASSWORD: PASSWORD } }, { session: false });
    tokenRoute(s);
    expect(await s.cli('login', '--email', 'me@example.com')).toBe(0);
    expect(s.stdout()).toContain('me@example.com');
    expect(s.stdout() + s.stderr()).not.toContain(PASSWORD);
    expect(s.server.calls[0]!.body).toEqual({ email: 'me@example.com', password: PASSWORD });
  });

  it('asks for the password on a TTY and never prints it', async () => {
    const readSecret = vi.fn(async () => PASSWORD);
    const s = setup({ readSecret, isTTY: true }, { session: false });
    tokenRoute(s);
    expect(await s.cli('login', '--email', 'me@example.com')).toBe(0);
    expect(readSecret).toHaveBeenCalledOnce();
    expect(s.stdout() + s.stderr()).not.toContain(PASSWORD);
  });

  it('a wrong password → 3', async () => {
    const s = setup({ env: { ...ENV, READEST_PASSWORD: 'bad' } }, { session: false });
    s.server.setIntercept((c) =>
      c.url.origin === SB
        ? json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' })
        : undefined,
    );
    expect(await s.cli('login', '--email', 'me@example.com')).toBe(3);
    expect(s.stderr()).toContain('login failed: invalid email or password');
    expect(s.stderr()).not.toContain('run readest login');
  });
});

describe('secretReader', () => {
  const tty = () => {
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      setRawMode: vi.fn(function (this: unknown) {
        return this;
      }),
    });
    const written: string[] = [];
    const output = new PassThrough();
    output.on('data', (c: Buffer) => written.push(c.toString()));
    return { input, output, written };
  };

  it('does not echo the typed characters and restores the terminal', async () => {
    const t = tty();
    const exit = vi.fn();
    const p = secretReader(t.input, t.output, exit)('Password: ');
    t.input.write('hunter2\r');
    await expect(p).resolves.toBe('hunter2');
    await new Promise((r) => setImmediate(r));
    expect(t.written.join('')).toContain('Password: ');
    expect(t.written.join('')).not.toContain('hunter2');
    expect(t.input.setRawMode).toHaveBeenCalledWith(true);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('Ctrl-C restores the terminal and exits 130', async () => {
    const t = tty();
    const exit = vi.fn();
    const p = secretReader(t.input, t.output, exit)('Password: ');
    t.input.write('abc\x03');
    await expect(p).rejects.toMatchObject({ exitCode: 130 });
    expect(exit).toHaveBeenCalledWith(130);
    expect(t.input.setRawMode).toHaveBeenLastCalledWith(false);
    expect(t.written.join('')).not.toContain('abc');
  });
});
