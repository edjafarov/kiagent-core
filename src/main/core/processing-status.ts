import type {
  ActiveCall,
  AppState,
  LaneState,
  ProviderStatus,
} from '@shared/contracts';

import type { ActiveCalls } from './active-calls';

export interface ProcessingStatusDeps {
  laneState: () => LaneState;
  countWaiting: () => Promise<number>;
  providers: () => Array<{
    id: string;
    remote: boolean;
    status: ProviderStatus;
  }>;
  activeCalls: Pick<ActiveCalls, 'list' | 'onChange'>;
  /** Wake the deferred-work re-drive (worker:vision, worker:audio). */
  wakeWorkers: () => Promise<void>;
  patch: (p: Partial<AppState['processing']>) => void;
  warn: (msg: string) => void;
  waitingEveryMs?: number; // default 60_000
}

const activeKey = (list: ActiveCall[]): string =>
  JSON.stringify(list.map((c) => [c.op, c.task]));

/** Observes the lane, the waiting count, executing local calls and model
 *  downloads, and pushes changes into AppState.processing. Observation
 *  only — except that a closed -> open lane flip wakes the deferred
 *  workers so waiting work resumes without waiting for their cadence. */
export function createProcessingStatus(deps: ProcessingStatusDeps): {
  start(): void;
  tick(): void;
  stop(): void;
} {
  let lastLane: LaneState | null = null;
  let lastWaiting: number | null = null;
  let lastDownloadKey: string | null = 'null';
  let lastActiveKey: string | null = null;
  let inFlight: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let unsub: (() => void) | null = null;

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

  const pushActive = (list: ActiveCall[]): void => {
    const key = activeKey(list);
    if (key === lastActiveKey) return;
    lastActiveKey = key;
    deps.patch({ active: list.map((c) => ({ op: c.op, task: c.task })) });
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
    tick() {
      const lane = deps.laneState();
      if (lane !== lastLane) {
        const prev = lastLane;
        lastLane = lane;
        deps.patch({ lane });
        if (prev !== null && prev !== 'open' && lane === 'open') {
          void deps
            .wakeWorkers()
            .then(refreshWaiting, (e) =>
              deps.warn(`worker wake failed: ${String(e)}`),
            );
        }
      }
      const dl = deps
        .providers()
        .find(
          (p) =>
            !p.remote &&
            typeof p.status === 'object' &&
            'downloading' in p.status,
        );
      const download =
        dl && typeof dl.status === 'object' && 'downloading' in dl.status
          ? { providerId: dl.id, pct: dl.status.downloading.pct }
          : null;
      const key = JSON.stringify(download);
      if (key !== lastDownloadKey) {
        lastDownloadKey = key;
        deps.patch({ download });
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      unsub?.();
      unsub = null;
    },
  };
}
