// src/main/updater/ipc.ts
import type { UpdateState, UpdaterManager } from './types';

/** The handle/broadcast seam from main.ts, injected for tests. */
export interface IpcBus {
  handle: (
    channel: string,
    fn: (e: unknown, payload: unknown) => unknown,
  ) => void;
  broadcast: (channel: string, payload: unknown) => void;
}

/** Wire the update channels to the manager. Returns an unsubscribe fn. */
export function registerUpdaterIpc(
  manager: UpdaterManager,
  bus: IpcBus,
): () => void {
  bus.handle('update:get-state', () => manager.getState());
  bus.handle('update:check', () => manager.check());
  bus.handle('update:quit-and-install', () => {
    manager.quitAndInstall();
  });
  return manager.onStateChange((s: UpdateState) =>
    bus.broadcast('push:update-state', s),
  );
}
