/**
 * Window-first boot (#140): what runs AFTER the window exists.
 *
 * `createBootQueue` holds the accounts whose extension source has not
 * registered yet ("boot-pending": declared by a loaded, enabled, non-errored
 * extension) and starts each exactly once when that source registers — or,
 * when the owning extension errors, is disabled or uninstalled first, once
 * through today's path (`runAccount`, which logs today's `no source
 * registered` line). Every user-initiated start (sync-now, Resume) goes
 * through `runOrQueue`.
 *
 * `startBackground` is the post-window chain: resume what can run now,
 * start the scheduler, then start the utility-process extensions.
 *
 * Both are pure over injected deps — no Electron — so they unit-test directly.
 */
import type { Account, AccountId, ExtensionSnapshot } from '@shared/contracts';

export type StartIntent = 'auto' | 'explicit';
type Level = 'info' | 'warn' | 'error';

export interface BootQueueDeps {
  /** Re-reads one account at dispatch (CoreStore.account); null once removed. */
  readAccount(id: AccountId): Promise<Account | null>;
  isRegistered(sourceId: string): boolean;
  /** SourceRegistrations.onRegister — returns the unsubscribe. */
  onRegister(cb: (sourceId: string) => void): () => void;
  /** Today's start path (core/boot.ts runAccount). */
  runAccount(account: Account): void;
  log(level: Level, msg: string): void;
}

