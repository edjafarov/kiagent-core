/** @jest-environment node */
import type { Cadence } from '@shared/contracts';

import {
  LEDGER_REKEY_JOB_ID,
  LEDGER_REKEY_MAX_RETRIES,
  registerLedgerRekey,
} from '../changes-maintenance';
import { createScheduler } from '../scheduler';
import type { CoreStore } from '../store/store';

function harness(pages: Array<boolean | Error>) {
  let job: { cadence: Cadence; run: () => Promise<void> } | null = null;
  let flag = false;
  const ledgerRekeyPage = jest.fn(async () => {
    const next = pages.shift() ?? true;
    if (next instanceof Error) throw next;
    const done = next;
    if (done) flag = true;
    return { done, scanned: 1 };
  });
  const onDone = jest.fn();
  const yieldTurn = jest.fn(async () => {});
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const trigger = jest.fn(async (id: string) => {
    if (id === LEDGER_REKEY_JOB_ID) await job!.run();
  });
  const registered = registerLedgerRekey({
    store: { ledgerRekeyed: async () => flag, ledgerRekeyPage },
    scheduler: {
      register: async (id, cadence, run) => {
        if (id === LEDGER_REKEY_JOB_ID) job = { cadence, run };
      },
      trigger,
    },
    logs: { log: () => {} },
    onDone,
    yieldTurn,
    setTimer: (fn, ms) => void timers.push({ fn, ms }),
  });
  /** Fires the oldest pending retry timer and waits for the re-run. */
  const fireTimer = async () => {
    const t = timers.shift();
    if (!t) throw new Error('no retry timer scheduled');
    const before = trigger.mock.calls.length;
    t.fn();
    // kick() triggers one microtask later (after the registered check).
    for (let i = 0; i < 10 && trigger.mock.calls.length === before; i += 1)
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    await trigger.mock.results.at(-1)!.value;
  };
  return {
    registered,
    job: () => job!,
    ledgerRekeyPage,
    onDone,
    yieldTurn,
    timers,
    trigger,
    fireTimer,
  };
}

