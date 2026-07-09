import type { Cadence, Scheduler, SchedulerEnv } from '@shared/contracts';

import { nextRun } from './engine/cadence';
import type { LogSink } from './engine/engine';
import type { CoreStore } from './store/store';

const TICK_MS = 30_000;

export interface CoreScheduler extends Scheduler {
  /** The engine registers every cadence found on contributions here. Async
   *  because the durable schedule row is persisted through the async AppDb;
   *  callers fire-and-forget (registration is not on any latency path). */
  register(
    id: string,
    cadence: Cadence,
    run: () => Promise<void>,
  ): Promise<void>;
  unregister(id: string): Promise<void>;
  start(): void;
  stop(): void;
}

/**
 * The ONE timing authority. Durable (last/next run persist in the store; a
 * window missed while the app was closed catches up on the first tick) and
 * central (battery/thermal/focus throttling happens here for everyone).
 */
export function createScheduler(
  store: CoreStore,
  env: () => SchedulerEnv,
  logs: LogSink,
): CoreScheduler {
  const jobs = new Map<
    string,
    { cadence: Cadence; run: () => Promise<void>; busy: boolean }
  >();
  let timer: NodeJS.Timeout | null = null;

  const fire = async (id: string): Promise<void> => {
    const job = jobs.get(id);
    if (!job || job.busy) return;
    job.busy = true;
    const now = new Date().toISOString();
    await store.scheduleUpsert({
      jobId: id,
      cadence: job.cadence,
      lastRun: now,
      nextRun: nextRun(job.cadence, now, new Date())?.toISOString() ?? null,
    });
    try {
      await job.run();
    } catch (err) {
      logs.log('scheduler', 'error', `job ${id} failed: ${String(err)}`);
    } finally {
      job.busy = false;
    }
  };

  const tick = async (): Promise<void> => {
    const e = env();
    // Background work parks on battery; cadence jobs still fire but their
    // inference-heavy work is gated by the inference plane's lane switch.
    if (e.onBattery && e.thermal !== 'nominal') return;
    const persisted = new Map(
      (await store.scheduleAll()).map((r) => [r.jobId, r]),
    );
    const nowD = new Date();
    for (const [id, job] of jobs) {
      if (job.cadence === 'manual') continue;
      const row = persisted.get(id);
      const due = row?.nextRun
        ? new Date(row.nextRun) <= nowD
        : (nextRun(job.cadence, row?.lastRun ?? null, nowD) ?? nowD) <= nowD;
      if (due) void fire(id);
    }
  };

  // tick reads the durable schedule through the async AppDb; a rejected read
  // (e.g. a dead DB worker in Task 4) must not surface as an unhandled
  // rejection off the interval timer.
  const safeTick = (): void => {
    void tick().catch((err) => {
      logs.log('scheduler', 'error', `tick failed: ${String(err)}`);
    });
  };

  return {
    get env() {
      return env();
    },
    async register(id, cadence, run) {
      jobs.set(id, { cadence, run, busy: false });
      const existing = (await store.scheduleAll()).find((r) => r.jobId === id);
      await store.scheduleUpsert({
        jobId: id,
        cadence,
        lastRun: existing?.lastRun ?? null,
        nextRun:
          existing?.nextRun ??
          nextRun(
            cadence,
            existing?.lastRun ?? null,
            new Date(),
          )?.toISOString() ??
          null,
      });
    },
    async unregister(id) {
      jobs.delete(id);
      await store.scheduleDelete(id);
    },
    async jobs() {
      const persisted = new Map(
        (await store.scheduleAll()).map((r) => [r.jobId, r]),
      );
      return [...jobs.entries()].map(([id, j]) => ({
        id,
        cadence: j.cadence,
        lastRun: persisted.get(id)?.lastRun ?? null,
        nextRun: persisted.get(id)?.nextRun ?? null,
      }));
    },
    async trigger(id) {
      await fire(id);
    },
    start() {
      if (timer) return;
      timer = setInterval(safeTick, TICK_MS);
      setTimeout(safeTick, 2_000); // catch up shortly after boot
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
