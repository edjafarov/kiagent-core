import fs from 'node:fs';
import path from 'node:path';

import type {
  Account,
  AuthChannel,
  Batch,
  Document,
  ExternalRef,
  FolderScopeUpdate,
  FolderSelectionChannel,
  Session,
  Source,
  SourceDescriptor,
} from '@shared/contracts';
import { isUnder } from '@shared/folder-paths';

import { FILE_POLICY_VERSION, newlyAdmitted } from '@shared/file-indexability';

import {
  createInlineConverter,
  type Converter,
} from '../../core/converter/converter';
import {
  advanceCursor,
  type Expansion,
  type LocalFolderCursor,
  type PendingExpansion,
} from './cursor';
import {
  expansionStep,
  nextDue,
  nextPending,
  noteContainer,
} from './expansion';
import {
  folderScopedConfig,
  readFolderRoots,
  partitionRemovedRoots,
  validateFolderRoots,
} from './folder-roots';
import { folderPickerSpec, selectionNodes } from './picker';
import { decideLocalFile, localCandidate } from './ingestible';
import {
  BATCH_SIZE,
  MAX_BATCH_READ_BYTES,
  buildItem,
  chunkBySize,
  containerOf,
  entryReadCost,
  toAbsPosix,
  walkPaths,
  walkRoot,
  type ScannedEntry,
  type WalkTrouble,
} from './scanner';
import { toDocument, type LocalFolderItem } from './to-document';
import { startWatcher, type FsEvent } from './watch';

export const descriptor: SourceDescriptor = {
  id: 'local-folder',
  // kiagent-ref's actual display name (Connector.displayName) is 'Local
  // files' (kiagent-ref index.ts:106) — kept verbatim per the porting brief's
  // "adjust name to match legacy naming if different".
  name: 'Local files',
  // Container children (spec B): mbox messages, vCards, Evernote notes;
  // ZIP members are `file`.
  documentTypes: ['file', 'email.message', 'contact.card', 'note'],
  auth: 'none',
  multiAccount: true,
  cadence: { every: '30m' },
  /** Tracked folders card + `accounts:start-manage-folders`. There is
   *  deliberately NO `reauthenticate`: `auth: 'none'` means this source can
   *  never reach `needsReauth`, so the reconnect flow (and its identity
   *  check) never applies to it — which is also why the fixed
   *  MACHINE_IDENTIFIER upsert on connect stays untouched. */
  folderScope: true,
};

/** One local-folder account = this machine. All roots this machine tracks
 *  live in `config.paths`, not in the identifier — see `connect()`. */
export const MACHINE_IDENTIFIER = 'this-machine';

/** The account's tracked roots, as absolute paths. Canonical
 *  `config.folderRoots` with the one-train legacy `config.paths` fallback —
 *  see folder-roots.ts, which also owns the permanent-error rule. */
function getRootPaths(account: Account): string[] {
  return readFolderRoots(account).map((r) => r.id);
}

/** `config.watch === false` stops `pull()` right after backfill/rescan
 *  instead of starting the chokidar watcher — used by tests to keep pull()
 *  finite; every real account defaults to `true` ("live sources keep
 *  yielding", per contracts.ts's Source.pull doc comment). */
function isWatchEnabled(account: Account): boolean {
  return account.config?.watch !== false;
}

/**
 * First-ever local-folder connection for this machine.
 *
 * DECISIONS A-4: this runs ONLY when no `local-folder` account exists.
 * `MACHINE_IDENTIFIER` is fixed, and `createAccount` upserts on
 * `(source, identifier)` with `config = excluded.config`
 * (`store.ts:1059-1064`), so a second `connect()` would REPLACE the whole
 * scope with just the newly picked roots and the following reconcile pass
 * would mass-archive every previously tracked root. Task 9 (core) and Task 13
 * (the alpha-cent shadow) route the Add tile to
 * `accounts:start-manage-folders` whenever a local-folder account is already
 * present; `manageFolders` below is that path, and it merges instead of
 * replacing because the picker opens preselected with the current roots.
 */
export async function connect(
  auth: AuthChannel,
): Promise<{ identifier: string; config: Record<string, unknown> }> {
  const picked = await auth.pickFolders(
    folderPickerSpec({ selected: [], purpose: 'connect' }),
  );
  const roots = await validateFolderRoots(picked.map((n) => n.id));
  return {
    identifier: MACHINE_IDENTIFIER,
    // Canonical only (A-2) — core derives `config.paths` for the legacy train.
    config: folderScopedConfig({}, roots),
  };
}

