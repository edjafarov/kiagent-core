// src/main/updater/updater.ts
import type { UpdateState, UpdaterDeps, UpdaterManager } from './types';

/** Normalize an unknown thrown value to a user-readable message. */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * macOS auto-update is impossible without a Developer ID signature; an unsigned
 * build makes electron-updater throw "Could not get code signature". Keep macOS
 * gated off until the Apple cert lands (Phase 2), then flip this to `true`.
 */
export const MAC_UPDATES_ENABLED = false;

const CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createUpdater(deps: UpdaterDeps): UpdaterManager {
  const { autoUpdater, log, isPackaged, platform, currentVersion } = deps;
  const now = deps.now ?? (() => Date.now());
  const subscribers = new Set<(s: UpdateState) => void>();

  // Eligibility gate (no network when disabled).
  let disabledReason: string | null = null;
  if (!isPackaged && !deps.devUpdates) disabledReason = 'dev';
  else if (platform === 'darwin' && !MAC_UPDATES_ENABLED)
    disabledReason = 'unsigned-macos';

  let state: UpdateState = disabledReason
    ? {
        status: 'disabled',
        reason: disabledReason,
        currentVersion,
        version: null,
      }
    : { status: 'idle', currentVersion, version: null };

  function set(next: Partial<UpdateState>): void {
    state = { ...state, ...next };
    // The renderer push is owned solely by registerUpdaterIpc via onStateChange;
    // do not broadcast here or every transition would be pushed twice.
    for (const cb of subscribers) cb(state);
  }

  if (!disabledReason) {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () =>
      set({ status: 'checking', error: undefined }),
    );
    autoUpdater.on('update-available', (info: unknown) =>
      set({ status: 'available', version: versionOf(info) }),
    );
    autoUpdater.on('download-progress', (p: unknown) =>
      set({
        status: 'downloading',
        percent: progressPercent(p),
        bytesPerSecond: progressBps(p),
      }),
    );
    autoUpdater.on('update-downloaded', (info: unknown) =>
      set({ status: 'downloaded', version: versionOf(info), percent: 100 }),
    );
    autoUpdater.on('update-not-available', () =>
      set({ status: 'up-to-date', version: null, checkedAt: now() }),
    );
    autoUpdater.on('error', (err: unknown) =>
      set({ status: 'error', error: errMsg(err) }),
    );
  }

  let delayTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  async function check(): Promise<UpdateState> {
    if (disabledReason) return state;
    set({ status: 'checking', error: undefined });
    try {
      await autoUpdater.checkForUpdates();
    } catch (e) {
      set({ status: 'error', error: errMsg(e) });
    }
    return state;
  }

  return {
    getState: () => state,
    check,
    quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
    onStateChange(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    start() {
      if (disabledReason) return;
      delayTimer = setTimeout(() => void check(), CHECK_DELAY_MS);
      intervalTimer = setInterval(() => void check(), CHECK_INTERVAL_MS);
    },
    stop() {
      if (delayTimer) clearTimeout(delayTimer);
      if (intervalTimer) clearInterval(intervalTimer);
      delayTimer = null;
      intervalTimer = null;
    },
  };
}

function versionOf(info: unknown): string | null {
  return (info as { version?: string } | null)?.version ?? null;
}
function progressPercent(p: unknown): number | undefined {
  return (p as { percent?: number } | null)?.percent;
}
function progressBps(p: unknown): number | undefined {
  return (p as { bytesPerSecond?: number } | null)?.bytesPerSecond;
}
