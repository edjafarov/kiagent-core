/**
 * The runtime: every core service, built once, with or without a window.
 *
 * `createRuntime(host)` returns at once. `ready` resolves when the services
 * exist (the MCP listener is bound and the outbox scheduler runs by then);
 * `start` runs the boot tail (extensions, account resumption, scheduled work);
 * `stop` is valid from the first moment and tears down whatever was acquired.
 *
 * Nothing here imports Electron: the host supplies the window, tray, dialogs,
 * keystore and power state, so the same code runs headless and under jest.
 */
import type { App } from 'electron';
import fs from 'fs';
import path from 'path';
import type {
  Account,
  AppState,
  AccountId,
  FolderScopeUpdate,
  ProjectionHandle,
  SchedulerEnv,
  Seq,
} from '@shared/contracts';
import type {
  AppStatePush,
  ConnectEvent,
  PushChannel,
  Pushes,
} from '@shared/ipc';
import { describeResetOutcome } from '@shared/reset-outcome';
import type { ProductConfig } from './product';
import type { ImageDownscaler } from './workers/vision/downscale';
import type { BootTimer } from './core/boot-timing';
import { createConnectBroker } from './auth/connect-broker';
import type { ConnectBroker } from './auth/connect-broker';
import {
  backgroundLaneState,
  effectiveLaneState,
  bootCore,
  takeLaneWake,
  resumeAccounts,
  runAccount,
} from './core/boot';
import type { BootDeps, CorePlatform } from './core/boot';
import { installCrashRecovery } from './core/crash-recovery';
import { createActivityLog, type ActivityLog } from './core/mcp/activity';
import { createSqlRunner } from './core/mcp/sql-runner';
import { utilityRunnerChild } from './core/mcp/sql-runner-spawn';
import { demoteHost } from './core/child-priority';
import { startMcp } from './core/mcp/server';
import { startReadDiagnosticsDump } from './core/read-diagnostics';
import type { McpServerHandle } from './core/mcp/server';
import { markOnboardingOnce } from './core/prefs';
import { createLedgerCounter } from './core/processing-counter';
import {
  createProcessingStatus,
  wakeDeferredWorkers,
} from './core/processing-status';
import { createGitHubCache } from './marketplace/github-cache';
import {
  createGitHubSource,
  InstallSourceError,
} from './marketplace/github-source';
import { formatGitHubRef } from './marketplace/github-ref';
import { createMarketplaceCatalog } from './marketplace/catalog';
import type { MarketplaceCatalog } from './marketplace/catalog';
import { buildMainApi } from './main-api';
import { createSharedFolders, sha256File } from './core/shared-folders';
import { ownLocalFolders } from './core/shared-folders/local-folder-access';
import { createBusyRegistry } from './core/busy';
import { wireOutboxPush } from './outbox-push';
import { wireSyncAppliedPush } from './sync-applied-push';
import { guardDraftTools } from './outbound/follower-tools';
import { followerLookup } from './core/sync/role';
import { wireAttentionPush } from './attention/push';
import {
  createAttentionService,
  type AttentionService,
} from './attention/service';
import { createExtensionPlatform } from './platform/extension-platform';
import {
  runFactoryReset,
  finishInterruptedReset,
  type FactoryResetDeps,
} from './factory-reset';
import { createResetJournal } from './reset-journal';
import type { ExtensionPlatform } from './platform/extension-platform';
import { EXTENSIONS_KEY, type ExtensionsSet } from './platform/extension-set';
import {
  assertProfileStorageVersion,
  markProfileStorageVersion,
  PROFILE_STORAGE_VERSION,
} from './platform/profile-storage-version';
import {
  createHungTransport,
  utilityProcessTransport,
} from './platform/transport';
import {
  createBootQueue,
  startBackground,
  type BootQueue,
} from './core/boot-background';
import { bootTail } from './boot-tail';
import {
  createFileRootRegistry,
  createFileRootsPersistence,
  restoreFileRootsFromFile,
} from './platform/file-roots';
import {
  createOutboundService,
  type OutboundService,
} from './outbound/service';
import { wireCalendarOutPush } from './calendar-out/push';
import { createOutboundRoutes } from './outbound/routes';
import {
  createCalendarOutService,
  type CalendarOutService,
} from './calendar-out/service';
import { buildBundledSenders, composeSenders } from './outbound/senders';
import { createCalendarWriterRegistry } from './calendar-out/writers';
import { createOwnerMail } from './outbound/owner-mail';
import { createDocumentBytes } from './outbound/document-bytes';
import { createAttachments } from './outbound/attachments';
import { createOutboxScheduler } from './outbound/scheduler';
import { registerBundledProviders } from './providers';
import type { LocalAsrProvider } from './providers/local-asr';
import type { LocalLlmProvider } from './providers/local-llm/provider';
import { registerBundledSources } from './sources';
import { readFolderRoots } from './sources/local-folder/folder-roots';
import {
  SHARED_IDENTIFIER,
  SHARED_SOURCE_ID,
  type SharedFolderHost,
} from './sources/shared-folder';
import { descriptor as sharedFolderDescriptor } from './sources/shared-folder/shared-folder-source';
import type { TrayMenuController } from './tray-menu';
import { attachBundledWorkers, VISION_CONSUMER } from './workers';

/** `ready` and `start` reject with this when `stop()` was called first. */
export class RuntimeStopped extends Error {
  constructor() {
    super('runtime stopped');
    this.name = 'RuntimeStopped';
  }
}

