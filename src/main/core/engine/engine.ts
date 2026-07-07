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
  Query,
  Seq,
  Session,
  Source,
  SyncStatus,
  Worker,
  WorkerSession,
} from '@shared/contracts';

import type { CoreStore } from '../store/store';

export interface LogSink {
  log(scope: string, level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
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

/** Iterate, but stop the moment the signal aborts — even while the source
 *  iterator is parked awaiting new data (the live feed blocks on commits). */
async function* abortable<T>(
  iterable: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const it = iterable[Symbol.asyncIterator]();
  const aborted = new Promise<'aborted'>((resolve) => {
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
  try {
    for (;;) {
      const r = await Promise.race([it.next(), aborted]);
      if (r === 'aborted' || r.done) return;
      yield r.value;
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

function refKey(r: ExternalRef): string {
  return `${r.type} ${r.externalId}`;
}

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
): Promise<void> {
  if (!source.reconcile) return;
  const startSeq = store.headSeq();
  const listed: ExternalRef[] = [];
  try {
    for await (const page of abortable(source.reconcile(session), signal)) {
      listed.push(...page);
    }
  } catch (err) {
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
  if (signal.aborted) return; // partial listing — never diff off it

  const listedKeys = new Set(listed.map(refKey));
  const deletions = store
    .liveRefs(account.id)
    .filter((r) => r.seq <= startSeq && !listedKeys.has(refKey(r)))
    .map(({ externalId, type }) => ({ externalId, type }));
  if (deletions.length === 0) return;

  const fresh = (await store.account(account.id)) ?? account;
  await store.commit({
    account: account.id,
    documents: [],
    deletions,
    cursor: fresh.cursor,
    error: null,
  });
}

export function createEngine(deps: EngineDeps): Engine & {
  /** Re-drive a worker's deferred changes (scheduler calls this on cadence). */
  rerunDeferred(worker: Worker): Promise<void>;
  /** Stop every running handle (app shutdown). */
  stopAll(): Promise<void>;
  /** Persist an account's config; restarts its sync loop if one is running
   *  so the new config takes effect immediately. */
  updateConfig(accountId: AccountId, config: Record<string, unknown>): Promise<void>;
  /** True while the account's pull loop is still executing; false once it
   *  settled (finished, gave up after retries, or was stopped). Cadence
   *  ticks consult this so they only START a pull, never replace one that
   *  is still going — for a socket-holding live source (WhatsApp) a
   *  replacement means a full re-login and a fresh history re-send. */
  isRunning(accountId: AccountId): boolean;
} {
  const { store, logs } = deps;
  const running = new Map<string, { stop(): Promise<void>; active(): boolean }>();

  const makeSession = (account: Account, signal: AbortSignal, scope: string): Session => ({
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
          logs.log(scope, 'warn', `token refresh failed: ${String(err)}`);
        }
      }
      return creds;
    },
    log(level, msg) {
      logs.log(scope, level, msg);
    },
  });

  const workerConsumerName = (w: Worker): string => `worker:${w.name}:v${w.version}`;

  /** Run one change through a worker with bounded retries. Returns emitted docs and enrich batch. */
  const workOne = async (
    worker: Worker,
    change: Change,
    signal: AbortSignal,
  ): Promise<{ docs: DocumentInput[]; enrich: EnrichInput[] }> => {
    const consumer = workerConsumerName(worker);
    const scope = `worker:${worker.name}`;
    const maxAttempts = worker.maxAttempts ?? 3;
    const emitted: DocumentInput[] = [];
    const enriched: EnrichInput[] = [];
    const session: WorkerSession = {
      signal,
      inference(prompt, opts) {
        return deps.inference.complete(prompt, { ...opts, lane: 'background' });
      },
      see(image, prompt, opts) {
        return deps.inference.see(image, prompt, { ...opts, lane: 'background' });
      },
      read(image, opts) {
        return deps.inference.read(image, { ...opts, lane: 'background' });
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

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      // A failed attempt's session output must not leak into the retry —
      // only the surviving attempt's emit/enrich calls are committed.
      emitted.length = 0;
      enriched.length = 0;
      try {
        const outcome = (await worker.work(change, session)) ?? 'done';
        store.ledgerRecord(
          consumer,
          change.seq,
          attempt,
          outcome === 'defer' ? 'deferred' : outcome,
        );
        return { docs: emitted, enrich: enriched };
      } catch (err) {
        if (signal.aborted) throw err;
        logs.log(scope, 'warn', `attempt ${attempt}/${maxAttempts} failed at seq ${change.seq}: ${String(err)}`);
        if (attempt === maxAttempts) {
          store.ledgerRecord(consumer, change.seq, attempt, 'failed');
          // A failed final attempt must not commit its half-finished output.
          // Returning the accumulated emit/enrich would persist a partial
          // document (or clobber an existing one via enrich) under a 'failed'
          // outcome. Drop it: the ledger records the failure, the cursor moves
          // on, and nothing partial lands.
          return { docs: [], enrich: [] };
        }
        await sleep(Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS), signal);
      }
    }
    return { docs: emitted, enrich: enriched };
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
      await running.get(`account:${account.id}`)?.stop();
      if (captured) await store.vault.save(account.id, captured);
      logs.log(`source:${source.descriptor.id}`, 'info', `connected ${identifier}`);
      return account;
    },

    run(account: Account): Handle {
      const source = deps.sources.get(account.source);
      const scope = `source:${account.source}`;
      const key = `account:${account.id}`;
      const abort = new AbortController();
      let status: SyncStatus = 'connecting';
      let done: Promise<void>;
      // One pull loop per account: a re-run (sync-now, cadence) replaces the
      // previous loop, never runs beside it.
      const prev = running.get(key);

      if (!source) {
        logs.log(scope, 'error', `no source registered for account ${account.id}`);
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
                ).catch((err) => {
                  // reconcilePass handles its own errors internally and
                  // should never throw — this is a defensive backstop so a
                  // bug in it can't crash the main pull loop.
                  logs.log(scope, 'error', `reconcile pass crashed: ${String(err)}`);
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
                  progress: batch.estimateTotal !== undefined
                    ? { done: progressDone, totalEstimate: batch.estimateTotal }
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
              retries += 1;
              const msg = String(err instanceof Error ? err.message : err);
              logs.log(scope, 'error', `sync failed (retry ${retries}/${SOURCE_MAX_RETRIES}): ${msg}`);
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
                await sleep(Math.min(BACKOFF_BASE_MS * 2 ** retries, BACKOFF_CAP_MS), abort.signal);
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
          return { pending: 0, done: done2, skipped: 0, failed: 0, deferred: 0 };
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
      await store.commit({ removeAccount: accountId });
      logs.log('engine', 'info', `account ${accountId} removed`);
    },

    async updateConfig(accountId: AccountId, config: Record<string, unknown>): Promise<void> {
      await store.setAccountConfig(accountId, config);
      // Only restart a loop that's actually running — a never-started account
      // just gets its config persisted for the next run(). And a running-map
      // entry alone isn't enough: pause is a status-only commit that leaves
      // the entry in place, so restarting on it would silently resume an
      // explicitly paused account (mirror the status gates in
      // accounts:set-cadence and boot's cadence job).
      if (!running.has(`account:${accountId}`)) return;
      const fresh = await store.account(accountId);
      if (fresh && fresh.status !== 'paused') engine.run(fresh);
    },

    attach(worker: Worker): Handle {
      const consumer = workerConsumerName(worker);
      const abort = new AbortController();
      let stopped = false;

      const done = (async () => {
        const start = store.consumerCursor(consumer);
        try {
          for await (const changes of abortable(store.feed(start), abort.signal)) {
            if (abort.signal.aborted) return;
            let emitted: DocumentInput[] = [];
            let enrich: EnrichInput[] = [];
            let cursor: Seq = store.consumerCursor(consumer);
            for (const change of changes) {
              if (abort.signal.aborted) return;
              if (worker.matches(change)) {
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
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            logs.log(`worker:${worker.name}`, 'error', `stopped: ${String(err)}`);
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
          const c = store.ledgerCounts(consumer);
          const pending = Math.max(0, store.headSeq() - store.consumerCursor(consumer));
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
      const seqs = store.ledgerDeferred(consumer);
      if (seqs.length === 0) return;
      const changes = store.changesAt(seqs);
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
          store.ledgerRecord(consumer, change.seq, 0, 'skip');
          continue;
        }
        const r = await workOne(worker, change, abort.signal);
        emitted = emitted.concat(r.docs);
        enrich = enrich.concat(r.enrich);
      }
      if (emitted.length || enrich.length) {
        await store.commit({
          consumer,
          cursor: store.consumerCursor(consumer),
          documents: emitted.length ? emitted : undefined,
          enrich: enrich.length ? enrich : undefined,
        });
      }
    },

    project<S>(projection: Projection<S>, onDiff: (state: S, seq: Seq) => void): Handle {
      const abort = new AbortController();
      let stopped = false;
      const done = (async () => {
        const read: Query = store.read;
        const state0 = (await projection.init(read)) as S;
        // Head captured after init: a change landing mid-init may be applied
        // twice; apply() must tolerate replays (upserts by id do).
        let seq = store.headSeq();
        let state: S = state0;
        onDiff(state, seq);
        try {
          for await (const changes of abortable(store.feed(seq), abort.signal)) {
            if (abort.signal.aborted) return;
            state = projection.apply(state, changes);
            seq = changes[changes.length - 1].seq;
            onDiff(state, seq);
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            logs.log('engine', 'error', `projection stopped: ${String(err)}`);
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
      await Promise.all([...running.values()].map((h) => h.stop().catch(() => {})));
    },
  };

  return engine;
}
