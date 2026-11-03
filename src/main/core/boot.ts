import path from 'path';

import type {
  Account,
  AccountId,
  Cadence,
  Credentials,
  DocumentInput,
  Handle,
  LaneState,
  LogStore,
  Prefs,
  Query,
  SchedulerEnv,
  Sender,
  Source,
  SourceDescriptor,
  Worker,
} from '@shared/contracts';

import { openDbInWorker } from '../db/worker-client';
import {
  createAdmission,
  type Admission,
  type EnrichmentInputs,
} from './admission';
import { createAppProjection } from './app-projection';
import {
  registerChangesPrune,
  registerLedgerRekey,
} from './changes-maintenance';
import type { AppStateExtras } from './app-projection';
import { createConverter } from './engine/convert';
import type { Converter } from './converter/converter';
import { createInlineConverter } from './converter/converter';
import {
  CONVERTER_TIMEOUT_MS,
  createConverterRunner,
} from './converter/runner';
import type { RunnerChild, SqlRunnerDiagnostics } from './mcp/sql-runner';
import { createEngine } from './engine/engine';
import type { LogSink } from './engine/engine';
import { createInference } from './inference';
import type { InferencePlane } from './inference';
import { detectLanguages } from './language';
import { setChildPriorityLog } from './child-priority';
import {
  describeHost,
  hostBudget,
  readHostFacts,
  type HostFacts,
  type LlmAccel,
} from './host-profile';
import { createLogs } from './logs';
import { createDbUserPrefsStore, createPrefs, type CorePrefs } from './prefs';
import { createScheduler } from './scheduler';
import type { CoreScheduler } from './scheduler';
import { gateEngine, gateFrom, readSyncGate } from './sync/role';
import { notMineToRun } from './sync/sources';
import { createSyncService, type SyncService } from './sync/service';
import { applyPendingSwap } from './sync/swap';
import { isResting } from './engine/resting';
import type { BusyRegistry } from './busy';
import { openReads } from './reads';
import type { ReadCaller } from './store/read-proxy';
import { openStore } from './store/store';
import type { CoreStore } from './store/store';
import type { AppDb } from '../db/app-db';

import { buildReadDiagnostics, type ReadDiagnostics } from './read-diagnostics';
import { startEventLoopMonitor } from './event-loop-monitor';

export interface BootDeps {
  dataDir: string;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
  /** Like `encrypt`, but throws where that one stores obfuscated bytes: the
   *  logins another device offers are never stored that way (spec 7.7). */
  encryptStrict?(plain: string): Buffer;
  /** Is the OS keystore really usable right now? */
  keystoreAvailable?(): boolean;
  /** The run's do-not-disturb state, shared with the extensions. */
  busy?: BusyRegistry;
  env(): SchedulerEnv;
  /** Bundled `dbWorker` entry file — the corpus SQLite connection is hosted in
   *  this worker thread so its synchronous calls never block the main loop. */
  dbWorkerFile: string;
  /** Spawns the bundled `kia-converter` child (webpack `worker` entry).
   *  Absent (tests, stdio) or KIA_CONVERTER_INLINE=1 ⇒ parsers run inline. */
  converterSpawn?: () => RunnerChild;
}

export interface SourceRegistry {
  register(source: Source): void;
  get(id: string): Source | undefined;
  list(): SourceDescriptor[];
  unregister(id: string): void;
  /** Does an installed connector's manifest declare a `prepareExport` hook for
   *  this source, whether or not it has registered yet? */
  advertisesPrepareExport?(id: string): boolean;
  /** The extension platform's answer to the above. */
  setPrepareExportAdvertiser?(fn: (id: string) => boolean): void;
}

/** #140: told the id of every `register()` call — including a crash
 *  respawn's re-registration of the same id. The window-first boot queue
 *  starts boot-pending accounts from here. Returns the unsubscribe. */
export interface SourceRegistrations {
  onRegister(cb: (sourceId: string) => void): () => void;
}

/** The one in-process source registry: bundled sources register here at boot,
 *  extension sources through `extension-platform.ts:338`
 *  (`deps.sources.register(makeSource(s))`). Lifted out of `bootCore` so
 *  `list()`'s derivation below is unit-testable — `bootCore` cannot run
 *  without a DB worker thread and nothing in the repo boots it in a test. The
 *  body is byte-identical to the literal it replaces, apart from `list()`. */
