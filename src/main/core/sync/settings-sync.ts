/** The settings-sync wiring main.ts used to hand-build: a setting changed on a
 *  follower with no leader reachable applies here at once and is delivered later
 *  (everything else a follower forwards still refuses); the leader's user_prefs
 *  changes arrive by the feed; connectors retry; a join's offer carries this
 *  device's settings. Main calls `installSettingsSync` once, after the
 *  preferences, the sync service and the extension platform exist. */
import { pickUserKeys, type CorePrefs } from '../prefs';
import type { ExtensionPlatform } from '../../platform/extension-platform';
import {
  forwardCore,
  wrapForwardedChannels,
  type OfflineHandler,
  type OfflineHandlers,
} from './forward-core';
import { extensionEnabledKey } from './settings-queue';
import type { ForwardRunners, SyncService } from './service';

/** One decision for a setting changed on a read-only copy: a key with a row
 *  still waiting goes through the queue (the row is replaced, so the older
 *  value cannot be delivered after the newer); otherwise the leader is asked
 *  once, and with no leader the change is applied here and queued. */
export interface ForwardOrQueueOp {
  keys: string[];
  isHeld: (key: string) => boolean;
  /** Asks the leader. Its answer is the channel's own `{ ok }` value: a
   *  refusal (`ok: false`) is the leader's answer, not a transport failure.
   *  A reply without `ok: true` is treated as refused. */
  forward: () => Promise<{ ok: boolean }>;
  /** A change that must also run on this device (a connector switch); a
   *  failed run queues nothing. */
  runLocal?: () => Promise<{ ok: boolean }>;
  enqueue: (key: string) => Promise<number>;
  apply: { forwarded(): void; queued(key: string, rowId: number): void };
}

const isNoMasterError = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'EXT_SYNC_NO_MASTER';

export async function forwardOrQueue(
  op: ForwardOrQueueOp,
): Promise<'forwarded' | 'forward-refused' | 'queued' | 'local-failed'> {
  if (!op.keys.some(op.isHeld)) {
    try {
      const r = await op.forward();
      // A value the leader refused is never recorded as the setting.
      if (!r.ok) return 'forward-refused';
      op.apply.forwarded();
      return 'forwarded';
    } catch (err) {
      if (!isNoMasterError(err)) throw err;
    }
  }
  if (op.runLocal) {
    const r = await op.runLocal();
    if (!r.ok) return 'local-failed';
  }
  for (const key of op.keys) {
    const rowId = await op.enqueue(key);
    op.apply.queued(key, rowId);
  }
  return 'queued';
}

export interface SettingsSyncDeps {
  prefs: CorePrefs;
  sync: Pick<
    SyncService,
    | 'forward'
    | 'readOnly'
    | 'enqueue'
    | 'onQueueChange'
    | 'discardQueued'
    | 'onApplied'
    | 'setSettingsOffer'
    | 'queuedSettings'
  >;
  extensions: Pick<
    ExtensionPlatform,
    | 'reconcileExtensions'
    | 'failedExtensions'
    | 'hasPendingExtensionRecords'
    | 'offerExtensions'
    | 'unionExtensions'
  >;
  handlers: Record<string, (req: unknown) => unknown>;
  afterPromote: (hook: () => void | Promise<void>) => void;
  syncExtensions: () => Promise<void>;
  onNoMaster: (message: string) => void;
  /** Differs from the brief's `(level, msg)`: keeps the logSink category
   *  ('extensions' here) exactly as main logged it. */
  log: (category: string, level: 'warn', msg: string) => void;
  retryEveryMs: number;
  /** Stamps an acknowledged setting; main passes `Date.now`. */
  nowMs: () => number;
  setInterval: typeof globalThis.setInterval;
}

function installOfflineSettings(
  prefs: CorePrefs,
  sync: Pick<SyncService, 'forward' | 'enqueue' | 'onQueueChange' | 'discardQueued'>,
  opts: {
    nowMs: () => number;
    /** Brings the running connectors in line with the mirrored extension set.
     *  Called after a queued connector switch is discarded: the switch had
     *  already been applied here, and discarding it must undo that. */
    reconcile?: () => Promise<unknown>;
  },
): OfflineHandlers {
  prefs.setOfflineQueue({
    enqueue: (r, o) => sync.enqueue(r, o),
    discard: (id) => sync.discardQueued(id),
    nowMs: opts.nowMs,
  });
  // No `onNoMaster`: a setting the queue took shows no refusal. A rejection of
  // the queue itself reaches the caller as an ordinary error.
  prefs.setForwardUser(async (user) => {
    await forwardCore(sync, 'prefs:patch', user);
  });
  prefs.setForwardExt(async (key, value) => {
    await forwardCore(sync, 'prefs:set-ext', { key, value });
  });
  sync.onQueueChange((e) => {
    prefs.onQueueChange(e);
    if (e.kind === 'discarded' && e.coalesceKey?.startsWith('core.extensions.')) {
      void Promise.resolve()
        .then(() => opts.reconcile?.())
        .catch(() => undefined);
    }
  });
  const setEnabled: OfflineHandler = async (req, runLocal, forward) => {
    const { id, enabled } = req as { id: string; enabled: boolean };
    const key = extensionEnabledKey(id);
    let out: unknown;
    let local: unknown;
    const how = await forwardOrQueue({
      keys: [key],
      isHeld: (k) => prefs.hasQueued(k),
      forward: async () => {
        out = await forward();
        return out as { ok: boolean };
      },
      runLocal: async () => {
        local = await runLocal();
        return local as { ok: boolean };
      },
      enqueue: () => prefs.queueExtensionEnabled(id, enabled),
      apply: { forwarded: () => prefs.ackForwarded(key, enabled), queued: () => undefined },
    });
    return how === 'forwarded' || how === 'forward-refused' ? out : local;
  };
  return { 'extension:set-enabled': setEnabled };
}


