import type { AppDb } from '../../../db/app-db';
import { DB_WORKER_CRASHED, DB_WORKER_DEAD } from '../../../db/worker-client';
import { QUERY_METHODS } from '../corpus-query';
import {
  createReadProxy,
  createReadStats,
  withWriterFallback,
} from '../read-proxy';

const codeErr = (code: string, message = code) =>
  Object.assign(new Error(message), { code });

function writer() {
  const w: Record<string, jest.Mock> = {};
  for (const m of QUERY_METHODS) w[m] = jest.fn(async () => `writer:${m}`);
  return w;
}
const readerDb = (proc: jest.Mock) => ({ proc }) as unknown as AppDb;

describe('createReadProxy', () => {
  it('forwards method + args to the read procedure and records execMs/totalMs', async () => {
    const proc = jest.fn(async () => ({
      value: ['hit'],
      execMs: 3,
      fuzzyRuns: 5,
    }));
    const stats = createReadStats();
    const q = createReadProxy(readerDb(proc), stats, 'mcp');
    expect(await q.search({ text: 'x' })).toEqual(['hit']);
    expect(proc).toHaveBeenCalledWith('read', {
      method: 'search',
      args: [{ text: 'x' }],
    });
    const g = stats.snapshot().groups[0];
    expect(g).toMatchObject({
      caller: 'mcp',
      method: 'search',
      via: 'reader',
      count: 1,
      execP95Ms: 3,
    });
    expect(g.p95Ms).toBeGreaterThanOrEqual(0);
    expect(stats.snapshot().fuzzyRuns).toBe(5); // the reader's cumulative counter is surfaced
  });
});

describe('createReadStats', () => {
  it('computes p50/p95/max per caller x method and keeps only the last 256 calls', () => {
    const stats = createReadStats(256);
    for (let i = 1; i <= 300; i += 1) {
      stats.record({
        caller: 'mcp',
        method: 'search',
        via: 'reader',
        execMs: i,
        totalMs: i,
        at: 1000,
      });
    }
    const g = stats.snapshot(2000).groups[0];
    expect(g.count).toBe(256); // 45..300
    expect(g.maxMs).toBe(300);
    expect(g.p50Ms).toBe(172); // nearest rank of 45..300 at 50%
    expect(g.p95Ms).toBe(288);
    expect(g.newestAgeMs).toBe(1000);
  });
});

describe('withWriterFallback', () => {
  const log = jest.fn();
  beforeEach(() => log.mockReset());

  it('starts in writer mode when the reader failed to open (logged once, stats active)', async () => {
    const w = writer();
    const stats = createReadStats();
    const router = withWriterFallback({
      proxy: null,
      writer: w as never,
      stats,
      log,
      openError: 'boom',
    });
    expect(router.mode()).toBe('writer');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'warn',
      '[db] read worker unavailable: boom — reads use the writer',
    );
    expect(await router.for('mcp').count({})).toBe('writer:count');
    expect(stats.snapshot().fallbacks['open-failed']).toBe(1);
    expect(stats.snapshot().groups[0]).toMatchObject({
      via: 'writer',
      count: 1,
    });
  });

  it('retries an in-flight DB_WORKER_CRASHED call once on the writer, without going sticky', async () => {
    const w = writer();
    const proc = jest
      .fn()
      .mockRejectedValueOnce(codeErr(DB_WORKER_CRASHED))
      .mockResolvedValue({ value: 'reader', execMs: 1 });
    const stats = createReadStats();
    const router = withWriterFallback({
      proxy: (c) => createReadProxy(readerDb(proc), stats, c),
      writer: w as never,
      stats,
      log,
    });
    expect(await router.for('mcp').document('d1' as never)).toBe(
      'writer:document',
    );
    expect(await router.for('mcp').document('d1' as never)).toBe('reader');
    expect(router.mode()).toBe('reader');
    expect(stats.snapshot().fallbacks.crashed).toBe(1);
  });

  it('DB_WORKER_DEAD (including parked callers) retries on the writer and then sticks', async () => {
    const w = writer();
    const proc = jest.fn(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(codeErr(DB_WORKER_DEAD)), 10),
        ),
    );
    const stats = createReadStats();
    const router = withWriterFallback({
      proxy: (c) => createReadProxy(readerDb(proc), stats, c),
      writer: w as never,
      stats,
      log,
    });
    const q = router.for('renderer');
    const [a, b] = await Promise.all([q.count({}), q.accounts()]);
    expect([a, b]).toEqual(['writer:count', 'writer:accounts']);
    expect(router.mode()).toBe('writer');
    proc.mockClear();
    expect(await q.count({})).toBe('writer:count');
    expect(proc).not.toHaveBeenCalled(); // sticky: the reader is not asked again
    expect(
      log.mock.calls.filter(([, m]) => /read worker is dead/.test(m as string)),
    ).toHaveLength(1);
    expect(stats.snapshot().fallbacks.dead).toBeGreaterThanOrEqual(1);
  });

  it('propagates SQL errors unchanged: no fallback, writer not called', async () => {
    const w = writer();
    const proc = jest
      .fn()
      .mockRejectedValue(new Error('search query: unmatched ")"'));
    const stats = createReadStats();
    const router = withWriterFallback({
      proxy: (c) => createReadProxy(readerDb(proc), stats, c),
      writer: w as never,
      stats,
      log,
    });
    await expect(router.for('mcp').search({ text: ')' })).rejects.toThrow(
      /unmatched/,
    );
    expect(w.search).not.toHaveBeenCalled();
    expect(stats.snapshot().fallbacks).toEqual({
      'open-failed': 0,
      crashed: 0,
      dead: 0,
    });
  });
});
