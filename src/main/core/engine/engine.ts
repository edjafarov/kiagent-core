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
  Handle,
  Inference,
  LogLevel,
  Projection,
  Seq,
  Session,
  Source,
  SyncStatus,
  Worker,
  WorkerSession,
} from '@shared/contracts';

import { sourceErrorCode } from '@shared/source-errors';

import { isDbWorkerTransientError } from '../../db/worker-client';

import type { CoreStore } from '../store/store';

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
  sources: { get(id: string): Source | undefined };
  inference: Inference;
  /** The commit-path conversion stage: binary in, markdown out. Deterministic
   *  parsers only — text-poor results are left for a vision worker ('defer'). */
  convert(input: DocumentInput): Promise<DocumentInput>;
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
/** How many listing refs reconcile hands the store at a time. This is the ONLY
 *  reconcile structure that ever sits on this thread, so it — not the account —
 *  bounds the pass's memory. A connector may yield pages of any size; they get
 *  re-chunked to this. */
export const RECONCILE_STAGE_BATCH = 10_000;

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
 * MASS_ARCHIVE_RATIO + MASS_ARCHIVE_MIN_DOCS. `allowMassArchive` — granted
 * for the first pass after the account's config changed (root removed from a
 * local-folder account, a re-connect) — bypasses both, which is also the
 * user's escape hatch when the shrinkage is real: re-saving the account's
 * settings applies the pending cleanup on the next cycle.
 *
 * TOCTOU guard: `source.reconcile()` takes its listing snapshot once, up
 * front (e.g. local-folder's `listEntries` walks the whole tree before ever
 * yielding), then this drains it, which can take a while for a large
 * tree/mailbox. Since this runs CONCURRENTLY with `pull()`, a document
 * pull() discovers and commits mid-drain — after reconcile's snapshot was
 * taken but before the `liveRefs()` read below — would look "live but
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
  allowMassArchive: boolean,
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
  } catch (err) {
    await store.reconcileEnd(account.id);
    if (signal.aborted) return; // cancellation-caused — not a real failure
    const msg = String(err instanceof Error ? err.message : err);
    logs.log(scope, 'error', `reconcile failed: ${msg}`);
    const fresh = (await store.account(account.id)) ?? account;
    await store.commit({
      account: account.id,
      documents: [],
      cursor: fresh.cursor,
      error: `reconcile: ${msg}`,
    });
    return;
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
  // `listedCount` comes from the DIFF, never from counting what we staged.
  // Staging lives in a connection-scoped TEMP table, so a DB-worker restart
  // between the drain and the diff silently empties it — and a local tally
  // would still claim the listing was fine, walking straight past the
  // empty-listing guard below into archiving the entire account.
  const { listedCount, liveCount, deletionCount } = await store.reconcileDiff(
    account.id,
    startSeq,
  );
  if (deletionCount === 0) {
    await store.reconcileEnd(account.id);
    return;
  }

  if (!allowMassArchive) {
    const refuse = async (why: string): Promise<void> => {
      await store.reconcileEnd(account.id);
      const msg =
        `reconcile: refusing to archive ${deletionCount} of ` +
        `${liveCount} documents (${why}). If this shrinkage is real, ` +
        `re-save the account's settings to apply the cleanup.`;
      logs.log(scope, 'error', msg);
      const fresh2 = (await store.account(account.id)) ?? account;
      await store.commit({
        account: account.id,
        documents: [],
        cursor: fresh2.cursor,
        error: msg,
      });
    };
    // Zero-false-positive first: an empty listing over a non-empty corpus is
    // always a broken listing or a deliberately emptied config — never
    // normal churn.
    if (listedCount === 0) {
      await refuse('the listing came back empty');
      return;
    }
    if (
      deletionCount > MASS_ARCHIVE_MIN_DOCS &&
      deletionCount > liveCount * MASS_ARCHIVE_RATIO
    ) {
      await refuse('the listing shrank suspiciously');
      return;
    }
  }

  // Archives (and clears the staged listing) inside the store — the ids never
  // come back here either.
  await store.reconcileArchive(account.id, startSeq);
  const fresh = (await store.account(account.id)) ?? account;
  await store.commit({
    account: account.id,
    documents: [],
    cursor: fresh.cursor,
    error: null,
  });
}

/** Derives a worker's ledger consumer key. MUST be derived (never a hard-coded
 *  constant): the engine keys deferred work as `worker:<name>:v<version>`, so
 *  a caller that hard-codes this string desyncs the moment a worker's
 *  `version` bumps — deferred work then accrues under the new key while the
 *  caller keeps querying the old, now-permanently-empty one. */
export const workerConsumerName = (w: Worker): string =>
  `worker:${w.name}:v${w.version}`;