/**
 * Stat every configured root up FRONT, before enumerating any of them, and
 * THROW if one is missing/unreadable rather than letting it silently
 * enumerate as empty. This matters because `walkPaths` skips what it cannot
 * read — an unmounted volume or a deleted folder yields ZERO entries with no
 * error, which looks identical to "this root is now genuinely empty." That
 * sameness is dangerous on BOTH sync paths:
 *  - pull/backfill: an unavailable root would stamp a bogus `{ completedAt }`
 *    watermark off the empty listing and take the incremental path forever
 *    after — its pre-existing files (mtime older than the bogus watermark)
 *    would never be indexed, with no recovery short of remove+re-add.
 *  - reconcile: the engine's reconcile pass (engine.ts) treats a
 *    complete-but-empty listing as authoritative and archives everything the
 *    account has live — a silently-empty root would mass-archive a perfectly
 *    healthy account the moment a drive is unmounted.
 * Throwing here instead surfaces as an ordinary sync/reconcile failure —
 * logged, recorded on the account row — and, critically, no watermark is
 * stamped and no diff/archive runs, so nothing is lost. A genuinely empty
 * but PRESENT directory stats fine and proceeds normally (zero entries is
 * legitimate then).
 */
async function assertRootsAvailable(rootPaths: string[]): Promise<void> {
  await Promise.all(
    rootPaths.map(async (root) => {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(root);
      } catch {
        throw new Error(
          `Local Folder: root is missing or unreadable: "${root}"`,
        );
      }
      if (!stat.isDirectory()) {
        throw new Error(`Local Folder: root is not a directory: "${root}"`);
      }
    }),
  );
}

/** Cursor entries for roots no longer present in `config.paths` are dropped
 *  as soon as the next batch commits — carrying forward a removed root's
 *  watermark forever would just be dead weight (that root is never read back
 *  since every per-root loop below iterates `rootPaths`, not the cursor), but
 *  the brief's contract is that they're actively shed, not merely ignored.
 *
 *  `pull()` must not rely on some OTHER batch happening to commit this
 *  cycle to make the prune stick — see `pull()`'s own comment for why. */
function pruneToConfiguredRoots(
  cursor: LocalFolderCursor,
  rootPaths: string[],
): LocalFolderCursor {
  if (cursor === null) return null;
  const configured = new Set(rootPaths);
  const roots: Record<string, { completedAt: string }> = {};
  for (const [root, entry] of Object.entries(cursor.roots)) {
    if (configured.has(root)) roots[root] = entry;
  }
  if (!cursor.expansions) return { ...cursor, roots };
  // A container under no configured root is out of scope: its documents are
  // archived through `scopeRootId`; re-adding the folder re-expands it.
  const expansions: Record<string, Expansion> = {};
  for (const [id, rec] of Object.entries(cursor.expansions))
    if (rootPaths.some((root) => isUnder(id, root))) expansions[id] = rec;
  return withExpansions({ ...cursor, roots }, expansions);
}

/** Whether `pruneToConfiguredRoots` actually dropped one or more entries
 *  (as opposed to every entry already matching a configured root). Prune
 *  only ever REMOVES keys, never adds any, so a plain count comparison is
 *  sufficient — no need to diff the actual key sets. */
function prunedSomething(
  before: LocalFolderCursor,
  after: LocalFolderCursor,
): boolean {
  if (before === null || after === null) return false;
  const count = (c: NonNullable<LocalFolderCursor>) =>
    Object.keys(c.roots).length + Object.keys(c.expansions ?? {}).length;
  return count(after) < count(before);
}

/**
 * Build one batch's items, splitting out a deletion ref for every entry
 * `buildItem` decided produces no document (policy `ignore`, unreadable
 * between listing and read, or NUL-sniffed "text"). Shared by both
 * `backfillRoot` and `incrementalRescanRoot`: a file that passed the cheap
 * enumeration-time gate but failed this final read/sniff must archive any
 * OLDER row at that path rather than leave a stale searchable document
 * behind.
 */
