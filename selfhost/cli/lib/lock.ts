import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, readdir, readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Deps } from './deps.ts';
import { CliError } from './errors.ts';

type LockInfo = { pid: number; started: string | null; token: string };

const POLL_MS = 200;
const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
const NOTIFY_MS = 30_000;

const parseLock = (text: string): LockInfo | null => {
  try {
    const v = JSON.parse(text) as Partial<LockInfo>;
    return typeof v.pid === 'number' && typeof v.token === 'string'
      ? { pid: v.pid, started: typeof v.started === 'string' ? v.started : null, token: v.token }
      : null;
  } catch {
    return null;
  }
};

const readLock = async (
  path: string,
): Promise<{ info: LockInfo | null; mtimeMs: number } | null> => {
  try {
    const [text, st] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { info: parseLock(text), mtimeMs: st.mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
};

const ignoreMissing = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
};

/**
 * A lock file published atomically with link(tmp, lock), so it is never seen
 * empty. It is abandoned when its pid is dead, the pid was reused (another
 * start time) or the owner stopped refreshing its mtime; the owner refreshes
 * it every 5 s. `assertHeld` catches the leftover race of two processes
 * removing the same abandoned lock: call it right before writing anything.
 */
export const withLock = async <T>(
  path: string,
  opts: { waitMs: number | null; onWait?: (pid: number) => void; label?: string },
  fn: (held: { assertHeld: () => void }) => Promise<T>,
  deps: Deps,
): Promise<T> => {
  const token = randomUUID();
  const own: LockInfo = { pid: process.pid, started: await deps.processStart(process.pid), token };
  const tmp = `${path}.${process.pid}.${token}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const startedWaiting = deps.now();
  let nextNotify = startedWaiting;

  for (;;) {
    await writeFile(tmp, JSON.stringify(own), { mode: 0o600 });
    let published = false;
    try {
      await link(tmp, path);
      published = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    } finally {
      await ignoreMissing(unlink(tmp));
    }
    if (published) break;

    const seen = await readLock(path);
    if (!seen) continue;
    const holder = seen.info;
    let abandoned = !holder;
    if (holder) {
      abandoned =
        !deps.isAlive(holder.pid) ||
        (await deps.processStart(holder.pid)) !== holder.started ||
        deps.now() - seen.mtimeMs > STALE_MS;
    }
    if (abandoned) {
      // Remove only the lock we judged: another process may have replaced it meanwhile.
      const again = await readLock(path);
      if (again && again.info?.token === holder?.token) await ignoreMissing(unlink(path));
      continue;
    }
    const waited = deps.now() - startedWaiting;
    if (opts.waitMs !== null && waited >= opts.waitMs) {
      throw new CliError(`held by ${holder!.pid} (${path})`);
    }
    if (opts.onWait && deps.now() >= nextNotify) {
      opts.onWait(holder!.pid);
      nextNotify += NOTIFY_MS;
    }
    await deps.sleep(POLL_MS);
  }

  await removeOrphans(path, deps);
  const assertHeld = () => {
    let current: LockInfo | null = null;
    try {
      current = parseLock(readFileSync(path, 'utf8'));
    } catch {
      current = null;
    }
    if (current?.token !== token) throw new CliError(`lock lost: ${path}`);
  };

  let stopped = false;
  const heartbeat = (async () => {
    while (!stopped) {
      await deps.sleep(HEARTBEAT_MS);
      if (stopped) break;
      const t = deps.now() / 1000;
      try {
        const cur = await readLock(path);
        if (cur?.info?.token === token) await utimes(path, t, t);
      } catch {
        // A failed touch only risks the lock being judged abandoned later.
      }
    }
  })();

  let result: T;
  try {
    result = await fn({ assertHeld });
  } catch (e) {
    stopped = true;
    try {
      assertHeld();
      await ignoreMissing(unlink(path));
    } catch {
      // the operation's own error is the one to report
    }
    throw e;
  }
  stopped = true;
  void heartbeat;
  try {
    assertHeld();
  } catch {
    // The work is done: report it, and leave the new owner's lock alone.
    deps.stderr(`warning: ${opts.label ?? 'lock'} was taken over by another process (${path})\n`);
    return result;
  }
  await ignoreMissing(unlink(path));
  return result;
};

/** Temp files of processes that died between writeFile and link. */
const removeOrphans = async (path: string, deps: Deps) => {
  const prefix = `${basename(path)}.`;
  const dir = dirname(path);
  for (const name of await readdir(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith('.tmp')) continue;
    const pid = Number(name.slice(prefix.length).split('.')[0]);
    if (!Number.isInteger(pid) || !deps.isAlive(pid)) await ignoreMissing(unlink(join(dir, name)));
  }
};