export function createEngine(deps: EngineDeps): Engine & {
  /** Re-drive a worker's deferred changes (scheduler calls this on cadence). */
  rerunDeferred(worker: Worker): Promise<void>;
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
} {
  const { store, logs } = deps;
  const running = new Map<
    string,
    { stop(): Promise<void>; active(): boolean }
  >();
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
  const reconcileAllowances = new Set<AccountId>();

  const makeSession = (
    account: Account,
    signal: AbortSignal,
    scope: string,
  ): Session => ({
    account,
    signal,
    async credentials(): Promise<Credentials | null> {
      const creds = await store.vault.load(account.id);
      if (!creds) return null;
      const refresh = deps.refreshers?.get(account.source);
      const expiringSoon =
        creds.expiresAt !== undefined &&
        Date.parse(creds.expiresAt) < Date.now() + 60_000;
      if (refresh && expiringSoon) {
        try {
          const fresh = await refresh(creds);
          if (fresh) {
            await store.vault.save(account.id, fresh);
            return fresh;
          }
        } catch (err) {
          // An auth-coded refresh failure (revoked grant) must PROPAGATE:
          // returning the stale token would just move the failure to the
          // next API call as an untyped 401 retry-storm. Swallow-and-warn
          // stays correct only for transient failures (network, 5xx), where
          // the stale token may in fact still work.
          if (sourceErrorCode(err) === 'auth') throw err;
          logs.log(scope, 'warn', `token refresh failed: ${String(err)}`);
        }
      }
      return creds;
    },
    log(level, msg) {
      logs.log(scope, level, msg);
    },
  });

  /** Run one change through a worker with bounded retries. Returns emitted docs and enrich batch. */
  const workOne = async (
    worker: Worker,
    change: Change,
    signal: AbortSignal,
  ): Promise<{ docs: DocumentInput[]; enrich: EnrichInput[] }> => {
    const consumer = workerConsumerName(worker);
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
          });
        },
        see(image, prompt, opts) {
          return deps.inference.see(image, prompt, {
            ...opts,
            lane: 'background',
          });
        },
        read(image, opts) {
          return deps.inference.read(image, { ...opts, lane: 'background' });
        },
        hear(audio, opts) {
          return deps.inference.hear(audio, { ...opts, lane: 'background' });
        },
        async fetchBytes(doc: Document) {
          const account = await store.account(doc.accountId);
          if (!account) return null;
          const source = deps.sources.get(account.source);
          if (!source?.fetchBytes) return null;
          return source.fetchBytes(makeSession(account, signal, scope), doc);
        },
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
        await store.ledgerRecord(
          consumer,
          change.seq,
          attempt,
          outcome === 'defer' ? 'deferred' : outcome,
        );
        return { docs: emitted, enrich: enriched };
      } catch (err) {
        if (signal.aborted) throw err;
        logs.log(
          scope,
          'warn',
          `attempt ${attempt}/${maxAttempts} failed at seq ${change.seq}: ${String(err)}`,
        );
        if (attempt === maxAttempts) {
          await store.ledgerRecord(consumer, change.seq, attempt, 'failed');
          // A failed final attempt must not commit its half-finished output.
          // Returning the accumulated emit/enrich would persist a partial
          // document (or clobber an existing one via enrich) under a 'failed'
          // outcome. Drop it: the ledger records the failure, the cursor moves
          // on, and nothing partial lands.
          return { docs: [], enrich: [] };
        }
        await sleep(
          Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS),
          signal,
        );
      }
    }
    // Unreachable unless maxAttempts < 1 (the loop always returns from
    // within on a success, on the final failed attempt, or on abort).
    return { docs: [], enrich: [] };
  };

  const engine = {
    async connect(source: Source, auth: AuthChannel): Promise<Account> {
      // Capture credentials the flow produces so the PLATFORM persists them —
      // the source never stores a blob.
      let captured: Credentials | null = null;
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
        pickFolders: (spec) => auth.pickFolders(spec),
      };
      const { identifier, config } = await source.connect(wrapped);
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
      reconcileAllowances.add(account.id);
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
      if (pauseIntents.has(account.id)) {
        logs.log(
          scope,
          'info',
          `run refused: account ${account.id} is being paused`,
        );
        const refused: Handle & { active(): boolean } = {
          status: 'paused',
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
                progressDone = Math.max(
                  fresh.progress?.done ?? 0,
                  await store.read.count({ account: account.id }),
                );
              }
              if (src.reconcile) {
                reconciling = reconcilePass(
                  src,
                  session,
                  abort.signal,
                  store,
                  fresh,
                  logs,
                  scope,
                  // One-shot: the pass right after a config change may
                  // legitimately mass-archive (root removal, re-scope).
                  reconcileAllowances.delete(account.id),
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
              for await (const batch of abortable(
                src.pull(session, fresh.cursor ?? null),
                abort.signal,
              )) {
                if (abort.signal.aborted) {
                  await reconciling;
                  return;
                }
                const documents: DocumentInput[] = [];
                for (const item of batch.items) {
                  const out = src.toDocument(item);
                  if (!out) continue;
                  const inputs = Array.isArray(out) ? out : [out];
                  for (const input of inputs) {
                    documents.push(await deps.convert(input));
                  }
                  // Real event-loop turn between items: converters parse
                  // PDFs/spreadsheets in-process (CPU-bound), and awaits on
                  // already-settled promises never leave the microtask
                  // queue — without this hop a backfill starves IPC (the
                  // whole UI) and every other account's loop until the
                  // batch ends. (Imported from timers/promises: jsdom-based
                  // tests have no setImmediate global.)
                  await nextEventLoopTurn();
                }
                status = batch.phase === 'backfill' ? 'backfilling' : 'live';
                if (batch.estimateTotal !== undefined) {
                  progressDone += batch.items.length;
                }
                await store.commit({
                  account: account.id,
                  documents,
                  deletions: batch.deletions,
                  cursor: batch.cursor,
                  status,
                  progress:
                    batch.estimateTotal !== undefined
                      ? {
                          done: progressDone,
                          totalEstimate: batch.estimateTotal,
                        }
                      : undefined,
                  error: null,
                });
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
              // A source with reconcile() then owns the `error` field on that
              // commit — passing `undefined` leaves the column as COALESCE
              // finds it (whatever reconcile just recorded, or unchanged).
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
                error: src.reconcile ? undefined : null,
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

      const handle: Handle & { active(): boolean } = {
        get status() {
          return status;
        },
        active: () => !settled,
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

    isRunning(accountId: AccountId): boolean {
      return running.get(`account:${accountId}`)?.active() ?? false;
    },

    async remove(accountId: AccountId): Promise<void> {
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
      await store.setAccountConfig(accountId, config);
      // The config just changed — the next reconcile pass may legitimately
      // mass-archive (e.g. a root removed from a local-folder account), so
      // grant it a one-shot pass through the breaker. Also the user's
      // documented escape hatch: re-saving settings applies a refused
      // cleanup.
      reconcileAllowances.add(accountId);
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
            const start = await store.consumerCursor(consumer);
            for await (const changes of abortable(
              store.feed(start),
              abort.signal,
            )) {
              if (abort.signal.aborted) return;
              let emitted: DocumentInput[] = [];
              let enrich: EnrichInput[] = [];
              let cursor: Seq = await store.consumerCursor(consumer);
              for (const change of changes) {
                if (abort.signal.aborted) return;
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
                if (matched) {
                  const r = await workOne(worker, change, abort.signal);
                  emitted = emitted.concat(r.docs);
                  enrich = enrich.concat(r.enrich);
                }
                cursor = change.seq;
              }
              await store.commit({
                consumer,
                cursor,
                documents: emitted.length ? emitted : undefined,
                enrich: enrich.length ? enrich : undefined,
              });
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
        },
      };
      running.set(consumer, handle);
      return handle;
    },

    async rerunDeferred(worker: Worker): Promise<void> {
      const consumer = workerConsumerName(worker);
      const abort = new AbortController();
      const seqs = await store.ledgerDeferred(consumer);
      if (seqs.length === 0) return;
      const changes = await store.changesAt(seqs);
      let emitted: DocumentInput[] = [];
      let enrich: EnrichInput[] = [];
      for (const change of changes) {
        // changesAt materializes the CURRENT document, so a doc that gained
        // real markdown between defer and re-drive no longer matches. Re-check
        // matches() — running workOne anyway would re-OCR and OVERWRITE that
        // fresh content. A non-matching deferred change no longer needs this
        // worker at all, so resolve its ledger entry terminally ('skip',
        // mirroring how a 'done' outcome clears the 'deferred' row via the
        // ledgerRecord upsert) instead of re-selecting it every cadence.
        if (!worker.matches(change)) {
          await store.ledgerRecord(consumer, change.seq, 0, 'skip');
          continue;
        }
        const r = await workOne(worker, change, abort.signal);
        emitted = emitted.concat(r.docs);
        enrich = enrich.concat(r.enrich);
      }
      if (emitted.length || enrich.length) {
        await store.commit({
          consumer,
          cursor: await store.consumerCursor(consumer),
          documents: emitted.length ? emitted : undefined,
          enrich: enrich.length ? enrich : undefined,
        });
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
              store.feed(seq),
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
      await Promise.all(
        [...running.values()].map((h) => h.stop().catch(() => {})),
      );
    },
  };

  return engine;
}