async function buildBatch(
  entries: readonly ScannedEntry[],
  scopeRootId: string,
  exps: Record<string, Expansion>,
): Promise<{ items: LocalFolderItem[]; deletions: ExternalRef[] }> {
  const built = await Promise.all(
    entries.map((e) => buildItem(e.absPath, e.stats)),
  );
  const items: LocalFolderItem[] = [];
  const deletions: ExternalRef[] = [];
  built.forEach((item, index) => {
    const { absPath, stats } = entries[index];
    const externalId = toAbsPosix(absPath);
    // A container is never an item here: the expander writes its row.
    if (item && 'container' in item)
      exps[externalId] = noteContainer(exps[externalId], item.container, {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    else if (item) items.push({ ...item, scopeRootId });
    else deletions.push({ externalId, type: 'file' });
  });
  return { items, deletions };
}

/** Every batch's cursor carries the expansion records as they stand when
 *  it is yielded (the Source contract: each cursor is a full snapshot). */
function withExpansions(
  cursor: LocalFolderCursor,
  exps: Record<string, Expansion>,
): LocalFolderCursor {
  if (Object.keys(exps).length > 0)
    return { roots: {}, ...cursor, expansions: { ...exps } };
  // No containers: the cursor keeps its pre-container shape.
  if (cursor === null || !('expansions' in cursor)) return cursor;
  const { expansions: _none, ...rest } = cursor;
  return rest;
}

/** Records under `root` the walk that just finished did not visit: the
 *  container left (deleted, renamed, or no longer admitted). Dropped, and
 *  its row deleted — which archives its children too. */
function dropUnvisited(
  root: string,
  visited: ReadonlySet<string>,
  exps: Record<string, Expansion>,
  trouble: WalkTrouble,
): ExternalRef[] {
  // A directory the walk could not read (a NAS hiccup, a privacy prompt)
  // hides its containers; dropping them would archive every child. The
  // guarded reconcile, or the next complete walk, decides instead.
  if (trouble.incomplete) return [];
  const gone: ExternalRef[] = [];
  for (const id of Object.keys(exps))
    if (!visited.has(id) && isUnder(id, root)) {
      delete exps[id];
      gone.push({ externalId: id, type: 'file' });
    }
  return gone;
}

/** Each item paired with whether it is the last one, pulling ONE item
 *  ahead — a root's final batch must carry its completion stamp, and a
 *  streamed walk only knows which batch was final once the walk has ended. */
async function* withLast<T>(
  items: AsyncIterable<T>,
): AsyncGenerator<{ value: T; last: boolean }> {
  let pending: { value: T } | null = null;
  for await (const value of items) {
    if (pending) yield { value: pending.value, last: false };
    pending = { value };
  }
  if (pending) yield { value: pending.value, last: true };
}

/** `entries` in ~50-file, byte-budgeted batches, each flagged final or not. */
function batchesOf(entries: AsyncIterable<ScannedEntry>) {
  return withLast(
    chunkBySize(entries, BATCH_SIZE, MAX_BATCH_READ_BYTES, entryReadCost),
  );
}

/**
 * `cursor` has no entry for `root` → full backfill, walking the tree as it
 * yields ~50-file batches (the walk holds one batch of entries, plus the one
 * `withLast` reads ahead; bytes are read only for the batch being yielded).
 * Every INTERMEDIATE batch leaves `root`'s cursor entry absent (still
 * catching up — see cursor.ts); only the FINAL batch stamps `{ completedAt }`
 * with `scanStartIso`, taken before the walk so nothing that changed during
 * it is missed once incremental mode takes over. `estimateTotal` is the
 * WHOLE-ACCOUNT file count, not this root's — the engine accumulates `done`
 * across every root, so a per-root estimate reads "242 / ~107" the moment a
 * second root is involved. Returns the cursor snapshot as of this root's
 * completion so the next root in `pull()`'s loop starts from an up-to-date
 * base; an empty root still yields one (empty) batch to carry the stamp.
 */
async function* backfillRoot(
  root: string,
  scanStartIso: string,
  estimateTotal: number,
  working: LocalFolderCursor,
  exps: Record<string, Expansion>,
): AsyncGenerator<
  Batch<LocalFolderCursor, LocalFolderItem>,
  LocalFolderCursor
> {
  let cursor = working;
  let yielded = false;
  const visited = new Set<string>();
  const trouble: WalkTrouble = { incomplete: false };
  async function* seen(): AsyncGenerator<ScannedEntry> {
    for await (const e of walkRoot(root, trouble)) {
      // Containers only: the walk must not hold one string per file.
      if (containerOf(e.absPath)) visited.add(toAbsPosix(e.absPath));
      yield e;
    }
  }
  for await (const { value: entries, last } of batchesOf(seen())) {
    const built = await buildBatch(entries, root, exps);
    const deletions = last
      ? [...built.deletions, ...dropUnvisited(root, visited, exps, trouble)]
      : built.deletions;
    if (last) cursor = advanceCursor(cursor, root, scanStartIso);
    yield {
      phase: 'backfill',
      items: built.items,
      deletions,
      cursor: withExpansions(cursor, exps),
      estimateTotal,
    };
    yielded = true;
  }
  if (!yielded) {
    const deletions = dropUnvisited(root, visited, exps, trouble);
    cursor = advanceCursor(cursor, root, scanStartIso);
    yield {
      phase: 'backfill',
      items: [],
      ...(deletions.length > 0 ? { deletions } : {}),
      cursor: withExpansions(cursor, exps),
      estimateTotal,
    };
  }
  return cursor;
}

/**
 * `cursor` has an entry for `root` → catch-up rescan of an already-live root:
 * kiagent-ref's `reconcileRoot()` runs `scanRoot()` again for the exact same
 * reason (its chokidar watcher starts with `ignoreInitial` and only observes
 * events going forward — kiagent-ref instance.ts:68-73). Only files whose
 * mtime OR ctime is newer than the cursor's watermark are yielded: a
 * rename/move keeps mtime but bumps ctime, so files reorganised while the app
 * was closed must be re-emitted at their new path because `reconcile()` has
 * already archived the old one. A ctime-only bump (chmod, xattr/Finder tag)
 * re-reads the file once, but the store's same-content-hash short-circuit
 * (`store/write-tx.ts` `upsertDocument`: existing row, same `content_hash`,
 * not archived → returns null, no feed churn) makes that a no-op write.
 * Offline DELETIONS are deliberately NOT handled here — that is `reconcile()`'s
 * job (below), matching the Source contract's two separate deletion channels.
 *
 * Like backfill, only the FINAL batch advances the watermark: an earlier one
 * committed with it would, after a crash, leave the rest of this rescan's
 * files older than the new watermark and never re-emitted. Nothing changed →
 * no batch yielded and `working` returned unchanged (this root's watermark
 * simply isn't advanced this cycle; the next cycle rescans from the same
 * point, which is safe/idempotent, just not maximally fresh).
 */
async function* incrementalRescanRoot(
  root: string,
  since: { completedAt: string },
  rescanStartIso: string,
  working: LocalFolderCursor,
  fromVersion: number,
  exps: Record<string, Expansion>,
): AsyncGenerator<
  Batch<LocalFolderCursor, LocalFolderItem>,
  LocalFolderCursor
> {
  const sinceMs = Date.parse(since.completedAt);
  const visited = new Set<string>();
  const trouble: WalkTrouble = { incomplete: false };
  async function* changed(): AsyncGenerator<ScannedEntry> {
    for await (const e of walkRoot(root, trouble)) {
      // Containers are inspected on every rescan, watermark or not: the
      // record decides (an mbox's mtime moves on every flag change, and an
      // outdated expander version re-expands). Unchanged → not yielded.
      const kind = containerOf(e.absPath);
      if (kind) {
        const id = toAbsPosix(e.absPath);
        visited.add(id);
        const at = { size: e.stats.size, mtimeMs: e.stats.mtimeMs };
        if (noteContainer(exps[id], kind, at) !== exps[id]) yield e;
        continue;
      }
      const touched =
        Math.max(e.stats.mtime.getTime(), e.stats.ctime.getTime()) > sinceMs;
      // After a FILE_POLICY_VERSION bump, also files the previous policy
      // ignored (deferred/none PDFs, newly admitted types). Never eager files
      // that were already indexed: re-emitting those would re-read and
      // re-parse them in main.
      if (
        touched ||
        newlyAdmitted(localCandidate(e.absPath, e.stats.size), fromVersion)
      )
        yield e;
    }
  }
  let cursor = working;
  let yielded = false;
  for await (const { value: entries, last } of batchesOf(changed())) {
    const built = await buildBatch(entries, root, exps);
    const deletions = last
      ? [...built.deletions, ...dropUnvisited(root, visited, exps, trouble)]
      : built.deletions;
    if (last) cursor = advanceCursor(working, root, rescanStartIso);
    yield {
      phase: 'live',
      items: built.items,
      deletions,
      cursor: withExpansions(cursor, exps),
    };
    yielded = true;
  }
  if (!yielded) {
    const deletions = dropUnvisited(root, visited, exps, trouble);
    if (deletions.length > 0)
      yield {
        phase: 'live',
        items: [],
        deletions,
        cursor: withExpansions(cursor, exps),
      };
  }
  return cursor;
}

export interface LocalFolderDeps {
  /** The platform converter; containers are expanded through its paged
   *  `expandPage` op (in the crash-isolated child in the app). */
  converter: Pick<Converter, 'expandPage'>;
}

let inlineDeps: LocalFolderDeps | null = null;
/** For `localFolderSource` (tests, tools): the in-process converter. */
function defaultDeps(): LocalFolderDeps {
  inlineDeps ??= { converter: createInlineConverter() };
  return inlineDeps;
}

export async function* pull(
  session: Session,
  cursor: LocalFolderCursor | null,
  deps: LocalFolderDeps = defaultDeps(),
): AsyncIterable<Batch<LocalFolderCursor, LocalFolderItem>> {
  const rootPaths = getRootPaths(session.account);
  // Both branches of the per-root loop need this guard, not just backfill:
  // an incremental rescan of a vanished root must surface the error too,
  // not silently no-op (see assertRootsAvailable).
  await assertRootsAvailable(rootPaths);
  let working = pruneToConfiguredRoots(cursor, rootPaths);
  /** Container expansion records — mutated by the scan, the events and the
   *  expansion steps, stamped onto every yielded cursor. */
  const exps: Record<string, Expansion> = { ...(working?.expansions ?? {}) };
  // Started BEFORE any scan or expansion work (see startWatcher).
  const watcher =
    isWatchEnabled(session.account) && !session.signal.aborted
      ? startWatcher(rootPaths, session.signal)
      : null;
  try {
    yield* scanThenDrive();
  } finally {
    await watcher?.close();
  }

  async function* scanThenDrive(): AsyncGenerator<
    Batch<LocalFolderCursor, LocalFolderItem>
  > {
    // If a root was just dropped from config, the prune above only lives in
    // this in-memory `working` cursor until SOME batch commits it. The
    // per-root loop below yields nothing at all when every surviving root is
    // quiet (an incremental rescan with no changes returns without yielding) —
    // so without this, the prune would silently vanish for the whole cycle,
    // the on-disk cursor would keep the removed root's stale `{ completedAt }`
    // entry, and re-adding that root later would wrongly take the incremental
    // path against that stale watermark instead of backfilling (see the
    // engine's reconcilePass, which even re-persists that stale cursor
    // verbatim once it archives the removed root's now-unlisted documents).
    // Yielding an immediate cursor-only batch — same phase as an ordinary
    // steady-state rescan, no items, no estimateTotal — guarantees the prune
    // commits in THIS cycle regardless of what the per-root loop does.
    if (prunedSomething(cursor, working)) {
      yield { phase: 'live', items: [], cursor: working };
    }

    // Backfill batches report the whole-account file count as
    // `estimateTotal`: the engine accumulates `done` across every root (seeded
    // with the documents already indexed), so against a per-root estimate the
    // progress line read "242 / ~107 (100%)" as soon as a second root started.
    // A count-only walk of every root comes first — paths only, no stat and
    // nothing kept, so it costs one readdir pass and over-counts only files a
    // size cap will drop — and only when some root backfills; nothing else
    // reads the estimate. The timestamp is captured BEFORE any walk so a
    // root's eventual `{ completedAt }` stamp can never postdate its own scan.
    const scanStartIso = new Date().toISOString();
    let estimateTotal = 0;
    if (rootPaths.some((root) => !working?.roots?.[root])) {
      for (const root of rootPaths) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars, no-await-in-loop
        for await (const _path of walkPaths(root)) {
          if (session.signal.aborted) return;
          estimateTotal += 1;
        }
      }
    }

    // Policy recovery rides the per-root rescan below; the stamp is applied
    // only after EVERY root finished, so no intermediate batch persists it.
    const fromVersion = working?.policyVersion ?? 1;
    let didBackfill = false;
    for (const root of rootPaths) {
      const since = working?.roots?.[root];
      if (!since) {
        didBackfill = true;
        working = yield* backfillRoot(
          root,
          scanStartIso,
          estimateTotal,
          working,
          exps,
        );
      } else {
        working = yield* incrementalRescanRoot(
          root,
          since,
          scanStartIso,
          working,
          fromVersion,
          exps,
        );
      }
    }

    // A backfill's final batch is phase 'backfill' (→ status 'backfilling'),
    // and the watch loop below commits nothing until a file actually changes —
    // without this cursor-only live batch the account would sit on
    // "Backfilling … (100%)" indefinitely after the walk finished. Gated on
    // didBackfill so quiet steady-state cycles stay zero-commit. The same
    // batch commits the FILE_POLICY_VERSION stamp after a policy recovery; a
    // crash before it just repeats the cheap newly-admitted emission.
    const stamp = didBackfill || fromVersion < FILE_POLICY_VERSION;
    if (stamp) {
      working = {
        ...(working ?? { roots: {} }),
        policyVersion: FILE_POLICY_VERSION,
      };
      yield { phase: 'live', items: [], cursor: withExpansions(working, exps) };
    }

    // The drive loop, steady state and initial drain alike: at most one
    // watcher event, then at most one due expansion step; it waits only when
    // neither can run. Ordinary indexing never queues behind a big container
    // for more than one page.
    const rootOf = (absPath: string): string | undefined =>
      rootPaths.find((root) => isUnder(absPath, root));
    for (;;) {
      if (session.signal.aborted) return;
      let progressed = false;
      const ev = watcher?.take();
      if (ev) {
        progressed = true;
        // eslint-disable-next-line no-await-in-loop
        const batch = await eventBatch(ev, rootOf, working, exps);
        if (batch) {
          working = batch.cursor;
          yield { ...batch, cursor: withExpansions(working, exps) };
        }
      }
      const id = nextPending(exps, Date.now());
      if (id) {
        progressed = true;
        // eslint-disable-next-line no-await-in-loop
        const out = await expansionStep({
          absPath: id,
          rec: exps[id] as PendingExpansion,
          scopeRootId: rootOf(id),
          converter: deps.converter,
          signal: session.signal,
          now: Date.now(),
        });
        if (session.signal.aborted) return;
        if (out.rec) exps[id] = out.rec;
        else delete exps[id];
        yield {
          phase: 'live',
          items: out.items,
          ...(out.deletions.length > 0 ? { deletions: out.deletions } : {}),
          cursor: withExpansions(working, exps),
        };
      }
      if (progressed) continue;
      // Nothing runnable. Without a watcher (tests, `watch: false`) the pull
      // ends; deferred expansions resume next cycle.
      if (!watcher) return;
      const due = nextDue(exps);
      // eslint-disable-next-line no-await-in-loop
      await watcher.wait(due === null ? undefined : due - Date.now());
    }
  }
}

/**
 * One watcher event as a batch, or null when it commits nothing. Each live
 * event advances ONLY the entry for the root the changed path falls under
 * — every other root's watermark is carried over untouched, so a restart
 * mid-watch resumes each root from its own last-known-good point.
 *
 * A container event updates its expansion record instead of building an
 * item (the drive loop's next step writes it); a container unlink drops the
 * record and deletes the row, which archives the children.
 */
async function eventBatch(
  ev: FsEvent,
  rootOf: (absPath: string) => string | undefined,
  cursor: LocalFolderCursor,
  exps: Record<string, Expansion>,
): Promise<
  | (Batch<LocalFolderCursor, LocalFolderItem> & { cursor: LocalFolderCursor })
  | null
> {
  const externalId = toAbsPosix(ev.absPath);
  const root = rootOf(ev.absPath);
  const advanced = root
    ? advanceCursor(cursor, root, new Date().toISOString())
    : cursor;
  if (ev.kind === 'unlink') {
    delete exps[externalId];
    return {
      phase: 'live',
      items: [],
      deletions: [{ externalId, type: 'file' }],
      cursor: advanced,
    };
  }
  let item: Awaited<ReturnType<typeof buildItem>>;
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(ev.absPath);
    item = await buildItem(ev.absPath, stats);
  } catch {
    // File vanished between the fs event and the stat — a matching unlink
    // event will follow if it was really removed; skip for now.
    return null;
  }
  if (item && 'container' in item) {
    // Outside every root (R5's stray event): nothing to expand into.
    if (!root) return null;
    exps[externalId] = noteContainer(exps[externalId], item.container, {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
    });
    return null;
  }
  // `buildItem` is null when the policy check it recomputes from the fresh
  // stat — including size, which the watcher's path-only pre-filter could
  // not see — now says `ignore` (or the read/sniff failed). A file that
  // passed the coarse pre-filter but fails here must archive any older row
  // at this path rather than leave it stale.
  //
  // `root` is `undefined` when the path falls under no configured root (an
  // event arriving after a root left the config, a resolution landing
  // outside every root). That item is STILL yielded — now simply without
  // `scopeRootId`, which the store records as `scope_root_id = NULL`
  // (DECISIONS R5). Never a throw, and no warn here: the engine emits the
  // single warn at store time.
  if (!item) {
    delete exps[externalId];
    return {
      phase: 'live',
      items: [],
      deletions: [{ externalId, type: 'file' }],
      cursor: advanced,
    };
  }
  return {
    phase: 'live',
    items: [root ? { ...item, scopeRootId: root } : item],
    cursor: advanced,
  };
}

