/** @jest-environment node */
import {
  createAdmission,
  FOREGROUND_GRACE_MS,
  inForeground,
  KIND_AGING_MS,
  MAX_FOREGROUND_WAIT_MS,
  type AdmissionDeps,
  type UnitKind,
} from '../admission';

/** A virtual clock: timers fire only when the test advances time. */
function virtualClock() {
  let t = 0;
  let seq = 0;
  const timers: Array<{ at: number; id: number; fn: () => void }> = [];
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const h = { at: t + Math.max(0, ms), id: (seq += 1), fn };
      timers.push(h);
      return h;
    },
    clearTimer: (h: unknown) => {
      const i = timers.indexOf(h as never);
      if (i >= 0) timers.splice(i, 1);
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
      t = end;
      await flush();
    },
    flush,
  };
}

const idle = {
  processing: () => ({ enabled: true, window: 'always' as const }),
  env: () => ({ onBattery: false, userActive: false }),
  weak: () => false,
  syncing: () => false,
};

function setup(over: Partial<AdmissionDeps> = {}) {
  const clock = virtualClock();
  const a = createAdmission({
    slots: 1,
    userActive: () => false,
    enrichment: idle,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...over,
  });
  return { a, clock };
}

/** Acquire and record when it resolves. */
function track(
  a: ReturnType<typeof createAdmission>,
  kind: UnitKind,
  signal = new AbortController().signal,
) {
  const s: { release?: () => void; error?: Error } = {};
  a.acquire(kind, signal).then(
    (r) => {
      s.release = r;
    },
    (e: Error) => {
      s.error = e;
    },
  );
  return s;
}

it('orders waiters ingest > convert > reconcile > redrive, then FIFO', async () => {
  const { a, clock } = setup();
  const first = track(a, 'ingest');
  await clock.flush();
  const order: string[] = [];
  const kinds: Array<[UnitKind, string]> = [
    ['redrive', 'R'],
    ['convert', 'C1'],
    ['ingest', 'I2'],
    ['reconcile', 'X'],
    ['convert', 'C2'],
  ];
  const waiters = kinds.map(([k, name]) => ({ name, s: track(a, k) }));
  await clock.flush();
  first.release!();
  for (let i = 0; i < kinds.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await clock.flush();
    const got = waiters.find((w) => w.s.release && !order.includes(w.name))!;
    order.push(got.name);
    got.s.release!();
  }
  expect(order).toEqual(['I2', 'C1', 'C2', 'X', 'R']);
});

it('caps running units at slots', async () => {
  const { a, clock } = setup({ slots: 2 });
  const s = [track(a, 'ingest'), track(a, 'ingest'), track(a, 'ingest')];
  await clock.flush();
  expect(s.map((x) => Boolean(x.release))).toEqual([true, true, false]);
  expect(a.snapshot().running).toBe(2);
});

it('foreground blocks new units, running ones finish; admission resumes after the grace', async () => {
  const { a, clock } = setup({ slots: 2 });
  const running = track(a, 'ingest');
  await clock.flush();
  const leave = a.foreground();
  const blocked = track(a, 'ingest');
  await clock.flush();
  expect(blocked.release).toBeUndefined();
  running.release!(); // a running unit is never preempted, it just finishes
  await clock.advance(100);
  leave();
  leave(); // idempotent
  await clock.advance(FOREGROUND_GRACE_MS - 1);
  expect(blocked.release).toBeUndefined();
  expect(a.foregroundBusy()).toBe(true);
  await clock.advance(1);
  expect(blocked.release).toBeDefined();
  expect(a.foregroundBusy()).toBe(false);
});

it('starvation escape: a 10 s waiter is admitted anyway, one at a time', async () => {
  const { a, clock } = setup({ slots: 2 });
  a.foreground(); // never leaves: a polling agent
  const one = track(a, 'ingest');
  const two = track(a, 'convert');
  await clock.advance(MAX_FOREGROUND_WAIT_MS - 1);
  expect(one.release).toBeUndefined();
  await clock.advance(1);
  expect(one.release).toBeDefined();
  expect(two.release).toBeUndefined(); // one escaped unit at a time
  one.release!();
  await clock.flush();
  expect(two.release).toBeDefined();
  expect(a.snapshot().starvationEscapes).toBe(2);
});

it('kind aging: at cap 1 under continuous ingest, a convert waiter gets in within KIND_AGING_MS', async () => {
  const { a, clock } = setup();
  let ingest = track(a, 'ingest');
  await clock.flush();
  const convert = track(a, 'convert');
  let admittedAt = -1;
  for (let t = 0; t < 2 * KIND_AGING_MS && admittedAt < 0; t += 100) {
    const nextIngest = track(a, 'ingest'); // always a younger ingest waiter
    // eslint-disable-next-line no-await-in-loop
    await clock.advance(100);
    ingest.release!();
    // eslint-disable-next-line no-await-in-loop
    await clock.flush();
    if (convert.release) {
      admittedAt = clock.now();
      convert.release();
      // eslint-disable-next-line no-await-in-loop
      await clock.flush();
    }
    ingest = nextIngest;
  }
  expect(admittedAt).toBeGreaterThanOrEqual(KIND_AGING_MS);
  expect(admittedAt).toBeLessThanOrEqual(KIND_AGING_MS + 100);
});

