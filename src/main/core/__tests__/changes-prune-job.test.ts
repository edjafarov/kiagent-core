/** @jest-environment node */
import type { Cadence } from '@shared/contracts';

import {
  CHANGES_PRUNE_CADENCE,
  CHANGES_PRUNE_JOB_ID,
  FIRST_PRUNE_DELAY_MS,
  pruneChangesOnce,
  registerChangesPrune,
} from '../changes-maintenance';
import type { ScheduleRow } from '../store/store';

const NOW = new Date('2026-10-09T12:00:00.000Z');

function fakeStore(over: Partial<ReturnType<typeof baseStore>> = {}) {
  const calls: string[] = [];
  return { store: { ...baseStore(calls), ...over }, calls };
}

function baseStore(calls: string[]) {
  return {
    ledgerRekeyed: async () => true,
    consumerFloor: async (): Promise<number | null> => 100,
    firstChangeSeqAt: async () => 1_000,
    headSeq: async () => 2_000,
    publishChangesFloor: async (n: number) => {
      calls.push(`floor:${n}`);
    },
    minChangeSeq: async () => 1,
    deleteChangesRange: async (a: number, b: number) => {
      calls.push(`del:${a}-${b}`);
      return b - a;
    },
    walCheckpoint: async () => {
      calls.push('ckpt');
    },
    scheduleAll: async (): Promise<ScheduleRow[]> => [],
    scheduleUpsert: async (r: ScheduleRow) => {
      calls.push(`upsert:${r.lastRun}:${r.nextRun}`);
    },
    changesFloor: async (): Promise<number | null> => null,
  };
}

describe('changes prune (#59 §3b)', () => {
  it('publishes the floor before any delete, deletes windows below limit, checkpoints every 20 and at the end', async () => {
    const { store, calls } = fakeStore();
    const r = await pruneChangesOnce({
      store,
      activeConsumers: () => ['w'],
      now: () => NOW,
      batch: 2,
      yieldTurn: async () => {},
    });
    // limit = min(floor 100, cutoff 1000, head 2000)
    expect(r).toEqual({ limit: 100, deleted: 99, batches: 50 });
    expect(calls[0]).toBe('floor:100');
    expect(calls[1]).toBe('del:1-3');
    expect(calls.filter((c) => c === 'ckpt')).toHaveLength(3); // 20, 40, end
    expect(calls).toContain('del:99-100');
  });

  it('is a no-op until the re-key repair is done', async () => {
    const { store, calls } = fakeStore({ ledgerRekeyed: async () => false });
    expect(
      await pruneChangesOnce({
        store,
        activeConsumers: () => ['w'],
        now: () => NOW,
      }),
    ).toEqual({ skipped: 'rekey-pending' });
    expect(calls).toEqual([]);
  });

  it('skips when no attached consumer has a row — never "no floor"', async () => {
    const { store, calls } = fakeStore({ consumerFloor: async () => null });
    expect(
      await pruneChangesOnce({
        store,
        activeConsumers: () => [],
        now: () => NOW,
      }),
    ).toEqual({ skipped: 'no-consumers' });
    expect(calls).toEqual([]);
  });

  it('the head row survives: limit never exceeds MAX(seq)', async () => {
    const { store, calls } = fakeStore({
      consumerFloor: async () => 50,
      firstChangeSeqAt: async () => 51,
      headSeq: async () => 50,
    });
    const r = await pruneChangesOnce({
      store,
      activeConsumers: () => ['w'],
      now: () => NOW,
      yieldTurn: async () => {},
    });
    expect(r).toMatchObject({ limit: 50 });
    expect(calls).toContain('del:1-50');
  });

  it('first registration seeds lastRun = now (no run at boot); an existing row is kept', async () => {
    const order: string[] = [];
    let job: { cadence: Cadence } | null = null;
    const { store, calls } = fakeStore();
    await registerChangesPrune({
      store,
      scheduler: {
        register: async (id, cadence) => {
          order.push(`register:${id}`);
          job = { cadence };
        },
        trigger: async () => {},
      },
      logs: { log: () => {} },
      activeConsumers: () => ['w'],
      now: () => NOW,
      setTimer: () => {},
    });
    expect(calls[0]).toBe(
      `upsert:${NOW.toISOString()}:${new Date(NOW.getTime() + 6 * 3_600_000).toISOString()}`,
    );
    expect(order).toEqual([`register:${CHANGES_PRUNE_JOB_ID}`]);
    expect(job!.cadence).toEqual(CHANGES_PRUNE_CADENCE);

    const existing = fakeStore({
      scheduleAll: async () => [
        {
          jobId: CHANGES_PRUNE_JOB_ID,
          cadence: CHANGES_PRUNE_CADENCE,
          lastRun: 'x',
          nextRun: 'y',
        },
      ],
    });
    await registerChangesPrune({
      store: existing.store,
      scheduler: { register: async () => {}, trigger: async () => {} },
      logs: { log: () => {} },
      activeConsumers: () => ['w'],
      now: () => NOW,
      setTimer: () => {},
    });
    expect(existing.calls.filter((c) => c.startsWith('upsert'))).toEqual([]);
  });

  it('the first-ever run is triggered once, 10 minutes in, only while changesFloor is absent', async () => {
    const timers: number[] = [];
    const triggered: string[] = [];
    let fire: (() => void) | null = null;
    const { store } = fakeStore();
    await registerChangesPrune({
      store,
      scheduler: {
        register: async () => {},
        trigger: async (id) => {
          triggered.push(id);
        },
      },
      logs: { log: () => {} },
      activeConsumers: () => ['w'],
      now: () => NOW,
      setTimer: (fn, ms) => {
        timers.push(ms);
        fire = fn;
      },
    });
    expect(timers).toEqual([FIRST_PRUNE_DELAY_MS]);
    fire!();
    expect(triggered).toEqual([CHANGES_PRUNE_JOB_ID]);

    const pruned = fakeStore({ changesFloor: async () => 5 });
    const t2: number[] = [];
    await registerChangesPrune({
      store: pruned.store,
      scheduler: { register: async () => {}, trigger: async () => {} },
      logs: { log: () => {} },
      activeConsumers: () => ['w'],
      now: () => NOW,
      setTimer: (_fn, ms) => {
        t2.push(ms);
      },
    });
    expect(t2).toEqual([]);
  });
});