export function createSourceRegistry(): SourceRegistry & SourceRegistrations {
  const registry = new Map<string, Source>();
  const listeners = new Set<(sourceId: string) => void>();
  let advertiser: (id: string) => boolean = () => false;
  return {
    advertisesPrepareExport: (id) => advertiser(id),
    setPrepareExportAdvertiser(fn) {
      advertiser = fn;
    },
    register(source) {
      registry.set(source.descriptor.id, source);
      for (const cb of [...listeners]) {
        try {
          cb(source.descriptor.id);
        } catch {
          // A listener never breaks a registration (or the next listener).
        }
      }
    },
    onRegister(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: (id) => registry.get(id),
    /** C-9. `hasReauthenticate` is CORE-DERIVED, here and nowhere else: this
     *  is the one place that turns registered Sources into descriptors, and
     *  `main.ts:403` (`'sources:list': () => p.sources.list()`) hands the
     *  result straight to the renderer, where Task 9 routes ErrorCard's
     *  Reconnect on it.
     *
     *  SPREAD FIRST, THEN SET — never `??`. A connector may author
     *  `hasReauthenticate` on its own descriptor (the field is optional on
     *  `SourceDescriptor`, so a wrong value type-checks) and core must
     *  overwrite it in BOTH directions. `s.descriptor.hasReauthenticate ??
     *  typeof s.reauthenticate === 'function'` would let a connector claiming
     *  `true` route the user into `accounts:start-reconnect`, whose engine
     *  side throws `<source> cannot be reconnected — remove this source and
     *  add it again` and leaves Remove — which deletes both search indexes,
     *  every document row, the vault credentials and the account row — as the
     *  only in-app move.
     *
     *  `typeof` is also the right question for a PROXIED extension source:
     *  `source-proxy.makeSource` attaches optional verbs conditionally behind
     *  the wire flags (`if (entry.hasFetchBytes) { source.fetchBytes = … }`,
     *  `source-proxy.ts:259-260`), so an extension without the verb has no
     *  property at all — there is no always-present stub to see through. */
    list: () =>
      [...registry.values()].map((s) => ({
        ...s.descriptor,
        hasReauthenticate: typeof s.reauthenticate === 'function',
      })),
    unregister(id) {
      registry.delete(id);
    },
  };
}

/** Outbound Senders contributed by EXTENSIONS, keyed by source id — the
 *  mirror of SourceRegistry for the send pipeline. Bundled transports do NOT
 *  live here (they are built directly in outbound/senders); the two sides are
 *  joined by `composeSenders`, which lets bundled shadow extension on a
 *  colliding id. Registration is cap-gated in the extension platform: an
 *  entry existing here already means the manifest declared 'send'.
 *
 *  `get` is on the hot path — the send service materializes a Sender on
 *  EVERY outbound tool call — so it must stay a cheap, side-effect-free map
 *  read: no lazy host wake-up, no per-call allocation. */
export interface SenderRegistry {
  register(sourceId: string, sender: Sender): void;
  get(sourceId: string): Sender | undefined;
  ids(): string[];
  unregister(sourceId: string): void;
}

export interface CorePlatform {
  /** Read-plane diagnostics (reads stats, SQL runner state, -wal size). The
   *  MCP server owns the runner, so the caller passes its diagnostics in. */
  readDiagnostics(sql?: SqlRunnerDiagnostics | null): Promise<ReadDiagnostics>;
  /** The single worker-backed database service shared by core and plugins. */
  db: AppDb;
  /** This device is a read-only follower, joining, or fenced (spec 7.6). Asked
   *  on every call, because the role changes while the app runs (step 2). */
  readOnly(): boolean;
  /** Runs what only a leader runs, after `sync.promote` has flipped the role:
   *  accounts resume from the copied cursor, the archive sweep and the ledger
   *  re-key start, and the workers held back attach. No restart. */
  promote(): Promise<void>;
  sync: SyncService;
  store: CoreStore;
  engine: ReturnType<typeof createEngine>;
  scheduler: CoreScheduler;
  inference: InferencePlane;
  prefs: CorePrefs;
  logs: LogStore;
  logSink: LogSink;
  sources: SourceRegistry & SourceRegistrations;
  senders: SenderRegistry;
  /** Per-source OAuth refreshers; source families add theirs at registration. */
  refreshers: Map<string, (creds: Credentials) => Promise<Credentials | null>>;
  /** The crash-isolated converter (#136): parsers + WASM rasteriser. */
  converter: Converter;
  convert(input: DocumentInput, signal?: AbortSignal): Promise<DocumentInput>;
  /** The ONE background-work owner (#147): unit admission, foreground
   *  first, and the enrichment lane `backgroundLaneState` projects. */
  admission: Admission;
  /** Hardware facts, read once at boot (host-profile.ts). */
  host: HostFacts;
  /** The local model's acceleration once detected; null before. Bound by
   *  main.ts after the bundled providers register. */
  llmAccel: () => LlmAccel | null;
  /** Foreground read path (MCP, renderer): the read worker with writer fallback.
   *  Attributed to caller 'other' in read diagnostics. */
  reads: Query;
  /** Same path, attributed to `caller` in read diagnostics. */
  readsFor(caller: ReadCaller): Query;
  createAppProjection(
    extras: AppStateExtras,
  ): ReturnType<typeof createAppProjection>;
  shutdown(): Promise<void>;
  /** #59 §0: start the one-shot ledger re-key repair (main.ts, once, after
   *  `scheduler.start()`). Retries itself with a bounded backoff. */
  startLedgerRekey(): void;
}

/** How long an archived document stays recoverable before it is destroyed.
 *
 *  `contracts.ts` describes the document lifecycle as "live → archived →
 *  gone", and `{ purgeArchived }` is the verb for the last hop — but until
 *  `registerArchiveSweep` below, nothing in production ever called it. Every
 *  row ever archived (an unselected folder, an upstream deletion, a reconcile
 *  diff) stayed on disk forever, and so did its `documents_fts` /
 *  `documents_tri` entries.
 *
 *  The window is what makes archiving-then-deleting safe rather than merely
 *  destructive. Inside it a mistake is free to undo: re-selecting a folder
 *  revives its documents through the upsert's `archived_at = NULL` with no
 *  re-download, and a connector that mis-attributes a scope root (twice this
 *  week) has 30 days to be corrected before anything is lost. Outside it the
 *  data is gone for good, and re-selecting means a full re-ingest.
 *
 *  It also bounds change-feed replay: a `'purge'` tombstone is how a remote
 *  consumer learns a document died, so the window must exceed the longest
 *  plausible consumer lag. 30 days does. */
export const ARCHIVE_RETENTION_DAYS = 30;

export const ARCHIVE_SWEEP_JOB_ID = 'maintenance:purge-archived';

/** Four times a day. The schedule is durable, so a window missed while the
 *  app was closed catches up on the first tick after boot rather than
 *  waiting out a whole period. */
export const ARCHIVE_SWEEP_CADENCE: Cadence = { every: '6h' };

/** The instant a sweep running at `now` purges before. */
export function archiveCutoff(now: Date): string {
  return new Date(
    now.getTime() - ARCHIVE_RETENTION_DAYS * 86_400_000,
  ).toISOString();
}

/** Register the ONE maintenance job that turns archived tombstones into gone.
 *
 *  Lifted out of `bootCore` (which needs a real DB worker) so the cadence,
 *  the job id, and the cutoff this destructive job computes are unit-testable.
 *  Registration is fire-and-forget by design — `CoreScheduler.register` is
 *  async only because the durable schedule row goes through the AppDb, and
 *  nothing at boot waits on it.
 *
 *  Deliberately unpaged: the purge cascade is one transaction, the same shape
 *  and the same unbounded-delete tradeoff `removeAccount` has always shipped
 *  with. It is also self-limiting in practice — a sweep only ever has one
 *  retention period's worth of archived rows to collect. */
export function registerArchiveSweep(deps: {
  store: Pick<CoreStore, 'commit'>;
  scheduler: Pick<CoreScheduler, 'register'>;
  logs: LogSink;
  now?: () => Date;
}): void {
  const now = deps.now ?? (() => new Date());
  void deps.scheduler.register(
    ARCHIVE_SWEEP_JOB_ID,
    ARCHIVE_SWEEP_CADENCE,
    async () => {
      const before = archiveCutoff(now());
      // No count is logged: the honest record of what died is the change
      // feed itself, one `'purge'` tombstone per document. Deriving a number
      // from corpus counts either side of the commit would be wrong whenever
      // a backfill batch lands in between.
      deps.logs.log(
        'maintenance',
        'info',
        `purging documents archived before ${before}`,
      );
      await deps.store.commit({ purgeArchived: { before } });
    },
  );
}

/**
 * Construction happens once, here. Everything downstream reads the platform —
 * no DI styles, no lazy getters, no module globals.
 */
/** The enrichment lane's live inputs, read through `get()` on every call so
 *  `llmAccel` (bound by main.ts later) and `engine.syncing()` are never
 *  stale and never read before they exist. */
export function enrichmentInputsFor(
  get: () => Pick<
    CorePlatform,
    'prefs' | 'scheduler' | 'host' | 'llmAccel' | 'engine'
  >,
): EnrichmentInputs {
  return {
    processing: () => get().prefs.get().processing,
    env: () => get().scheduler.env,
    weak: () => hostBudget(get().host, get().llmAccel()).weak,
    syncing: () => get().engine.syncing(),
  };
}

export async function bootCore(deps: BootDeps): Promise<CorePlatform> {
  const { store: logStore, sink } = createLogs(path.join(deps.dataDir, 'logs'));
  let platform!: CorePlatform;
  const host = readHostFacts();
  // accel is detected lazily by the local-llm provider; unknown at boot.
  sink.log('host', 'info', describeHost(host, null));
  setChildPriorityLog((msg) => sink.log('priority', 'info', msg));
  const eventLoop = startEventLoopMonitor({
    log: (level, msg) => sink.log('event-loop', level, msg),
  });
  const prefs = createPrefs(deps.dataDir);
  // The corpus SQLite connection lives in a worker thread (the store is
  // AppDb-driven, so every read/write and the relocated commit transaction
  // cross the bridge); this is what keeps backfill off the main event loop.
  const dbPath = path.join(deps.dataDir, 'kiagent.db');
  // A snapshot from the master replaces the file before anything opens it.
  if (applyPendingSwap(dbPath) === 'abandoned') {
    sink.log('sync', 'error', 'could not apply the snapshot; kept this device as it was');
  }
  const db = await openDbInWorker(dbPath, deps.dbWorkerFile);
  // Read once, before anything starts: only the boot swap changes it. A
  // joining device is gated like a follower, across restarts (spec 7.7).
  const gateAtBoot = await readSyncGate(db);
  const readOnlyAtBoot = gateFrom(gateAtBoot);
  const store = openStore(db, {
    encrypt: deps.encrypt,
    decrypt: deps.decrypt,
    detectLanguages,
    profileDir: deps.dataDir,
    readOnly: () => sync.readOnly(),
  });
  const budget = hostBudget(host, null);
  // Foreground reads (MCP, renderer) run on their own read-only worker so they
  // never queue behind ingest writes. Opened AFTER the writer migrated.
  const readPlane = await openReads({
    dbPath,
    workerFile: deps.dbWorkerFile,
    writer: store.read,
    weak: budget.weak,
    log: (level, msg) => sink.log('db', level, msg),
  });
  const inference = createInference(sink);
  const scheduler = createScheduler(store, deps.env, sink);
  // Lazy reads through `platform`: nothing evaluates the lane before
  // `platform` is assigned below.
  const admission = createAdmission({
    slots: budget.ingestSlots,
    userActive: () => scheduler.env.userActive,
    enrichment: enrichmentInputsFor(() => platform),
  });
  inference.setForegroundIdle((signal) => admission.foregroundIdle(signal));
  const converter: Converter =
    deps.converterSpawn && process.env.KIA_CONVERTER_INLINE !== '1'
      ? createConverterRunner({
          spawn: deps.converterSpawn,
          // Doubled on 1-slot hosts: a demoted child on a weak machine is
          // slow, not stuck (spec §1).
          timeoutMs: CONVERTER_TIMEOUT_MS * (budget.ingestSlots === 1 ? 2 : 1),
          log: (level, msg) => sink.log('converter', level, msg),
        })
      : createInlineConverter();
  const convert = createConverter(sink, converter);

  const sources = createSourceRegistry();

  const senderRegistry = new Map<string, Sender>();
  const senders: SenderRegistry = {
    register(sourceId, sender) {
      senderRegistry.set(sourceId, sender);
    },
    get: (sourceId) => senderRegistry.get(sourceId),
    ids: () => [...senderRegistry.keys()],
    unregister(sourceId) {
      senderRegistry.delete(sourceId);
    },
  };

  const refreshers = new Map<
    string,
    (creds: Credentials) => Promise<Credentials | null>
  >();
  const engine = createEngine({
    store,
    sources,
    inference,
    convert,
    logs: sink,
    refreshers,
    admission,
    // #59 §3a: seed pages run on the read worker, never behind ingest.
    reads: readPlane.readsFor('other'),
  });

  const sync = createSyncService({
    db,
    store,
    dbPath,
    workerFile: deps.dbWorkerFile,
    encryptStrict: deps.encryptStrict,
    decrypt: deps.decrypt,
    keystoreAvailable: deps.keystoreAvailable,
    isInstalled: (source) => sources.get(source) !== undefined,
    start: async (id) => {
      const account = await store.account(id as AccountId);
      if (account && !isResting(account.status)) runAccount(platform, account);
    },
    busy: () => deps.busy?.get().reasons[0] ?? null,
    initialReadOnly: readOnlyAtBoot,
    // A tracking master may have been replaced while it was off.
    fencedAtBoot: gateAtBoot.tracking && !readOnlyAtBoot,
    onPromoted: () => platform.promote(),
    sources,
    log: (level, msg) => sink.log('sync', level, msg),
  });
  // A connector installed later starts the accounts that were waiting for it.
  sources.onRegister((sourceId) => {
    void startWhenInstalled(platform, sourceId).catch((err) =>
      sink.log('sync', 'error', `could not start accounts for ${sourceId}: ${String(err)}`),
    );
  });
  // Asked on every call, so a promotion opens this same engine.
  await sync.loadOwned();
  // The user's preferences come from the copied table from here on; a device
  // that can write it moves any it still keeps in prefs.json there, once.
  await prefs.attachUser(createDbUserPrefsStore(db, () => !sync.readOnly()));
  const gate = gateEngine(engine, () => sync.readOnly(), sync);
  // A follower's copied rows change only by what the master sends.
  let archiveSweep = false;
  const startArchiveSweep = (): void => {
    if (archiveSweep) return;
    archiveSweep = true;
    registerArchiveSweep({ store, scheduler, logs: sink });
  };
  if (!readOnlyAtBoot) startArchiveSweep();
  // #59 §3b: prune `changes` to a bounded tail. Never at boot; first-ever
  // run 10 minutes in; a no-op until the ledger re-key repair is done.
  void registerChangesPrune({
    store,
    scheduler,
    logs: sink,
    activeConsumers: () => engine.activeConsumers(),
  }).catch((err) =>
    sink.log(
      'maintenance',
      'error',
      `changes prune registration failed: ${String(err)}`,
    ),
  );

  // #59 §0: registered here (needs `platform` for the wake), started once
  // by main.ts's startScheduler (boot-background's scheduler step, after
  // scheduler.start()) so it never competes with the window.
  const ledgerRekey = registerLedgerRekey({
    store,
    scheduler,
    logs: sink,
    onDone: () => requestLaneWake(platform),
  });

  platform = {
    readOnly: () => sync.readOnly(),
    promote: () =>
      promoteCore(platform, {
        deviceId: () => sync.deviceId(),
        archiveSweep: startArchiveSweep,
        ledgerRekey: () => void ledgerRekey.then((r) => r.kick()),
        attachHeld: gate.attachHeld,
      }),
    sync,
    startLedgerRekey: () => {
      if (!sync.readOnly()) void ledgerRekey.then((r) => r.kick());
    },
    db,
    store,
    engine,
    scheduler,
    inference,
    prefs,
    logs: logStore,
    logSink: sink,
    sources,
    senders,
    refreshers,
    convert,
    converter,
    admission,
    host,
    readDiagnostics: (sql) =>
      buildReadDiagnostics({
        stats: readPlane.stats,
        walPath: `${dbPath}-wal`,
        sql,
        eventLoop: () => eventLoop.last(),
        admission: () => admission.snapshot(),
        converter: () => converter.stats(),
      }),
    reads: readPlane.reads,
    readsFor: readPlane.readsFor,
    llmAccel: () => null,
    createAppProjection,
    shutdown: async () => {
      eventLoop.stop();
      scheduler.stop();
      await engine.stopAll();
      await converter.stop();
      await sync.close();
      await readPlane.close();
      await store.close();
    },
  };
  // Bound synchronously before anything can call: production never sees the
  // plane's closed default.
  inference.setLanePolicy(() => backgroundLaneOpen(platform));
  return platform;
}

/** Start (or restart) one account's sync and keep its cadence job registered.
 *  Used at boot, after a connect flow, and by resume/sync-now — the ONE way
 *  an account starts pulling. Calling runAccount itself is a deliberate
 *  (re)start: engine.run replaces any previous loop. The cadence tick is
 *  NOT — it only starts a pull when none is executing. */
export function runAccount(platform: CorePlatform, account: Account): Handle {
  const handle = platform.engine.run(account);
  const source = platform.sources.get(account.source);
  const cadence = account.cadence ?? source?.descriptor.cadence;
  if (cadence) {
    platform.scheduler.register(
      `source:${account.source}:${account.id}`,
      cadence,
      async () => {
        // Start-if-idle, never replace. A batch source's previous pull has
        // ended by now, so this begins the next incremental one — but a live
        // source's pull never ends, and replacing it would tear down its
        // connection and force a fresh login + full history re-send every
        // tick (WhatsApp). The tick doubles as a supervisor: a loop that
        // died (retries exhausted, extension crash) is no longer running
        // and gets restarted here. Both reads below go stale inside
        // engine.pause()'s stop-to-commit window (loop stopped, 'paused'
        // commit still queued behind other accounts' batches) — engine.run
        // itself re-checks the pause intent and the committed status, so a
        // tick landing in that window is refused instead of resurrecting a
        // paused account.
        if (platform.engine.isRunning(account.id)) return;
        const fresh = await platform.store.account(account.id);
        // 'needsReauth' is a RESTING state like 'paused': the loop stopped
        // deliberately (revoked credential — retrying just re-hammers the
        // provider with doomed requests). Only the user's explicit Retry
        // (sync-now → runAccount) or a fresh connect starts it again.
        if (fresh && !isResting(fresh.status)) platform.engine.run(fresh);
      },
    );
  }
  return handle;
}

/** Persist a cadence change and re-apply it. The restart is gated by the
 *  same resting-state rule as the cadence tick above, boot's resumeAccounts,
 *  and engine.updateConfig: a cadence save on a 'paused' or 'needsReauth'
 *  account persists the new cadence but starts NOTHING — saving a schedule is
 *  not a Retry, and one doomed pull per save would re-hammer a revoked
 *  credential. The new cadence job registers on the next runAccount (explicit
 *  Retry via sync-now, resume, or a fresh connect), same as for 'paused'. */
export async function setAccountCadence(
  platform: CorePlatform,
  accountId: AccountId,
  cadence: Cadence | null,
): Promise<void> {
  await platform.store.setAccountCadence(accountId, cadence);
  const account = await platform.store.account(accountId);
  if (!account) return;
  if (isResting(account.status)) return;
  runAccount(platform, account);
}

/** Resume sync for every non-paused account and register cadence jobs.
 *  `defer` (#140): offered each account whose source is NOT registered yet;
 *  returning true means the caller queued it for that source's registration,
 *  so it is skipped without today's "not registered — skipping" line.
 *  `signal` (#140): once aborted (quit, interactive Reset all) nothing more
 *  starts — checked after the read and before every dispatch. */
export async function resumeAccounts(
  platform: CorePlatform,
  opts: {
    defer?(account: Account): boolean;
    /** Accounts this call must not start (a promotion skips other devices'). */
    skip?(account: Account): boolean;
    signal?: AbortSignal;
  } = {},
): Promise<Map<string, Handle>> {
  const handles = new Map<string, Handle>();
  const accounts = await platform.store.read.accounts();
  for (const account of accounts) {
    if (opts.signal?.aborted) break;
    if (account.source === 'worker') continue; // synthetic accounts don't sync
    if (opts.skip?.(account)) continue;
    // Same resting-state rule as the cadence tick: a needsReauth account
    // must not resume hammering a revoked credential at every boot. A
    // needs-connector account starts once its connector is registered
    // (startWhenInstalled), and a device-owned one the seed holds is paused.
    if (account.status === 'needs-connector') {
      if (platform.sources.get(account.source)) {
        const started = await startNeedsConnector(platform, account);
        if (started) handles.set(account.id, runAccount(platform, started));
      }
      continue;
    }
    if (isResting(account.status)) continue;
    if (!platform.sources.get(account.source)) {
      if (opts.defer?.(account)) continue;
      platform.logSink.log(
        'engine',
        'warn',
        `account ${account.identifier}: source '${account.source}' not registered — skipping`,
      );
      continue;
    }
    handles.set(account.id, runAccount(platform, account));
  }
  return handles;
}

/** What a new leader starts, after the role flipped (spec 7.8): accounts from
 *  the copied cursor except device-owned ones that belong to another device,
 *  then the leader-only maintenance, then the workers that were held back. */
export async function promoteCore(
  platform: CorePlatform,
  hooks: {
    deviceId(): string | null;
    archiveSweep(): void;
    ledgerRekey(): void;
    attachHeld(): Promise<void>;
  },
): Promise<void> {
  const me = hooks.deviceId();
  await resumeAccounts(platform, { skip: (a) => notMineToRun(a, me) });
  hooks.archiveSweep();
  hooks.ledgerRekey();
  await hooks.attachHeld();
}

/** Its connector is here now: back to connecting, then the usual start.
 *  Returns the account to run, or null when it moved on in the meantime. */
async function startNeedsConnector(
  platform: CorePlatform,
  account: Account,
): Promise<Account | null> {
  const fresh = await platform.store.account(account.id);
  if (!fresh || fresh.status !== 'needs-connector') return null;
  await platform.store.commit({
    account: fresh.id,
    documents: [],
    cursor: fresh.cursor,
    status: 'connecting',
  });
  return { ...fresh, status: 'connecting' };
}

/** A connector was installed or registered: every account waiting on it
 *  starts, with no restart (spec 7.7 step 4). */
export async function startWhenInstalled(
  platform: CorePlatform,
  sourceId: string,
): Promise<void> {
  const waiting = (await platform.store.read.accounts()).filter(
    (a) => a.source === sourceId && a.status === 'needs-connector',
  );
  for (const a of waiting) {
    const started = await startNeedsConnector(platform, a);
    if (started) runAccount(platform, started);
  }
}

/** Attach a worker and, when it declares a cadence, schedule its deferred
 *  re-drive — the second half of the two-pass pattern. */
export function attachWorker(platform: CorePlatform, worker: Worker): Handle {
  const handle = platform.engine.attach(worker);
  if (worker.schedule && worker.schedule !== 'live') {
    platform.scheduler.register(
      `worker:${worker.name}`,
      worker.schedule,
      async () => {
        await platform.engine.rerunDeferred(worker);
      },
    );
  }
  return handle;
}

/** The enrichment lane, projected from the admission owner (#147 §5): same
 *  result and LaneState values as before. Inference admission, the worker
 *  pre-flights, the extension `lane()` resolver and the 5 s publisher all
 *  read it. Ingest/convert/reconcile/redrive units are admitted by
 *  `platform.admission.acquire` and are never closed by a lane state. */
export function backgroundLaneState(
  platform: CorePlatform,
  now = new Date(),
): LaneState {
  return platform.admission.enrichmentLane(now);
}

/** Platforms that refused background work since the publisher last woke the
 *  deferred workers. Coalesced: one wake covers any number of refusals. */
const pendingWake = new WeakSet<CorePlatform>();

/** Is the background lane open? A `false` answer records a pending wake, so
 *  a closure that opens and closes between two publisher ticks still wakes
 *  the deferred workers on the next tick (instead of their 30-min cadence). */
export function backgroundLaneOpen(
  platform: CorePlatform,
  now = new Date(),
): boolean {
  const open = backgroundLaneState(platform, now) === 'open';
  if (!open) pendingWake.add(platform);
  return open;
}

/** Consume the pending wake (the 5 s publisher calls this only while open). */
export function takeLaneWake(platform: CorePlatform): boolean {
  const had = pendingWake.has(platform);
  pendingWake.delete(platform);
  return had;
}

/** Arm one lane wake from outside the lane check. The ledger re-key repair
 *  (#59 §0) calls this when it finishes, so the deferred re-drive it held
 *  back runs on the next open publisher tick instead of on its cadence. */
export function requestLaneWake(platform: CorePlatform): void {
  pendingWake.add(platform);
}
