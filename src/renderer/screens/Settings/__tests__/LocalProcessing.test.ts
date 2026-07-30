import { pausedLine } from '../LocalProcessing';

it.each([
  ['open lane shows nothing', 'open', 12, null],
  ['empty queue shows nothing even when closed', 'until-idle', 0, null],
  [
    'idle window, user active',
    'until-idle',
    1700,
    'Paused — waiting for this Mac to be idle.',
  ],
  [
    'night window, daytime',
    'until-night',
    3,
    'Paused — runs overnight (22:00–07:00).',
  ],
  ['on battery', 'battery', 3, 'Paused — on battery power.'],
  [
    'processing disabled',
    'disabled',
    3,
    'Paused — background processing is turned off.',
  ],
] as const)('%s', (_n, lane, queued, want) => {
  expect(pausedLine(lane, queued)).toBe(want);
});
