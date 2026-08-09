/**
 * Main-process JS-heap telemetry.
 *
 * A packaged build died after ~25h with `EXC_BREAKPOINT` on `CrBrowserMain`.
 * The stack symbolized to nonsense and nothing in any log explained it; the
 * cause was only recoverable from Electron's Crashpad annotations, which said
 * `electron.v8-oom.heap.used = 3.09 GiB` against V8's default 4 GiB cap. So the
 * main process ran out of JavaScript heap, and we had no idea whether that was
 * a slow leak or one large allocation on a fat heap — the two want completely
 * different fixes, and neither is visible after the fact.
 *
 * Two details:
 *
 *  - Records go to the log JSONL **synchronously** (`appendRecordSync`, shared
 *    with the crash handlers). A V8 OOM aborts the process from inside the
 *    allocator: no JS runs afterwards, so the sink's async append would lose
 *    exactly the samples leading up to the death. The sink is still notified so
 *    the live viewer sees them.
 *  - `rss` is sampled alongside the V8 numbers. `getHeapStatistics()` describes
 *    only the JS heap; if RSS climbs while the heap is flat the leak is native
 *    or external (buffers, a worker, a native module) and no heap snapshot will
 *    ever show it.
 *
 * Snapshots are **off unless `KIA_HEAP_SNAPSHOT=1`**. `writeHeapSnapshot()`
 * blocks the main thread for seconds and emits a file roughly the size of the
 * heap — several GB at the point where it would be most informative. That is an
 * acceptable trade when you are hunting a leak on your own machine and a bad
 * one to hand every user. The periodic line costs nothing and ships to everyone.
 *
 * v8/process are injected rather than imported so the policy is testable
 * without a browser process, matching `crash-handlers`.
 */
import fs from 'fs';
import path from 'path';

import {
  appendRecordSync,
  describeError,
  type CrashSink,
} from './crash-handlers';

export const HEAP_SCOPE = 'main.heap';
export const HEAP_SNAPSHOT_DIR = 'heap-snapshots';
/** Five minutes: ~288 lines a day, enough resolution to see a curve. */
export const DEFAULT_SAMPLE_INTERVAL_MS = 5 * 60_000;
/** Far enough above a healthy heap to be a real signal, far enough below the
 *  cap that a snapshot still has room to be written. */
export const DEFAULT_SNAPSHOT_RATIO = 0.7;

/** The subset of `v8.HeapStatistics` this needs. */
export interface HeapStatisticsLike {
  used_heap_size: number;
  total_heap_size: number;
  heap_size_limit: number;
  total_available_size: number;
  external_memory?: number;
}

export interface HeapWatchDeps {
  /** The directory `createLogs()` writes to — `<dataDir>/logs`. */
  logDir: string;
  /** `<userData>/data`; snapshots get their own dir under it. */
  dataDir: string;
  /** Null until `bootCore` has produced one. */
  sink: () => CrashSink | null;
  getHeapStatistics: () => HeapStatisticsLike;
  rss: () => number;
  writeHeapSnapshot: (filePath: string) => void;
  /** `KIA_HEAP_SNAPSHOT=1`. See the note above on why this is not the default. */
  snapshotEnabled: boolean;
  now?: () => Date;
  intervalMs?: number;
  snapshotRatio?: number;
}

export interface HeapWatch {
  /** Take and record one sample. Never throws. */
  sample(): void;
  stop(): void;
}

function record(
  deps: HeapWatchDeps,
  level: 'info' | 'warn' | 'error',
  msg: string,
  fields: Record<string, unknown>,
  now: Date,
): void {
  appendRecordSync(deps.logDir, {
    ts: now.toISOString(),
    level,
    scope: HEAP_SCOPE,
    msg,
    fields,
  });
  try {
    deps.sink()?.log(HEAP_SCOPE, level, msg, fields);
  } catch {
    // A sink that throws must not suppress the record already on disk.
  }
}

function snapshotName(now: Date, usedBytes: number): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${Math.round(usedBytes / 1024 / 1024)}mb.heapsnapshot`;
}

export function createHeapWatch(deps: HeapWatchDeps): HeapWatch {
  const now = deps.now ?? (() => new Date());
  const ratio = deps.snapshotRatio ?? DEFAULT_SNAPSHOT_RATIO;
  // Latched on the first attempt, success or failure: a snapshot that fails
  // (no disk space is the likely reason at 3 GB) would otherwise retry every
  // tick, and every attempt freezes the main thread.
  let snapshotAttempted = false;

  const sample = (): void => {
    const at = now();
    const stats = deps.getHeapStatistics();
    const used = stats.used_heap_size;
    const limit = stats.heap_size_limit;
    const usedPct = limit > 0 ? Math.round((used / limit) * 1000) / 10 : 0;
    const hot = limit > 0 && used / limit >= ratio;

    record(
      deps,
      hot ? 'warn' : 'info',
      hot ? 'heap above snapshot threshold' : 'heap sample',
      {
        usedBytes: used,
        totalBytes: stats.total_heap_size,
        limitBytes: limit,
        availableBytes: stats.total_available_size,
        externalBytes: stats.external_memory,
        rssBytes: deps.rss(),
        usedPct,
      },
      at,
    );

    if (!hot || !deps.snapshotEnabled || snapshotAttempted) return;
    snapshotAttempted = true;

    const dir = path.join(deps.dataDir, HEAP_SNAPSHOT_DIR);
    const file = path.join(dir, snapshotName(at, used));
    // Announced before the write: the freeze that follows is seconds long and
    // has to be attributable to this and not read as a hang.
    record(
      deps,
      'warn',
      'writing heap snapshot — main thread will block',
      {
        file,
        usedBytes: used,
      },
      at,
    );
    const started = Date.now();
    try {
      fs.mkdirSync(dir, { recursive: true });
      deps.writeHeapSnapshot(file);
      record(
        deps,
        'warn',
        'wrote heap snapshot',
        {
          file,
          ms: Date.now() - started,
        },
        now(),
      );
    } catch (err) {
      record(deps, 'error', 'heap snapshot failed', describeError(err), now());
    }
  };

  return { sample, stop: () => {} };
}

/**
 * Starts sampling on a timer. The timer is unref'd: heap telemetry must never
 * be the reason the process stays alive.
 */
export function startHeapWatch(deps: HeapWatchDeps): () => void {
  const watch = createHeapWatch(deps);
  const timer = setInterval(
    () => watch.sample(),
    deps.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS,
  );
  timer.unref?.();
  return () => clearInterval(timer);
}