/** Guard: only ever read bytes for a path resolving inside ONE of the
 *  account's own configured roots — a doc whose stored `metadata.absPath`
 *  has been tampered with (or points at a since-removed/relocated root) must
 *  never leak bytes from elsewhere on disk. Throws the no-roots permanent
 *  error (via `getRootPaths`) for a malformed config, like pull()/reconcile().
 *
 *  Rechecks `decideLocalFile` against the file's CURRENT on-disk size before
 *  reading — the doc's stored metadata can be stale (grown since it was
 *  indexed), and this is the first bound this function has ever had. The
 *  check applies the decision's own bound, not one flat ceiling: this is
 *  deliberately how a 20-100 MiB local PDF (committed metadata-only,
 *  `bytes: 'deferred'`) still gets its bytes fetched here by the convert and
 *  vision workers, while a `bytes: 'none'` file (past MAX_FETCH_BYTES) or a
 *  300 MiB audio file (`audio` pipeline, 200 MiB cap) does not. Any stat/read
 *  race still returns `null`, as before. */
export async function fetchBytes(
  session: Session,
  doc: Document,
): Promise<Uint8Array | null> {
  const rootPaths = getRootPaths(session.account).map((p) => path.resolve(p));
  const absPathRaw = doc.metadata?.absPath;
  if (typeof absPathRaw !== 'string') return null;
  const absPath = path.resolve(absPathRaw);
  if (!rootPaths.some((root) => isUnder(absPath, root))) return null;
  try {
    const stat = await fs.promises.stat(absPath);
    const d = decideLocalFile(absPath, stat.size);
    if (d.kind === 'ignore' || d.bytes === 'none') return null;
    return new Uint8Array(await fs.promises.readFile(absPath));
  } catch {
    return null;
  }
}

