import type { ActiveCall, ProviderStatus } from '@shared/contracts';

import {
  createProcessingStatus,
  wakeDeferredWorkers,
  type ProcessingStatusDeps,
} from '../processing-status';

type Prov = { id: string; remote: boolean; status: ProviderStatus };

function setup(over: Partial<ProcessingStatusDeps> = {}) {
  let providers: Prov[] = [];
  let calls: ActiveCall[] = [];
  let sub: ((c: ActiveCall[]) => void) | null = null;
  const patch = jest.fn();
  const warn = jest.fn();
  const wakeWorkers = jest.fn(async () => {});
  const countWaiting = jest.fn(async () => 5);
  const deps: ProcessingStatusDeps = {
    countWaiting,
    providers: () => providers,
    activeCalls: {
      list: () => calls,
      onChange: (fn) => {
        sub = fn;
        return () => {
          sub = null;
        };
      },
    },
    wakeWorkers,
    patch,
    warn,
    ...over,
  };
  const status = createProcessingStatus(deps);
  return {
    status,
    patch,
    warn,
    wakeWorkers,
    countWaiting,
    setProviders: (p: Prov[]) => {
      providers = p;
    },
    emitCalls: (c: ActiveCall[]) => {
      calls = c;
      sub?.(c);
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('first waiting read happens on start, then on the interval, patching only on change', async () => {
  const t = setup();
  t.countWaiting
    .mockResolvedValueOnce(5)
    .mockResolvedValueOnce(5)
    .mockResolvedValueOnce(7);
  t.status.start();
  await flush();
  expect(t.patch).toHaveBeenCalledWith({ waiting: 5 });
  await jest.advanceTimersByTimeAsync(60_000);
  await jest.advanceTimersByTimeAsync(60_000);
  const waits = t.patch.mock.calls.filter(([p]) => 'waiting' in p);
  expect(waits.map(([p]) => p.waiting)).toEqual([5, 7]);
  expect(t.countWaiting).toHaveBeenCalledTimes(3);
  t.status.stop();
});

test('a closed->open flip wakes the workers once and then re-reads waiting', async () => {
  const t = setup();
  t.status.tick('until-idle');
  expect(t.wakeWorkers).not.toHaveBeenCalled();
  t.status.tick('open');
  t.status.tick('open');
  expect(t.wakeWorkers).toHaveBeenCalledTimes(1);
  expect(t.countWaiting).not.toHaveBeenCalled();
  await flush();
  expect(t.countWaiting).toHaveBeenCalledTimes(1);
});

test('open->closed and open->open do not wake', () => {
  const t = setup();
  t.status.tick('open');
  t.status.tick('open');
  t.status.tick('battery');
  expect(t.wakeWorkers).not.toHaveBeenCalled();
});

test('lane is patched only when it changes', () => {
  const t = setup();
  t.status.tick('open');
  t.status.tick('open');
  t.status.tick('disabled');
  expect(t.patch.mock.calls.filter(([p]) => 'lane' in p)).toEqual([
    [{ lane: 'open' }],
    [{ lane: 'disabled' }],
  ]);
});

test('refreshWaiting recomputes now and pushes only a changed count', async () => {
  const t = setup();
  t.countWaiting.mockResolvedValueOnce(2).mockResolvedValueOnce(2);
  await t.status.refreshWaiting();
  await t.status.refreshWaiting();
  expect(
    t.patch.mock.calls.filter(([p]) => 'waiting' in p).map(([p]) => p.waiting),
  ).toEqual([2]);
});

test('wakeDeferredWorkers triggers the vision and audio workers and survives a failure', async () => {
  const trigger = jest.fn(async (id: string) => {
    if (id === 'worker:vision') throw new Error('x');
  });
  await wakeDeferredWorkers({ trigger });
  expect(trigger.mock.calls.map(([id]) => id)).toEqual([
    'worker:vision',
    'worker:audio',
  ]);
});

test('download mirrors the first local downloading provider, including the speech model', () => {
  const t = setup();
  t.setProviders([
    { id: 'cloud', remote: true, status: { downloading: { pct: 1 } } },
    { id: 'local-asr', remote: false, status: { downloading: { pct: 42 } } },
  ]);
  t.status.tick('open');
  expect(t.patch).toHaveBeenCalledWith({
    download: { providerId: 'local-asr', pct: 42 },
  });
  t.setProviders([{ id: 'local-asr', remote: false, status: 'ready' }]);
  t.status.tick('open');
  expect(t.patch).toHaveBeenLastCalledWith({ download: null });
});

test('active is patched only when the (op, task) list changes', () => {
  const t = setup();
  t.status.start();
  const patchesBefore = () =>
    t.patch.mock.calls.filter(([p]) => 'active' in p).length;
  const base = patchesBefore();
  t.emitCalls([{ op: 'see', task: 'a' }]);
  t.emitCalls([{ op: 'see', task: 'a' }]);
  expect(patchesBefore() - base).toBe(1);
  t.emitCalls([]);
  jest.advanceTimersByTime(250);
  expect(patchesBefore() - base).toBe(2);
  t.status.stop();
});

const activePatches = (t: ReturnType<typeof setup>) =>
  t.patch.mock.calls.filter(([p]) => 'active' in p).map(([p]) => p.active);

test('a call that enters and leaves within 50 ms is shown, and [] only lands after 250 ms', () => {
  const t = setup();
  t.status.start();
  t.patch.mockClear();
  t.emitCalls([{ op: 'see', task: 'a' }]);
  jest.advanceTimersByTime(50);
  t.emitCalls([]);
  expect(activePatches(t)).toEqual([[{ op: 'see', task: 'a' }]]);
  jest.advanceTimersByTime(249);
  expect(activePatches(t)).toHaveLength(1);
  jest.advanceTimersByTime(1);
  expect(activePatches(t)).toEqual([[{ op: 'see', task: 'a' }], []]);
  t.status.stop();
});

test('a new call entering inside the grace window cancels the pending []', () => {
  const t = setup();
  t.status.start();
  t.emitCalls([{ op: 'see', task: 'a' }]);
  t.patch.mockClear();
  t.emitCalls([]);
  jest.advanceTimersByTime(100);
  t.emitCalls([{ op: 'see', task: 'b' }]);
  jest.advanceTimersByTime(1000);
  expect(activePatches(t)).toEqual([[{ op: 'see', task: 'b' }]]);
  t.status.stop();
});

test('stop() clears a pending empty patch', () => {
  const t = setup();
  t.status.start();
  t.emitCalls([{ op: 'see', task: 'a' }]);
  t.patch.mockClear();
  t.emitCalls([]);
  t.status.stop();
  jest.advanceTimersByTime(1000);
  expect(activePatches(t)).toEqual([]);
});

test('a failing count keeps the last value and warns', async () => {
  const t = setup();
  t.countWaiting.mockResolvedValueOnce(4).mockRejectedValueOnce(new Error('x'));
  t.status.start();
  await flush();
  await jest.advanceTimersByTimeAsync(60_000);
  expect(t.warn).toHaveBeenCalledTimes(1);
  expect(
    t.patch.mock.calls.filter(([p]) => 'waiting' in p).map(([p]) => p.waiting),
  ).toEqual([4]);
  t.status.stop();
});
