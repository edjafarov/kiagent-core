/**
 * Main-thread event-loop delay, in 60 s windows (#147 §6): the number the
 * sync-yields work exists to move. p50/p99/max of the last window go into
 * readDiagnostics() and the KIA_READ_DIAG_FILE dump; a window whose p99
 * exceeds 250 ms logs one warning.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** The slice of perf_hooks' IntervalHistogram this module reads (ns). */
export interface HistogramLike {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(p: number): number;
  readonly max: number;
  readonly count: number;
}

export interface EventLoopWindow {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  samples: number;
  /** ms epoch the window closed. */
  at: number;
}

export interface EventLoopMonitor {
  last(): EventLoopWindow | null;
  stop(): void;
}

const NS_PER_MS = 1e6;
const toMs = (ns: number) =>
  Number.isFinite(ns) ? Math.round((ns / NS_PER_MS) * 10) / 10 : 0;

export function startEventLoopMonitor(deps: {
  log(level: 'warn', msg: string): void;
  windowMs?: number;
  warnP99Ms?: number;
  histogram?: HistogramLike;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(t: unknown): void;
  now?(): number;
}): EventLoopMonitor {
  const h = deps.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  const windowMs = deps.windowMs ?? 60_000;
  const warnP99Ms = deps.warnP99Ms ?? 250;
  const now = deps.now ?? Date.now;
  const every =
    deps.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const cancel =
    deps.clearInterval ??
    ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>));
  let last: EventLoopWindow | null = null;
  h.enable();
  const timer = every(() => {
    const samples = h.count;
    last =
      samples > 0
        ? {
            p50Ms: toMs(h.percentile(50)),
            p99Ms: toMs(h.percentile(99)),
            maxMs: toMs(h.max),
            samples,
            at: now(),
          }
        : { p50Ms: 0, p99Ms: 0, maxMs: 0, samples: 0, at: now() };
    h.reset();
    if (last.p99Ms > warnP99Ms)
      deps.log(
        'warn',
        `event loop p99 ${last.p99Ms} ms (max ${last.maxMs} ms) over the last ${windowMs / 1000} s`,
      );
  }, windowMs);
  return {
    last: () => last,
    stop() {
      cancel(timer);
      h.disable();
    },
  };
}