export interface RuntimeHost {
  userDataDir: string;
  isPackaged: boolean;
  product: ProductConfig;
  bundledExtensionsDir: string;
  assetPath(...paths: string[]): string;
  app: Pick<App, 'getPath' | 'getVersion' | 'getName'>;
  encryption: Pick<
    BootDeps,
    'encrypt' | 'decrypt' | 'encryptStrict' | 'keystoreAvailable'
  >;
  /** Power, thermal and window focus, read live by admission. */
  env(): SchedulerEnv;
  downscale: ImageDownscaler;
  notifyRenderer<C extends PushChannel>(channel: C, payload: Pushes[C]): void;
  /** Read when an extension first asks for its main API, never earlier. */
  tray(): TrayMenuController;
  openWindow(): void;
  notify(msg: string): void;
  trashItem(file: string): Promise<void>;
  confirm(opts: {
    message: string;
    detail: string;
    confirmLabel: string;
    cancelLabel: string;
  }): Promise<boolean>;
  inform(opts: {
    type: 'info' | 'warning';
    message: string;
    detail: string;
  }): void;
  onPrefs?(prefs: Prefs): void;
  bootTimer: BootTimer;
  log: { warn(...args: unknown[]): void };
}

/** What the host needs to answer the renderer and drive the tray. */
export interface RuntimeHandles {
  platform: CorePlatform;
  lastPush(): AppStatePush;
  patchState(partial: Partial<AppState>): void;
  bundled: {
    localLlm: LocalLlmProvider;
    localAsr: LocalAsrProvider;
    /** Provider ids whose bundled program is not on disk. */
    missingBinaries: readonly string[];
  };
  extensions: ExtensionPlatform;
  catalog: MarketplaceCatalog;
  broker: ConnectBroker;
  outbound: OutboundService;
  calendarOut: CalendarOutService;
  attention: AttentionService;
  mcp: McpServerHandle;
  activity: ActivityLog;
  refreshWaiting(): Promise<void>;
  /** sync-now and Resume (#140): run now, or queue behind a boot-pending
   *  extension source. */
  startAccount(account: Account): void;
  /** Every account sync, now. */
  syncNow(): void;
  factoryResetDeps(): FactoryResetDeps;
}

export interface RuntimePhases {
  /** Runs once the bounded in-process extensions are active: the host opens
   *  its window here. Utility extensions start after it returns. */
  afterInProcessExtensions(): Promise<void>;
}

export interface Runtime {
  ready: Promise<RuntimeHandles>;
  start(phases: RuntimePhases): Promise<void>;
  stop(): Promise<void>;
}

type Prefs = ReturnType<CorePlatform['prefs']['get']>;

export const EXTENSION_RETRY_MS = 60 * 60 * 1000;
/** How long stop() waits for a construction step that is still running. */
const STOP_WAIT_MS = 5000;

export async function syncExtensions(
  extensions: ExtensionPlatform,
  p: CorePlatform,
): Promise<void> {
  try {
    await extensions.seedExtensionSet();
    await extensions.reconcileExtensions();
  } catch (err) {
    p.logSink.log(
      'extensions',
      'warn',
      `extension reconcile failed: ${String(err)}`,
    );
  }
}