it('slow mode: while the user is active a released slot stays held for factor × duration, capped at 2 s', async () => {
  let active = true;
  const { a, clock } = setup({ userActive: () => active });
  const first = track(a, 'ingest');
  await clock.flush();
  const second = track(a, 'ingest');
  await clock.advance(400);
  first.release!(); // ran 400 ms; factor 1.0 at 1 slot → held 400 ms
  await clock.advance(399);
  expect(second.release).toBeUndefined();
  await clock.advance(1);
  expect(second.release).toBeDefined();
  const third = track(a, 'ingest');
  await clock.advance(5_000);
  second.release!(); // ran 5 s → hold capped at 2 s
  await clock.advance(1_999);
  expect(third.release).toBeUndefined();
  await clock.advance(1);
  expect(third.release).toBeDefined();
  active = false;
  const fourth = track(a, 'ingest');
  third.release!(); // user away: no hold
  await clock.flush();
  expect(fourth.release).toBeDefined();
  expect(a.snapshot().slowModeHoldMs).toBe(2_400);
});

it('slow mode factor is 0.25 with 2 slots', async () => {
  const { a, clock } = setup({ slots: 2, userActive: () => true });
  const [x, y] = [track(a, 'ingest'), track(a, 'ingest')];
  await clock.flush();
  const z = track(a, 'ingest');
  await clock.advance(800);
  x.release!(); // held 200 ms
  await clock.advance(199);
  expect(z.release).toBeUndefined();
  await clock.advance(1);
  expect(z.release).toBeDefined();
  expect(y.release).toBeDefined();
});

it('lane states never stop units', async () => {
  const { a, clock } = setup({
    enrichment: {
      processing: () => ({ enabled: false, window: 'night' as const }),
      env: () => ({ onBattery: true, userActive: true }),
      weak: () => true,
      syncing: () => true,
    },
  });
  expect(a.enrichmentLane()).toBe('disabled');
  const s = track(a, 'ingest');
  await clock.flush();
  expect(s.release).toBeDefined();
});

it('abort rejects a waiting acquire with AbortError and it never takes a slot', async () => {
  const { a, clock } = setup();
  const holder = track(a, 'ingest');
  await clock.flush();
  const ac = new AbortController();
  const aborted = track(a, 'convert', ac.signal);
  const after = track(a, 'redrive');
  ac.abort();
  await clock.flush();
  expect(aborted.error?.name).toBe('AbortError');
  holder.release!();
  await clock.flush();
  expect(after.release).toBeDefined();
  await expect(a.acquire('ingest', ac.signal)).rejects.toHaveProperty(
    'name',
    'AbortError',
  );
});

it('release is idempotent', async () => {
  const { a, clock } = setup();
  const one = track(a, 'ingest');
  await clock.flush();
  const two = track(a, 'ingest');
  const three = track(a, 'ingest');
  one.release!();
  one.release!();
  await clock.flush();
  expect(two.release).toBeDefined();
  expect(three.release).toBeUndefined();
  expect(a.snapshot().running).toBe(1);
});

describe('foregroundIdle (enrichment waits, never throws)', () => {
  it('resolves at once when idle', async () => {
    const { a } = setup();
    await expect(a.foregroundIdle()).resolves.toBeUndefined();
  });
  it('waits while foreground is busy and resolves after the grace', async () => {
    const { a, clock } = setup();
    const leave = a.foreground();
    let done = false;
    void a.foregroundIdle().then(() => {
      done = true;
    });
    await clock.advance(1_000);
    expect(done).toBe(false);
    leave();
    await clock.advance(FOREGROUND_GRACE_MS);
    expect(done).toBe(true);
  });
  it('is capped at MAX_FOREGROUND_WAIT_MS', async () => {
    const { a, clock } = setup();
    a.foreground();
    let done = false;
    void a.foregroundIdle().then(() => {
      done = true;
    });
    await clock.advance(MAX_FOREGROUND_WAIT_MS - 1);
    expect(done).toBe(false);
    await clock.advance(1);
    expect(done).toBe(true);
  });
  it('rejects AbortError on abort', async () => {
    const { a, clock } = setup();
    a.foreground();
    const ac = new AbortController();
    // Assertion attached BEFORE the abort: a rejection left unhandled across
    // an event-loop turn is recorded by jest-circus as a test error.
    const rejected = await expect(
      a.foregroundIdle(ac.signal),
    ).rejects.toHaveProperty('name', 'AbortError');
    ac.abort();
    await clock.flush();
    await rejected;
  });
});

it('inForeground enters and leaves, including on throw', async () => {
  const { a } = setup();
  await expect(
    inForeground(a, async () => {
      expect(a.snapshot().foregroundInFlight).toBe(1);
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(a.snapshot().foregroundInFlight).toBe(0);
});
