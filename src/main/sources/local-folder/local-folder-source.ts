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

import { advanceCursor, type LocalFolderCursor } from './cursor';
import {
  folderScopedConfig,
  readFolderRoots,
  partitionRemovedRoots,
  validateFolderRoots,
} from './folder-roots';
import { folderPickerSpec, selectionNodes } from './picker';
import { decideLocalFile } from './ingestible';
import {
  BATCH_SIZE,
  MAX_BATCH_READ_BYTES,
  buildItem,
  chunk,
  chunkBySize,
  entryReadCost,
  listEntries,
  toAbsPosix,
  type ScannedEntry,
} from './scanner';
import { toDocument, type LocalFolderItem } from './to-document';
import { watchLoop } from './watch';

export const descriptor: SourceDescriptor = {
  id: 'local-folder',
  // kiagent-ref's actual display name (Connector.displayName) is 'Local
  // files' (kiagent-ref index.ts:106) — kept verbatim per the porting brief's
  // "adjust name to match legacy naming if different".
  name: 'Local files',
  documentTypes: ['file'],
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
const MACHINE_IDENTIFIER = 'this-machine';

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
 * enumerate as empty. This matters because `listEntries` uses fast-glob's
 * `suppressErrors: true` — an unmounted volume or a deleted folder yields
 * ZERO entries with no error, which looks identical to "this root is now
 * genuinely empty." That sameness is dangerous on BOTH sync paths:
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
  return { roots };
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
  return Object.keys(after.roots).length < Object.keys(before.roots).length;
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
): Promise<{ items: LocalFolderItem[]; deletions: ExternalRef[] }> {
  const built = await Promise.all(
    entries.map((e) => buildItem(e.absPath, e.stats)),
  );
  const items: LocalFolderItem[] = [];
  const deletions: ExternalRef[] = [];
  built.forEach((item, index) => {
    if (item) items.push({ ...item, scopeRootId });
    else
      deletions.push({
        externalId: toAbsPosix(entries[index].absPath),
        type: 'file',
      });
  });
  return { items, deletions };
}

/**
 * `cursor` has no entry for `root` → full backfill over `entries` (listed by
 * `pull()` at cycle start — see the pre-listing note there), yielding ~50-file
 * batches. Every INTERMEDIATE batch leaves `root`'s cursor entry absent
 * (still catching up — see cursor.ts); only the FINAL batch stamps
 * `{ completedAt }` with `scanStartIso`, taken from BEFORE the listing so
 * nothing that changed during the walk is missed once incremental mode takes
 * over. `estimateTotal` is the WHOLE-ACCOUNT file count, not this root's —
 * the engine accumulates `done` across every root, so a per-root estimate
 * reads "242 / ~107" the moment a second root is involved. Returns the
 * cursor snapshot as of this root's completion (or `working` unchanged if
 * the root turned out empty — same one-batch shortcut either way) so the
 * next root in `pull()`'s loop starts from an up-to-date base.
 */
async function* backfillRoot(
  root: string,
  entries: ScannedEntry[],
  scanStartIso: string,
  estimateTotal: number,
  working: LocalFolderCursor,
): AsyncGenerator<
  Batch<LocalFolderCursor, LocalFolderItem>,
  LocalFolderCursor
> {
  if (entries.length === 0) {
    const next = advanceCursor(working, root, scanStartIso);
    yield { phase: 'backfill', items: [], cursor: next, estimateTotal };
    return next;
  }

  const batches = chunkBySize(
    entries,
    BATCH_SIZE,
    MAX_BATCH_READ_BYTES,
    entryReadCost,
  );
  let cursor = working;
  for (let i = 0; i < batches.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const { items, deletions } = await buildBatch(batches[i], root);
    const isLast = i === batches.length - 1;
    if (isLast) cursor = advanceCursor(cursor, root, scanStartIso);
    yield { phase: 'backfill', items, deletions, cursor, estimateTotal };
  }
  return cursor;
}

/**
 * `cursor` has an entry for `root` → catch-up rescan of an already-live root:
 * kiagent-ref's `reconcileRoot()` runs `scanRoot()` again for the exact same
 * reason (its chokidar watcher starts with `ignoreInitial` and only observes
 * events going forward — kiagent-ref instance.ts:68-73). Only files whose
 * mtime is newer than the cursor's watermark are yielded; offline DELETIONS
 * are deliberately NOT handled here — that is `reconcile()`'s job (below),
 * matching the Source contract's two separate deletion channels. Nothing
 * changed → no batch yielded and `working` returned unchanged (this root's
 * watermark simply isn't advanced this cycle; the next cycle rescans from
 * the same point, which is safe/idempotent, just not maximally fresh).
 */