/**
 * Full listing of what exists on disk right now, across EVERY configured
 * root, streamed in pages of 500 as the walk goes — the engine stages each
 * page, then diffs the whole listing against what it has stored and archives
 * anything missing (offline deletions kiagent-ref would have caught via
 * `reconcileRoot()`'s present-set diff, instance.ts:68-85). The up-front
 * `assertRootsAvailable` is the anti-mass-archival guard: a missing root must
 * throw here, never enumerate as empty (see that helper's doc for the full
 * rationale). An aborted pass stops mid-walk; the engine never diffs a
 * listing cut short by its signal.
 */
export async function* reconcile(
  session: Session,
): AsyncIterable<ExternalRef[]> {
  const rootPaths = getRootPaths(session.account);
  await assertRootsAvailable(rootPaths);

  for (const root of rootPaths) {
    // eslint-disable-next-line no-await-in-loop
    for await (const page of chunkBySize(
      walkRoot(root),
      500,
      Infinity,
      () => 0,
    )) {
      if (session.signal.aborted) return;
      yield page.map(
        (e): ExternalRef => ({
          externalId: toAbsPosix(e.absPath),
          type: 'file',
        }),
      );
    }
  }
}

/**
 * Edit this account's folder scope with its existing (nonexistent — `auth:
 * 'none'`) credentials. Persists NOTHING: core owns the one transaction
 * (`applyFolderScope`).
 *
 * The cursor transformation is exactly `pruneToConfiguredRoots`: retained
 * roots keep their `{completedAt}` watermark (spec invariant 10), removed
 * roots are dropped, and an added root is left ABSENT so the next `pull()`
 * takes the backfill path and walks its whole tree. That helper is
 * module-private in THIS file (`local-folder-source.ts:166-177`, alongside
 * `prunedSomething`) — it is NOT exported from `cursor.ts`, which only
 * declares `LocalFolderCursor` and `advanceCursor`. That is precisely why
 * `manageFolders` lives here and not in `folder-roots.ts`: moving it there
 * is `TS2304: Cannot find name 'pruneToConfiguredRoots'`.
 *
 * `archiveScopeRootIds` and `reattributeScopeRoots` are DECISIONS R8 and
 * C-46/D5, computed together by `partitionRemovedRoots` so they cannot
 * disagree: a removed root goes to `archive` only when NO retained root
 * satisfies `isUnder(removed, retained)`, and to `reattribute` (aimed at that
 * retained root) when one does. Core must never derive either by
 * set-difference.
 *
 * De-selecting a subfolder of a still-selected parent removes zero documents
 * from scope — but the right answer is NOT silence. Those rows stay stamped
 * with the subfolder id, which is no longer in the config, so no later save
 * can match them and they would outlive the selection (C-46/D3). This source
 * holds real absolute paths, so containment is decidable locally and it can
 * name the retained root they now belong to.
 *
 * The ids on both sides are the CONFIG spellings (B-7) — the same strings
 * `scope_root_id` was stamped with — never the re-resolved picked ones.
 *
 * This return deliberately OMITS `archiveNullScoped`. The field exists on
 * `FolderScopeUpdate` (optional, default false — DECISIONS C-1), and omitting
 * it IS how this source says `false`. (Under C-34 core declines to act on the
 * flag in this train at all: it is absent from `applyFolderScope`'s input type
 * and the engine does not forward it. That changes nothing here — this source
 * has always meant `false` — but do not "restore" a forwarding path on the
 * strength of this comment.) A-3
 * permits the flag only alongside a cursor that forces a FULL re-establish,
 * and this function deliberately preserves retained watermarks; and unlike
 * the cloud connectors this source never hashSkips, so an archived row is
 * always rewritten on re-emit and no repair path is needed. local-folder's
 * NULL-scoped rows come from `watch.ts`'s tolerated `rootOf() === undefined`
 * branch (R5) and are cleaned up by `reconcile()`, which never lists them.
 */
