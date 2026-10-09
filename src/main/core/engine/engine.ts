import { setImmediate as nextEventLoopTurn } from 'timers/promises';

import type {
  Account,
  AccountId,
  AuthChannel,
  Change,
  Credentials,
  Document,
  DocumentInput,
  Engine,
  EnrichInput,
  ExternalRef,
  FolderScopeUpdate,
  Handle,
  Inference,
  Lane,
  LogLevel,
  Projection,
  Query,
  Seq,
  Session,
  Source,
  SyncStatus,
  Worker,
  WorkerSession,
  MessageEvidenceReadInput,
} from '@shared/contracts';

import { sourceErrorCode } from '@shared/source-errors';

import {
  AccountFlowBusyError,
  FolderScopeConfigError,
  FolderScopeStaleError,
} from './flow-errors';

import { isDbWorkerTransientError } from '../../db/worker-client';

import { RECONCILE_ERROR_PREFIX } from '../store/last-error';
import { NOOP_ADMISSION, type Admission } from '../admission';
import { seedConsumerName } from '../store/maintenance-keys';
import type { CoreStore } from '../store/store';
import { readMessageEvidence as readMessageEvidenceOperation } from './message-evidence';
import { FetchDeferredError } from './fetch-deferred';
import { freshCredentials } from './fresh-credentials';

export interface LogSink {
  log(
    scope: string,
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): void;
}

export interface EngineDeps {
  store: CoreStore;
  /** #59 §3a: where a new consumer's seed pages are read. Production passes
   *  the read worker (boot's 'other' read plane) so paging never queues behind
   *  ingest; defaults to `store.read`. */
  reads?: Query;
  /** Seed page size — tests only (default SEED_PAGE). */
  seedPageSize?: number;
  sources: { get(id: string): Source | undefined };
  /** The plane. `seeWithMeta` is optional so engine fakes that never call
   *  it keep compiling; a session's `seeWithMeta` throws when absent. */
  inference: Inference & {
    seeWithMeta?(
      image: Uint8Array,
      prompt: string,
      opts?: {
        mime?: string;
        lane?: Lane;
        task?: string;
        signal?: AbortSignal;
      },
    ): Promise<{ text: string; providerId: string; modelId: string }>;
    /** Optional so engine fakes keep compiling; absent = nothing may. */
    mayBecomeReady?(kind: 'see' | 'read'): boolean;
    hasProvider?(kind: 'see' | 'read'): boolean;
  };
  /** The commit-path conversion stage: binary in, markdown out. Deterministic
   *  parsers only — text-poor results are left for a vision worker ('defer').
   *  `signal` cancels a queued or running converter job (pause/stop). */
  convert(input: DocumentInput, signal?: AbortSignal): Promise<DocumentInput>;
  /** #147 background admission. Optional: absent = admit at once. */
  admission?: Pick<Admission, 'acquire'>;
  logs: LogSink;
  /** Per-source OAuth refreshers. The PLATFORM refreshes tokens before a
   *  session hands them out — no refresh logic in any source. */
  refreshers?: Map<string, (creds: Credentials) => Promise<Credentials | null>>;
}

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const SOURCE_MAX_RETRIES = 5;
/** Consecutive DB-worker-crash retries an infinite feed consumer
 *  (attach/project) tolerates before giving up. The worker supervisor's own
 *  crash-loop breaker converts a persistent crash into a non-transient
 *  DB_WORKER_DEAD long before this budget matters — it exists so a bug in
 *  that classification can never turn a consumer into a hot retry loop. */
const FEED_RETRY_MAX = 5;

/** Iterate, but stop the moment the signal aborts — even while the source
 *  iterator is parked awaiting new data (the live feed blocks on commits).
 *
 *  Exported for `__tests__/abortable-leak.test.ts` only — the retention this
 *  guards against is invisible through the public engine surface. */
export async function* abortable<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const it = iterable[Symbol.asyncIterator]();
  try {
    for (;;) {
      if (signal.aborted) return;
      // The wakeup is armed FRESH each iteration and dropped on every exit
      // path. Racing one long-lived `aborted` promise instead — as this did
      // until 2026-08-09 — leaks: Promise.race subscribes a new reaction to
      // each input on every call, and a promise that never settles (the
      // healthy case: nothing ever aborts) never drains its reaction list. So
      // each iteration left a reaction pinning that iteration's settled race
      // promise, whose result is the yielded value. store.feed() yields up to
      // FEED_BATCH changes carrying whole Documents — markdown included — and
      // the attach/project consumers below iterate forever, so every batch
      // ever read stayed reachable: 3.09 GiB of a 4 GiB heap after ~25h, and
      // a main-process OOM. Same arm-then-drop discipline as feed()'s next().
      let fire!: () => void;
      const woke = new Promise<'aborted'>((resolve) => {
        fire = () => resolve('aborted');
      });
      signal.addEventListener('abort', fire, { once: true });
      try {
        const r = await Promise.race([it.next(), woke]);
        if (r === 'aborted' || r.done) return;
        yield r.value;
      } finally {
        // Also covers the suspended-at-yield case: a consumer that stops
        // iterating runs this through the generator's return path, so a
        // long-lived flaky source can never accrue listeners on the shared
        // per-account signal (Node warns past 10).
        signal.removeEventListener('abort', fire);
      }
    }
  } finally {
    void it.return?.();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Mass-archive breaker thresholds: a reconcile diff that would archive more
 *  than MASS_ARCHIVE_RATIO of the account's live docs AND more than
 *  MASS_ARCHIVE_MIN_DOCS absolute is refused unless the account's config
 *  just changed. Small corpora (≤ the floor) stay breaker-free — a 3-doc
 *  test account archiving 2 is normal churn, not a listing bug. */
const MASS_ARCHIVE_MIN_DOCS = 100;
const MASS_ARCHIVE_RATIO = 0.5;

/** A one-shot pass on the mass-archive breaker (spec §5.6). `full` waives
 *  both refusals (the pass right after a Save that archived, a connect, a
 *  config edit). `ratio` waives only the >50% arm — the empty-listing refusal
 *  stays armed — and is what a first scope declaration or an unchanged
 *  re-save earns: a legitimate shrink, never an excuse for a broken listing. */
export type AllowanceKind = 'full' | 'ratio';

/** The scope ids an account's config declares, or `null` when it declares
 *  none. `folderRoots` (folder-scoped connectors), then the Drive-style
 *  `roots`, then local-folder `paths` — whichever is an array first. */
export function declaredScopeIds(
  config: Record<string, unknown>,
): string[] | null {
  const { folderRoots, roots, paths } = config;
  if (Array.isArray(folderRoots))
    return folderRoots.map((r) => String((r as { id: unknown }).id));
  if (Array.isArray(roots))
    return roots.map((r) =>
      String((r as { rootFolderId: unknown }).rootFolderId),
    );
  if (Array.isArray(paths) && paths.every((p) => typeof p === 'string'))
    return paths as string[];
  return null;
}
/** How many listing refs reconcile hands the store at a time. This is the ONLY
 *  reconcile structure that ever sits on this thread, so it — not the account —
 *  bounds the pass's memory. A connector may yield pages of any size; they get
 *  re-chunked to this. */
export const RECONCILE_STAGE_BATCH = 10_000;

/** Deferred entries pulled — and Documents materialized — per re-drive page.
 *  The re-drive's peak memory is a function of THIS, never of the backlog
 *  size: an unbounded read of a 2.1M-entry vision backlog put ~2 GB of live
 *  Documents on the main heap and killed the process (2026-08-24). Matched to
 *  FEED_BATCH, the live tail's equivalent bound. */
export const REDRIVE_PAGE = 500;
/** #59 §3a: live documents per seed page (one read-worker call each). */
export const SEED_PAGE = 500;

/** #147 §4 bounded writer units: a sub-commit (or a consumer flush) closes
 *  once it holds this much markdown/text … */
export const SUB_COMMIT_BYTES = 8 * 1024 * 1024;
/** … or this many documents — whichever comes first, and only ever at a
 *  source-item boundary. */
export const SUB_COMMIT_DOCS = 50;

/** UTF-8 bytes of the markdown a document carries into a writer unit — a
 *  real byte count: `.length` counts UTF-16 code units, which lets CJK text
 *  reach ~3× the bound before a flush. */
const textBytes = (d: { markdown?: string | null }): number =>
  Buffer.byteLength(d.markdown ?? '', 'utf8');

/** What one worked change records in its work_ledger row — the store's own
 *  outcome union, which `workOne` hands back for its caller to record. */
type LedgerOutcome = NonNullable<Parameters<CoreStore['ledgerRecord']>[3]>;
type LedgerEntry = Parameters<CoreStore['ledgerRecordMany']>[1][number];

/**
 * Runs a source's optional `reconcile()` once per pull cycle: drains its full
 * listing, then archives whatever the account still has live that ISN'T in
 * that listing — the offline-deletion channel the Source contract promises
 * (contracts.ts:320) but that, before this, no engine code ever called.
 *
 * Kicked off fire-and-forget, IN PARALLEL with `source.pull()` (see the call
 * site in `run()`), rather than sequenced off any Batch/phase event. Two
 * things rule out a batch-shaped trigger: a resumed account's initial
 * catch-up can legitimately commit ZERO batches (nothing changed since last
 * cursor — imap's syncMailboxOnce and local-folder's incrementalRescan both
 * skip yielding when there's nothing to report), and even when it commits
 * some, they're already phase:'live' from the very first one on a resumed
 * account — there's no batch-shaped signal marking "the catch-up finished,
 * now watching" versus "still catching up". Running it concurrently instead
 * means it always gets a chance to run, every cycle, regardless of what
 * pull() does — and it mirrors kiagent-ref's own boot-time behavior: "live →
 * startRealtime(), fire-and-forget reconcile()" (backend-surface.md:397).
 * Running concurrently is mostly self-protecting — `archiveByRef` only ever
 * touches a document that ALREADY exists, so a doc pull() hasn't committed
 * yet simply isn't there to be wrongly archived — EXCEPT for the one window
 * that isn't: a doc pull() commits WHILE reconcile is mid-drain, after its
 * listing snapshot was taken. The `startSeq` guard below closes that one.
 *
 * Abort-safety is the correctness core: a listing cut short by cancellation
 * (or an error caused by one) looks identical to "everything but the first
 * page got deleted." `abortable()` stops draining the moment the signal
 * fires, and the `signal.aborted` check AFTER the drain — not just inside the
 * catch — is what catches that: it's what distinguishes "the source returned
 * normally after seeing the abort itself" (no exception, but still a partial
 * listing) from a genuinely complete one. Either way, skip the diff.
 *
 * A genuine (non-abort) failure is recorded on the account exactly like a
 * pull failure is (`logs.log(..., 'error', ...)` + a commit carrying
 * `error:`), without touching `status` — reconcile is an adjunct check, not
 * the sync itself, so one failed listing shouldn't flip a healthy account to
 * 'error'.
 *
 * Mass-archive breaker: nothing structurally enforces the reconcile identity
 * invariant (contracts.ts) — a silently-empty listing (imap resolving zero
 * mailboxes, an unmounted drive slipping past a source's own guard) or a
 * key-scheme drift would diff to "archive the whole account". Two graduated
 * refusals, both recorded on the account instead of archiving: (1) a listing
 * that came back EMPTY while live docs exist — no legitimate bundled flow
 * produces one except deliberately clearing the config; (2) a diff exceeding
 * MASS_ARCHIVE_RATIO + MASS_ARCHIVE_MIN_DOCS. `allowance` (see
 * AllowanceKind): `full` — granted for the first pass after the account's
 * config changed (root removed, a re-connect) — bypasses both; `ratio`
 * bypasses only the second, and is the user's escape hatch when a shrinkage
 * is real: re-saving the account's settings applies the pending cleanup on
 * the next cycle, but never off an empty listing.
 *
 * TOCTOU guard: `source.reconcile()`'s listing is a walk over the source
 * (local-folder streams its tree page by page as this drains it), which can
 * take a while for a large tree/mailbox. Since this runs CONCURRENTLY with `pull()`, a document
 * pull() discovers and commits mid-drain — after reconcile's walk went past
 * it but before the `liveRefs()` read below — would look "live but
 * unlisted" and get archived the instant it lands. `startSeq`, captured
 * before the drain even begins, closes that window: only documents that
 * were ALREADY live before this pass started are eligible for archiving:
 * anything pull() adds while reconcile is running is newer than what
 * reconcile's listing could possibly know about, so it's excluded rather
 * than treated as a deletion candidate.
 */
async function reconcilePass(
  source: Source,
  session: Session,
  signal: AbortSignal,
  store: CoreStore,
  account: Account,
  logs: LogSink,
  scope: string,
  allowance: AllowanceKind | undefined,
  admission: Pick<Admission, 'acquire'>,
): Promise<void> {
  if (!source.reconcile) return;
  const startSeq = await store.headSeq();
  // Stream the connector's listing straight into the store, re-chunked. The
  // pass used to build `listed[]` + a key Set here and then a `deletions[]`
  // off a paged live-ref read: all three scale with the ACCOUNT, and on a
  // 3.7M-document local-folder root (the fs watcher walking a symlink cycle
  // back into its own root) they took ~3.2 GiB against V8's 4 GiB cap and
  // killed the main process with an OOM SIGTRAP. Only counts come back now.
  await store.reconcileBegin(account.id);
  // Records the pass's outcome on the account: `last_error` only. Never the
  // cursor — pull() commits concurrently, and a read-then-write of the cursor
  // here could roll back one it just advanced (alpha-cent#181). The pass
  // shares `last_error` with pull(): each clears only its own error (see
  // `sharesError` in run()), so a healthy pass never erases pull's failure.
  const finish = async (error: string | null): Promise<void> => {
    await store.setAccountStatus(
      account.id,
      error === null ? { error, errorScope: 'reconcile' } : { error },
    );
  };
  // ONE failure path for the whole pass — drain, diff, archive and the final
  // commit (spec §5.8: a store that lost its staging throws from any of
  // them). Ends the pass and, unless cancellation caused it, records the
  // error. Never archives.
  try {
    let batch: ExternalRef[] = [];
    for await (const page of abortable(source.reconcile(session), signal)) {
      for (const ref of page) {
        batch.push(ref);
        if (batch.length >= RECONCILE_STAGE_BATCH) {
          // eslint-disable-next-line no-await-in-loop
          await store.reconcileStage(account.id, batch);
          batch = [];
        }
      }
    }
    if (batch.length > 0) {
      await store.reconcileStage(account.id, batch);
    }
    if (signal.aborted) {
      // partial listing — never diff off it
      await store.reconcileEnd(account.id);
      return;
    }

    // `startSeq` is the TOCTOU guard, applied inside the diff: only documents
    // already live when this pass began are archiving candidates, so anything
    // pull() commits mid-drain (newer than the listing could know about) is
    // excluded rather than archived the instant it lands.
    // `listedCount` comes from the DIFF, never from counting what we staged:
    // a local tally would still claim the listing was fine after staging was
    // lost, walking straight past the empty-listing guard below.
    const { listedCount, liveCount, deletionCount } = await store.reconcileDiff(
      account.id,
      startSeq,
    );
    if (deletionCount === 0) {
      await store.reconcileEnd(account.id);
      await finish(null); // a healthy pass clears its own earlier failure
      return;
    }

    // Zero-false-positive first: an empty listing over a non-empty corpus is
    // always a broken listing or a deliberately emptied config — never normal
    // churn. Only `full` waives it; `ratio` waives only the second arm.
    const refusal =
      allowance === 'full'
        ? null
        : listedCount === 0
          ? 'the listing came back empty'
          : allowance !== 'ratio' &&
              deletionCount > MASS_ARCHIVE_MIN_DOCS &&
              deletionCount > liveCount * MASS_ARCHIVE_RATIO
            ? 'the listing shrank suspiciously'
            : null;
    if (refusal !== null) {
      await store.reconcileEnd(account.id);
      const msg =
        `${RECONCILE_ERROR_PREFIX}refusing to archive ${deletionCount} of ` +
        `${liveCount} documents (${refusal}). If this shrinkage is real, ` +
        `re-save the account's settings to apply the cleanup.`;
      logs.log(scope, 'error', msg);
      await finish(msg);
      return;
    }

    // Archives (and clears the staged listing) inside the store — the ids
    // never come back here either.
    // One bounded archive transaction per RPC, each an admitted `reconcile`
    // unit (#147 §4): the DB worker serves requests in order, so a single
    // multi-chunk RPC would block every other writer until the whole cleanup
    // ended. The store ends the pass on the chunk that reports `done`; a DB
    // worker respawn mid-pass surfaces as "reconcile staging lost" (caught
    // below), never as a partial archive of a re-created staging table.
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const release = await admission.acquire('reconcile', signal);
      let done: boolean;
      try {
        // eslint-disable-next-line no-await-in-loop
        ({ done } = await store.reconcileArchiveChunk(account.id, startSeq));
      } finally {
        release();
      }
      if (done) break;
    }
    await finish(null);
  } catch (err) {
    await store.reconcileEnd(account.id).catch(() => {});
    if (signal.aborted) return; // cancellation-caused — not a real failure
    const msg = String(err instanceof Error ? err.message : err);
    logs.log(scope, 'error', `reconcile failed: ${msg}`);
    await finish(`${RECONCILE_ERROR_PREFIX}${msg}`);
  }
}

