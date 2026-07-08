import type log from 'electron-log';
import type { UpdateState } from './types';

/**
 * A native notification to surface. The concrete OS call (Electron's
 * `Notification`) is injected via `UpdateNotifierDeps.notify` so this module
 * stays free of Electron runtime state and unit-testable.
 */
export interface NotifyOptions {
  title: string;
  body: string;
  /** Invoked when the user clicks the notification. */
  onClick: () => void;
}

export interface UpdateNotifierDeps {
  /** Show a native OS notification. */
  notify: (opts: NotifyOptions) => void;
  /** Restart and install the already-downloaded update. */
  quitAndInstall: () => void;
  log: typeof log;
}

export interface UpdateNotifier {
  /**
   * Feed every update-state transition. Fires a one-shot native notification
   * the moment an update finishes downloading, then stays quiet until a
   * different version is ready (the periodic re-check loop re-emits
   * `downloaded` without re-nagging).
   */
  handle(state: UpdateState): void;
}

/**
 * Gentle native nudge: notify once per downloaded version; clicking restarts
 * into the new build. Deliberately silent on `available`/`downloading` — the
 * update is auto-downloaded in the background, so the only moment worth
 * interrupting the user is when it is ready to install instantly.
 */
export function createUpdateNotifier(deps: UpdateNotifierDeps): UpdateNotifier {
  let lastNotifiedVersion: string | null = null;
  return {
    handle(state: UpdateState): void {
      if (state.status !== 'downloaded') return;
      const { version } = state;
      if (!version || version === lastNotifiedVersion) return;
      lastNotifiedVersion = version;
      try {
        deps.notify({
          title: `KIAgent ${version} is ready`,
          body: 'Click to restart and update now.',
          onClick: () => deps.quitAndInstall(),
        });
      } catch (e) {
        deps.log.warn('[updater] native notification failed', e);
      }
    },
  };
}