export function installSettingsSync(d: SettingsSyncDeps): {
  forwardedLocal: Map<string, (req: unknown) => unknown>;
  coreRunner: ForwardRunners['core'];
} {
  const { prefs, sync, extensions } = d;
  const reconcileLogged = (): Promise<unknown> =>
    extensions
      .reconcileExtensions()
      .catch((err) =>
        d.log('extensions', 'warn', `extension reconcile failed: ${String(err)}`),
      );
  const offlineHandlers = installOfflineSettings(prefs, sync, {
    nowMs: d.nowMs,
    reconcile: reconcileLogged,
  });
  const forwardedLocal = wrapForwardedChannels(
    d.handlers,
    sync,
    d.onNoMaster,
    offlineHandlers,
  );
  // A device that just became able to write seeds the extension set once.
  d.afterPromote(() => d.syncExtensions());
  // A connector that could not install here is tried again every hour.
  const timer = d.setInterval(() => {
    if (
      extensions.failedExtensions().length > 0 ||
      extensions.hasPendingExtensionRecords()
    )
      void d.syncExtensions();
  }, d.retryEveryMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  // What the leader changed in user_prefs arrives by the feed.
  sync.onApplied((tables, meta) => {
    if (tables.includes('user_prefs')) {
      // The extension set is one of the rows that may have changed.
      void prefs
        .refreshUser({
          prefKeys: meta.prefKeys,
          pullStartedAt: meta.pullStartedAt,
        })
        .then(() => extensions.reconcileExtensions())
        .catch((err) =>
          d.log('extensions', 'warn', `extension reconcile failed: ${String(err)}`),
        );
    }
  });
  // A join's offer carries this device's settings and connectors; as the seed
  // it adds what it lacks, through the same paths a user change takes, so it
  // reaches every follower by the feed (spec 7.9 rule 6).
  sync.setSettingsOffer({
    export: async () => ({
      prefs: await prefs.offerable(),
      extensions: extensions.offerExtensions(),
    }),
    import: async (s) => {
      const addedPrefs = await prefs.addMissing(s.prefs);
      const added = await extensions.unionExtensions(s.extensions);
      // The seed installs a joiner's connector the way any device does.
      if (added.length > 0) void reconcileLogged();
      return { prefs: addedPrefs, extensions: added };
    },
  });
  const coreRunner: ForwardRunners['core'] = async (name, req) => {
    // Not an IPC channel: only a follower's `host.prefs.set` sends it, and
    // the leader's own listeners hear it as another device's change.
    if (name === 'prefs:set-ext') {
      const { key, value } = (req ?? {}) as { key?: unknown; value?: unknown };
      if (typeof key !== 'string') throw new Error('prefs:set-ext needs a key');
      await prefs.setExt(key, value, { notify: true });
      return undefined;
    }
    // A copy may only send user keys: a device key in a forwarded patch is
    // this leader's own business, never another device's.
    if (name === 'prefs:patch') return prefs.patch(pickUserKeys(req));
    const local = forwardedLocal.get(name);
    if (!local) throw new Error(`${name} is not a forwarded channel`);
    return local(req);
  };
  return { forwardedLocal, coreRunner };
}

/** Boot, once the preferences have attached and before anything serves an
 *  edit: what was queued before the last quit shows again. A queue that cannot
 *  be read leaves the overlay empty and is logged, never thrown. */
export async function restoreQueuedSettings(
  prefs: Pick<CorePrefs, 'ready' | 'restoreQueued'>,
  sync: Pick<SyncService, 'queuedSettings'>,
  log: (category: string, level: 'warn', msg: string) => void,
): Promise<void> {
  try {
    await prefs.ready;
    prefs.restoreQueued(await sync.queuedSettings());
  } catch (err) {
    log('sync', 'warn', `queued settings were not restored: ${String(err)}`);
  }
}