/** Derives a worker's ledger consumer key. MUST be derived (never a hard-coded
 *  constant): the engine keys deferred work as `worker:<name>:v<version>`, so
 *  a caller that hard-codes this string desyncs the moment a worker's
 *  `version` bumps — deferred work then accrues under the new key while the
 *  caller keeps querying the old, now-permanently-empty one. */
export const workerConsumerName = (
  w: Pick<Worker, 'name' | 'version'>,
): string => `worker:${w.name}:v${w.version}`;

/** The config keys the folder-scope path owns. `roots` and `paths` are R1's
 *  one-train legacy mirrors of `folderRoots`, written by CORE (A-2) in the v3
 *  migration and in `applyFolderScope`; an old Marketplace connector reads
 *  them, so they must move together with the canonical key or the two shapes
 *  desync. TODO(folder-scope-train-2): drop the legacy mirror keys. */
const SCOPE_KEYS = ['folderRoots', 'roots', 'paths'] as const;

function pickScopeKeys(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SCOPE_KEYS)
    if (Object.prototype.hasOwnProperty.call(config, key))
      out[key] = config[key];
  return out;
}

/** What a deferred-work re-drive did. `{ skipped: 'rekey-pending' }`: the
 *  one-shot ledger re-key repair (#59 §0) has not finished, so nothing ran
 *  and nothing was recorded; the repair's completion wakes the re-drive. */
export type RedriveResult = { skipped: 'rekey-pending' } | undefined;