export function createRuntime(host: RuntimeHost): Runtime {
  const broadcast: RuntimeHost['notifyRenderer'] = (channel, payload) =>
    host.notifyRenderer(channel, payload);
  const fileRoots = createFileRootRegistry();
  let platform: CorePlatform | null = null;
  let mcp: McpServerHandle | null = null;
  let extensionsPlatform: ExtensionPlatform | null = null;
  let attentionService: AttentionService | null = null;
  let attentionPush: ReturnType<typeof wireAttentionPush> | null = null;
  /** The renderer's app-state projection, once started (a follower's applied
   *  deltas read it again). */
  let appProjection: ProjectionHandle | null = null;
  let bundledProviders: {
    localLlm: LocalLlmProvider;
    localAsr: LocalAsrProvider;
  } | null = null;
  let activity: ActivityLog | null = null;
  let stopActivityWatch: (() => void) | null = null;
  let stopOutboxScheduler: (() => void) | null = null;
  let stopProcessing: (() => void) | null = null;
  let processingTick: ReturnType<typeof setInterval> | undefined;
  // The shared-folders service holds chokidar (fsevents) watchers. Left open at
  // quit they deadlock Node's teardown on macOS (fse_instance_destroy waits on a
  // mutex inside FreeEnvironment), after JS is gone, so no backstop can fire:
  // the process stays without a window and a restart never relaunches.
  let closeSharedFolders: (() => Promise<void>) | null = null;
  // #140: the boot queue (sync-now/Resume run-or-queue) and the post-window chain's stop.
  let bootQueue: BootQueue | null = null;
  let bootChain: { stop(): void } | null = null;
  let stopping = false;
  let startTail: ((phases: RuntimePhases) => Promise<void>) | null = null;

  /** Between awaited construction steps: a stop() that came meanwhile wins. */
  const check = (): void => {
    if (stopping) throw new RuntimeStopped();
  };

  // Every step is bounded, so a quit can't hang: LlamaServer.stop escalates to
  // SIGKILL after a grace window, and localAsr.dispose() awaits the signalled
  // whisper-cli child whose own SIGTERM→SIGKILL escalation is capped at ~2s.
  // Each field is taken before it is disposed, so a second pass (construction
  // that finished a step after stop()) only tears down what is new.
  const teardown = async (): Promise<void> => {
    const held = {
      stopActivityWatch,
      stopOutboxScheduler,
      stopProcessing,
      bundledProviders,
      mcp,
      extensionsPlatform,
      closeSharedFolders,
      attentionPush,
      attentionService,
      platform,
    };
    stopActivityWatch = null;
    stopOutboxScheduler = null;
    stopProcessing = null;
    bundledProviders = null;
    mcp = null;
    extensionsPlatform = null;
    closeSharedFolders = null;
    attentionPush = null;
    attentionService = null;
    platform = null;
    held.stopActivityWatch?.();
    held.stopOutboxScheduler?.();
    held.stopProcessing?.();
    await held.bundledProviders?.localLlm.dispose().catch(() => {});
    await held.bundledProviders?.localAsr.dispose().catch(() => {});
    await held.mcp?.stop().catch(() => {});
    // Extensions stop first, so no caller can start new attention work while
    // the service drains admitted operations; only then do we dispose the
    // attention service and finally shut down the shared DB platform.
    await held.extensionsPlatform?.stop().catch(() => {});
    // Bounded: close() also waits for a sort in progress, which must not hold
    // the quit; the watchers themselves close at once.
    await Promise.race([
      held.closeSharedFolders?.().catch(() => {}),
      new Promise((r) => {
        setTimeout(r, 3000).unref?.();
      }),
    ]);
    held.attentionPush?.dispose();
    await held.attentionService?.dispose().catch(() => {});
    await held.platform?.shutdown().catch(() => {});
  };

  const build = async (): Promise<RuntimeHandles> => {
    await assertProfileStorageVersion(
      host.userDataDir,
      PROFILE_STORAGE_VERSION,
    );
    const dataDir = path.join(host.userDataDir, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const fileRootsPath = path.join(host.userDataDir, 'file-roots.json');
    await restoreFileRootsFromFile(fileRootsPath, fileRoots, (error) =>
      host.log.warn('[file-roots] unable to restore persisted grants', error),
    );
    const persistFileRoots = createFileRootsPersistence(
      fileRootsPath,
      fileRoots,
    );
    const act = createActivityLog(dataDir);
    activity = act;
    const enc = host.encryption;
    // Bundled DB worker (webpack `dbWorker` entry): prod emits `dbWorker.js`,
    // the dev config `dbWorker.bundle.dev.js` — the same existsSync-fallback
    // scheme as extensionHostScript below. Hosting the corpus SQLite connection
    // off the main thread is what keeps backfill from freezing the UI.
    const dbWorkerFile =
      [
        path.join(__dirname, 'dbWorker.js'),
        path.join(__dirname, 'dbWorker.bundle.dev.js'),
      ].find((f) => fs.existsSync(f)) ?? path.join(__dirname, 'dbWorker.js');
    // Bundled converter child (webpack `worker` entry, #136): prod
    // `worker.js`, dev `worker.bundle.dev.js`. Demoted to BELOW_NORMAL on
    // spawn — never LOW: Windows IDLE-class children starve under load.
    const converterFile =
      [
        path.join(__dirname, 'worker.js'),
        path.join(__dirname, 'worker.bundle.dev.js'),
      ].find((f) => fs.existsSync(f)) ?? path.join(__dirname, 'worker.js');

    // One do-not-disturb state for the run, shared by every extension and by
    // the sync service's restart checks.
    const busy = createBusyRegistry();

    platform = await bootCore({
      dataDir,
      ...enc,
      busy,
      env: host.env,
      dbWorkerFile,
      converterSpawn: () =>
        utilityRunnerChild(
          converterFile,
          {},
          (line) => platform?.logSink.log('converter', 'warn', line),
          {
            serviceName: 'kia-converter',
            onSpawn: (pid) => demoteHost(pid, {}, 'kia-converter'),
          },
        ),
    });
    check();
    host.bootTimer.mark('bootCore');
    await markProfileStorageVersion(host.userDataDir, PROFILE_STORAGE_VERSION);
    const p = platform;

    attentionPush = wireAttentionPush(broadcast);
    // A follower's pages read again when a delta from the leader lands.
    wireSyncAppliedPush(p.sync, {
      attentionHint: () => attentionPush?.hint(),
      broadcast,
      reproject: () => appProjection?.reinit(),
    });
    const attention = createAttentionService({
      db: p.db,
      log: (message) => p.logSink.log('attention', 'warn', message),
      onChanged: attentionPush.hint,
    });
    attentionService = attention;
    p.store.onReset(() => attention.notifyReset());

    const bundled = registerBundledProviders(p, {
      assetsDir: host.assetPath(),
      dataDir,
    });
    bundledProviders = bundled;
    p.llmAccel = () => bundled.localLlm.accel();
    attachBundledWorkers(p, {
      ...bundled,
      // Built HERE so the worker and its module stay Electron-free (and so
      // jest never has to mock `electron` to exercise them).
      downscale: host.downscale,
    });
    // Retired worker versions leave orphaned work_attempts rows; sweep them
    // once the bundled workers are attached. Best-effort: a stale row only
    // costs one extra counted attempt for a worker that comes back.
    p.store.pruneAttempts(p.engine.activeConsumers()).catch(() => {});
    // #139: the same contract for consumers + work_ledger (retired worker
    // versions such as worker:audio:v1). No work_ledger statement when
    // nothing is retired.
    p.store
      .sweepRetiredConsumers(p.engine.activeConsumers())
      .catch((err) =>
        p.logSink.log(
          'store',
          'warn',
          `retired consumer sweep failed: ${String(err)}`,
        ),
      );

    // Bundled transports SHADOW extension senders on a colliding source
    // id, and both sides are read live on every send — so an extension
    // activating after this point is picked up without re-composing.
    // Calendar writers (platform 2.16.0): extensions register into it on
    // activation; the event-draft service reads it live.
    const calendarWriters = createCalendarWriterRegistry();
    const senderLookup = followerLookup(
      composeSenders(
        buildBundledSenders({ store: p.store, logSink: p.logSink }),
        p.senders,
      ),
      p.readOnly,
      {
        ownsAccount: (id) => p.sync.ownsAccount(id),
        ownerOf: async (id) =>
          (await p.store.account(id))?.ownerDeviceId ?? null,
        deviceId: () => p.sync.deviceId(),
        deviceName: (id) => p.sync.deviceName(id),
      },
    );
    const documentBytes = createDocumentBytes({
      document: (id) => p.readsFor('other').document(id),
      account: (id) => p.store.account(id),
      sources: p.sources,
      session: (a, signal) => p.engine.session(a, signal, 'owner-mail'),
    });
    const outbound = createOutboundService({
      store: p.store,
      attachments: createAttachments({
        documentBytes,
        blocked: [host.userDataDir],
      }),
      prefs: p.prefs,
      senders: senderLookup,
      descriptorFor: (id) => p.sources.get(id)?.descriptor,
      logSink: p.logSink,
    });
    // Rows stuck in 'sending' can only mean a previous process died
    // mid-send. Awaited (not fire-and-forget): this sweep must complete
    // before the MCP server starts serving — the store's db.run crosses the
    // worker-thread bridge, so a floating promise here could still be in
    // flight when the HTTP listener accepts its first confirm request.
    // A transient DB-bridge failure here must not abort boot (mirrors the
    // extensionsPlatform.start() guard below) — startMcp/createTray/
    // resumeAccounts/createWindow must all still run; any 'sending' rows
    // left behind are simply picked up by the next boot's sweep.
    // Calendar event drafts (calendar spec §5): gated exactly as mail —
    // confirm modes, URL origins and the link secret come from `outbound`.
    const calendarOut = createCalendarOutService({
      store: p.store,
      writers: followerLookup(calendarWriters, p.readOnly),
      sources: p.sources,
      ctx: () => outbound.context(),
      prefs: p.prefs,
      vaultScope: async (id) => (await p.store.vault.load(id))?.scope,
      logSink: p.logSink,
      readOnly: p.readOnly,
      // Same job the tray's Sync now triggers; it skips a run in progress.
      onChanged: (a) =>
        void p.scheduler.trigger(`source:${a.source}:${a.id}`).catch(() => {}),
    });
    // Owner-only route for the assistant's email channel: no Outbox, the
    // recipient is pinned to the account's own address by core.
    const ownerMail = createOwnerMail({
      account: (id) => p.store.account(id),
      sources: p.sources,
      senders: senderLookup,
      session: (a, signal) => p.engine.session(a, signal, 'owner-mail'),
    });
    await installCrashRecovery({
      platform: p,
      recoverCalendar: () => calendarOut.recover(),
      recoverOutbox: () => p.store.outbox.recoverOrphanedSending(),
      logSink: p.logSink,
    });

    // Scheduled sends (spec §8): one tick now settles anything due or
    // missed while the app was closed, then every 30 s.
    const outboxScheduler = createOutboxScheduler({
      store: p.store,
      service: outbound,
      logSink: p.logSink,
      readOnly: p.readOnly,
    });
    outboxScheduler.start();
    // Event drafts expire after 7 days; a coarse sweep is enough.
    const eventExpiry = setInterval(() => {
      if (p.readOnly()) return;
      calendarOut
        .expireOverdue()
        .catch((err) =>
          p.logSink.log(
            'calendar-out',
            'warn',
            `expire sweep failed: ${String(err)}`,
          ),
        );
    }, 60_000);
    eventExpiry.unref?.();
    stopOutboxScheduler = () => {
      outboxScheduler.stop();
      clearInterval(eventExpiry);
    };

    // Tells the renderer the outbox may have changed (create, a transition,
    // an expired sweep, or an account removal cascade) without a per-row
    // payload — coalesced internally to one push per 50 ms.
    wireOutboxPush(p.store, broadcast);
    wireCalendarOutPush(p.store, broadcast);

    // Bundled SQL runner (webpack `sqlRunner` entry): prod `sqlRunner.js`, dev
    // `sqlRunner.bundle.dev.js`.
    const sqlRunnerFile =
      [
        path.join(__dirname, 'sqlRunner.js'),
        path.join(__dirname, 'sqlRunner.bundle.dev.js'),
      ].find((f) => fs.existsSync(f)) ?? path.join(__dirname, 'sqlRunner.js');
    // Late-bound: the shared-folders service is built further down.
    let sharedSourceHost: SharedFolderHost | null = null;
    const mcpServer = await startMcp({
      query: p.readsFor('mcp'),
      sqlExecutor: createSqlRunner({
        spawn: () =>
          utilityRunnerChild(
            sqlRunnerFile,
            { KIA_SQL_RUNNER_DB: path.join(dataDir, 'kiagent.db') },
            (line) => p.logSink.log('sql-runner', 'warn', line),
          ),
        timeoutMs: 10_000,
        idleMs: 300_000,
        log: (level, msg) => p.logSink.log('sql-runner', level, msg),
      }),
      logSink: p.logSink,
      dataDir,
      onActivity: (rec) => act.append(rec),
      // Real app boot: heal HTTP client configs left pointing at a port we
      // no longer hold (candidate-port fallback). Tests never set this.
      reconcileClientConfigs: true,
      outbound: guardDraftTools(outbound, {
        readOnly: () => p.sync.readOnly(),
        masterName: () => p.sync.masterName(),
      }),
      calendar: calendarOut,
      localPathOf: async (doc) =>
        (await sharedSourceHost?.sharedFolders.pathOf(doc)) ?? null,
      admission: p.admission,
      sync: {
        accounts: async () =>
          (await p.readsFor('mcp').accounts()).map((a) => ({
            id: a.id as string,
            source: a.source,
            identifier: a.identifier,
            status: a.status,
            lastSyncAt: a.lastSyncAt ?? null,
            lastError: a.lastError ?? null,
          })),
        // The engine gate's own rule (sync/role.ts gateEngine).
        runsHere: (id) =>
          !p.sync.ownedByOther(id) &&
          (!p.sync.readOnly() || p.sync.ownsAccount(id)),
        syncedOn: () =>
          p.sync.readOnly()
            ? (p.sync.masterName() ?? 'another device')
            : 'another device',
        hasJob: (jobId) => p.scheduler.has(jobId),
        trigger: (jobId) => p.scheduler.trigger(jobId),
        isRunning: (id) => p.engine.isRunning(id as AccountId),
      },
    });
    mcp = mcpServer;
    check();
    host.bootTimer.mark('mcp');
    // Acceptance aid (§6): KIA_READ_DIAG_FILE=/path makes the app rewrite its
    // read diagnostics every 5 s so the external MCP probe can read them.
    if (process.env.KIA_READ_DIAG_FILE) {
      startReadDiagnosticsDump(
        process.env.KIA_READ_DIAG_FILE,
        () => p.readDiagnostics(mcp?.sqlDiagnostics() ?? null),
        5_000,
      );
    }
    // Onboarding step 2 reconciliation: a client connected in an earlier
    // run (config file already carries our entry) counts as done.
    void mcp
      .clients()
      .then((cs) => {
        if (cs.some((c) => c.connected))
          markOnboardingOnce(p.prefs, 'mcpConnectedAt').catch(() => {});
      })
      .catch(() => {});

    // ONE consumer of the activity file, two effects: the live feed push
    // and the onboarding first-query latch. Both transports land here (the
    // stdio sibling appends to the same file), and the boot replay batch
    // covers queries served while the app was closed — which is exactly how
    // stdio clients latch step 3 despite living in another process.
    stopActivityWatch = act.watch((recs) => {
      broadcast('push:mcp-activity', recs);
      if (recs.some((r) => r.ok)) {
        markOnboardingOnce(p.prefs, 'firstQueryAt').catch(() => {});
      }
    });

    // THE canonical projection: one push channel carries all live app state.
    // Ownership split: the projection owns the FEED-derived slice (accounts);
    // identity/prefs/processing/mcp live here and change via patchState —
    // seeded from their real sources so the first diff can't regress them.
    // #139: the 5 s tick below counts only when the ledger generation (or
    // the active consumer set) moved; this boot read primes it.
    const ledgerCounter = createLedgerCounter({
      store: p.store,
      activeConsumers: () => p.engine.activeConsumers(),
    });
    const [initialLedger, initialIdentity] = await Promise.all([
      ledgerCounter.count(),
      p.store.identity.get(),
    ]);
    let rev = 0;
    let lastPush: AppStatePush = {
      state: {
        accounts: [],
        processing: {
          pending: initialLedger.pending,
          done: initialLedger.done,
          skipped: initialLedger.skip,
          failed: initialLedger.failed,
          lane: backgroundLaneState(p),
          waiting: null,
          active: [],
          download: null,
        },
        mcp: { port: mcp?.port ?? null, clients: 0 },
        identity: initialIdentity,
        prefs: p.prefs.get(),
        extensions: [],
        ready: false,
      },
      seq: 0,
      rev,
    };
    const projection = p.createAppProjection({
      prefs: () => p.prefs.get(),
      identity: () => p.store.identity.get(),
      mcp: () => ({ port: mcp?.port ?? null, clients: 0 }),
      processing: async () => {
        const all = await p.store.ledgerCountsAll(p.engine.activeConsumers());
        return {
          ...lastPush.state.processing,
          pending: all.pending,
          done: all.done,
          skipped: all.skip,
          failed: all.failed,
        };
      },
      extensions: () => extensionsPlatform?.snapshot() ?? [],
      archiveSnapshot: (account) => p.store.archiveSnapshot(account),
    });
    // Coalesce push:app-state broadcasts (#5). Core broadcasts on every feed
    // diff (per DB write) with no throttle, so active backfill re-clones
    // AppState to every window per write and floods the renderer, freezing the
    // UI. Trailing-edge throttle: diffs within the window collapse into one
    // broadcast of the latest lastPush (the renderer already drops out-of-order
    // revs). Interim mitigation; the real fix is DB/projection work off the
    // main thread.
    const APP_STATE_PUSH_THROTTLE_MS = 100;
    let appStatePushScheduled = false;
    const flushAppStatePush = () => {
      appStatePushScheduled = false;
      broadcast('push:app-state', lastPush);
    };
    const scheduleAppStatePush = () => {
      if (appStatePushScheduled) return;
      appStatePushScheduled = true;
      setTimeout(flushAppStatePush, APP_STATE_PUSH_THROTTLE_MS).unref?.();
    };
    const patchState = (partial: Partial<AppState>) => {
      rev += 1;
      lastPush = {
        state: { ...lastPush.state, ...partial },
        seq: lastPush.seq,
        rev,
      };
      scheduleAppStatePush();
    };
    // Prod emits `extensionHost.js`; the dev webpack config (`.erb/configs/
    // webpack.config.main.dev.ts`) suffixes every entry with
    // `.bundle.dev.js`. Resolved once here, same existsSync-fallback
    // pattern as the MCP stdio entry in core/mcp/server.ts.
    const extensionHostScript = [
      path.join(__dirname, 'extensionHost.js'),
      path.join(__dirname, 'extensionHost.bundle.dev.js'),
    ].find((f) => fs.existsSync(f));
    const ghCache = createGitHubCache({
      cacheFile: path.join(host.userDataDir, 'extensions', 'github-cache.json'),
    });
    const ghSource = createGitHubSource({ cache: ghCache });
    // The broker (and bundled-source registration) must exist BEFORE the
    // extension platform: extension-contributed oauth sources register
    // their profile into this broker and their refresher into p.refreshers
    // — the SAME Map instance bootCore handed to the engine deps.
    const broker = createConnectBroker(p, (event: ConnectEvent) =>
      broadcast('push:connect', event),
    );
    const bundledRefreshers = registerBundledSources(
      (s) => p.sources.register(s),
      broker,
      p.converter,
      path.join(host.userDataDir, 'expand-tmp'),
      () => sharedSourceHost,
    );
    for (const [sourceId, refresher] of bundledRefreshers)
      p.refreshers.set(sourceId, refresher);

    const syncNow = (): void => {
      void (async () => {
        const jobs = await p.scheduler.jobs();
        // Account syncs only — worker:* jobs (vision/OCR sweeps) run on
        // their own cadence. trigger() skips jobs already mid-run.
        await Promise.allSettled(
          jobs
            .filter((j) => j.id.startsWith('source:'))
            .map((j) => p.scheduler.trigger(j.id)),
        );
        // #140 (spec: tray Sync now is explicit): boot-pending accounts have no cadence job yet.
        bootQueue?.syncPending(await p.store.read.accounts());
      })();
    };

    // Cheap (a closure over the service, no I/O) — safe to build here even
    // though the loopback server (startMcp above) already built its OWN
    // instance for server.ts's /outbox/* dispatch. Both share all state
    // through `outbound`, so having two instances is intentional, not a
    // duplication bug.
    const outboundRoutes = createOutboundRoutes(outbound, calendarOut);
    const sharedFolders = await createSharedFolders({
      // Before start-up: a local-folder scan the migration restarts must
      // already see the shared folders it leaves alone.
      publish: (api) => {
        sharedSourceHost = { db: p.db, sharedFolders: api };
      },
      db: p.db,
      sync: p.sync,
      hashFile: sha256File,
      trash: (file) => host.trashItem(file),
      now: () => Date.now(),
      log: (level, msg) => p.logSink.log('shared-folders', level, msg),
      ensureAccount: async () => {
        const account = await p.store.createAccount({
          source: SHARED_SOURCE_ID,
          identifier: SHARED_IDENTIFIER,
          config: {},
          status: 'connecting',
          cadence: sharedFolderDescriptor.cadence,
        });
        runAccount(p, account);
      },
      // Only this device's own local folders: the accounts table holds the
      // other Macs' too, often with the very same absolute paths.
      localFolders: ownLocalFolders({
        accounts: () => p.store.read.accounts(),
        deviceId: () => p.sync.deviceId(),
        roots: (a) => readFolderRoots(a as never).map((r) => r.id),
        // Read fresh each time: the account's loop restarts after each call.
        // applyScope awaits the old loop's stop() (the pull and its reconcile),
        // so nothing built under the old exclusions commits afterwards, then
        // restarts the loop, whose walks read the exclusions anew.
        quiesce: async (accountId) => {
          const account = await p.store.account(accountId as AccountId);
          if (!account) return;
          await p.engine.applyScope(
            account.id,
            {
              config: account.config as FolderScopeUpdate['config'],
              cursor: account.cursor,
              archiveScopeRootIds: [],
              archiveRefs: [],
            },
            JSON.stringify(account.config),
          );
        },
        archive: async (accountId, refs) => {
          const account = await p.store.account(accountId as AccountId);
          if (!account) return;
          await p.engine.applyScope(
            account.id,
            {
              config: account.config as FolderScopeUpdate['config'],
              cursor: account.cursor,
              archiveScopeRootIds: [],
              archiveRefs: refs,
            },
            JSON.stringify(account.config),
          );
        },
      }),
    });
    sharedSourceHost = { db: p.db, sharedFolders };
    closeSharedFolders = () => sharedFolders.close();
    check();
    const extensions = createExtensionPlatform({
      sync: p.sync,
      prefs: p.prefs,
      secrets: p.store.secrets,
      // The user's extension set lives in user_prefs; only a device that can
      // write the table changes it.
      extensionSet: {
        get: () => p.prefs.getCore(EXTENSIONS_KEY) as ExtensionsSet | undefined,
        canWrite: () => !p.sync.readOnly(),
        update: (fn) =>
          p.prefs.updateCore(EXTENSIONS_KEY, (cur) =>
            fn(cur as ExtensionsSet | undefined),
          ),
      },
      extDir: path.join(host.userDataDir, 'extensions'),
      bundledDir: host.bundledExtensionsDir,
      dormantExtensions: host.product.dormantExtensions,
      testNetExtensionId: host.product.testNetExtensionId,
      bundledDataDir: path.join(host.userDataDir, 'bundled-extensions-data'),
      db: p.db,
      reads: p.readsFor('extension'),
      attention,
      fileRoots,
      // Declared roots (platform 2.3.0) may never cover the app's own data.
      userDataDir: host.userDataDir,
      mainApiForPlugin: (callerPluginId) =>
        buildMainApi({
          callerPluginId,
          patchAppState: (partial) => patchState(partial),
          store: p.store,
          fileRoots,
          persistFileRoots,
          // Non-null: startMcp() above is awaited before this point, so
          // `mcp` always holds a live McpServerHandle here.
          mcp: mcp!,
          app: host.app,
          dataDir,
          tray: host.tray(),
          ui: { openWindow: () => host.openWindow() },
          outbound: {
            service: outbound,
            calendar: calendarOut,
            routes: outboundRoutes,
          },
          readMessageEvidence: (input) => p.engine.readMessageEvidence(input),
          ownerMail,
          documents: documentBytes,
          sharedFolders,
          inference: p.inference,
          busy,
          runAccount: (account) => runAccount(p, account),
          applyFolderScope: async (accountId, update, configAtOpen) => {
            await p.engine.applyScope(accountId, update, configAtOpen);
          },
        }),
      store: p.store,
      sources: p.sources,
      senders: p.senders,
      calendarWriters,
      scheduler: p.scheduler,
      registerTool: (t) => (mcp ? mcp.registerTool(t) : () => {}),
      inference: p.inference,
      // Both the extension-facing host.inference.lane() and the
      // platform.lane event resolve through this SAME function, so they
      // can never disagree about why the background lane is (or isn't)
      // open right now.
      // The effective lane: a busy device reads open while a helper answers.
      laneState: () => effectiveLaneState(p),
      logSink: p.logSink,
      notify: (msg) => {
        host.notify(msg);
      },
      transportFactory: (id) =>
        !host.isPackaged && process.env.KIA_TEST_HANG_EXT === id
          ? createHungTransport()
          : utilityProcessTransport(
              extensionHostScript ?? path.join(__dirname, 'extensionHost.js'),
              `kia-ext:${id}`,
              // Child console + crash traces into the app log — a crashing host
              // writes '[ext-host] uncaught: …' to stderr as its only trace.
              (stream, line) =>
                p.logSink.log(
                  `extension:${id}`,
                  stream === 'stderr' ? 'warn' : 'info',
                  line,
                ),
            ),
      onChange: (snapshot) => {
        patchState({ extensions: snapshot });
        attention.setExtensions(snapshot);
        host.bootTimer.observe(snapshot);
        bootQueue?.onSnapshot(snapshot);
      },
      download: async (ref) => {
        if (ref.startsWith('github:')) {
          // Pinned to the repository as GitHub names it NOW (renames and
          // transfers followed), plus its numeric id for the publisher guard.
          try {
            const resolved = await ghSource.resolveGitHubRef(ref);
            const bytes = await ghSource
              .downloadAsset(resolved.tarballUrl)
              .catch((e) => {
                throw new InstallSourceError('unreachable', e);
              });
            return {
              bytes,
              pinnedRef: `${formatGitHubRef(resolved.owner, resolved.repo)}@${resolved.tag}`,
              repoId: resolved.repoId,
            };
          } catch (e) {
            if (e instanceof InstallSourceError && e.detail !== undefined)
              host.log.warn(
                `install source unreachable: ${e.detail instanceof Error ? e.detail.message : String(e.detail)}`,
              );
            throw e;
          }
        }
        return { bytes: await ghSource.downloadAsset(ref), pinnedRef: ref };
      },
      oauth: {
        registerProfile: (sourceId, profile) =>
          broker.registerOAuthProfile(sourceId, profile),
        unregisterProfile: (sourceId) =>
          broker.unregisterOAuthProfile(sourceId),
        refreshers: p.refreshers,
      },
    });
    extensionsPlatform = extensions;
    const catalog = createMarketplaceCatalog({
      source: ghSource,
      snapshot: () => extensionsPlatform!.snapshot(),
    });
    const processingStatus = createProcessingStatus({
      countWaiting: () => p.store.visualWaitingCount(VISION_CONSUMER),
      gen: () => p.store.ledgerGen(),
      providers: () =>
        p.inference.providers().map((prov) => ({
          id: prov.id,
          remote: prov.remote === true,
          status: prov.status(),
          ...(prov.id === 'local-asr'
            ? { variants: bundled.localAsr.variants() }
            : {}),
        })),
      activeCalls: p.inference.activeCalls,
      wakeWorkers: () => wakeDeferredWorkers(p.scheduler),
      patch: (partial) =>
        patchState({
          processing: { ...lastPush.state.processing, ...partial },
        }),
      warn: (msg) => host.log.warn(`processing-status: ${msg}`),
    });
    appProjection = p.engine.project(
      projection,
      (state: AppState, seq: Seq) => {
        rev += 1;
        // Onboarding step 1: any account that has ever reached 'live'. Also
        // covers startup — the projection's init() snapshot flows through here.
        if (state.accounts.some((a) => a.account.status === 'live'))
          markOnboardingOnce(p.prefs, 'sourceBackfilledAt').catch(() => {});
        // Take ONLY the feed-derived slice from the projection. Its internal
        // state still carries init()-time snapshots of the other slices; using
        // them here would clobber later patches (a signed-in identity would
        // revert to null on the first sync batch — the sign-in bounce bug).
        lastPush = {
          state: {
            ...state,
            identity: lastPush.state.identity,
            prefs: lastPush.state.prefs,
            processing: lastPush.state.processing,
            mcp: lastPush.state.mcp,
            extensions: lastPush.state.extensions,
          },
          seq,
          rev,
        };
        scheduleAppStatePush();
      },
    );

    // Non-feed slices (prefs, processing counters) refresh on their own clock.
    p.prefs.onChange((prefs) => {
      patchState({ prefs });
      host.onPrefs?.(prefs);
    });
    host.onPrefs?.(p.prefs.get());
    processingStatus.start();
    processingTick = setInterval(async () => {
      // ledgerCountsAll is now an async worker RPC — a transient read failure
      // (e.g. a dead/restarting DB worker) must not escape as an unhandled
      // rejection on the timer. Mirrors scheduler.ts's safeTick guard.
      try {
        // Publication only: admission reads the policy directly (setLanePolicy).
        // This tick is the single publisher: one lane evaluation, shared by
        // platform.lane (refreshLane re-resolves LaneState every tick, so a
        // 'battery' -> 'until-synced' reason change still emits once) and the
        // status module (push + worker wake). refreshLane() never throws.
        const lane = backgroundLaneState(p);
        // The wake is consumed ONCE and shared, so extensions and workers
        // both hear about a reopening that happened between two ticks.
        // What may run now: also open while a helper answers for a busy
        // device. The status row below keeps the real reason.
        const wake = effectiveLaneState(p) === 'open' && takeLaneWake(p);
        extensionsPlatform?.refreshLane(wake);
        processingStatus.tick(lane, wake);
        // #139: no ledger read at idle — only after something moved it.
        const all = await ledgerCounter.countIfChanged();
        if (!all) return;
        const processing = {
          pending: all.pending,
          done: all.done,
          skipped: all.skip,
          failed: all.failed,
        };
        const prev = lastPush.state.processing;
        if (
          prev.pending !== processing.pending ||
          prev.done !== processing.done ||
          prev.skipped !== processing.skipped ||
          prev.failed !== processing.failed
        ) {
          patchState({
            processing: { ...lastPush.state.processing, ...processing },
          });
        }
      } catch (err) {
        host.log.warn(`processing-counter refresh failed: ${String(err)}`);
      }
    }, 5_000);
    const tick = processingTick;
    stopProcessing = () => {
      processingStatus.stop();
      clearInterval(tick);
    };

    // Live log streaming to the Logs screen.
    void (async () => {
      for await (const records of p.logs.tail()) {
        if (records.length) broadcast('push:logs', records);
      }
    })();

    const factoryResetDeps = (): FactoryResetDeps => {
      return {
        store: p.store,
        platform: extensionsPlatform,
        resetSync: () => p.sync.resetState(),
        journal: createResetJournal(dataDir),
        // Stop every real account's sync loop BEFORE the wipe. engine.pause
        // is the one public API that both aborts a running loop and (via its
        // pause intent) blocks the cadence tick from resurrecting it
        // mid-wipe. Without this, still-running loops keep committing
        // against deleted accounts (throwing 'commit: unknown account') while
        // the wipe runs. Worker consumers are deliberately NOT stopped —
        // nothing restarts them until relaunch, and the emptied work ledger
        // idles them out on its own.
        pauseSources: async () => {
          bootChain?.stop(); // an interactive Reset all halts the boot chain first (#140)
          const accounts = await p.store.read.accounts();
          for (const account of accounts) {
            if (account.source === 'worker') continue;
            await p.engine.pause(account.id).catch(() => {});
          }
        },
        // Only once the core wipe committed (factory-reset.ts): a reset that
        // stopped at an extension leaves the accounts in place.
        afterCoreWipe: async () => {
          // A factory reset is THE legitimate un-latch: the get-started
          // checklist must come back for the now-empty app. Configuration
          // prefs (theme, processing) survive — only the onboarding latches
          // reset.
          await p.prefs.patch({
            onboarding: {
              sourceBackfilledAt: null,
              mcpConnectedAt: null,
              firstQueryAt: null,
              dismissedAt: null,
            },
          });
          // The feed names titles of documents the reset just deleted —
          // truncate it with them. No push needed: the panel re-pulls
          // mcp-activity:recent on next mount (reset lives on Settings;
          // Connection isn't mounted).
          activity?.reset();
          patchState({ identity: null, accounts: [] });
        },
      };
    };

    startTail = async (phases) => {
      // #140 window-first boot: the order lives in boot-tail.ts; this block only
      // wires it. Utility-process extensions start AFTER the window.
      const journal = createResetJournal(dataDir);
      const queue = createBootQueue({
        readAccount: (id: AccountId) => p.store.account(id),
        isRegistered: (sourceId) => p.sources.get(sourceId) !== undefined,
        onRegister: (cb) => p.sources.onRegister(cb),
        runAccount: (account) => {
          runAccount(p, account);
        },
        log: (level, msg) => p.logSink.log('engine', level, msg),
      });
      const background = new AbortController();
      bootQueue = queue;
      bootChain = {
        stop: () => {
          background.abort();
          queue.stop();
        },
      };
      // The ONE scheduler start, for both boot paths (bootTail's interrupted-
      // reset branch and startBackground's step).
      const startScheduler = (): void => {
        p.scheduler.start();
        // #59 §0: one-shot, paged, in the background. Re-drive stays gated
        // until it finishes; its completion arms the lane wake.
        p.startLedgerRekey();
      };
      const finishedReset = await bootTail({
        journalPending: () => journal.pending(),
        finishInterruptedReset: () =>
          finishInterruptedReset({
            journal,
            confirmFinish: () =>
              host.confirm({
                message: 'Reset all did not finish',
                detail:
                  'The last Reset all stopped before it was done, so some of ' +
                  'your data may be deleted already and some not. Finish it now ' +
                  'to delete the rest, or keep what is left.',
                confirmLabel: 'Finish reset',
                cancelLabel: 'Keep what is left',
              }),
            loadExtensions: () => extensions.load(),
            reset: () => runFactoryReset(factoryResetDeps()),
          }),
        loadExtensions: () => extensions.load(),
        armQueue: () => queue.arm(extensions.snapshot()),
        startInProcess: () => extensions.startInProcess(),
        startAllExtensions: () => extensions.start(),
        resumeAll: async () => {
          await resumeAccounts(p);
        },
        startScheduler,
        // The host registers its own 'activate' handler in the same phase.
        registerActivate: () => {},
        createWindow: () => phases.afterInProcessExtensions(),
        startBackground: () =>
          startBackground({
            resumeReady: async (signal) => {
              await resumeAccounts(p, { defer: (a) => queue.defer(a), signal });
            },
            startScheduler,
            startUtilityExtensions: async () => {
              // The boot signal: quit / Reset all cancels pending activations
              // before any further utility host spawns (#140).
              await extensions.startUtility(background.signal);
              // The user's extensions follow them: seed the set once from what
              // is installed (a device that can write), then bring this device
              // in line with it. A connector that fails retries every hour.
              void syncExtensions(extensions, p);
              // 'all settled' comes from statuses, not from startUtility()
              // returning (a handshake retry resolves start early).
              host.bootTimer.armSettled(extensions.snapshot());
            },
            mark: (step, detail) => host.bootTimer.mark(step, detail),
            log: (level, msg) => p.logSink.log('platform', level, msg),
            signal: background.signal,
          }),
        mark: (step, detail) => host.bootTimer.mark(step, detail),
        logError: (err) =>
          p.logSink.log(
            'platform',
            'error',
            'extension platform failed to start',
            {
              error: err instanceof Error ? err.message : String(err),
            },
          ),
      });
      if (finishedReset) {
        const nameOf = (id: string) =>
          extensions.snapshot().find((e) => e.id === id)?.name ?? id;
        host.inform({
          type: finishedReset.ok ? 'info' : 'warning',
          message: finishedReset.ok
            ? 'Reset all finished'
            : 'Reset all did not finish',
          detail: describeResetOutcome(finishedReset, nameOf),
        });
      }
    };

    return {
      platform: p,
      lastPush: () => lastPush,
      patchState,
      bundled,
      extensions,
      catalog,
      broker,
      outbound,
      calendarOut,
      attention,
      mcp: mcpServer,
      activity: act,
      refreshWaiting: () => processingStatus.refreshWaiting(),
      startAccount: (account) => {
        if (bootQueue) bootQueue.runOrQueue(account, 'explicit');
        else runAccount(p, account);
      },
      syncNow,
      factoryResetDeps,
    };
  };

  const ready = build().catch(async (err: unknown) => {
    if (!stopping) throw err;
    await teardown();
    throw new RuntimeStopped();
  });
  // The host awaits `ready`; this only keeps a stop() before that await from
  // surfacing as an unhandled rejection.
  ready.catch(() => {});

  return {
    ready,
    async start(phases) {
      await ready;
      check();
      await startTail?.(phases);
    },
    async stop() {
      if (stopping) return;
      stopping = true;
      bootChain?.stop(); // #140: nothing further resumes or starts once stopping
      await teardown();
      // Construction that was mid-step sees the stop at its next check and
      // tears down what it had just acquired: wait for that, but never let a
      // step that hangs hold the quit.
      await Promise.race([
        ready.then(
          () => {},
          () => {},
        ),
        new Promise((r) => {
          setTimeout(r, STOP_WAIT_MS).unref?.();
        }),
      ]);
    },
  };
}
