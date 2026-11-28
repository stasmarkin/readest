import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { hash7 } from '../../cli/lib/books.ts';
import { AuthRequiredError, CliError } from '../../cli/lib/errors.ts';
import { withLock } from '../../cli/lib/lock.ts';
import { classify, DAY_MS, massDeleteLimit } from './classify.ts';
import type { SyncDeps } from './deps.ts';
import { buildEpub, collectImageUrls, parseBody } from './epub.ts';
import type { BuiltEpub } from './epub.ts';
import { loadImageCache } from './images.ts';
import type { ImageCache } from './images.ts';
import { buildMeta } from './meta.ts';
import { readestBooks, readestDelete, readestUpload, readestWhoami, GROUP } from './readest.ts';
import type { CliOutcome } from './readest.ts';
import { scanVault } from './scan.ts';
import type { Scan } from './scan.ts';
import { BOOK_HASH, checkIdentity, loadState, saveState } from './state.ts';
import type { FileRecord, Held, Op } from './state.ts';
import { downloadImages, webSession } from './web.ts';
import type { WebSession } from './web.ts';

export type SyncOpts = {
  dryRun: boolean;
  allowMassDelete: boolean;
  notify: boolean;
  vault: string;
  stateDir: string;
};

export const LOGIN_TEXT = 'readest: нужен вход — выполни `readest login`';
export const USER_TEXT = 'readest: сменился пользователь readest';
const LEVI_TIMEOUT_MS = 30_000;

/** Auth failed: stop after the operation at hand, which stays in the journal if it was one. */
class AuthStop extends Error {
  text: string;
  constructor(text: string) {
    super(text);
    this.text = text;
  }
}

const authText = (e: AuthRequiredError) =>
  e.message === 'сменился пользователь readest' ? USER_TEXT : LOGIN_TEXT;

const isLockLost = (e: unknown) => e instanceof CliError && e.message.startsWith('lock lost');

const reasonOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Candidate = { relpath: string; kind: 'upload' | 'replace' | 'rebuild' };

export const runSync = async (opts: SyncOpts, deps: SyncDeps): Promise<number> => {
  for (const [cmd, args] of [
    ['pandoc', ['--version']],
    ['readest', ['--version']],
  ] as const) {
    const r = await deps.run(cmd, [...args], { timeoutMs: 30_000 });
    if (r.code !== 0) {
      deps.stderr(`clippings-sync: ${cmd} is not available (${r.code ?? 'timeout'})\n`);
      return 2;
    }
  }
  const stateDir = resolve(opts.stateDir);
  await deps.mkdir(stateDir);
  try {
    return await withLock(
      join(stateDir, 'sync.lock'),
      { waitMs: 0, label: 'sync lock' },
      (held) => syncLocked(opts, deps, stateDir, held),
      deps,
    );
  } catch (e) {
    if (e instanceof CliError && e.message.startsWith('held by')) {
      deps.stdout('уже идёт\n');
      return 0;
    }
    deps.stderr(`clippings-sync: ${reasonOf(e)}\n`);
    return e instanceof CliError ? e.exitCode : 1;
  }
};