export function createEngine(deps: EngineDeps): Engine & {
  /** Feed-consumer names of the currently attached workers. The consumers
   *  table also keeps rows of retired workers (e.g. an old version), whose
   *  frozen cursors must not count as pending work. */
  activeConsumers(): string[];
  /** Re-drive a worker's deferred changes (scheduler calls this on cadence). */
  rerunDeferred(worker: Worker): Promise<RedriveResult>;
  /** Stop every running handle (app shutdown). */
  stopAll(): Promise<void>;
  /** Persist an account's config; restarts its sync loop if one is running
   *  so the new config takes effect immediately. */
  updateConfig(
    accountId: AccountId,
    config: Record<string, unknown>,
  ): Promise<void>;
  /** True while the account's pull loop is still executing; false once it
   *  settled (finished, gave up after retries, or was stopped). Cadence
   *  ticks consult this so they only START a pull, never replace one that
   *  is still going — for a socket-holding live source (WhatsApp) a
   *  replacement means a full re-login and a fresh history re-send. */
  isRunning(accountId: AccountId): boolean;
  /** Pause an account: abort any in-flight sync loop, THEN persist
   *  `status: 'paused'`. A status-only commit alone is not enough — a loop
   *  still pulling flips the status back on its next batch commit (the
   *  "backfill resumes itself after pause" bug), so the loop must be stopped
   *  first. A no-op teardown for an already-idle account. */
  pause(accountId: AccountId): Promise<void>;
  /** Explicitly resume a paused account: clear any pending pause intent and
   *  persist `status: 'connecting'` BEFORE the caller starts the loop —
   *  run() refuses paused/pausing accounts, so this is the one door back in.
   *  Returns the account carrying the new status (feed it to run()), or null
   *  if the account is gone. */
  resume(accountId: AccountId): Promise<Account | null>;
  /** Build a Session for a flow that is NOT the pull loop — today only
   *  `manageFolders`. `makeSession` is a closure inside createEngine, so
   *  without this verb the broker would have to re-implement the vault load
   *  and the expiring-token refresh, which is the one place a stale token
   *  must PROPAGATE rather than be swallowed (engine.ts:406-414). */
  session(account: Account, signal: AbortSignal, scope: string): Session;
  /** Re-authenticate ONE existing account in place. Invariant 2: it may
   *  replace credentials and status, and must preserve config, cursor,
   *  folder roots and documents byte-for-byte — so it calls neither
   *  `connect()` (which upserts config through createAccount) nor
   *  `setAccountConfig`, and never grants a reconcile allowance.
   *
   *  `auth` is the caller's channel, not an `oauthClient` bag: the broker's
   *  channel already bakes the BYO client into `authUrl` (connect-broker.ts
   *  :109), exactly as `connect(source, auth)` relies on, and the engine has
   *  no OAuth profile registry to bake it with (EngineDeps, :41-52). See this
   *  task's contractConcerns — DECISIONS' frozen `reconnect(accountId,
   *  opts?)` lives on `broker.startReconnect`, which can honour it.
   *
   *  `signal` is the flow's abort signal — a cancel that lands after
   *  `reauthenticate()` resolves aborts BEFORE the first durable write, so
   *  cancel has nothing to compensate.
   *
   *  Restarting is the CALLER's move, mirroring `accounts:resume`
   *  (main.ts:457-464): a needsReauth account was skipped by boot's
   *  resumeAccounts, so it has no cadence job and needs `runAccount`, which
   *  lives in boot and would be a cycle from here. */
  reconnect(
    accountId: AccountId,
    auth: AuthChannel,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Apply a folder-scope edit the source computed: stop the loop, then ONE
   *  store transaction (config + cursor + archival of the roots the SOURCE
   *  named + a `changes` row per archived document) and a restart.
   *
   *  This is the ONLY door folder scope goes through. `updateConfig` refuses
   *  it (below): that path persists config BEFORE stopping anything, so the
   *  old loop keeps pulling under the new config and its next commit
   *  overwrites the transformed cursor.
   *
   *  R8/A-1: `update.archiveScopeRootIds` is FORWARDED VERBATIM. Core must
   *  never derive it — only the source knows whether a removed root's
   *  documents are still covered by a retained one, and a set-difference over
   *  `folderRoots` archives every row whose `scope_root_id` was frozen by
   *  `hashSkip` at some historical folder (314 of 316 on the real production
   *  account). An empty array is legal.
   *
   *  C-46/D5: `update.reattributeScopeRoots` is forwarded on exactly the same
   *  terms, and is where a removed-but-still-covered root belongs. An empty
   *  archive set is NOT the right way to say that — silence freezes a stale
   *  stamp no later save can match (C-46/D2, C-46/D3). Absent means none, and
   *  the coercion to `[]` for the store's required input happens at the call
   *  site below and nowhere else.
   *
   *  **C-28.2 — `expectedConfigJson` is a REQUIRED parameter, not something
   *  this function may fetch for itself.** It is the caller's snapshot of the
   *  account config taken when the picker OPENED, and it is the whole value of
   *  the store's compare-and-swap. Read here instead, it would be a baseline
   *  fetched after the caller's own staleness check, so a config write landing
   *  in between would be adopted as "expected" and then overwritten by
   *  `applyFolderScope`'s `UPDATE accounts SET config = ?`, with nobody told.
   *  Required rather than optional on purpose: an optional parameter with a
   *  re-read fallback re-introduces the bug the first time a caller forgets. */
  applyScope(
    accountId: AccountId,
    update: FolderScopeUpdate,
    expectedConfigJson: string,
  ): Promise<{ archived: number }>;
  /** Claim the account's single flow slot. Idempotent for the holder; throws
   *  AccountFlowBusyError for anyone else. Callers release in a `finally`. */
  claimAccountFlow(accountId: AccountId, flowId: string): void;
  /** Release the slot IF `flowId` still holds it — a late release from a
   *  settled flow must never free a slot its successor already took. */
  releaseAccountFlow(accountId: AccountId, flowId: string): void;
  /** True while any ACCOUNT loop is in its initial (or re-)backfill —
   *  synchronous, no DB read. Worker handles share `running` and are
   *  excluded by key. */
  syncing(): boolean;
} {
  const { store, logs } = deps;
  const admission = deps.admission ?? NOOP_ADMISSION;
  const running = new Map<
    string,
    { stop(): Promise<void>; active(): boolean; syncing?(): boolean }
  >();
  /** Re-drives in flight: `stopAll` aborts and drains them (#147 §4). */
  const activeRedrives = new Set<{
    abort: AbortController;
    done: Promise<void>;
  }>();
  /** Set by `stopAll` before anything else: a scheduler callback that
   *  finished its deferred-work probe after shutdown began must not launch
   *  an untracked re-drive. Never cleared — `stopAll` is shutdown. */
  let stopping = false;
  /** Consumer names of attached workers (a subset of `running`'s keys, which
   *  also hold account loops). */
  const attachedWorkers = new Set<string>();
  /** Accounts with a pause in flight: set BEFORE pause() aborts the loop,
   *  cleared only after the 'paused' status commit lands. run() consults it
   *  so the cadence-tick supervisor (or sync-now) can't resurrect the loop
   *  inside the stop-to-commit window — the tick reads isRunning=false and a
   *  still-stale 'backfilling' there and would otherwise restart the loop,
   *  whose batch commits then overwrite 'paused' (the v0.45.0 bug through a
   *  different door). */
  const pauseIntents = new Set<AccountId>();
  /** Accounts whose config just changed (updateConfig, re-connect): the NEXT
   *  reconcile pass may exceed the mass-archive breaker — removing a
   *  local-folder root or re-scoping an account legitimately archives big
   *  fractions of the corpus. Consumed (deleted) when the pass starts. */
  const reconcileAllowances = new Map<AccountId, AllowanceKind>();
  // A merge never downgrades: a pending `full` outlives a later `ratio`.
  const grantAllowance = (id: AccountId, kind: AllowanceKind): void => {
    if (reconcileAllowances.get(id) !== 'full')
      reconcileAllowances.set(id, kind);
  };
  const takeAllowance = (id: AccountId): AllowanceKind | undefined => {
    const kind = reconcileAllowances.get(id);
    reconcileAllowances.delete(id);
    return kind;
  };

  /** The ONE account-scoped flow allowed at a time: reconnect and
   *  manage-folders cannot overlap on one account (spec invariant 13). Keyed
   *  by account, valued by the flowId that holds it — process-local, like
   *  `running` and `pauseIntents`, and released in the flow's own finally.
   *
   *  `connect-broker.start()` deliberately does NOT claim this: `start` is
   *  handed a sourceId and has no account id until `connect()` has already
   *  returned and `createAccount` has upserted, so a lock taken there would
   *  be taken after the write it was supposed to order. See the ruling in the
   *  task notes — the residual connect-vs-manage race is DETECTED by
   *  applyScope's `expectedConfigJson` guard, not silently lost, and A-4
   *  removes the only two-click UI path (local-folder "add another folder")
   *  that reached it. */
  const activeByAccount = new Map<AccountId, string>();

  /** **C-28.1 — the account TRANSITION intent, and it is NOT `activeByAccount`.**
   *  `activeByAccount` above is the UI-level lock: one flow per account, held
   *  by the broker for as long as a picker modal is open — minutes. This one
   *  is the engine-level mutex: held only across the few hundred milliseconds
   *  in which an account is torn down, rewritten and restarted, and it is the
   *  ONLY one `run()` consults.
   *
   *  Why `run()` must consult THIS and never `activeByAccount`: `applyScope`
   *  restarts the account from inside the flow, while the broker still holds
   *  `activeByAccount[accountId] = flowId`. A `run()` that refused on the flow
   *  lock would refuse the restart the flow itself is making, and the account
   *  would sit at its new scope with no loop and no scheduled wakeup.
   *
   *  Why it exists at all: without it ANY restart path — `updateConfig`, a
   *  cadence tick's start-if-idle supervisor (`boot.ts:180-205`), sync-now —
   *  can install a REPLACEMENT loop in the window between `applyScope`'s
   *  `stop()` and its store transaction. `running.has(key)` is still true for
   *  most of that window (a handle deletes its own map entry only at the END
   *  of `stop()`), so `updateConfig`'s `if (!running.has(...)) return;` gate
   *  waves it straight through. The replacement loop's first batch commit then
   *  writes `cursor` — over the cursor `applyFolderScope` just transformed —
   *  so the newly added roots never backfill and the removed roots' pages are
   *  re-pulled. The config CAS cannot see any of it: an ordinary pull commit
   *  does not touch `config`. Same shape as `pauseIntents` above, same reason:
   *  a durable-state read is stale for exactly as long as a transition lasts. */
  const transitionIntents = new Set<AccountId>();
  const evidenceReads = new Map<AccountId, Set<AbortController>>();
  const abortEvidenceReads = (accountId?: AccountId): void => {
    const sets = accountId
      ? [evidenceReads.get(accountId)]
      : [...evidenceReads.values()];
    for (const set of sets)
      for (const controller of set ?? []) controller.abort();
  };

  /** Stop an account's loop for a transition, reporting whether there WAS one.
   *  `restoreLoopAfterFailure` needs that answer — restarting an account that
   *  had no loop would silently start syncing something the user had stopped. */
  const stopForTransition = async (accountId: AccountId): Promise<boolean> => {
    const handle = running.get(`account:${accountId}`);
    const wasRunning = handle?.active() ?? false;
    await handle?.stop();
    return wasRunning;
  };

  /** **C-28.4, and the engine half of C-29.** Put back a loop this flow
   *  stopped, after a failure that happened AFTER the stop. Without it a stale
   *  CAS result, a `FolderScopeStaleError`, or a DB worker that commits and
   *  then dies before its reply (`bridge.ts` commits, `worker-client.ts`
   *  rejects the in-flight call) leaves the account quiesced with nothing
   *  scheduled to wake it. For an account whose source declares no
   *  `descriptor.cadence`, `runAccount` registers no scheduler job at all
   *  (`boot.ts:180-183`), so "quiesced" means "until the app restarts".
   *
   *  Re-reads DURABLE state first, deliberately: after a partial failure the
   *  in-memory picture is precisely what cannot be trusted, and the COMMITTED
   *  status is what decides whether a restart is even legal (paused and
   *  needsReauth stay parked, exactly as `updateConfig` and the cadence tick
   *  do). Never lets its own failure mask the original error — the caller's
   *  rejection is the one the user has to see. */
  const restoreLoopAfterFailure = async (
    accountId: AccountId,
    wasRunning: boolean,
  ): Promise<void> => {
    if (!wasRunning) return;
    try {
      const now = await store.account(accountId);
      if (now && now.status !== 'paused' && now.status !== 'needsReauth')
        engine.run(now);
    } catch {
      // Swallowed on purpose — see above.
    }
  };

  const makeSession = (
    account: Account,
    signal: AbortSignal,
    scope: string,
  ): Session => ({
    account,
    signal,
    credentials(): Promise<Credentials | null> {
      return freshCredentials({
        vault: store.vault,
        account: account.id,
        refresh: deps.refreshers?.get(account.source),
        warn: (msg) => logs.log(scope, 'warn', msg),
      });
    },
    log(level, msg) {
      logs.log(scope, level, msg);
    },
  });

  /** Run one change through a worker with bounded retries. Returns emitted
   *  docs and enrich batch, plus the ledger outcome and attempt count — the
   *  CALLER records them, so it can order that write against its commit of
   *  the output (the re-drive has no cursor: its ledger row is its only
   *  driver, and must not say 'done' before the output is durable). */
  const workOne = async (
    worker: Worker,
    change: Change,
    signal: AbortSignal,
    /** The unit kind a worker's `session.admit()` acquires here. */
    admitKind: 'convert' | 'redrive',
  ): Promise<{
    docs: DocumentInput[];
    enrich: EnrichInput[];
    attempts: number;
    outcome: LedgerOutcome;
  }> => {
    const scope = `worker:${worker.name}`;
    const maxAttempts = worker.maxAttempts ?? 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // Fresh accumulators AND a fresh session object per attempt: workers are
      // third-party extension code, and a failed attempt can leave a dangling
      // background promise running (e.g. an un-awaited setTimeout/then chain)
      // that calls session.emit()/enrich() after its attempt already threw.
      // With a shared session across attempts that late call would push into
      // the SAME array the next attempt is accumulating into, polluting the
      // retry's committed output. Rebinding `session` each iteration means a
      // dangling call from a dead attempt writes into an orphaned array that
      // nothing ever reads — never into the array the live attempt returns.
      const emitted: DocumentInput[] = [];
      const enriched: EnrichInput[] = [];
      const session: WorkerSession = {
        signal,
        inference(prompt, opts) {
          return deps.inference.complete(prompt, {
            ...opts,
            lane: 'background',
            signal,
          });
        },
        see(image, prompt, opts) {
          return deps.inference.see(image, prompt, {
            ...opts,
            lane: 'background',
            signal,
          });
        },
        seeWithMeta(image, prompt, opts) {
          if (!deps.inference.seeWithMeta) {
            throw new Error('inference.seeWithMeta is not wired');
          }
          return deps.inference.seeWithMeta(image, prompt, {
            ...opts,
            lane: 'background',
            signal,
          });
        },
        read(image, opts) {
          return deps.inference.read(image, {
            ...opts,
            lane: 'background',
            signal,
          });
        },
        hear(audio, opts) {
          return deps.inference.hear(audio, {
            ...opts,
            lane: 'background',
            signal,
          });
        },
        async fetchBytes(doc: Document) {
          const account = await store.account(doc.accountId);
          if (!account) return null;
          const source = deps.sources.get(account.source);
          // Workers attach before sources register (bundled sources a few
          // steps later in boot, extension sources when their host comes
          // up). Not-yet-registered is transient — a null here would read as
          // "the source cannot serve these bytes" and end the doc for good.
          if (!source)
            throw new FetchDeferredError(
              `source '${account.source}' is not registered yet`,
            );
          if (!source.fetchBytes) return null;
          // Needs re-auth: don't hammer the provider (an IMAP login per doc
          // each re-drive is what gets accounts throttled or locked). Park
          // until the user reconnects.
          if (account.status === 'needsReauth')
            throw new FetchDeferredError(
              `${account.source} account needs re-authentication`,
            );
          try {
            return await source.fetchBytes(
              makeSession(account, signal, scope),
              doc,
            );
          } catch (err) {
            if (signal.aborted) throw err;
            throw new FetchDeferredError(
              `${account.source} fetchBytes failed: ${String(err)}`,
              { cause: err },
            );
          }
        },
        async bump(key: string) {
          if (change.kind !== 'document')
            throw new Error('bump() needs a document change');
          return store.bumpAttempt(
            workerConsumerName(worker),
            change.document.id,
            key,
          );
        },
        mayBecomeReady: (kind) =>
          deps.inference.mayBecomeReady?.(kind) ?? false,
        hasProvider: (kind) => deps.inference.hasProvider?.(kind) ?? true,
        admit: () => admission.acquire(admitKind, signal),
        emit(doc) {
          emitted.push(doc);
        },
        enrich(e) {
          enriched.push(e);
        },
        log(level, msg) {
          logs.log(scope, level, msg);
        },
      };
      try {
        const outcome = (await worker.work(change, session)) ?? 'done';
        return {
          docs: emitted,
          enrich: enriched,
          attempts: attempt,
          outcome: outcome === 'defer' ? 'deferred' : outcome,
        };
      } catch (err) {
        if (signal.aborted) throw err;
        if (err instanceof FetchDeferredError) {
          // Bytes unavailable right now — park for the re-drive rather than
          // burn retries into a terminal 'failed' (see fetch-deferred.ts).
          logs.log(scope, 'warn', `deferred seq ${change.seq}: ${err.message}`);
          return {
            docs: [],
            enrich: [],
            attempts: attempt,
            outcome: 'deferred',
          };
        }
        logs.log(
          scope,
          'warn',
          `attempt ${attempt}/${maxAttempts} failed at seq ${change.seq}: ${String(err)}`,
        );
        if (attempt === maxAttempts) {
          // A failed final attempt must not commit its half-finished output.
          // Returning the accumulated emit/enrich would persist a partial
          // document (or clobber an existing one via enrich) under a 'failed'
          // outcome. Drop it: the caller records the failure, the cursor moves
          // on, and nothing partial lands.
          return { docs: [], enrich: [], attempts: attempt, outcome: 'failed' };
        }
        await sleep(
          Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS),
          signal,
        );
      }
    }
    // Unreachable unless maxAttempts < 1 (the loop always returns from
    // within on a success, on the final failed attempt, or on abort). No
    // attempt ran, so nothing was worked: record it as failed.
    return { docs: [], enrich: [], attempts: 0, outcome: 'failed' };
  };

  /** #59 §3a: seed `consumer` from `documents` instead of replaying the whole
   *  change log. Runs when the consumer has no row, a half-done seed
   *  (`seed:<consumer>` exists), or a cursor below the published prune
   *  floor. The real row sits at `h0` (head at seed start) from the first
   *  moment, so `pending` and the prune floor are right while seeding; a
   *  document that changes meanwhile comes again through feed(h0), which is
   *  idempotent (emissions key on (consumer, seq)). Returns false when
   *  stopped mid-seed — the seed row keeps the last committed page.
   *  A half-done seed resumes ONLY while its snapshot is still feedable: the
   *  real row exists and h0 >= the published floor. Otherwise (the retired
   *  sweep dropped the real row, or pruning passed h0 while the consumer was
   *  away) feed(h0) would start inside a deleted interval, so the seed
   *  restarts at the current head. */
  const seedConsumer = async (
    worker: Worker,
    consumer: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const cursor = await store.consumerRow(consumer);
    const floor = (await store.changesFloor()) ?? 0;
    const seed = await store.consumerRow(seedConsumerName(consumer));
    const feedable = cursor !== null && cursor >= floor;
    if (feedable && seed === null) return true; // nothing to seed
    let after: Seq = seed ?? 0;
    if (!feedable) {
      // beginSeed resets seed:<consumer> to 0 with the new h0.
      await store.beginSeed(consumer, await store.headSeq());
      after = 0;
    }
    const h0 = await store.consumerCursor(consumer);
    const reads = deps.reads ?? store.read;
    const pageSize = deps.seedPageSize ?? SEED_PAGE;
    for (;;) {
      if (signal.aborted) return false;
      // eslint-disable-next-line no-await-in-loop
      const page = await reads.seedPage!({
        afterSeq: after,
        throughSeq: h0,
        limit: pageSize,
      });
      if (page.length === 0) break;
      let emitted: DocumentInput[] = [];
      let enrich: EnrichInput[] = [];
      let clear: string[] = [];
      let ledger: LedgerEntry[] = [];
      let staged = 0;
      const worked: string[] = [];
      // As attach's dropBatch: nothing crashed, so clear the session.bump
      // counters of what returned. The seed cursor stays put and the
      // unflushed ledger entries are discarded with their outputs. No
      // consumer cursor: the real row stays at h0 (#147 §4 contract).
      const dropPage = () =>
        worked.length
          ? store.commit({ consumer, clearAttempts: worked }).catch(() => {})
          : undefined;
      /** One bounded seed write: an admitted `convert` unit like every
       *  consumer flush (#147 §4). It carries the outputs and the ledger
       *  outcomes worked so far in ONE transaction, under the REAL consumer
       *  (its synthetic worker account), and never a consumer `cursor` — the
       *  real row stays at h0 (#59 §3a). Only the page's last flush carries
       *  `seedCursor`: a crash after an intermediate flush re-works the page
       *  from the old seed cursor (idempotent: emissions key on
       *  (consumer, seq), the ledger upserts). */
      const flush = async (seedCursor?: Seq): Promise<void> => {
        const hasOutput =
          emitted.length > 0 ||
          enrich.length > 0 ||
          clear.length > 0 ||
          ledger.length > 0;
        if (!hasOutput && seedCursor === undefined) return;
        let release: () => void;
        try {
          release = await admission.acquire('convert', signal);
        } catch (err) {
          if (signal.aborted) await dropPage();
          throw err;
        }
        try {
          await store.commit({
            consumer,
            ...(seedCursor !== undefined ? { seedCursor } : {}),
            ledger: ledger.length ? ledger : undefined,
            documents: emitted.length ? emitted : undefined,
            enrich: enrich.length ? enrich : undefined,
            clearAttempts: clear.length ? clear : undefined,
          });
        } finally {
          release();
        }
        emitted = [];
        enrich = [];
        clear = [];
        ledger = [];
        staged = 0;
      };
      for (const document of page) {
        if (signal.aborted) {
          // eslint-disable-next-line no-await-in-loop
          await dropPage();
          return false;
        }
        const change: Change = {
          seq: document.seq,
          kind: 'document',
          document,
        };
        let matched = false;
        try {
          matched = worker.matches(change);
        } catch (err) {
          logs.log(
            `worker:${worker.name}`,
            'warn',
            `matches() threw on seq ${change.seq} — treated as non-match: ${String(err)}`,
          );
        }
        if (!matched) continue;
        // eslint-disable-next-line no-await-in-loop
        const r = await workOne(worker, change, signal, 'convert');
        worked.push(document.id);
        ledger.push({
          seq: change.seq,
          attempts: r.attempts,
          outcome: r.outcome,
        });
        emitted.push(...r.docs);
        enrich.push(...r.enrich);
        if (r.outcome === 'done') clear.push(document.id);
        staged +=
          r.docs.reduce((n, d) => n + textBytes(d), 0) +
          r.enrich.reduce((n, e) => n + textBytes(e), 0);
        // eslint-disable-next-line no-await-in-loop
        if (staged >= SUB_COMMIT_BYTES) await flush();
      }
      after = page[page.length - 1].seq;
      // The page's last flush: its remaining outputs and ledger outcomes
      // plus the seed progress, in one transaction. A crash before it
      // re-works the page from the old seed cursor; after it, every deferral
      // behind the seed cursor already has its retry row.
      // eslint-disable-next-line no-await-in-loop
      await flush(after);
    }
    await store.endSeed(consumer);
    return true;
  };

  const engine = {
    readMessageEvidence: async (input: MessageEvidenceReadInput) => {
      const doc =
        typeof input?.documentId === 'string'
          ? await store.read.document(input.documentId)
          : null;
      const accountId = doc?.accountId;
      const controller = new AbortController();
      if (accountId) {
        let set = evidenceReads.get(accountId);
        if (!set) {
          set = new Set();
          evidenceReads.set(accountId, set);
        }
        set.add(controller);
      }
      try {
        return await readMessageEvidenceOperation(
          {
            store,
            sources: deps.sources,
            session: makeSession,
            paused: (id) => pauseIntents.has(id),
            transitioning: (id) => transitionIntents.has(id),
            signal: controller.signal,
          },
          input,
        );
      } finally {
        if (accountId) {
          const set = evidenceReads.get(accountId);
          set?.delete(controller);
          if (set?.size === 0) evidenceReads.delete(accountId);
        }
      }
    },
    async connect(source: Source, auth: AuthChannel): Promise<Account> {
      // Capture credentials the flow produces so the PLATFORM persists them —
      // the source never stores a blob.
      let captured: Credentials | null = null;
      let usedPicker = false;
      const wrapped: AuthChannel = {
        async oauth(scopes) {
          captured = await auth.oauth(scopes);
          return captured;
        },
        showQr: (qr) => auth.showQr(qr),
        async prompt(schema) {
          const answers = await auth.prompt(schema);
          if (typeof answers.password === 'string') {
            captured = { ...(captured ?? {}), password: answers.password };
          }
          return answers;
        },
        status: (msg) => auth.status(msg),
        // No credentials ride pickFolders — forward verbatim.
        pickFolders: (spec) => {
          usedPicker = true;
          return auth.pickFolders(spec);
        },
      };
      const connected = await source.connect(wrapped);
      const { identifier } = connected;
      let { config } = connected;
      // Re-Adding a known folder-scoped account through a connect that shows
      // NO picker (Gmail, MS365 write fixed defaults) must not reset the
      // user's folder selection: the upsert below replaces config wholesale,
      // and nothing would archive what the lost selection had covered. That
      // includes its ABSENCE: a legacy (undeclared) account must stay
      // undeclared, or connect's defaults become a declared scope whose first
      // reconcile archives everything outside them. A connect that DID show
      // the picker is the user choosing afresh.
      if (source.descriptor.folderScope && !usedPicker) {
        const prior = (await store.read.accounts()).find(
          (a) =>
            a.source === source.descriptor.id && a.identifier === identifier,
        );
        if (prior) {
          const fresh = { ...(config ?? {}) };
          for (const key of SCOPE_KEYS) delete fresh[key];
          config = { ...fresh, ...pickScopeKeys(prior.config ?? {}) };
        }
      }
      // createAccount upserts on (source, identifier): re-authenticating an
      // already-known account returns its EXISTING id (documents keep their
      // account) with the latest config/status. If that account still has a
      // sync loop running, stop it now — otherwise the caller's next run()
      // would layer a second loop on top of one still tearing down.
      const account = await store.createAccount({
        source: source.descriptor.id,
        identifier,
        config,
        status: 'connecting',
        cadence: source.descriptor.cadence,
      });
      // A (re-)connect rewrites the account's config/scope: the next
      // reconcile pass may legitimately exceed the mass-archive breaker.
      grantAllowance(account.id, 'full');
      await running.get(`account:${account.id}`)?.stop();
      if (captured) await store.vault.save(account.id, captured);
      logs.log(
        `source:${source.descriptor.id}`,
        'info',
        `connected ${identifier}`,
      );
      return account;
    },

    run(account: Account): Handle {
      const source = deps.sources.get(account.source);
      const scope = `source:${account.source}`;
      const key = `account:${account.id}`;
      // Refuse to start while a pause is in flight. The cadence tick doubles
      // as a loop supervisor (start-if-idle) and decides from isRunning() +
      // a status read — both stale inside pause()'s stop-to-commit window
      // (the 'paused' commit is worker-RPC and can queue behind other
      // accounts' batches). Starting here would resurrect the loop the user
      // just paused; its batch commits would then overwrite 'paused'. The
      // committed-status recheck at loop entry below closes the mirror-image
      // window (tick read a stale status BEFORE the commit landed, calls
      // run() after the intent cleared).
      // C-28.1. `pauseIntents` and `transitionIntents` refuse a start for the
      // same underlying reason — a durable-state read is stale for exactly as
      // long as the window lasts — but they mean different things to whoever
      // asked, so the log line and the refused handle's status say which.
      // Only these two: `activeByAccount` is deliberately NOT consulted here.
      // The broker holds it across a whole open picker modal, and applyScope
      // restarts the account from inside the flow that holds it, so refusing
      // on the flow lock would refuse that restart and strand the account.
      let refusal: string | null = null;
      if (pauseIntents.has(account.id)) refusal = 'is being paused';
      else if (transitionIntents.has(account.id))
        refusal = 'is mid folder-scope / reconnect transition';
      if (refusal) {
        logs.log(
          scope,
          'info',
          `run refused: account ${account.id} ${refusal}`,
        );
        const refused: Handle & { active(): boolean } = {
          status: pauseIntents.has(account.id) ? 'paused' : 'connecting',
          active: () => false,
          async stats() {
            const account2 = await store.account(account.id);
            return {
              pending: 0,
              done: account2?.progress?.done ?? 0,
              skipped: 0,
              failed: 0,
              deferred: 0,
            };
          },
          async stop() {},
        };
        return refused;
      }
      const abort = new AbortController();
      let status: SyncStatus = 'connecting';
      /** This run's last SUCCESSFULLY committed batch was a backfill batch.
       *  The truthful "still syncing" signal: every run starts at
       *  'connecting', quiet watchers never yield, and `status` flips to
       *  'live' before its commit lands. Only moves after a commit resolves. */
      let backfillCommitted = false;
      let done: Promise<void>;
      // One pull loop per account: a re-run (sync-now, cadence) replaces the
      // previous loop, never runs beside it.
      const prev = running.get(key);

      if (!source) {
        logs.log(
          scope,
          'error',
          `no source registered for account ${account.id}`,
        );
        status = 'error';
        done = Promise.resolve();
      } else {
        done = (async () => {
          await prev?.stop().catch(() => {});
          if (abort.signal.aborted) return;
          let retries = 0;
          for (;;) {
            // Settled before every exit from this iteration (all three
            // returns below, and the catch) so a cycle's reconcile pass never
            // outlives it — e.g. into a retry's fresh session, or past
            // store.close() in a test's afterEach once stop() resolves.
            let reconciling: Promise<void> = Promise.resolve();
            try {
              // Re-resolve every attempt: an extension crash respawns its
              // host, which registers a FRESH source proxy — the instance
              // captured at run() start is bound to the dead child's
              // endpoint and would fail every retry with 'endpoint
              // disposed'. Mid-respawn the registry can be briefly empty;
              // fall back to the captured one and let the normal backoff
              // land a later retry on the replacement.
              const src = deps.sources.get(account.source) ?? source;
              const fresh = (await store.account(account.id)) ?? account;
              // Paused accounts never start pulling, no matter who called
              // run(). A cadence tick (or sync-now) can read a stale
              // pre-pause status, then invoke run() after pause() finished —
              // the entry-time intent check above already missed it. This
              // COMMITTED-status read happens after the 'paused' commit
              // landed (the intent clears only after it), so it catches that
              // straggler. Explicit resume commits 'connecting' before
              // running, so it passes. The intent recheck covers a pause
              // launched between run() and this read (belt to the abort's
              // braces).
              if (fresh.status === 'paused' || pauseIntents.has(account.id)) {
                status = 'paused';
                return;
              }
              const session = makeSession(fresh, abort.signal, scope);
              // Backfill progress accumulates across batches — and across
              // restarts, via the persisted account.progress. Only a truly
              // fresh backfill (no cursor yet) starts the count over. Items
              // are counted rather than emitted documents so filtered items
              // (e.g. imap's automated-mail skip) still advance the bar
              // toward the source's item-based estimate. The stored document
              // count floors the seed: it's a lower bound on items already
              // processed, which rescues accounts whose earlier batches were
              // committed by a build that didn't accumulate the counter.
              let progressDone = 0;
              if (fresh.cursor !== null) {
                // An intermediate sub-commit (#147) left `base` = the count at
                // the stored cursor: the half-committed batch replays from
                // that cursor, so count up from base — `done` and the
                // document count both include items about to be replayed.
                // No base: today's legacy seed, unchanged.
                progressDone =
                  fresh.progress?.base ??
                  Math.max(
                    fresh.progress?.done ?? 0,
                    await store.read.count({ account: account.id }),
                  );
              }
              // §5.3: a folder-scoped account that declares no scope (a
              // legacy account before its first Save) enumerates the
              // connector's defaults — there is no declared set to reconcile
              // against, so no pass runs until the user saves one.
              const undeclared =
                src.descriptor.folderScope === true &&
                declaredScopeIds(fresh.config ?? {}) === null;
              // One-shot, and consumed by EVERY cycle — a skipped pass too.
              // Left pending, a `full` from a settings edit would merge over
              // the first Save's `ratio` and disarm §5.7(b)'s empty-listing
              // refusal on the first-declaration pass.
              const allowance = takeAllowance(account.id);
              // A cycle that runs a reconcile pass shares `last_error` with
              // it: a good pull batch clears only pull's own error, never a
              // failure the pass recorded moments earlier (alpha-cent#181),
              // and the pass clears only its own. Pull's failures still land
              // after the pass — the catch below awaits `reconciling` first.
              const sharesError = Boolean(src.reconcile) && !undeclared;
              const errorScope = sharesError ? ('pull' as const) : undefined;
              if (src.reconcile && !undeclared) {
                reconciling = reconcilePass(
                  src,
                  session,
                  abort.signal,
                  store,
                  fresh,
                  logs,
                  scope,
                  // The pass right after a config change may legitimately
                  // mass-archive (root removal, re-scope).
                  allowance,
                  admission,
                ).catch((err) => {
                  // reconcilePass handles its own errors internally and
                  // should never throw — this is a defensive backstop so a
                  // bug in it can't crash the main pull loop.
                  logs.log(
                    scope,
                    'error',
                    `reconcile pass crashed: ${String(err)}`,
                  );
                });
              }
              // The last cursor this account durably committed: what an
              // intermediate sub-commit writes back, so a crash between
              // sub-commits re-pulls the batch from where it began
              // (unchanged content_hash makes the replay a no-op).
              let committedCursor: unknown = fresh.cursor ?? null;
              for await (const batch of abortable(
                src.pull(session, fresh.cursor ?? null),
                abort.signal,
              )) {
                if (abort.signal.aborted) {
                  await reconciling;
                  return;
                }
                status = batch.phase === 'backfill' ? 'backfilling' : 'live';
                const { items } = batch;
                // `base` only on intermediate progress (see AccountProgress).
                const progressAt = (consumed: number, intermediate: boolean) =>
                  batch.estimateTotal !== undefined
                    ? {
                        done: progressDone + consumed,
                        totalEstimate: batch.estimateTotal,
                        ...(intermediate ? { base: progressDone } : {}),
                      }
                    : undefined;
                const relink: Array<{
                  child: ExternalRef;
                  parent: ExternalRef;
                }> = [];
                let next = 0;
                // One admitted unit per sub-commit (#147 §3): the batch is in
                // hand, so the slot covers toDocument + convert + ONE bounded
                // write and nothing else — never the wait for the next batch.
                do {
                  // eslint-disable-next-line no-await-in-loop
                  const release = await admission.acquire(
                    'ingest',
                    abort.signal,
                  );
                  try {
                    const documents: DocumentInput[] = [];
                    let bytes = 0;
                    while (
                      next < items.length &&
                      documents.length < SUB_COMMIT_DOCS &&
                      bytes < SUB_COMMIT_BYTES
                    ) {
                      if (abort.signal.aborted) break;
                      const out = src.toDocument(items[next]);
                      next += 1;
                      for (const input of out
                        ? Array.isArray(out)
                          ? out
                          : [out]
                        : []) {
                        // eslint-disable-next-line no-await-in-loop
                        const converted = await deps.convert(
                          input,
                          abort.signal,
                        );
                        documents.push(converted);
                        bytes += textBytes(converted);
                        if (converted.parent)
                          relink.push({
                            child: {
                              externalId: converted.externalId,
                              type: converted.type,
                            },
                            parent: converted.parent,
                          });
                      }
                      // Real event-loop turn between items: toDocument is CPU
                      // work on this thread, and awaits on settled promises
                      // never leave the microtask queue. (timers/promises:
                      // jsdom-based tests have no setImmediate global.)
                      // eslint-disable-next-line no-await-in-loop
                      await nextEventLoopTurn();
                    }
                    if (abort.signal.aborted) break;
                    const last = next >= items.length;
                    // Boundaries fall only between items, so one item's
                    // parent and attachments never split. Only the LAST
                    // sub-commit moves the cursor and applies deletions; it
                    // also re-links children earlier sub-commits landed.
                    // eslint-disable-next-line no-await-in-loop
                    await store.commit(
                      last
                        ? {
                            account: account.id,
                            documents,
                            deletions: batch.deletions,
                            cursor: batch.cursor,
                            status,
                            progress: progressAt(items.length, false),
                            error: null,
                            errorScope,
                            relink: relink.length ? relink : undefined,
                          }
                        : {
                            account: account.id,
                            documents,
                            cursor: committedCursor,
                            status,
                            progress: progressAt(next, true),
                            error: null,
                            errorScope,
                          },
                    );
                  } finally {
                    release();
                  }
                } while (next < items.length);
                if (abort.signal.aborted) {
                  await reconciling;
                  return;
                }
                committedCursor = batch.cursor;
                if (batch.estimateTotal !== undefined)
                  progressDone += items.length;
                backfillCommitted = batch.phase === 'backfill';
                retries = 0;
              }
              // abortable() ends the for-await loop the same way whether the
              // source's stream finished naturally OR the signal fired mid-
              // pull — without this check an abort (e.g. stop() during
              // connect()'s upsert-reconnect) would be misread as a clean
              // finish and flip status back to 'live' after stop() already
              // set it to 'paused'.
              if (abort.signal.aborted) {
                await reconciling;
                return;
              }
              // Pull stream ended cleanly: cadence-driven sources rest until
              // the scheduler re-runs them. Let this cycle's reconcile land
              // FIRST: it's concurrent with pull(), so without this await its
              // error commit could race the commit below and get clobbered.
              // A cycle that ran a pass clears only pull's own error here,
              // leaving whatever the pass just recorded.
              await reconciling;
              // Re-check: `await reconciling` is a real suspension point —
              // stop() can land during it, same hazard the abort guard above
              // exists for. Without this, a stop() landing exactly here would
              // still fall through and flip status back to 'live' after
              // stop() already set it to 'paused'.
              if (abort.signal.aborted) return;
              status = 'live';
              await store.commit({
                account: account.id,
                documents: [],
                cursor: ((await store.account(account.id)) ?? account).cursor,
                status,
                error: null,
                errorScope,
              });
              return;
            } catch (err) {
              await reconciling;
              if (abort.signal.aborted) return;
              const msg = String(err instanceof Error ? err.message : err);
              // Taxonomy branch — keyed on the `code` PROPERTY, never
              // instanceof (extension-proxied errors are rehydrated plain
              // Errors carrying the wire's `code`). 'auth' → 'needsReauth'
              // and stop: retries cannot fix a revoked credential, and the
              // supervisor tick / boot resume skip this status, so only the
              // user's explicit Retry (or a fresh connect) restarts the
              // loop. 'permanent' → 'error' and stop, skipping the pointless
              // 5x backoff. Everything un-coded keeps the transient path.
              const code = sourceErrorCode(err);
              if (code) {
                status = code === 'auth' ? 'needsReauth' : 'error';
                logs.log(
                  scope,
                  'error',
                  code === 'auth'
                    ? `authentication required — sync stopped: ${msg}`
                    : `permanent failure — not retrying: ${msg}`,
                );
                await store.commit({
                  account: account.id,
                  documents: [],
                  cursor: ((await store.account(account.id)) ?? account).cursor,
                  status,
                  error: msg,
                });
                return;
              }
              retries += 1;
              logs.log(
                scope,
                'error',
                `sync failed (retry ${retries}/${SOURCE_MAX_RETRIES}): ${msg}`,
              );
              if (retries >= SOURCE_MAX_RETRIES) {
                status = 'error';
                await store.commit({
                  account: account.id,
                  documents: [],
                  cursor: ((await store.account(account.id)) ?? account).cursor,
                  status,
                  error: msg,
                });
                return;
              }
              try {
                await sleep(
                  Math.min(BACKOFF_BASE_MS * 2 ** retries, BACKOFF_CAP_MS),
                  abort.signal,
                );
              } catch {
                return;
              }
            }
          }
        })();
      }

      // Settles exactly when the loop is over — finished, errored out, or
      // stopped. The map entry alone can't tell (finished loops stay in the
      // map until stop()), and isRunning() needs the distinction. Two-arg
      // then, not finally: finally() forks a new chain that re-throws done's
      // rejection unhandled (stop()'s own `done.catch` doesn't cover it).
      let settled = false;
      void done.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      const handle: Handle & { active(): boolean; syncing(): boolean } = {
        get status() {
          return status;
        },
        active: () => !settled,
        syncing: () =>
          !settled &&
          backfillCommitted &&
          status !== 'error' &&
          status !== 'paused' &&
          status !== 'needsReauth',
        async stats() {
          const account2 = await store.account(account.id);
          const done2 = account2?.progress?.done ?? 0;
          return {
            pending: 0,
            done: done2,
            skipped: 0,
            failed: 0,
            deferred: 0,
          };
        },
        async stop() {
          abort.abort();
          status = 'paused';
          await done.catch(() => {});
          // A re-run replaces the map entry with its own handle BEFORE
          // awaiting prev.stop() — deleting unconditionally here would
          // remove the REPLACEMENT's entry, orphaning its loop: nothing
          // could stop it, and the next re-run would find no prev and start
          // a second concurrent loop (two live sockets for socket-holding
          // sources like WhatsApp — a session conflict).
          if (running.get(key) === handle) running.delete(key);
        },
      };
      running.set(key, handle);
      return handle;
    },

    async reconnect(
      accountId: AccountId,
      auth: AuthChannel,
      signal?: AbortSignal,
    ): Promise<void> {
      const account = await store.account(accountId);
      if (!account) throw new Error(`unknown account: ${accountId}`);
      const source = deps.sources.get(account.source);
      if (!source) throw new Error(`unknown source: ${account.source}`);
      if (!source.reauthenticate)
        throw new Error(
          `${account.source} cannot be reconnected — remove this source and add it again`,
        );
      // Same capture wrapper as connect(): the source never stores a blob.
      // The ordering is the whole guarantee — a reauthenticate() that throws
      // (identity mismatch, abandoned browser) leaves `captured` unused, so
      // NOTHING below runs and the account keeps its old credentials, its
      // status and its lastError.
      let captured: Credentials | null = null;
      const wrapped: AuthChannel = {
        async oauth(scopes) {
          captured = await auth.oauth(scopes);
          return captured;
        },
        showQr: (qr) => auth.showQr(qr),
        async prompt(schema) {
          const answers = await auth.prompt(schema);
          if (typeof answers.password === 'string')
            captured = { ...(captured ?? {}), password: answers.password };
          return answers;
        },
        status: (msg) => auth.status(msg),
        pickFolders: () => {
          throw new Error('reconnect must not change folder scope');
        },
      };

      // ── PRE-COMMIT PHASE (C-28.3). Fully cancellable; writes nothing. ──
      // Everything up to and including the check below can be abandoned for
      // free: no vault write, no status write, no stopped loop. A cancel here
      // throws and the account is exactly as it was.
      await source.reauthenticate(account, wrapped);
      if (signal?.aborted) throw new Error('reconnect cancelled');

      // ── POINT OF NO RETURN (C-28.3) ──
      // From the line below, `signal` is deliberately NOT consulted again, and
      // that is the fix, not an oversight. The old code checked it exactly
      // once, here, and then did three more awaited things — stop(),
      // vault.save(), the status write. A cancel landing inside those left an
      // account that was stopped, re-credentialled and half-committed while
      // the UI said "cancelled", with nobody scheduled to restart it. There
      // are only two coherent answers to a cancel in that window: undo
      // everything (impossible — the sign-in cannot be un-signed and the old
      // token may already be revoked at the provider), or finish. So this
      // finishes, and the broker's rule is the mirror image: **if
      // engine.reconnect RESOLVES, it committed, and the caller restarts the
      // account regardless of `flow.cancelled`.** The worst case is a UI that
      // says "cancelled" over an account that is healthy and syncing.
      transitionIntents.add(accountId);
      abortEvidenceReads(accountId);
      let wasRunning = false;
      try {
        // Quiesce only NOW. Stopping before the (minutes-long) sign-in would
        // leave a healthy account with no loop for the whole window. abort
        // alone is cooperative (one more batch commit can still land), so this
        // awaits stop(), which awaits the loop AND its reconcile pass. Keyed
        // by ACCOUNT, so a sibling account of the same provider keeps running.
        // The transition intent above is what stops a cadence tick or a
        // sync-now from installing a replacement loop in this window (C-28.1).
        wasRunning = await stopForTransition(accountId);
        // ORDER IS LOAD-BEARING (C-28.3). Credentials first: these two are
        // separate durable writes with no transaction spanning them, so one of
        // the two partial states is going to be reachable, and this picks the
        // harmless one. Credentials-written-but-status-not leaves an account
        // that still reads `needsReauth`/`error`, still offers Reconnect, and
        // whose stored token is strictly newer than the one it replaced —
        // pressing Reconnect again fixes it, and nothing was lost. The reverse
        // order leaves an account that reads healthy while holding a revoked
        // token, so it starts pulling and 401s its way back to needsReauth,
        // having hammered the provider first.
        if (captured) await store.vault.save(accountId, captured);
        // C-28.6: setAccountStatus, NOT store.commit. Every commit stamps
        // `last_sync_at = ?` unconditionally (write-tx.ts:423-431), so the
        // empty status-only commit this used to be made a reconnect render in
        // the UI as a completed sync that never fetched a page. This verb
        // writes `status` + `last_error` and nothing else — and note there is
        // no cursor write at all now: reconnect's invariant 2 is that the
        // cursor does not change, and the safest way to not change a value is
        // to not write it.
        await store.setAccountStatus(accountId, {
          status: 'connecting',
          error: null,
        });
      } catch (err) {
        // C-28.4. The account was quiesced by THIS flow and the caller only
        // restarts on success, so without this it stays stopped — for a
        // source with no `descriptor.cadence`, until the app restarts.
        transitionIntents.delete(accountId);
        await restoreLoopAfterFailure(accountId, wasRunning);
        throw err;
      } finally {
        transitionIntents.delete(accountId);
      }
      logs.log(
        `source:${account.source}`,
        'info',
        `reconnected ${account.identifier}`,
      );
    },

    async applyScope(
      accountId: AccountId,
      update: FolderScopeUpdate,
      expectedConfigJson: string,
    ): Promise<{ archived: number }> {
      const roots = update.config.folderRoots;
      if (!Array.isArray(roots) || roots.length === 0)
        throw new FolderScopeConfigError(
          'a folder-scoped account must keep at least one root — remove the source to stop tracking it entirely',
        );
      // **C-27 / C-34 — archiveNullScoped is refused, always, in this train,
      // and the refusal is STRUCTURAL. READ THIS BEFORE EDITING THE
      // `store.applyFolderScope({…})` CALL BELOW.**
      //
      // C-27 made the v3 migration attribution-only: a cloud row it could not
      // attribute stays LIVE with `scope_root_id` NULL rather than being
      // archived, because a frozen `metadata.root_folder_id` is stale data,
      // not evidence of being out of scope. That ruling only holds if nothing
      // downstream archives those same rows — and this flag does exactly that.
      // C-27 made it conditional on proving that a completed re-walk
      // re-stamps in-scope rows. It does not: both cloud connectors'
      // `hashSkip` is QUERY-first, not cursor-driven, and returns true (emit
      // nothing) for any existing, non-archived, `extraction_status:'ok'` row
      // whose hash is unchanged — google-docs `src/source.ts:463-488`,
      // onedrive `src/source.ts:293-300` — so resetting the cursor to force a
      // full re-walk does not defeat it and the row is never re-stamped.
      // Honouring the flag would therefore archive precisely the documents
      // the migration was forbidden to touch, with no in-app recovery, on
      // BOTH cloud sources at once. For OneDrive it is permanent: it has no
      // reconcile() at all (`source.ts:62`).
      //
      // So the call below does not pass the field — not even as `false`.
      // C-34 removed `archiveNullScoped` from CoreStore.applyFolderScope's
      // INPUT TYPE, which is what turns this from a convention into a
      // guarantee: re-adding `archiveNullScoped: update.archiveNullScoped ===
      // true` to that object literal does not compile. TS 5.8.2 reports
      //   error TS2353: Object literal may only specify known properties, and
      //   'archiveNullScoped' does not exist in type '…'
      // so `npm run typecheck` and every ts-jest suite importing the engine
      // refuse it. Do not "simplify" it back; if you believe the flag should
      // be honoured, the change starts in the STORE (Task 3) with an
      // archive-AFTER-proof predicate shaped like reconcile's (`seq <= ?` AND
      // `NOT EXISTS (… reconcile_listing …)`, write-tx.ts:512-538) plus a
      // listing pass for OneDrive, which has none — and it must be gated on
      // evidence from a connector, not on the flag's existence.
      //
      // A source may still ASK (A-3 gives it the field, and both connectors
      // set it). That is worth recording, so the ask is logged once per Save.
      // Logged, not thrown: the rest of the update — the roots the source
      // named in `archiveScopeRootIds` — is safe and is what the user actually
      // clicked Save for. Throwing would cost them the folder edit as well.
      if (update.archiveNullScoped === true)
        logs.log('folder-scope', 'warn', 'archiveNullScoped refused (C-27)', {
          accountId,
        });
      // From here to the `finally`, this account is IN TRANSITION: run() will
      // refuse to start a loop for it and updateConfig will refuse to write
      // its config (C-28.1). Declared BEFORE the stop, like pause()'s intent,
      // because the window that needs covering opens the moment the loop goes
      // away — `running.has(key)` stays true for most of stop(), so every
      // stale-read supervisor in the app would happily start a replacement.
      transitionIntents.add(accountId);
      abortEvidenceReads(accountId);
      let wasRunning = false;
      try {
        // Quiesce. abort() alone is cooperative — store.commit is a DB-worker
        // RPC that completes — so only awaiting stop() (which awaits the pull
        // loop AND its concurrent reconcile pass) gives a point where nothing
        // else can write this account. Refusing an empty scope ABOVE the
        // intent keeps a rejected update from costing the account its loop.
        wasRunning = await stopForTransition(accountId);
        const res = await store.applyFolderScope({
          accountId,
          config: update.config,
          cursor: update.cursor,
          // Forwarded, never derived (R8/A-1).
          archiveScopeRootIds: update.archiveScopeRootIds,
          // C-46/D5, forwarded the same way. Optional on the wire (a
          // pre-1.2.0 connector simply has none), required in the store's
          // input, so the coercion happens exactly here — the store never
          // guesses, and the engine never derives containment.
          reattributeScopeRoots: update.reattributeScopeRoots ?? [],
          // §5.1, coerced the same way.
          archiveRefs: update.archiveRefs ?? [],
          // NOTE the absence of `archiveNullScoped` — C-34, see the block
          // above. The store's input type has no such property in this train,
          // so adding it back here is a compile error, by design.
          //
          // C-28.2: the CALLER's picker-open snapshot, straight through. No
          // re-read here, ever. There is deliberately no `store.account()`
          // call before the transaction at all — an unknown account is
          // reported by `applyFolderScope` itself
          // (`applyFolderScope: unknown account <id>`), and removing the read
          // removes the temptation to feed it back in as the baseline.
          expectedConfigJson,
        });
        if (res.stale) throw new FolderScopeStaleError();
        // The scope just NARROWED: the next reconcile pass may legitimately
        // exceed the mass-archive breaker (a removed root is exactly the case
        // the allowance exists for).
        //
        // **C-35 — but ONLY if this Save actually archived something.** The
        // allowance is not a relaxation of the ≥100/≥50% ratio; ONE
        // `if (allowance !== 'full')` wraps BOTH refusals in `reconcilePass`
        // (engine.ts:284-313), the zero-false-positive "the listing came back
        // empty" arm included — the arm whose own comment says an empty
        // listing over a non-empty corpus is "always a broken listing … never
        // normal churn". A pure WIDENING Save (the user added a folder and
        // removed none) archives nothing, so it has no mass-archive to
        // authorise; granting one anyway would disarm the empty-listing guard
        // for one pass, and the next reconcile could archive an entire corpus
        // off a listing that failed. `res.archived` is the store's own count
        // from the transaction that just committed, so this reads the outcome
        // rather than guessing at it from `archiveScopeRootIds` (which is an
        // intent, and is legitimately non-empty with nothing matching it).
        //
        // §5.6: a Save that archived nothing may still earn a `ratio`
        // allowance — a FIRST declaration (a legacy account's prior
        // enumeration was wider than any declared set) or an UNCHANGED
        // re-save (the user's escape hatch from a ratio refusal). A changed
        // set that archived nothing earns none, as above.
        const priorIds = declaredScopeIds(
          JSON.parse(expectedConfigJson) as Record<string, unknown>,
        );
        const nextIds = update.config.folderRoots.map((r) => r.id);
        const sameSet =
          priorIds !== null &&
          priorIds.length === nextIds.length &&
          priorIds.every((id) => nextIds.includes(id));
        if (res.archived > 0) grantAllowance(accountId, 'full');
        else if (priorIds === null || sameSet)
          grantAllowance(accountId, 'ratio');
        const after = await store.account(accountId);
        // Restart unconditionally EXCEPT the two resting states. Deliberately
        // NOT gated on `running.has` the way updateConfig is: stop() above
        // deleted this account's map entry, so that read is always false here
        // — and a scope change is an explicit user action whose added roots
        // must backfill now, not at the next cadence tick. run() re-checks
        // pauseIntents itself, so a pause landing in this window still wins.
        //
        // The intent is released on the line BEFORE the restart and there is
        // no `await` between them: run() consults `transitionIntents`, so
        // holding it here would refuse our own restart, and releasing it an
        // await earlier would reopen the window for somebody else's.
        // JavaScript is single-threaded — two adjacent synchronous statements
        // cannot be interleaved.
        transitionIntents.delete(accountId);
        if (
          after &&
          after.status !== 'paused' &&
          after.status !== 'needsReauth'
        )
          engine.run(after);
        return { archived: res.archived };
      } catch (err) {
        // C-28.4 / C-29. The account was quiesced by THIS call; if the write
        // failed — stale CAS, or a DB worker that committed and then died
        // before its reply — nobody else is going to start it again. Re-reads
        // durable state, so a partially-applied transition restarts against
        // what actually landed.
        transitionIntents.delete(accountId);
        await restoreLoopAfterFailure(accountId, wasRunning);
        throw err;
      } finally {
        transitionIntents.delete(accountId);
      }
    },

    session(account: Account, signal: AbortSignal, scope: string): Session {
      return makeSession(account, signal, scope);
    },

    claimAccountFlow(accountId: AccountId, flowId: string): void {
      const held = activeByAccount.get(accountId);
      if (held !== undefined && held !== flowId)
        throw new AccountFlowBusyError(held);
      activeByAccount.set(accountId, flowId);
    },

    releaseAccountFlow(accountId: AccountId, flowId: string): void {
      if (activeByAccount.get(accountId) === flowId)
        activeByAccount.delete(accountId);
    },

    syncing(): boolean {
      for (const [key, h] of running) {
        if (key.startsWith('account:') && h.syncing?.() === true) return true;
      }
      return false;
    },

    isRunning(accountId: AccountId): boolean {
      return running.get(`account:${accountId}`)?.active() ?? false;
    },

    async remove(accountId: AccountId): Promise<void> {
      abortEvidenceReads(accountId);
      await running.get(`account:${accountId}`)?.stop();
      reconcileAllowances.delete(accountId);
      await store.commit({ removeAccount: accountId });
      logs.log('engine', 'info', `account ${accountId} removed`);
    },

    async pause(accountId: AccountId): Promise<void> {
      // Declare the intent BEFORE stopping: from here until the 'paused'
      // commit lands, run() refuses to start this account, so the cadence
      // tick's supervisor (isRunning=false + still-stale status) and
      // sync-now can't resurrect the loop inside that window.
      pauseIntents.add(accountId);
      abortEvidenceReads(accountId);
      try {
        // Stop the in-flight loop FIRST. A status-only 'paused' commit while
        // the pull loop is still producing batches gets steamrolled: the
        // loop's next commit flips status back to 'backfilling' (and, once
        // the stream ends, 'live'), so the account silently resumes. stop()
        // aborts the loop and awaits its teardown; optional chaining makes
        // it a no-op for an idle account, preserving the plain status-only
        // pause in that case.
        await running.get(`account:${accountId}`)?.stop();
        // Read the cursor AFTER stop(): the abort window can let one final
        // batch land and advance the cursor, so a value read before stop()
        // would be stale — persisting it would re-pull that range on resume.
        const account = await store.account(accountId);
        if (!account) return;
        await store.commit({
          account: accountId,
          documents: [],
          cursor: account.cursor,
          status: 'paused',
        });
      } finally {
        // Clear even when the commit throws: a stuck intent would silently
        // brick the account (nothing could ever start it) with no committed
        // state explaining why. Failing open matches the committed status —
        // if 'paused' never landed, the supervisor restarting the loop is
        // consistent with what the store says.
        pauseIntents.delete(accountId);
      }
    },

    async resume(accountId: AccountId): Promise<Account | null> {
      // The mirror of pause(): drop any in-flight pause intent FIRST so
      // run() stops refusing this account, then commit 'connecting' so the
      // loop-entry status recheck passes. Only an explicit user resume walks
      // this path — the cadence tick and sync-now never flip a 'paused'
      // status.
      pauseIntents.delete(accountId);
      const account = await store.account(accountId);
      if (!account) return null;
      await store.commit({
        account: accountId,
        documents: [],
        cursor: account.cursor,
        status: 'connecting',
      });
      return { ...account, status: 'connecting' };
    },

    async updateConfig(
      accountId: AccountId,
      config: Record<string, unknown>,
    ): Promise<void> {
      // Folder scope NEVER moves through this door. applyScope is the only
      // path that stops the loop, transforms the cursor and archives the
      // source-named roots in one transaction; this one persists config
      // BEFORE the restart's prev.stop(), so the old loop keeps pulling under
      // the new config and its next commit rewrites the cursor.
      //
      // Two ways this channel could corrupt scope, and each gets its own
      // answer: a payload that CARRIES folderRoots is refused loudly; a
      // payload that OMITS it on a scoped account is silently completed,
      // because setAccountConfig overwrites the whole column and the
      // omission would otherwise delete the account's roots — while
      // accounts:update-config stays a legitimate escape hatch for
      // non-folder keys (cadence overrides, outbound settings).
      //
      // **C-28.1 — and this account must not be in the middle of a transition
      // either.** Checked FIRST, before the payload is even looked at: the two
      // sets below are the only places in the engine that know an account is
      // contended, and neither is visible to the config CAS (an ordinary pull
      // commit does not touch config, so nothing downstream expects config to
      // be contended). `activeByAccount` covers a broker flow that owns the
      // account — including the minutes a picker modal is open —
      // `transitionIntents` the sub-second stop→write→restart window inside
      // applyScope/reconnect. Refusing costs the user a retry; not refusing
      // costs them either a bogus "this account changed while the folder
      // picker was open" on a Save they did make, or (before C-28.2 threaded
      // the snapshot) the silent loss of the config write itself.
      const heldBy = activeByAccount.get(accountId);
      if (heldBy !== undefined) throw new AccountFlowBusyError(heldBy);
      if (transitionIntents.has(accountId))
        throw new AccountFlowBusyError('account-transition');
      if (Object.prototype.hasOwnProperty.call(config, 'folderRoots'))
        throw new FolderScopeConfigError(
          'folderRoots cannot be written through accounts:update-config — use accounts:start-manage-folders',
        );
      const existing = await store.account(accountId);
      const next =
        existing &&
        Object.prototype.hasOwnProperty.call(existing.config, 'folderRoots')
          ? { ...config, ...pickScopeKeys(existing.config) }
          : config;
      await store.setAccountConfig(accountId, next);
      // The config just changed — the next reconcile pass may legitimately
      // mass-archive (e.g. a root removed from a local-folder account), so
      // grant it a one-shot pass through the breaker. Also the user's
      // documented escape hatch: re-saving settings applies a refused
      // cleanup.
      //
      // PRE-EXISTING LINE, deliberately left unconditional — do not "fix" it
      // to match applyScope's C-35 guard above. `updateConfig` never archives
      // anything itself, so an `archived > 0` condition here would be
      // permanently false and would delete the escape hatch that
      // reconcilePass's own refusal message advertises ("If this shrinkage is
      // real, re-save the account's settings to apply the cleanup",
      // engine.ts:287-290). C-35 is about applyScope, where the outcome IS
      // knowable: an explicit Save that archived nothing has no mass-archive
      // to authorise.
      grantAllowance(accountId, 'full');
      // Only restart a loop that's actually running — a never-started account
      // just gets its config persisted for the next run(). And a running-map
      // entry alone isn't enough: pause and needsReauth are status-only resting
      // states that leave a finished handle in the map, so restarting on them
      // would silently resume an explicitly paused account or re-hammer a
      // revoked credential (mirror the status gates in boot's cadence job and
      // resumeAccounts).
      if (!running.has(`account:${accountId}`)) return;
      const fresh = await store.account(accountId);
      if (fresh && fresh.status !== 'paused' && fresh.status !== 'needsReauth')
        engine.run(fresh);
    },

    attach(worker: Worker): Handle {
      const consumer = workerConsumerName(worker);
      const abort = new AbortController();
      let stopped = false;

      // The feed loop is an INFINITE consumer: one uncaught store rejection
      // would otherwise settle `done` and silently halt background processing
      // until app restart. The consumer cursor is durable and delivery is
      // at-least-once, so a DB-worker crash (coded transient by the worker
      // supervisor) is survivable by construction: back off and resume from
      // the committed cursor. Anything else — including DB_WORKER_DEAD after
      // the supervisor gave up — still stops the loop, as before.
      const done = (async () => {
        let retries = 0;
        for (;;) {
          try {
            // #59 §3a: a consumer with no row, a half-done seed, or a cursor
            // below the pruned floor is seeded from `documents` first.
            if (!(await seedConsumer(worker, consumer, abort.signal))) return;
            const start = await store.consumerCursor(consumer);
            for await (const changes of abortable(
              store.feed(start),
              abort.signal,
            )) {
              if (abort.signal.aborted) return;
              let emitted: DocumentInput[] = [];
              let enrich: EnrichInput[] = [];
              let clear: string[] = [];
              let staged = 0;
              // One doc, one work() per batch: the feed materializes every
              // change row as the doc's CURRENT row, so a replay hands the
              // worker identical copies. Working each would repeat the cost
              // and trip session.bump fences without any crash.
              const seen = new Set<string>();
              const batchStart: Seq = await store.consumerCursor(consumer);
              let cursor: Seq = batchStart;
              // Docs whose work() RETURNED in this batch. A stop drops the
              // batch (re-worked next start), but none of them crashed the
              // process: clear their session.bump counters so a quit is
              // never counted as a parser crash. The cursor stays put.
              const worked: string[] = [];
              const dropBatch = () =>
                worked.length
                  ? store
                      .commit({
                        consumer,
                        cursor: batchStart,
                        clearAttempts: worked,
                      })
                      .catch(() => {})
                  : undefined;
              /** One bounded consumer write (#147 §4), always an admitted
               *  `convert` unit — acquired right before the commit, released
               *  right after it — including the batch's final commit when it
               *  carries only the cursor (spec §4: every flush is admitted).
               *  `cursorAfter` only on that final commit: an intermediate
               *  flush leaves consumers.cursor untouched (CommitBatch
               *  contract). */
              const flush = async (cursorAfter?: Seq): Promise<void> => {
                const hasOutput =
                  emitted.length > 0 || enrich.length > 0 || clear.length > 0;
                if (!hasOutput && cursorAfter === undefined) return;
                let release: () => void;
                try {
                  release = await admission.acquire('convert', abort.signal);
                } catch (err) {
                  if (abort.signal.aborted) await dropBatch();
                  throw err;
                }
                try {
                  await store.commit({
                    consumer,
                    ...(cursorAfter !== undefined
                      ? { cursor: cursorAfter }
                      : {}),
                    documents: emitted.length ? emitted : undefined,
                    enrich: enrich.length ? enrich : undefined,
                    clearAttempts: clear.length ? clear : undefined,
                  });
                } finally {
                  release();
                }
                emitted = [];
                enrich = [];
                clear = [];
                staged = 0;
              };
              for (const change of changes) {
                if (abort.signal.aborted) {
                  await dropBatch();
                  return;
                }
                // A matcher throw is a worker bug over untrusted connector
                // metadata, not a store failure — contained here so one
                // poisoned document can't stop the loop permanently (the
                // commit below still advances the cursor past it).
                let matched = false;
                try {
                  matched = worker.matches(change);
                } catch (err) {
                  logs.log(
                    `worker:${worker.name}`,
                    'warn',
                    `matches() threw on seq ${change.seq} — treated as non-match: ${String(err)}`,
                  );
                }
                // Only MATCHED document changes enter `seen`; non-matching,
                // account and purge changes keep their path untouched.
                if (matched && change.kind === 'document') {
                  if (seen.has(change.document.id)) {
                    cursor = change.seq;
                    continue;
                  }
                  seen.add(change.document.id);
                }
                if (matched) {
                  const r = await workOne(
                    worker,
                    change,
                    abort.signal,
                    'convert',
                  );
                  if (change.kind === 'document')
                    worked.push(change.document.id);
                  await store.ledgerRecord(
                    consumer,
                    change.seq,
                    r.attempts,
                    r.outcome,
                  );
                  emitted = emitted.concat(r.docs);
                  enrich = enrich.concat(r.enrich);
                  if (r.outcome === 'done' && change.kind === 'document')
                    clear.push(change.document.id);
                  staged +=
                    r.docs.reduce((n, d) => n + textBytes(d), 0) +
                    r.enrich.reduce((n, e) => n + textBytes(e), 0);
                  if (staged >= SUB_COMMIT_BYTES) await flush();
                }
                cursor = change.seq;
              }
              await flush(cursor);
              retries = 0; // durable progress — a later crash starts fresh
            }
            return; // feed ended: only abortable() exhausting on abort
          } catch (err) {
            if (abort.signal.aborted) return;
            if (!isDbWorkerTransientError(err) || retries >= FEED_RETRY_MAX) {
              logs.log(
                `worker:${worker.name}`,
                'error',
                `stopped: ${String(err)}`,
              );
              return;
            }
            retries += 1;
            logs.log(
              `worker:${worker.name}`,
              'warn',
              `feed interrupted by a DB worker crash — resuming (${retries}/${FEED_RETRY_MAX}): ${String(err)}`,
            );
            try {
              await sleep(
                Math.min(BACKOFF_BASE_MS * 2 ** (retries - 1), BACKOFF_CAP_MS),
                abort.signal,
              );
            } catch {
              return; // stopped while backing off
            }
          }
        }
      })();

      // Worker keys never reach isRunning() (it prefixes 'account:'), but the
      // shared running map's shape asks every entry to answer active().
      // Two-arg then, not finally — see the account-loop twin above.
      let settled = false;
      void done.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      const handle: Handle & { active(): boolean } = {
        active: () => !settled,
        get status() {
          return stopped ? ('paused' as SyncStatus) : ('live' as SyncStatus);
        },
        async stats() {
          const c = await store.ledgerCounts(consumer);
          const pending = Math.max(
            0,
            (await store.headSeq()) - (await store.consumerCursor(consumer)),
          );
          return {
            pending,
            done: c.done,
            skipped: c.skip,
            failed: c.failed,
            deferred: c.deferred,
          };
        },
        async stop() {
          stopped = true;
          abort.abort();
          await done.catch(() => {});
          running.delete(consumer);
          attachedWorkers.delete(consumer);
        },
      };
      running.set(consumer, handle);
      attachedWorkers.add(consumer);
      return handle;
    },

    activeConsumers(): string[] {
      return [...attachedWorkers];
    },

    async rerunDeferred(worker: Worker): Promise<RedriveResult> {
      if (stopping) return undefined;
      // #59 §0: until every deferred row is keyed on its document's current
      // seq, a re-drive could resolve a stale seq to nothing and skip it for
      // good, or race the repair. No-op — before any probe, admission or
      // materialisation; the repair's completion wakes us.
      if (!(await store.ledgerRekeyed())) return { skipped: 'rekey-pending' };
      // The gate awaited the store: stopAll() may have begun meanwhile.
      if (stopping) return undefined;
      const consumer = workerConsumerName(worker);
      const abort = new AbortController();
      let finished!: () => void;
      const entry = {
        abort,
        done: new Promise<void>((r) => {
          finished = r;
        }),
      };
      activeRedrives.add(entry);
      try {
        // Keyset paging over the backlog, NOT a snapshot of it.
        //
        // This loop used to read every deferred seq at once and hand the whole
        // list to changesAt(), which materializes one full Document per entry.
        // A vision backlog of 2,136,099 deferred entries made that array ~2 GB
        // of live main heap, held for the entire loop — the app went from 6% to
        // 93% heap at the first 30m re-drive tick and died there. Both the seq
        // list and the materialized page are now bounded by REDRIVE_PAGE, so
        // peak footprint is a function of the page size and never of the
        // backlog size.
        //
        // `after` advances monotonically, which is also what terminates the
        // loop: an entry that defers AGAIN stays 'deferred' but sits below the
        // watermark, so this run will not re-select it and spin forever. It is
        // simply picked up by the next scheduled re-drive.
        let after: Seq = 0;
        for (;;) {
          if (abort.signal.aborted) return undefined; // between pages
          // eslint-disable-next-line no-await-in-loop
          const seqs = await store.ledgerDeferred(
            consumer,
            after,
            REDRIVE_PAGE,
          );
          if (seqs.length === 0) return undefined;
          after = seqs[seqs.length - 1];
          // eslint-disable-next-line no-await-in-loop
          const changes = await store.changesAt(seqs);
          // #59 §0: a deferred seq no document carries any more resolves to
          // nothing. With the repair done that only means the document was
          // purged (or changed and was fed again under its new seq): resolve
          // the row terminally so it stops being re-selected forever.
          const resolved = new Set(changes.map((c) => c.seq));
          const unresolved: LedgerEntry[] = seqs
            .filter((s) => !resolved.has(s))
            .map((s) => ({ seq: s, attempts: 0, outcome: 'skip' }));

          let emitted: DocumentInput[] = [];
          let enrich: EnrichInput[] = [];
          const ledger: LedgerEntry[] = [...unresolved];
          let clear: string[] = [];
          let staged = 0;
          /** Re-drive output, one admitted `redrive` unit per flush. NEVER a
           *  cursor: re-drive has none of its own, and writing the consumer's
           *  could rewind a live tail that advanced meanwhile (#147 §4). */
          const flush = async (): Promise<void> => {
            if (!emitted.length && !enrich.length && !clear.length) return;
            const release = await admission.acquire('redrive', abort.signal);
            try {
              await store.commit({
                consumer,
                documents: emitted.length ? emitted : undefined,
                enrich: enrich.length ? enrich : undefined,
                clearAttempts: clear.length ? clear : undefined,
              });
            } finally {
              release();
            }
            emitted = [];
            enrich = [];
            clear = [];
            staged = 0;
          };
          // Same per-batch coalescing as the live tail: changesAt materializes
          // the CURRENT doc for every seq, so a doc with several deferred rows
          // is worked once; its duplicates resolve like a skip.
          const seen = new Set<string>();
          for (const change of changes) {
            if (abort.signal.aborted) return undefined; // between changes
            // changesAt materializes the CURRENT document, so a doc that gained
            // real markdown between defer and re-drive no longer matches, and an
            // ARCHIVED doc stops matching too (both bundled classifiers return
            // 'skip' on archivedAt). Re-check matches() — running workOne anyway
            // would re-OCR and OVERWRITE that fresh content. A non-matching
            // deferred change no longer needs this worker at all, so resolve its
            // ledger entry terminally ('skip', mirroring how a 'done' outcome
            // clears the 'deferred' row via the upsert) instead of re-selecting
            // it every cadence.
            if (!worker.matches(change)) {
              ledger.push({ seq: change.seq, attempts: 0, outcome: 'skip' });
              continue;
            }
            if (change.kind === 'document') {
              if (seen.has(change.document.id)) {
                ledger.push({ seq: change.seq, attempts: 0, outcome: 'skip' });
                continue;
              }
              seen.add(change.document.id);
            }
            // eslint-disable-next-line no-await-in-loop
            const r = await workOne(worker, change, abort.signal, 'redrive');
            emitted.push(...r.docs);
            enrich.push(...r.enrich);
            if (r.outcome === 'done' && change.kind === 'document')
              clear.push(change.document.id);
            ledger.push({
              seq: change.seq,
              attempts: r.attempts,
              outcome: r.outcome,
            });
            staged +=
              r.docs.reduce((n, d) => n + textBytes(d), 0) +
              r.enrich.reduce((n, e) => n + textBytes(e), 0);
            // eslint-disable-next-line no-await-in-loop
            if (staged >= SUB_COMMIT_BYTES) await flush();
          }

          // Commit per page rather than accumulating across the whole backlog:
          // the old cross-loop `concat` accumulators grew without bound (and
          // reallocated on every iteration).
          // eslint-disable-next-line no-await-in-loop
          await flush();
          if (abort.signal.aborted) return undefined; // before the ledger write
          // Only now resolve the page's ledger entries — its skips and worked
          // outcomes in ONE statement (one round trip per entry was 2.1M of
          // them through the DB worker bridge). The re-drive has no cursor: the
          // ledger row is its only driver, so writing 'done' before the commit
          // lost the output of any entry a quit or crash caught in between.
          // A crash between the commit and this write leaves the entries
          // 'deferred' and the next re-drive re-works them: at-least-once, by
          // design. A workOne throw (abort) mid-page records nothing either.
          if (ledger.length) {
            // eslint-disable-next-line no-await-in-loop
            await store.ledgerRecordMany(consumer, ledger);
          }
        }
      } catch (err) {
        // Stopped mid-page: nothing of this page was recorded in the ledger,
        // so its entries stay 'deferred' for the next run.
        if (abort.signal.aborted) return undefined;
        throw err;
      } finally {
        activeRedrives.delete(entry);
        finished();
      }
    },

    project<S>(
      projection: Projection<S>,
      onDiff: (state: S, seq: Seq) => void,
    ): Handle {
      const abort = new AbortController();
      let stopped = false;
      // Same retry shell as attach's feed loop: this projection is the
      // renderer's ONE live-state channel (main.ts wires push:app-state
      // through it), so a single DB-worker crash mid-read must not freeze the
      // UI until app restart. On a coded-transient store error the projection
      // re-inits from current state — init() reads CURRENT rows, so replays
      // are safe by the same argument as the mid-init note below.
      const done = (async () => {
        const { read } = store;
        // The whole body (init + the first async headSeq/onDiff, now that
        // store reads are worker RPCs, and the feed loop) sits in one try, so
        // a store rejection anywhere — including a worker death during boot,
        // before the feed's first await — is logged and settles `done` rather
        // than escaping as an unhandled rejection. Matches the run/attach twins'
        // guarantee that `done` never rejects.
        let retries = 0;
        for (;;) {
          try {
            const state0 = (await projection.init(read)) as S;
            // Head captured after init: a change landing mid-init may be applied
            // twice; apply() must tolerate replays (upserts by id do).
            let seq = await store.headSeq();
            let state: S = state0;
            onDiff(state, seq);
            for await (const changes of abortable(
              // #59 §0: a projection writes no ledger, and app-projection
              // counts a document's insert row (seq === ingestSeq) even when
              // the reader only reaches it after a later update.
              store.feed(seq, { everySeq: true }),
              abort.signal,
            )) {
              if (abort.signal.aborted) return;
              state = projection.apply(state, changes);
              seq = changes[changes.length - 1].seq;
              onDiff(state, seq);
              retries = 0;
            }
            return;
          } catch (err) {
            if (abort.signal.aborted) return;
            if (!isDbWorkerTransientError(err) || retries >= FEED_RETRY_MAX) {
              logs.log('engine', 'error', `projection stopped: ${String(err)}`);
              return;
            }
            retries += 1;
            logs.log(
              'engine',
              'warn',
              `projection interrupted by a DB worker crash — re-initializing (${retries}/${FEED_RETRY_MAX}): ${String(err)}`,
            );
            try {
              await sleep(
                Math.min(BACKOFF_BASE_MS * 2 ** (retries - 1), BACKOFF_CAP_MS),
                abort.signal,
              );
            } catch {
              return; // stopped while backing off
            }
          }
        }
      })();

      const handle: Handle = {
        get status() {
          return stopped ? ('paused' as SyncStatus) : ('live' as SyncStatus);
        },
        async stats() {
          return { pending: 0, done: 0, skipped: 0, failed: 0, deferred: 0 };
        },
        async stop() {
          stopped = true;
          abort.abort();
          await done.catch(() => {});
        },
      };
      return handle;
    },

    async stopAll(): Promise<void> {
      stopping = true; // first: no re-drive may register from here on
      abortEvidenceReads();
      const redrives = [...activeRedrives];
      for (const r of redrives) r.abort.abort();
      await Promise.all([
        ...[...running.values()].map((h) => h.stop().catch(() => {})),
        ...redrives.map((r) => r.done),
      ]);
    },
  };

  return engine;
}