export async function manageFolders(
  session: Session,
  channel: FolderSelectionChannel,
): Promise<FolderScopeUpdate<LocalFolderCursor>> {
  const current = readFolderRoots(session.account);
  const picked = await channel.pickFolders(
    folderPickerSpec({
      selected: await selectionNodes(current),
      purpose: 'manage',
    }),
  );
  const roots = await validateFolderRoots(picked.map((n) => n.id));
  const cursor = pruneToConfiguredRoots(
    (session.account.cursor ?? null) as LocalFolderCursor,
    roots.map((r) => r.id),
  );
  const removed = partitionRemovedRoots(current, roots);
  return {
    config: folderScopedConfig(session.account.config ?? {}, roots),
    cursor,
    archiveScopeRootIds: removed.archive,
    reattributeScopeRoots: removed.reattribute,
  };
}

export function createLocalFolderSource(
  deps: LocalFolderDeps,
): Source<LocalFolderCursor, LocalFolderItem> {
  return {
    descriptor,
    connect,
    pull: (session, cursor) => pull(session, cursor, deps),
    toDocument,
    fetchBytes,
    reconcile,
    manageFolders,
  };
}

/** Built with the in-process converter (created on first pull) — tests and
 *  tools. The app registers `createLocalFolderSource({ converter })`
 *  (sources/index.ts). */
export const localFolderSource: Source<LocalFolderCursor, LocalFolderItem> =
  createLocalFolderSource({
    converter: {
      expandPage: (...args) => defaultDeps().converter.expandPage(...args),
    },
  });