const syncLocked = async (
  opts: SyncOpts,
  deps: SyncDeps,
  stateDir: string,
  held: Held,
): Promise<number> => {
  const vault = resolve(opts.vault);
  const dry = opts.dryRun;
  const counts = { added: 0, replaced: 0, deleted: 0, deferred: 0, errors: 0 };
  let incomplete = false;
  let massStop = false;
  const line = (action: string, relpath: string, detail: string) =>
    deps.stdout(`${action} ${relpath} — ${detail}\n`);
  const fail = (relpath: string, reason: string) => {
    counts.errors++;
    line('error', relpath, reason);
  };
  const summary = () =>
    deps.stdout(
      `итог${dry ? ' (dry-run)' : ''}: +${counts.added} ~${counts.replaced} -${counts.deleted}, ` +
        `отложено ${counts.deferred}, ошибок ${counts.errors}\n`,
    );
  const exitCode = () => (massStop ? 2 : counts.errors || incomplete ? 1 : 0);

  try {
    const st = await deps.stat(vault);
    if (!st.isDir) throw new Error('not a directory');
    await deps.readdir(vault);
  } catch (e) {
    deps.stderr(`clippings-sync: vault is not readable: ${vault} (${reasonOf(e)})\n`);
    return 2;
  }

  const state = await loadState(deps, stateDir);
  const save = () => (dry ? Promise.resolve() : saveState(deps, stateDir, state, held));
  const now = () => deps.now();

  const authStopped = async (text: string): Promise<number> => {
    deps.stderr(`${text}\n`);
    if (opts.notify && !dry && state.authAlertSentAt === undefined) {
      const r = await deps.run('levi', ['notify', text, '--from', 'clippings-sync'], {
        timeoutMs: LEVI_TIMEOUT_MS,
      });
      // Only an accepted alert counts: a refused one is sent again next hour.
      if (r.code === 0) {
        state.authAlertSentAt = now();
        await save();
      }
    }
    return 3;
  };

  let userId: string;
  try {
    const who = await readestWhoami(deps);
    userId = who.userId;
    const seen = { vault, server: who.server, userId };
    if (checkIdentity(state, seen) === 'first') {
      state.identity = seen;
      await save();
    }
  } catch (e) {
    if (e instanceof AuthRequiredError) return authStopped(authText(e));
    throw e;
  }

  /** readest under the lock check: a stolen lock must not reach the server. */
  const exec = async (op: Op, recovering: boolean, ownedBefore: boolean): Promise<CliOutcome> => {
    held.assertHeld();
    let out: CliOutcome;
    try {
      if (op.kind === 'delete') {
        out = await readestDelete(deps, op.oldHash, userId);
      } else {
        const mode =
          op.kind === 'upload' ? { group: GROUP } : { replace: op.oldHash, resume: recovering };
        out = await readestUpload(deps, join(stateDir, op.epub), mode, op.record.metaHash, userId);
      }
    } catch (e) {
      if (e instanceof AuthRequiredError) throw new AuthStop(LOGIN_TEXT);
      throw e;
    }
    if (out.kind !== 'done' || op.kind === 'delete') return out;
    const item = out.item;
    if (item.status === 'skipped' && item.reason === 'duplicate') {
      return {
        kind: 'fileError',
        reason: `duplicate of ${item.duplicateOf?.hash ?? '?'} (${item.duplicateOf?.title ?? ''})`,
      };
    }
    const step =
      op.kind === 'replace' ? item.step : item.status === 'skipped' ? 'already' : item.status;
    if (op.kind === 'replace' && item.status !== 'replaced') {
      return { kind: 'fileError', reason: `unexpected status ${item.status}` };
    }
    if (item.hash !== op.newHash)
      return { kind: 'fileError', reason: `hash mismatch: ${item.hash}` };
    // An existing book under this hash is ours if we made it, this is our own retry, or it carries our metaHash.
    if (
      step !== 'uploaded' &&
      !ownedBefore &&
      !recovering &&
      item.metaHash !== op.record.metaHash
    ) {
      return {
        kind: 'fileError',
        reason: `conflict: ${step} book ${hash7(op.newHash)} is not ours`,
      };
    }
    return out;
  };

  const outboxDir = (hash: string) => {
    if (!BOOK_HASH.test(hash)) throw new CliError(`refusing outbox path for hash "${hash}"`, 2);
    return join(stateDir, 'outbox', hash);
  };

  /** Journal step 4 and 5 (or the undo of a file error): the registry, then the outbox. */
  const settle = async (op: Op, out: CliOutcome, recovering: boolean, ownedBefore: boolean) => {
    if (out.kind === 'unknown') return;
    state.ops = state.ops.filter((o) => o !== op);
    if (out.kind === 'done') {
      if (op.kind === 'delete') {
        if (state.files[op.relpath]?.bookHash === op.oldHash) delete state.files[op.relpath];
      } else {
        state.files[op.relpath] = {
          ...op.record,
          metaHash: out.item.metaHash ?? op.record.metaHash,
          syncedAt: now(),
        };
        delete state.pending[op.relpath];
      }
    } else if (op.kind !== 'delete' && !ownedBefore && !recovering) {
      delete state.history[op.newHash];
    }
    await save();
    if (op.kind !== 'delete') {
      held.assertHeld();
      await deps.rm(outboxDir(op.newHash));
    }
  };

  const report = (op: Op, out: CliOutcome, action: string, detail: string) => {
    if (out.kind === 'done') line(action, op.relpath, detail);
    else if (out.kind === 'fileError') fail(op.relpath, out.reason);
    else fail(op.relpath, `исход неизвестен, повторю: ${out.reason}`);
  };

  /** Steps 1–5 of the journal for a fresh operation. */
  const publish = async (op: Op, epub?: BuiltEpub): Promise<CliOutcome> => {
    const ownedBefore = op.kind !== 'delete' && op.newHash in state.history;
    if (op.kind !== 'delete' && epub) {
      const abs = join(stateDir, op.epub);
      await deps.mkdir(outboxDir(op.newHash));
      await deps.writeFile(`${abs}.tmp`, epub.bytes);
      held.assertHeld();
      await deps.rename(`${abs}.tmp`, abs);
      state.history[op.newHash] = op.relpath;
    }
    state.ops.push(op);
    await save();
    const out = await exec(op, false, ownedBefore);
    await settle(op, out, false, ownedBefore);
    return out;
  };

  try {
    let cache: ImageCache | undefined;
    if (!dry) {
      // Outbox files with no operation are left by a crash before step 2.
      const referenced = new Set(
        state.ops.flatMap((o) => (o.kind === 'delete' ? [] : [o.newHash])),
      );
      const outbox = await deps.readdir(join(stateDir, 'outbox')).catch(() => []);
      for (const e of outbox) {
        if (referenced.has(e.name) || e.kind !== 'dir' || !/^[0-9a-f]{32}$/.test(e.name)) continue;
        held.assertHeld();
        await deps.rm(join(stateDir, 'outbox', e.name));
      }
    }

    // Recovery: each journalled operation again, with the same file; the mass-delete guard does not apply.
    let recoveryUnknown = false;
    for (const op of [...state.ops]) {
      if (dry) {
        deps.stdout(`незавершённая операция: ${op.kind} ${op.relpath}\n`);
        continue;
      }
      if (op.kind !== 'delete') {
        const bytes = await deps.readFile(join(stateDir, op.epub)).catch(() => null);
        if (!bytes || createHash('sha256').update(bytes).digest('hex') !== op.record.epubSha256) {
          throw new CliError(
            `outbox damaged for ${op.relpath}: ${op.epub} is missing or changed; journal kept`,
            2,
          );
        }
      }
      const out = await exec(op, true, true);
      await settle(op, out, true, true);
      report(op, out, 'recovered', op.kind);
      if (out.kind === 'unknown') recoveryUnknown = true;
    }
    if (recoveryUnknown) {
      summary();
      return 1;
    }

    const live = new Map(
      (await readestBooks(deps, userId)).map((b) => [b.hash, b.metaHash ?? null]),
    );
    const scan: Scan = await scanVault(deps, vault);
    const plan = classify(state, scan, new Set(live.keys()), now());

    // An empty or partial snapshot must not opt every book out for good.
    const registered = Object.keys(state.files).length;
    const optOutStop =
      plan.toOptOut.length > massDeleteLimit(registered) ||
      (plan.toOptOut.length > 0 && plan.toOptOut.length === registered);
    if (optOutStop && !opts.allowMassDelete) {
      massStop = true;
      deps.stderr(
        `стоп: в библиотеке нет ${plan.toOptOut.length} книг из реестра; optOut не записан (--allow-mass-delete)\n`,
      );
      plan.toOptOut = [];
    }
    for (const relpath of plan.toOptOut) {
      line('optout', relpath, `книга ${hash7(state.files[relpath]!.bookHash)} удалена в Readest`);
      if (dry) continue;
      state.optOut[relpath] = state.files[relpath]!.bookHash;
      delete state.files[relpath];
      delete state.pending[relpath];
    }
    for (const relpath of Object.keys(state.pending)) {
      if (!scan.files.has(relpath)) delete state.pending[relpath];
    }
    await save();

    const candidates: Candidate[] = [
      ...plan.upload.map((relpath) => ({ relpath, kind: 'upload' as const })),
      ...plan.replace.map((relpath) => ({ relpath, kind: 'replace' as const })),
      ...plan.rebuild.map((relpath) => ({ relpath, kind: 'rebuild' as const })),
    ].sort((a, b) => (a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0));

    cache = await loadImageCache(deps, join(stateDir, 'images'));
    const prepare = async (relpath: string) => {
      const f = scan.files.get(relpath)!;
      const built = buildMeta(relpath, new TextDecoder().decode(f.bytes), f.srcKey);
      const doc = await parseBody(deps, built.body);
      return { built, doc, urls: collectImageUrls(doc) };
    };
    const parsed = new Map<string, Awaited<ReturnType<typeof prepare>>>();
    const wanted: string[] = [];
    for (const c of candidates) {
      if (c.kind === 'rebuild') {
        wanted.push(...state.files[c.relpath]!.missingImages);
        continue;
      }
      try {
        const p = await prepare(c.relpath);
        parsed.set(c.relpath, p);
        wanted.push(...p.urls);
      } catch (e) {
        fail(c.relpath, reasonOf(e));
      }
    }
    const toFetch = [...new Set(wanted)].filter((u) => cache!.needsFetch(u));

    if (dry) {
      for (const u of toFetch) deps.stdout(`требуется скачивание ${u}\n`);
      for (const c of candidates) {
        if (c.kind !== 'rebuild' && !parsed.has(c.relpath)) continue;
        const pendingUrls =
          c.kind === 'rebuild'
            ? state.files[c.relpath]!.missingImages
            : parsed.get(c.relpath)!.urls.filter((u) => cache!.needsFetch(u));
        const verb = { upload: 'залить', replace: 'заменить', rebuild: 'дособрать' }[c.kind];
        const cond =
          c.kind !== 'rebuild' && pendingUrls.length
            ? ` (отсрочка, если не скачаются картинки: ${pendingUrls.length})`
            : c.kind === 'rebuild'
              ? ' (если появятся картинки)'
              : '';
        deps.stdout(`план: ${verb} ${c.relpath}${cond}\n`);
        if (c.kind === 'upload') counts.added++;
        else counts.replaced++;
      }
    } else {
      let session: WebSession | undefined;
      try {
        if (toFetch.length) {
          session = webSession(deps);
          await downloadImages(deps, cache, session, toFetch, now(), () => cache!.save(held));
          await cache.save(held);
        }
      } finally {
        await session?.close();
      }

      const tmpDir = join(stateDir, 'tmp', randomUUID());
      try {
        for (const c of candidates) {
          const rec = state.files[c.relpath];
          const f = scan.files.get(c.relpath)!;
          if (c.kind === 'rebuild') {
            const r = rec!;
            const improved = r.missingImages.some((u) => cache.get(u)?.status === 'ok');
            if (!improved) {
              r.imagesComplete = r.missingImages.every((u) => cache.get(u)?.status === 'gone');
              r.rebuildAttemptAt = now();
              await save();
              continue;
            }
            try {
              parsed.set(c.relpath, await prepare(c.relpath));
            } catch (e) {
              fail(c.relpath, reasonOf(e));
              continue;
            }
          }
          const p = parsed.get(c.relpath);
          if (!p) continue;
          let epub: BuiltEpub;
          try {
            epub = await buildEpub({
              relpath: c.relpath,
              scanned: f,
              built: p.built,
              doc: p.doc,
              cache,
              tmpDir,
              deps,
            });
          } catch (e) {
            fail(c.relpath, reasonOf(e));
            continue;
          }
          let late = false;
          if (c.kind !== 'rebuild' && epub.tempUrls.length) {
            let pend = state.pending[c.relpath];
            if (!pend || pend.srcKey !== f.srcKey) {
              pend = { srcKey: f.srcKey, firstDeferredAt: now() };
              state.pending[c.relpath] = pend;
            }
            if (now() - pend.firstDeferredAt < DAY_MS) {
              await save();
              counts.deferred++;
              line('deferred', c.relpath, `недоступно картинок: ${epub.tempUrls.length}`);
              continue;
            }
            late = true;
          }
          if (rec && epub.bookHash === rec.bookHash) {
            fail(c.relpath, 'hash collision: the new EPUB has the old book hash');
            continue;
          }
          // Same hash and same metaHash (identifier = this relpath) is this sync's own earlier build.
          if (
            live.has(epub.bookHash) &&
            !(epub.bookHash in state.history) &&
            live.get(epub.bookHash) !== epub.metaHash
          ) {
            fail(
              c.relpath,
              `conflict: book ${hash7(epub.bookHash)} is in the library but not ours`,
            );
            continue;
          }
          const record: FileRecord = {
            srcKey: f.srcKey,
            epubSha256: epub.epubSha256,
            bookHash: epub.bookHash,
            metaHash: epub.metaHash,
            title: epub.title,
            syncedAt: now(),
            imagesComplete: epub.imagesComplete,
            missingImages: epub.missingImages,
          };
          const epubRel = join('outbox', epub.bookHash, epub.fileName);
          const op: Op = rec
            ? {
                kind: 'replace',
                relpath: c.relpath,
                epub: epubRel,
                oldHash: rec.bookHash,
                newHash: epub.bookHash,
                record,
              }
            : { kind: 'upload', relpath: c.relpath, epub: epubRel, newHash: epub.bookHash, record };
          const out = await publish(op, epub);
          const lacking = epub.tempUrls.length ? `, без картинок: ${epub.tempUrls.length}` : '';
          report(op, out, rec ? 'replaced' : 'uploaded', `${hash7(epub.bookHash)}${lacking}`);
          if (out.kind === 'done') {
            if (rec) counts.replaced++;
            else counts.added++;
            // The first upload without its images after the day of waiting needs a look.
            if (late) incomplete = true;
          }
        }
      } finally {
        await deps.rm(tmpDir);
      }
    }

    if (plan.delete.length && plan.massDeleteStop && !opts.allowMassDelete) {
      massStop = true;
      deps.stderr(
        plan.massDeleteStop === 'empty'
          ? `стоп: vault пуст, а в реестре ${Object.keys(state.files).length} книг; удаления не выполнены (--allow-mass-delete)\n`
          : `стоп: исчезло ${plan.delete.length} файлов — больше порога; удаления не выполнены (--allow-mass-delete)\n`,
      );
    } else {
      for (const relpath of plan.delete) {
        const hash = state.files[relpath]!.bookHash;
        if (dry) {
          deps.stdout(`план: удалить ${relpath}\n`);
          counts.deleted++;
          continue;
        }
        const op: Op = { kind: 'delete', relpath, oldHash: hash };
        const out = await publish(op);
        report(op, out, 'deleted', hash7(hash));
        if (out.kind === 'done') counts.deleted++;
      }
    }

    // Every call that needed the login went through: the next refusal is news again.
    if (state.authAlertSentAt !== undefined && !dry) {
      delete state.authAlertSentAt;
      await save();
    }
  } catch (e) {
    if (e instanceof AuthStop) {
      summary();
      return authStopped(e.text);
    }
    if (e instanceof AuthRequiredError) {
      summary();
      return authStopped(authText(e));
    }
    if (isLockLost(e)) {
      summary();
      deps.stderr(`clippings-sync: ${reasonOf(e)}\n`);
      return 1;
    }
    throw e;
  }
  summary();
  return exitCode();
};
