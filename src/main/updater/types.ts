// Updater contracts. The renderer-facing state shapes (`UpdateStatus`,
// `UpdateState`) live in the shared IPC contract so both main and renderer
// speak them; the main-only injection seam (`AutoUpdaterLike`, `UpdaterDeps`,
// `UpdaterManager`) lives here because it references electron-log/electron-updater.
import type log from 'electron-log';
import type { UpdateState, UpdateStatus } from '@shared/ipc';

export type { UpdateState, UpdateStatus };

/**
 * The slice of electron-updater's `autoUpdater` the module needs. Declared
 * structurally (not importing the concrete type) so tests can pass a fake
 * EventEmitter without satisfying the full electron-updater surface.
 */
export interface AutoUpdaterLike {
  logger: unknown;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  forceDevUpdateConfig?: boolean;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdaterDeps {
  autoUpdater: AutoUpdaterLike;
  log: typeof log;
  /** `app.isPackaged`. */
  isPackaged: boolean;
  /** `process.platform`. */
  platform: NodeJS.Platform;
  /** `app.getVersion()`. */
  currentVersion: string;
  /** `process.env.KIAGENT_DEV_UPDATES === '1'` — allow update checks in dev. */
  devUpdates?: boolean;
  /** Injectable clock for `checkedAt` (defaults to Date.now). */
  now?: () => number;
}

export interface UpdaterManager {
  getState(): UpdateState;
  /** Kicks off a check; resolves with the post-kickoff state. */
  check(): Promise<UpdateState>;
  quitAndInstall(): void;
  /** Subscribe to state transitions; returns an unsubscribe fn. */
  onStateChange(cb: (s: UpdateState) => void): () => void;
  /** Begin scheduled checks (10s after call, then every 6h). No-op if disabled. */
  start(): void;
  /** Clear the schedule. */
  stop(): void;
}
