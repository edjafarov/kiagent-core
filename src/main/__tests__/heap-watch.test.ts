/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CRASH_LOG_FILE } from '../crash-handlers';
import {
  HEAP_SNAPSHOT_DIR,
  createHeapWatch,
  startHeapWatch,
  type HeapStatisticsLike,
  type HeapWatchDeps,
} from '../heap-watch';

const GiB = 1024 ** 3;

function stats(usedGiB: number): HeapStatisticsLike {
  return {
    used_heap_size: usedGiB * GiB,
    total_heap_size: usedGiB * GiB + 64 * 1024 * 1024,
    heap_size_limit: 4 * GiB,
    total_available_size: 4 * GiB - usedGiB * GiB,
    external_memory: 12 * 1024 * 1024,
  };
}

function makeDeps(overrides: Partial<HeapWatchDeps> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-heap-'));
  const logDir = path.join(dataDir, 'logs');
  const sinkCalls: Array<[string, string, string]> = [];
  const snapshots: string[] = [];
  let used = 1;
  const deps: HeapWatchDeps = {
    logDir,
    dataDir,
    sink: () => ({
      log: (scope, level, msg) => {
        sinkCalls.push([scope, level, msg]);
      },
    }),
    getHeapStatistics: () => stats(used),
    rss: () => 5 * GiB,
    writeHeapSnapshot: (file) => {
      snapshots.push(file);
    },
    snapshotEnabled: false,
    now: () => new Date('2026-08-09T10:00:00.000Z'),
    ...overrides,
  };
  const readLines = () =>
    fs.existsSync(path.join(logDir, CRASH_LOG_FILE))
      ? fs
          .readFileSync(path.join(logDir, CRASH_LOG_FILE), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  return {
    deps,
    dataDir,
    logDir,
    sinkCalls,
    snapshots,
    readLines,
    setUsed: (giB: number) => {
      used = giB;
    },
  };
}

describe('heap sampling', () => {
  it('writes one durable record per sample, with the numbers that explain an OOM', () => {
    const { deps, readLines, sinkCalls } = makeDeps();

    createHeapWatch(deps).sample();

    const [rec] = readLines();
    expect(rec.scope).toBe('main.heap');
    expect(rec.level).toBe('info');
    expect(rec.fields).toMatchObject({
      usedBytes: 1 * GiB,
      limitBytes: 4 * GiB,
      availableBytes: 3 * GiB,
      externalBytes: 12 * 1024 * 1024,
      rssBytes: 5 * GiB,
      usedPct: 25,
    });
    // The live viewer sees it too, but the file write is the one that has to
    // land: an OOM abort runs no further JS to flush the sink's async append.
    expect(sinkCalls).toEqual([['main.heap', 'info', expect.any(String)]]);
  });

  it('records even before the platform has produced a sink', () => {
    const { deps, readLines } = makeDeps({ sink: () => null });

    expect(() => createHeapWatch(deps).sample()).not.toThrow();
    expect(readLines()).toHaveLength(1);
  });
});

describe('threshold', () => {
  it('warns once the heap enters the danger zone, snapshots or not', () => {
    const { deps, readLines, setUsed } = makeDeps();
    const watch = createHeapWatch(deps);

    watch.sample();
    setUsed(3);
    watch.sample();

    expect(readLines().map((r) => r.level)).toEqual(['info', 'warn']);
  });

  it('does not snapshot below the threshold', () => {
    const { deps, snapshots } = makeDeps({ snapshotEnabled: true });

    createHeapWatch(deps).sample();

    expect(snapshots).toEqual([]);
  });

  it('does not snapshot when the env gate is off', () => {
    const { deps, snapshots, setUsed } = makeDeps();
    setUsed(3);

    createHeapWatch(deps).sample();

    expect(snapshots).toEqual([]);
  });
});

describe('snapshot', () => {
  it('writes one snapshot into its own dir and never a second', () => {
    const { deps, dataDir, snapshots, setUsed, readLines } = makeDeps({
      snapshotEnabled: true,
    });
    const watch = createHeapWatch(deps);
    setUsed(3);

    watch.sample();
    watch.sample();

    expect(snapshots).toEqual([
      path.join(
        dataDir,
        HEAP_SNAPSHOT_DIR,
        '2026-08-09T10-00-00-000Z-3072mb.heapsnapshot',
      ),
    ]);
    expect(fs.existsSync(path.join(dataDir, HEAP_SNAPSHOT_DIR))).toBe(true);
    // Announced before the write, because the write freezes the main thread
    // for seconds and that pause has to be attributable.
    const msgs = readLines().map((r) => r.msg);
    expect(msgs[1]).toMatch(/writing heap snapshot/i);
    expect(msgs[2]).toMatch(/wrote heap snapshot/i);
  });

  it('survives a failing write and does not retry it every tick', () => {
    const { deps, setUsed, readLines } = makeDeps({
      snapshotEnabled: true,
      writeHeapSnapshot: () => {
        throw new Error('no space left on device');
      },
    });
    const watch = createHeapWatch(deps);
    setUsed(3);

    expect(() => watch.sample()).not.toThrow();
    watch.sample();

    const errors = readLines().filter((r) => r.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].fields.message).toBe('no space left on device');
  });
});

describe('startHeapWatch', () => {
  it('samples on a timer that never holds the process open, and stops', () => {
    jest.useFakeTimers();
    try {
      const { deps, readLines } = makeDeps();
      const unref = jest.fn();
      jest.spyOn(global, 'setInterval').mockImplementation(((
        fn: () => void,
        ms: number,
      ) => ({
        fn,
        ms,
        unref,
      })) as unknown as typeof setInterval);

      const stop = startHeapWatch({ ...deps, intervalMs: 1000 });

      expect(unref).toHaveBeenCalled();
      const timer = (setInterval as unknown as jest.Mock).mock.results[0]
        .value as { fn: () => void };
      timer.fn();
      expect(readLines()).toHaveLength(1);

      expect(() => stop()).not.toThrow();
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  });
});
