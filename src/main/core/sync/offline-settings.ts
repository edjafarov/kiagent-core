/** Phase 6c wiring: a setting changed on a follower with no leader reachable
 *  applies here at once and is delivered later. Everything else a follower
 *  forwards still refuses. Main calls this once, after the preferences and the
 *  sync service exist. */
import type { CorePrefs } from '../prefs';
import { forwardCore, type OfflineHandler, type OfflineHandlers } from './forward-core';
import { extensionEnabledKey } from './settings-queue';
import type { SyncService } from './service';

export function installOfflineSettings(
  prefs: CorePrefs,
  sync: Pick<SyncService, 'forward' | 'enqueue' | 'onQueueChange'>,
): OfflineHandlers {
  prefs.setOfflineQueue({ enqueue: (r, o) => sync.enqueue(r, o), nowMs: Date.now });
  // No `onNoMaster`: a setting the queue took shows no refusal. A rejection of
  // the queue itself reaches the caller as an ordinary error.
  prefs.setForwardUser(async (user) => {
    await forwardCore(sync, 'prefs:patch', user);
  });
  prefs.setForwardExt(async (key, value) => {
    await forwardCore(sync, 'prefs:set-ext', { key, value });
  });
  sync.onQueueChange((e) => prefs.onQueueChange(e));
  const setEnabled: OfflineHandler = async (req, runLocal) => {
    const { id, enabled } = req as { id: string; enabled: boolean };
    const r = (await runLocal()) as { ok: boolean };
    if (r.ok) await prefs.queueExtensionEnabled(id, enabled);
    return r;
  };
  setEnabled.held = (req) => prefs.hasQueued(extensionEnabledKey((req as { id: string }).id));
  return { 'extension:set-enabled': setEnabled };
}

/** Boot, once the preferences have attached: what was queued before the last
 *  quit shows again. */
export async function restoreOfflineSettings(
  prefs: CorePrefs,
  sync: Pick<SyncService, 'queuedSettings'>,
): Promise<void> {
  await prefs.ready;
  prefs.restoreQueued(await sync.queuedSettings());
}