describe('ledger re-key job (#59 §0)', () => {
  it('is a manual job: the scheduler tick never fires it', async () => {
    const h = harness([]);
    await h.registered;
    expect(h.job().cadence).toBe('manual');
  });

  it('pages until done, yielding between pages, then fires the wake once', async () => {
    const h = harness([false, false, true]);
    await h.registered;
    await h.job().run();
    expect(h.ledgerRekeyPage).toHaveBeenCalledTimes(3);
    expect(h.yieldTurn).toHaveBeenCalledTimes(2);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it('runs once: a second run reads only the cached flag', async () => {
    const h = harness([true]);
    await h.registered;
    await h.job().run();
    await h.job().run();
    expect(h.ledgerRekeyPage).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it('a page that fails (DB-worker crash) re-triggers itself after a backoff and resumes to completion', async () => {
    const h = harness([false, new Error('db worker crashed'), false, true]);
    await h.registered;
    await h.job().run(); // page 1 ok, page 2 rejects
    expect(h.ledgerRekeyPage).toHaveBeenCalledTimes(2);
    expect(h.onDone).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(1);
    await h.fireTimer(); // resumes from the durable cursor
    expect(h.trigger).toHaveBeenCalledWith(LEDGER_REKEY_JOB_ID);
    expect(h.ledgerRekeyPage).toHaveBeenCalledTimes(4);
    expect(h.onDone).toHaveBeenCalledTimes(1);
    expect(h.timers).toHaveLength(0);
  });

  it('backs off with growing delays and gives up after a bounded number of retries', async () => {
    const h = harness(
      Array.from(
        { length: LEDGER_REKEY_MAX_RETRIES + 5 },
        () => new Error('db worker permanently dead'),
      ),
    );
    await h.registered;
    await h.job().run();
    const delays: number[] = [];
    while (h.timers.length > 0) {
      delays.push(h.timers[0].ms);
      // eslint-disable-next-line no-await-in-loop
      await h.fireTimer();
    }
    expect(delays).toHaveLength(LEDGER_REKEY_MAX_RETRIES);
    for (let i = 1; i < delays.length; i += 1)
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    expect(h.ledgerRekeyPage).toHaveBeenCalledTimes(
      LEDGER_REKEY_MAX_RETRIES + 1,
    );
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it('a successful page resets the retry budget', async () => {
    const pages: Array<boolean | Error> = [];
    for (let i = 0; i < LEDGER_REKEY_MAX_RETRIES + 2; i += 1)
      pages.push(new Error('crash'), false);
    pages.push(true);
    const h = harness(pages);
    await h.registered;
    await h.job().run();
    while (h.timers.length > 0)
      // eslint-disable-next-line no-await-in-loop
      await h.fireTimer();
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  /** The real scheduler over a fake schedule table. Page two fails; then
   *  `failOnce` (if any) fails exactly once more — the boot kick's or the
   *  retry's schedule write, or the retry's completion check. */
  async function realSchedulerRun(
    failOnce:
      | 'none'
      | 'retry-schedule-write'
      | 'boot-schedule-write'
      | 'completion-check',
  ) {
    const rows = new Map<string, unknown>();
    let upserts = 0;
    let armed = failOnce;
    const scheduler = createScheduler(
      {
        scheduleAll: async () => [...rows.values()],
        scheduleUpsert: async (r: { jobId: string }) => {
          upserts += 1;
          // upsert 1 = register(); 2 = the boot kick's run; 3 = the retry's.
          if (
            (armed === 'boot-schedule-write' && upserts === 2) ||
            (armed === 'retry-schedule-write' && upserts === 3)
          ) {
            armed = 'none';
            throw new Error('db worker crashed');
          }
          rows.set(r.jobId, r);
        },
      } as unknown as CoreStore,
      () => ({ onBattery: false, thermal: 'nominal' }) as never,
      { log: () => {} },
    );
    const pages: Array<boolean | Error> =
      failOnce === 'boot-schedule-write'
        ? [false, true]
        : [false, new Error('crash'), true];
    let flag = false;
    let checks = 0;
    const ledgerRekeyPage = jest.fn(async () => {
      const next = pages.shift() ?? true;
      if (next instanceof Error) throw next;
      if (next) flag = true;
      return { done: next, scanned: 1 };
    });
    const timers: Array<() => void> = [];
    const onDone = jest.fn();
    const { kick } = await registerLedgerRekey({
      store: {
        ledgerRekeyed: async () => {
          checks += 1;
          // check 1 = the boot run; check 2 = the first retry.
          if (armed === 'completion-check' && checks === 2) {
            armed = 'none';
            throw new Error('db worker crashed');
          }
          return flag;
        },
        ledgerRekeyPage,
      },
      scheduler,
      logs: { log: () => {} },
      onDone,
      yieldTurn: async () => {},
      setTimer: (fn) => void timers.push(fn),
    });
    const flush = async () => {
      for (let i = 0; i < 10; i += 1)
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    };
    kick(); // the one boot trigger
    await flush();
    for (let i = 0; timers.length > 0 && i < 20; i += 1) {
      timers.shift()!();
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }
    return { flag, onDone, timers };
  }

  it.each([
    'none',
    'retry-schedule-write',
    'boot-schedule-write',
    'completion-check',
  ] as const)(
    'with the real scheduler: page two fails, then a transient %s failure — the repair still completes and wakes the lane once',
    async (failOnce) => {
      const r = await realSchedulerRun(failOnce);
      expect(r.flag).toBe(true);
      expect(r.onDone).toHaveBeenCalledTimes(1);
      expect(r.timers).toHaveLength(0);
    },
  );

  it('a retry trigger that keeps rejecting (store gone) backs off boundedly, never an unhandled rejection', async () => {
    const timers: Array<() => void> = [];
    let job: (() => Promise<void>) | null = null;
    const trigger = jest.fn(async () => {
      throw new Error('corpus DB is permanently unavailable');
    });
    const { kick } = await registerLedgerRekey({
      store: {
        ledgerRekeyed: async () => false,
        ledgerRekeyPage: async () => {
          throw new Error('db worker crashed');
        },
      },
      scheduler: {
        register: async (_id, _c, run) => {
          job = run;
        },
        trigger,
      },
      logs: { log: () => {} },
      onDone: () => {},
      yieldTurn: async () => {},
      setTimer: (fn) => void timers.push(fn),
    });
    expect(job).not.toBeNull();
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      kick();
      for (let i = 0; i < 50; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
        timers.shift()?.();
      }
      await new Promise((r) => setImmediate(r));
    } finally {
      process.off('unhandledRejection', unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(trigger).toHaveBeenCalledTimes(LEDGER_REKEY_MAX_RETRIES + 1);
    expect(timers).toHaveLength(0);
  });

  it('a registration that keeps failing is retried by each kick on the same backoff, then completes', async () => {
    let registerFailures = 2; // the eager boot registration + the first kick
    let job: (() => Promise<void>) | null = null;
    let flag = false;
    const timers: Array<() => void> = [];
    const onDone = jest.fn();
    const { kick } = await registerLedgerRekey({
      store: {
        ledgerRekeyed: async () => flag,
        ledgerRekeyPage: async () => {
          flag = true;
          return { done: true, scanned: 0 };
        },
      },
      scheduler: {
        register: async (_id, _c, run) => {
          if (registerFailures > 0) {
            registerFailures -= 1;
            throw new Error('db worker crashed');
          }
          job = run;
        },
        trigger: async () => {
          if (!job) throw new Error('not registered');
          await job();
        },
      },
      logs: { log: () => {} },
      onDone,
      yieldTurn: async () => {},
      setTimer: (fn) => void timers.push(fn),
    });
    const flush = async () => {
      for (let i = 0; i < 10; i += 1)
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setImmediate(r));
    };
    kick();
    await flush();
    expect(timers).toHaveLength(1); // the kick's registration failed
    timers.shift()!();
    await flush();
    expect(flag).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(timers).toHaveLength(0);
  });
});
