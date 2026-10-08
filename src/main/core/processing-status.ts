import type {
  ActiveCall,
  AppState,
  LaneState,
  ProviderStatus,
} from '@shared/contracts';

import type { ActiveCalls } from './active-calls';

export interface ProcessingStatusDeps {
  countWaiting: () => Promise<number>;
  providers: () => Array<{
    id: string;
    remote: boolean;
    status: ProviderStatus;
    /** Optional extra models (the speech accuracy model) whose download
     *  never shows in the provider's own status. */
    variants?: Array<{ status: ProviderStatus }>;
  }>;
  activeCalls: Pick<ActiveCalls, 'list' | 'onChange'>;
  /** Wake the deferred-work re-drive (worker:vision, worker:audio). */
  wakeWorkers: () => Promise<void>;
  patch: (p: Partial<AppState['processing']>) => void;
  warn: (msg: string) => void;
  waitingEveryMs?: number; // default 60_000
}

/** Re-drive the deferred-work workers now (a closed lane just opened). A
 *  worker that fails or is unknown must not stop the other. */
export async function wakeDeferredWorkers(scheduler: {
  trigger(id: string): Promise<void>;
}): Promise<void> {
  await Promise.allSettled([
    scheduler.trigger('worker:vision'),
    scheduler.trigger('worker:audio'),
  ]);
}

const EMPTY_GRACE_MS = 250;

const activeKey = (list: ActiveCall[]): string =>
  JSON.stringify(list.map((c) => [c.op, c.task]));

/** Observes the lane, the waiting count, executing local calls and model
 *  downloads, and pushes changes into AppState.processing. Observation
 *  only — except that a closed -> open lane flip wakes the deferred
 *  workers so waiting work resumes without waiting for their cadence. */
function downloadingPct(s: ProviderStatus): number | null {
  return typeof s === 'object' && 'downloading' in s ? s.downloading.pct : null;
}

export function createProcessingStatus(deps: ProcessingStatusDeps): {
  start(): void;
  /** `wakePending`: a background refusal happened since the last wake
   *  (boot.ts `takeLaneWake`). */
  tick(lane: LaneState, wakePending?: boolean): void;
  /** Recompute the waiting count now and push it if it changed. */
  refreshWaiting(): Promise<void>;
  stop(): void;
} {
  let lastLane: LaneState | null = null;
  let lastWaiting: number | null = null;
  let lastDownloadKey: string | null = 'null';
  let lastActiveKey: string | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;
  let emptyTimer: ReturnType<typeof setTimeout> | null = null;

  const refreshWaiting = (): Promise<void> => {
    inFlight ??= deps
      .countWaiting()
      .then((n) => {
        if (n !== lastWaiting) {
          lastWaiting = n;
          deps.patch({ waiting: n });
        }
      })
      .catch((e) => deps.warn(`waiting count failed: ${String(e)}`))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const clearEmptyTimer = (): void => {
    if (emptyTimer) clearTimeout(emptyTimer);
    emptyTimer = null;
  };

  const patchActive = (list: ActiveCall[]): void => {
    lastActiveKey = activeKey(list);
    deps.patch({ active: list.map((c) => ({ op: c.op, task: c.task })) });
  };

  // The app-state broadcast coalesces for 100 ms, so a call that starts and
  // ends inside that window would never be seen. A non-empty -> empty
  // change therefore lands EMPTY_GRACE_MS late; a new call cancels it.
  const pushActive = (list: ActiveCall[]): void => {
    const key = activeKey(list);
    if (list.length > 0) {
      clearEmptyTimer();
      if (key !== lastActiveKey) patchActive(list);
      return;
    }
    if (emptyTimer) return;
    if (key === lastActiveKey) return;
    if (lastActiveKey === null) {
      patchActive(list);
      return;
    }
    emptyTimer = setTimeout(() => {
      emptyTimer = null;
      patchActive([]);
    }, EMPTY_GRACE_MS);
  };

  return {
    start() {
      if (timer) return;
      unsub = deps.activeCalls.onChange(pushActive);
      pushActive(deps.activeCalls.list());
      void refreshWaiting();
      timer = setInterval(
        () => void refreshWaiting(),
        deps.waitingEveryMs ?? 60_000,
      );
    },
    refreshWaiting,
    tick(lane, wakePending = false) {
      const prev = lastLane;
      if (lane !== lastLane) {
        lastLane = lane;
        deps.patch({ lane });
      }
      const edge = prev !== null && prev !== 'open' && lane === 'open';
      if (edge || (lane === 'open' && wakePending)) {
        void deps
          .wakeWorkers()
          .then(refreshWaiting, (e) =>
            deps.warn(`worker wake failed: ${String(e)}`),
          );
      }
      let download: AppState['processing']['download'] = null;
      for (const p of deps.providers()) {
        if (p.remote) continue;
        const pct = [p.status, ...(p.variants ?? []).map((v) => v.status)]
          .map(downloadingPct)
          .find((v) => v !== null);
        if (pct !== undefined && pct !== null) {
          download = { providerId: p.id, pct };
          break;
        }
      }
      const key = JSON.stringify(download);
      if (key !== lastDownloadKey) {
        lastDownloadKey = key;
        deps.patch({ download });
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      clearEmptyTimer();
      unsub?.();
      unsub = null;
    },
  };
}