async function* incrementalRescanRoot(
  root: string,
  since: { completedAt: string },
  entries: ScannedEntry[],
  rescanStartIso: string,
  working: LocalFolderCursor,
): AsyncGenerator<
  Batch<LocalFolderCursor, LocalFolderItem>,
  LocalFolderCursor
> {
  const sinceMs = Date.parse(since.completedAt);
  const changed = entries.filter((e) => e.stats.mtime.getTime() > sinceMs);

  if (changed.length === 0) return working;

  const next = advanceCursor(working, root, rescanStartIso);
  for (const b of chunkBySize(
    changed,
    BATCH_SIZE,
    MAX_BATCH_READ_BYTES,
    entryReadCost,
  )) {
    // eslint-disable-next-line no-await-in-loop
    const { items, deletions } = await buildBatch(b, root);
    yield { phase: 'live', items, deletions, cursor: next };
  }
  return next;
}

export async function* pull(
  session: Session,
  cursor: LocalFolderCursor | null,
): AsyncIterable<Batch<LocalFolderCursor, LocalFolderItem>> {
  const rootPaths = getRootPaths(session.account);
  // Both branches of the per-root loop need this guard, not just backfill:
  // an incremental rescan of a vanished root must surface the error too,
  // not silently no-op (see assertRootsAvailable).
  await assertRootsAvailable(rootPaths);
  let working = pruneToConfiguredRoots(cursor, rootPaths);

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

  // One walk per root per cycle, ALL taken up front (both branches of the
  // per-root loop needed a listing anyway), so backfill batches can report
  // the whole-account file count as `estimateTotal`. The engine accumulates
  // `done` across every root; against a per-root estimate the progress line
  // read "242 / ~107 (100%)" as soon as a second root's backfill started.
  // The timestamp is captured BEFORE the listings so a root's eventual
  // `{ completedAt }` stamp can never postdate its own scan.
  const scanStartIso = new Date().toISOString();
  const listings = new Map<string, ScannedEntry[]>();
  for (const root of rootPaths) {
    // eslint-disable-next-line no-await-in-loop
    listings.set(root, await listEntries(root));
  }
  let estimateTotal = 0;
  for (const entries of listings.values()) estimateTotal += entries.length;

  let didBackfill = false;
  for (const root of rootPaths) {
    const since = working?.roots?.[root];
    const entries = listings.get(root) ?? [];
    if (!since) {
      didBackfill = true;
      working = yield* backfillRoot(
        root,
        entries,
        scanStartIso,
        estimateTotal,
        working,
      );
    } else {
      working = yield* incrementalRescanRoot(
        root,
        since,
        entries,
        scanStartIso,
        working,
      );
    }
  }

  // A backfill's final batch is phase 'backfill' (→ status 'backfilling'),
  // and the watch loop below commits nothing until a file actually changes —
  // without this cursor-only live batch the account would sit on
  // "Backfilling … (100%)" indefinitely after the walk finished. Gated on
  // didBackfill so quiet steady-state cycles stay zero-commit.
  if (didBackfill) {
    yield { phase: 'live', items: [], cursor: working };
  }

  if (session.signal.aborted || !isWatchEnabled(session.account)) return;
  yield* watchLoop(rootPaths, session, working);
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
 *  check applies the PIPELINE's own cap, not one flat ceiling: this is
 *  deliberately how a 20-50 MiB local PDF (committed metadata-only, `vision`
 *  pipeline, 50 MiB cap) still gets its bytes fetched here for OCR, while a
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
    if (decideLocalFile(absPath, stat.size).kind === 'ignore') return null;
    return new Uint8Array(await fs.promises.readFile(absPath));
  } catch {
    return null;
  }
}

/**
 * Full listing of what exists on disk right now, across EVERY configured
 * root, chunked so a huge tree doesn't force one giant array — the engine
 * diffs this against what it has stored and archives anything missing
 * (offline deletions kiagent-ref would have caught via `reconcileRoot()`'s
 * present-set diff, instance.ts:68-85). The up-front `assertRootsAvailable`
 * is the anti-mass-archival guard: a missing root must throw here, never
 * enumerate as empty (see that helper's doc for the full rationale).
 */
export async function* reconcile(
  session: Session,
): AsyncIterable<ExternalRef[]> {
  const rootPaths = getRootPaths(session.account);
  await assertRootsAvailable(rootPaths);

  const refs: ExternalRef[] = [];
  for (const root of rootPaths) {
    // eslint-disable-next-line no-await-in-loop
    const entries = await listEntries(root);
    for (const e of entries)
      refs.push({ externalId: toAbsPosix(e.absPath), type: 'file' });
  }
  for (const c of chunk(refs, 500)) {
    if (session.signal.aborted) return;
    yield c;
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

export const localFolderSource: Source<LocalFolderCursor, LocalFolderItem> = {
  descriptor,
  connect,
  pull,
  toDocument,
  fetchBytes,
  reconcile,
  manageFolders,
};
