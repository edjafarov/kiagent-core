import { backgroundLaneOpen, backgroundLaneState, takeLaneWake } from '../boot';
import type { CorePlatform } from '../boot';
import { createInference, LaneClosedError } from '../inference';
import { createProcessingStatus } from '../processing-status';

const GiB = 1024 ** 3;

function platform(over: {
  enabled?: boolean;
  window?: 'always' | 'idle' | 'night';
  onBattery?: boolean;
  userActive?: boolean;
  weak?: boolean;
  syncing?: boolean;
}): CorePlatform {
  return {
    prefs: {
      get: () => ({
        processing: {
          enabled: over.enabled ?? true,
          window: over.window ?? 'always',
        },
      }),
    },
    scheduler: {
      env: {
        onBattery: over.onBattery ?? false,
        thermal: 'nominal',
        appFocus: 'focused',
        userActive: over.userActive ?? false,
      },
    },
    host: over.weak
      ? { platform: 'darwin', arch: 'arm64', cores: 4, totalMemBytes: 8 * GiB }
      : {
          platform: 'darwin',
          arch: 'arm64',
          cores: 8,
          totalMemBytes: 16 * GiB,
        },
    llmAccel: () => 'metal',
    engine: { syncing: () => over.syncing ?? false },
  } as unknown as CorePlatform;
}

const NOON = new Date('2026-01-01T12:00:00');
const LATE = new Date('2026-01-01T23:30:00');
const EARLY = new Date('2026-01-01T06:00:00');

it.each([
  ['disabled beats everything', { enabled: false }, NOON, 'disabled'],
  ['battery closes any window', { onBattery: true }, NOON, 'battery'],
  ['always on AC', {}, NOON, 'open'],
  ['night window, late evening', { window: 'night' as const }, LATE, 'open'],
  ['night window, early morning', { window: 'night' as const }, EARLY, 'open'],
  ['night window, daytime', { window: 'night' as const }, NOON, 'until-night'],
  [
    'idle window, user active',
    { window: 'idle' as const, userActive: true },
    NOON,
    'until-idle',
  ],
  [
    'idle window, machine idle',
    { window: 'idle' as const, userActive: false },
    NOON,
    'open',
  ],
  [
    'weak + syncing waits for sync',
    { weak: true, syncing: true },
    NOON,
    'until-synced',
  ],
  [
    'weak, sync done → window decides',
    { weak: true, syncing: false },
    NOON,
    'open',
  ],
  ['strong + syncing is unaffected', { syncing: true }, NOON, 'open'],
  [
    'battery beats until-synced',
    { weak: true, syncing: true, onBattery: true },
    NOON,
    'battery',
  ],
  [
    'disabled beats until-synced',
    { weak: true, syncing: true, enabled: false },
    NOON,
    'disabled',
  ],
  [
    'until-synced beats the idle window',
    { weak: true, syncing: true, window: 'idle' as const, userActive: true },
    NOON,
    'until-synced',
  ],
])('%s → %s', (_n, over, now, want) => {
  expect(backgroundLaneState(platform(over), now)).toBe(want);
  expect(backgroundLaneOpen(platform(over), now)).toBe(want === 'open');
});

describe('pending wake', () => {
  it('a refusal leaves one pending wake; taking it clears it', () => {
    const p = platform({ weak: true, syncing: true });
    expect(takeLaneWake(p)).toBe(false);
    expect(backgroundLaneOpen(p)).toBe(false);
    expect(backgroundLaneOpen(p)).toBe(false);
    expect(takeLaneWake(p)).toBe(true);
    expect(takeLaneWake(p)).toBe(false);
  });
  it('an open answer never sets it', () => {
    const p = platform({});
    expect(backgroundLaneOpen(p)).toBe(true);
    expect(takeLaneWake(p)).toBe(false);
  });
});

describe('refusal → pending wake → publisher tick', () => {
  function status() {
    const wakeWorkers = jest.fn(async () => {});
    const s = createProcessingStatus({
      countWaiting: async () => 0,
      providers: () => [],
      activeCalls: { list: () => [], onChange: () => () => {} },
      wakeWorkers,
      patch: () => {},
      warn: () => {},
    } as never);
    return { s, wakeWorkers };
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('an inference-admission refusal before the first tick wakes on the first open tick', async () => {
    let syncing = true;
    const p = platform({ weak: true });
    (p as any).engine = { syncing: () => syncing };
    const plane = createInference({ log: () => {} } as never);
    plane.register({
      id: 'x',
      supports: ['read'],
      status: () => 'ready',
      handle: async () => 't',
    } as never);
    plane.setLanePolicy(() => backgroundLaneOpen(p));
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).rejects.toThrow(LaneClosedError);
    syncing = false; // sync finished before any tick ran
    const { s, wakeWorkers } = status();
    const lane = backgroundLaneState(p);
    s.tick(lane, lane === 'open' && takeLaneWake(p));
    await flush();
    expect(wakeWorkers).toHaveBeenCalledTimes(1);
  });

  it('a worker pre-flight refusal between two open ticks wakes on the next tick', async () => {
    let syncing = false;
    const p = platform({ weak: true });
    (p as any).engine = { syncing: () => syncing };
    const { s, wakeWorkers } = status();
    s.tick(backgroundLaneState(p), takeLaneWake(p)); // open, nothing pending
    syncing = true;
    expect(backgroundLaneOpen(p)).toBe(false); // worker laneOpen() refuses
    syncing = false; // …and sync ends before the next tick
    const lane = backgroundLaneState(p);
    s.tick(lane, lane === 'open' && takeLaneWake(p));
    await flush();
    expect(wakeWorkers).toHaveBeenCalledTimes(1);
  });
});
