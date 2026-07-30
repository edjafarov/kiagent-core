import { backgroundLaneOpen, backgroundLaneState } from '../boot';
import type { CorePlatform } from '../boot';

function platform(over: {
  enabled?: boolean;
  window?: 'always' | 'idle' | 'night';
  onBattery?: boolean;
  userActive?: boolean;
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
])('%s → %s', (_n, over, now, want) => {
  expect(backgroundLaneState(platform(over), now)).toBe(want);
  expect(backgroundLaneOpen(platform(over), now)).toBe(want === 'open');
});