export interface BootQueue {
  /** Marks the boot-pending sources from the post-load() snapshot and starts
   *  listening for their registration. */
  arm(snapshot: readonly ExtensionSnapshot[]): void;
  /** resumeAccounts' `defer`: queues an automatic start for a boot-pending
   *  account and returns true; false leaves today's behaviour. */
  defer(account: Account): boolean;
  /** sync-now / Resume: runs now, or queues behind a boot-pending source
   *  (no error status written). */
  runOrQueue(account: Account, intent: StartIntent): void;
  /** Tray Sync now: `runOrQueue(account, 'explicit')` for every non-worker,
   *  non-paused account whose source is boot-pending; all others are left to
   *  their cadence job (the tray triggers those itself). */
  syncPending(accounts: readonly Account[]): void;
  /** The platform's snapshot (deps.onChange): releases the queue of an entry
   *  that errored, was disabled or was uninstalled before registering. */
  onSnapshot(snapshot: readonly ExtensionSnapshot[]): void;
  /** Quit / interactive factory reset: nothing queued is started afterwards. */
  stop(): void;
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function createBootQueue(deps: BootQueueDeps): BootQueue {
  /** Boot-pending source id → the extension that declares it. */
  const pending = new Map<string, string>();
  /** Boot-pending source id → queued account ids with their strongest intent. */
  const queued = new Map<string, Map<AccountId, StartIntent>>();
  let off: (() => void) | null = null;
  let stopped = false;

  const isPending = (sourceId: string): boolean =>
    !stopped && pending.has(sourceId) && !deps.isRegistered(sourceId);

  function enqueue(account: Account, intent: StartIntent): void {
    let q = queued.get(account.source);
    if (!q) {
      q = new Map();
      queued.set(account.source, q);
    }
    // An explicit start upgrades a queued automatic one; never the reverse.
    if (q.get(account.id) !== 'explicit') q.set(account.id, intent);
  }

  /** Today's rules: nothing starts a paused account (Resume has already
   *  cleared it by the time it queues); an automatic start never retries a
   *  needsReauth account, the user's explicit Retry does. */
  function shouldStart(
    account: Account | null,
    intent: StartIntent,
  ): account is Account {
    if (!account || account.status === 'paused') return false;
    return intent === 'explicit' || account.status !== 'needsReauth';
  }

  async function dispatch(
    sourceId: string,
    why: 'registered' | 'released',
  ): Promise<void> {
    const q = queued.get(sourceId);
    queued.delete(sourceId);
    pending.delete(sourceId);
    if (pending.size === 0) {
      off?.();
      off = null;
    }
    if (!q) return;
    for (const [id, intent] of q) {
      if (stopped) return;
      try {
        // eslint-disable-next-line no-await-in-loop
        const fresh = await deps.readAccount(id);
        if (stopped) return;
        if (shouldStart(fresh, intent)) deps.runAccount(fresh);
      } catch (err) {
        deps.log(
          'error',
          `boot: account ${id} (${why} source '${sourceId}') did not start: ${message(err)}`,
        );
      }
    }
  }

  return {
    arm(snapshot) {
      if (stopped) return;
      for (const e of snapshot) {
        if (!e.enabled || e.status === 'errored') continue;
        for (const sourceId of e.sourceIds)
          if (!deps.isRegistered(sourceId)) pending.set(sourceId, e.id);
      }
      if (pending.size > 0 && !off)
        off = deps.onRegister((sourceId) => {
          if (pending.has(sourceId)) void dispatch(sourceId, 'registered');
        });
    },

    defer(account) {
      if (!isPending(account.source)) return false;
      enqueue(account, 'auto');
      return true;
    },

    runOrQueue(account, intent) {
      if (isPending(account.source)) {
        enqueue(account, intent);
        return;
      }
      deps.runAccount(account);
    },

    syncPending(accounts) {
      for (const account of accounts) {
        if (account.source === 'worker' || account.status === 'paused')
          continue;
        if (isPending(account.source)) enqueue(account, 'explicit');
      }
    },

    onSnapshot(snapshot) {
      if (stopped || pending.size === 0) return;
      const byId = new Map(snapshot.map((e) => [e.id, e]));
      for (const [sourceId, extensionId] of [...pending]) {
        const e = byId.get(extensionId);
        // Status 'disabled' while still enabled is a transient deactivate (a
        // DB-worker respawn re-activation, a Reset all) — not a release.
        // needs-consent keeps the queue: it drains when consent registers it.
        if (e && e.enabled && e.status !== 'errored') continue;
        if (deps.isRegistered(sourceId)) continue;
        void dispatch(sourceId, 'released');
      }
    },

    stop() {
      stopped = true;
      off?.();
      off = null;
      pending.clear();
      queued.clear();
    },
  };
}

export interface StartBackgroundDeps {
  /** Today's resume, restricted to registered sources (boot-pending ones
   *  queue through BootQueue.defer). Receives `signal` and must stop
   *  starting accounts once it aborts (resumeAccounts' `signal`). */
  resumeReady(signal: AbortSignal): Promise<void>;
  startScheduler(): void;
  /** Starts each utility-process extension; per extension, not awaited as a
   *  whole by anything the user waits on. */
  startUtilityExtensions(): Promise<void>;
  mark(step: string, detail?: string): void;
  log(level: Level, msg: string): void;
  /** Aborted on quit (before extensionsPlatform.stop()) and by an
   *  interactive factory reset. */
  signal: AbortSignal;
}

/** The post-window chain. Every step is logged, never rejects. */
export async function startBackground(
  deps: StartBackgroundDeps,
): Promise<void> {
  const step = async (name: string, run: () => unknown): Promise<boolean> => {
    if (deps.signal.aborted) return false;
    try {
      await run();
    } catch (err) {
      deps.log('error', `boot: ${name} failed: ${message(err)}`);
    }
    return !deps.signal.aborted;
  };
  if (!(await step('resume', () => deps.resumeReady(deps.signal)))) return;
  if (!(await step('scheduler start', () => deps.startScheduler()))) return;
  deps.mark('scheduler started');
  if (!(await step('utility extensions', () => deps.startUtilityExtensions())))
    return;
  // NOT "all settled": a host resolves start() as soon as a handshake retry
  // is merely scheduled. Settlement is decided from extension statuses by
  // BootTimer.armSettled (wired in main.ts's startUtilityExtensions).
  deps.mark('utility extensions started');
}
