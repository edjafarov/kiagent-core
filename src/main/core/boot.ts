import path from 'path';

import type {
  Account,
  Credentials,
  DocumentInput,
  Handle,
  LogStore,
  Prefs,
  SchedulerEnv,
  Source,
  SourceDescriptor,
  Worker,
} from '@shared/contracts';

import { openDb } from '../db/app-db';
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
}

export interface SourceRegistry {
  register(source: Source): void;
  get(id: string): Source | undefined;
  list(): SourceDescriptor[];
  unregister(id: string): void;
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
  // Task 4 swaps this in-process handle for openDbInWorker (moving the corpus
  // SQLite work off the main thread); the store is AppDb-driven either way.
  const db = await openDb(path.join(deps.dataDir, 'kiagent.db'));
  const store = openStore(db, {
    encrypt: deps.encrypt,
    decrypt: deps.decrypt,
    detectLanguages,
  });
  const inference = createInference(sink);
  const scheduler = createScheduler(store, deps.env, sink);
  const convert = createConverter(sink);

  const registry = new Map<string, Source>();
  const sources: SourceRegistry = {
    register(source) {
      registry.set(source.descriptor.id, source);
    },
    get: (id) => registry.get(id),
    list: () => [...registry.values()].map((s) => s.descriptor),
    unregister(id) {
      registry.delete(id);
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
        // and gets restarted here.
        if (platform.engine.isRunning(account.id)) return;
        const fresh = await platform.store.account(account.id);
        if (fresh && fresh.status !== 'paused') platform.engine.run(fresh);
      },
    );
  }
  return handle;
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

/** Evaluate the processing window: is the background inference lane open? */
export function backgroundLaneOpen(
  platform: CorePlatform,
  now = new Date(),
): boolean {
  const p = platform.prefs.get().processing;
  if (!p.enabled) return false;
  const { env } = platform.scheduler;
  if (env.onBattery) return false;
  switch (p.window) {
    case 'always':
      return true;
    case 'night': {
      const h = now.getHours();
      return h >= 22 || h < 7;
    }
    case 'idle':
    default:
      return !env.userActive;
  }
}
