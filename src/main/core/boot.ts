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
  SchedulerEnv,
  Sender,
  Source,
  SourceDescriptor,
  Worker,
} from '@shared/contracts';

import { openDbInWorker } from '../db/worker-client';
import { createAppProjection } from './app-projection';
import type { AppStateExtras } from './app-projection';
import { createConverter } from './engine/convert';
import { createEngine } from './engine/engine';
import type { LogSink } from './engine/engine';
import { createInference } from './inference';
import type { InferencePlane } from './inference';
import { detectLanguages } from './language';
import { createLogs } from './logs';
import { createPrefs } from './prefs';
import { createScheduler } from './scheduler';
import type { CoreScheduler } from './scheduler';
import { openStore } from './store/store';
import type { CoreStore } from './store/store';

export interface BootDeps {
  dataDir: string;
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
  env(): SchedulerEnv;
  /** Bundled `dbWorker` entry file — the corpus SQLite connection is hosted in
   *  this worker thread so its synchronous calls never block the main loop. */
  dbWorkerFile: string;
}

export interface SourceRegistry {
  register(source: Source): void;
  get(id: string): Source | undefined;
  list(): SourceDescriptor[];
  unregister(id: string): void;
}

/** The one in-process source registry: bundled sources register here at boot,
 *  extension sources through `extension-platform.ts:338`
 *  (`deps.sources.register(makeSource(s))`). Lifted out of `bootCore` so
 *  `list()`'s derivation below is unit-testable — `bootCore` cannot run
 *  without a DB worker thread and nothing in the repo boots it in a test. The
 *  body is byte-identical to the literal it replaces, apart from `list()`. */
export function createSourceRegistry(): SourceRegistry {
  const registry = new Map<string, Source>();
  return {
    register(source) {
      registry.set(source.descriptor.id, source);
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
  store: CoreStore;
  engine: ReturnType<typeof createEngine>;
  scheduler: CoreScheduler;
  inference: InferencePlane;
  prefs: Prefs;
  logs: LogStore;
  logSink: LogSink;
  sources: SourceRegistry;
  senders: SenderRegistry;
  /** Per-source OAuth refreshers; source families add theirs at registration. */
  refreshers: Map<string, (creds: Credentials) => Promise<Credentials | null>>;
  convert(input: DocumentInput): Promise<DocumentInput>;
  createAppProjection(
    extras: AppStateExtras,
  ): ReturnType<typeof createAppProjection>;
  shutdown(): Promise<void>;
}

/**
 * Construction happens once, here. Everything downstream reads the platform —
 * no DI styles, no lazy getters, no module globals.
 */
export async function bootCore(deps: BootDeps): Promise<CorePlatform> {
  const { store: logStore, sink } = createLogs(path.join(deps.dataDir, 'logs'));
  const prefs = createPrefs(deps.dataDir);
  // The corpus SQLite connection lives in a worker thread (the store is
  // AppDb-driven, so every read/write and the relocated commit transaction
  // cross the bridge); this is what keeps backfill off the main event loop.
  const db = await openDbInWorker(
    path.join(deps.dataDir, 'kiagent.db'),
    deps.dbWorkerFile,
  );
  const store = openStore(db, {
    encrypt: deps.encrypt,
    decrypt: deps.decrypt,
    detectLanguages,
  });
  const inference = createInference(sink);
  const scheduler = createScheduler(store, deps.env, sink);
  const convert = createConverter(sink);

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
  });

  return {
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
    createAppProjection,
    shutdown: async () => {
      scheduler.stop();
      await engine.stopAll();
      await store.close();
    },
  };
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
        if (
          fresh &&
          fresh.status !== 'paused' &&
          fresh.status !== 'needsReauth'
        )
          platform.engine.run(fresh);
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
  if (account.status === 'paused' || account.status === 'needsReauth') return;
  runAccount(platform, account);
}

/** Resume sync for every non-paused account and register cadence jobs. */
export async function resumeAccounts(
  platform: CorePlatform,
): Promise<Map<string, Handle>> {
  const handles = new Map<string, Handle>();
  const accounts = await platform.store.read.accounts();
  for (const account of accounts) {
    if (account.source === 'worker') continue; // synthetic accounts don't sync
    if (account.status === 'paused') continue;
    // Same resting-state rule as the cadence tick: a needsReauth account
    // must not resume hammering a revoked credential at every boot.
    if (account.status === 'needsReauth') continue;
    if (!platform.sources.get(account.source)) {
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

/** Evaluate the processing window and say WHY it's closed when it is. */
export function backgroundLaneState(
  platform: CorePlatform,
  now = new Date(),
): LaneState {
  const p = platform.prefs.get().processing;
  if (!p.enabled) return 'disabled';
  const { env } = platform.scheduler;
  if (env.onBattery) return 'battery';
  switch (p.window) {
    case 'always':
      return 'open';
    case 'night': {
      const h = now.getHours();
      return h >= 22 || h < 7 ? 'open' : 'until-night';
    }
    case 'idle':
    default:
      return env.userActive ? 'until-idle' : 'open';
  }
}

/** Evaluate the processing window: is the background inference lane open? */
export function backgroundLaneOpen(
  platform: CorePlatform,
  now = new Date(),
): boolean {
  return backgroundLaneState(platform, now) === 'open';
}
