// src/main/updater/ipc.ts
import type { InvokeHandlers } from '@shared/ipc';

import type { UpdateState, UpdaterManager } from './types';

/** The three update channels, as a slice of main's exhaustive handler map.
 *
 *  These are RETURNED rather than registered. Registering them here — through
 *  a stringly-typed `handle(channel: string, …)` seam, which is what this was
 *  — put them outside the one place that can be checked for completeness, and
 *  cost two `as never` casts at the call site to bridge the untyped bus back
 *  to the typed contract. Handing main a `Pick` keeps the module's test seam
 *  (the record is directly callable) without the hole. */
export function updaterInvokeHandlers(
  manager: UpdaterManager,
): Pick<
  InvokeHandlers,
  'update:get-state' | 'update:check' | 'update:quit-and-install'
> {
  return {
    'update:get-state': () => manager.getState(),
    'update:check': () => manager.check(),
    'update:quit-and-install': () => {
      manager.quitAndInstall();
    },
  };
}

/** The push half, which has no channel-completeness question to answer.
 *  Returns an unsubscribe fn. */
export function subscribeUpdaterState(
  manager: UpdaterManager,
  broadcast: (state: UpdateState) => void,
): () => void {
  return manager.onStateChange(broadcast);
}
