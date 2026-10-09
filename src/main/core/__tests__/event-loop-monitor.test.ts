/** @jest-environment node */
import {
  startEventLoopMonitor,
  type HistogramLike,
} from '../event-loop-monitor';

function fakeHistogram(values: {
  p50: number;
  p99: number;
  max: number;
  count: number;
}) {
  const h: HistogramLike & { resets: number; enabled: boolean } = {
    resets: 0,
    enabled: false,
    enable() {
      h.enabled = true;
    },
    disable() {
      h.enabled = false;
    },
    reset() {
      h.resets += 1;
    },
    percentile: (p: number) => (p === 50 ? values.p50 : values.p99),
    get max() {
      return values.max;
    },
    get count() {
      return values.count;
    },
  };
  return h;
}

it('reports each window in ms, resets the histogram, and warns above the p99 threshold', () => {
  const ms = 1e6;
  const h = fakeHistogram({
    p50: 3 * ms,
    p99: 300 * ms,
    max: 900 * ms,
    count: 40,
  });
  let tick!: () => void;
  const warns: string[] = [];
  const m = startEventLoopMonitor({
    log: (_l, msg) => warns.push(msg),
    histogram: h,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
    now: () => 5_000,
  });
  expect(h.enabled).toBe(true);
  expect(m.last()).toBeNull();
  tick();
  expect(m.last()).toEqual({
    p50Ms: 3,
    p99Ms: 300,
    maxMs: 900,
    samples: 40,
    at: 5_000,
  });
  expect(h.resets).toBe(1);
  expect(warns).toHaveLength(1);
  expect(warns[0]).toMatch(/p99 300 ms/);
  m.stop();
  expect(h.enabled).toBe(false);
});

it('an empty window reports zeros and never warns', () => {
  const h = fakeHistogram({
    p50: Number.NaN,
    p99: Number.NaN,
    max: 0,
    count: 0,
  });
  let tick!: () => void;
  const warns: string[] = [];
  const m = startEventLoopMonitor({
    log: (_l, msg) => warns.push(msg),
    histogram: h,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
    now: () => 1,
  });
  tick();
  expect(m.last()).toEqual({ p50Ms: 0, p99Ms: 0, maxMs: 0, samples: 0, at: 1 });
  expect(warns).toHaveLength(0);
  m.stop();
});

it('the real histogram measures a blocked loop', async () => {
  let tick!: () => void;
  const m = startEventLoopMonitor({
    log: () => {},
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));
  const until = Date.now() + 120;
  while (Date.now() < until) {
    /* block the loop */
  }
  await new Promise((r) => setTimeout(r, 50));
  tick();
  expect(m.last()!.maxMs).toBeGreaterThanOrEqual(80);
  m.stop();
});
