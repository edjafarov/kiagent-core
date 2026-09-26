import { needsYou, sourceStatus } from '../source-status';

test('each status names its one fix', () => {
  expect(sourceStatus({ status: 'needsReauth' })).toMatchObject({
    label: 'Signed out',
    tone: 'err',
    fix: 'reconnect',
  });
  expect(sourceStatus({ status: 'error' })).toMatchObject({ fix: 'retry' });
  expect(sourceStatus({ status: 'paused' })).toMatchObject({
    label: 'Paused',
    fix: 'resume',
  });
  expect(sourceStatus({ status: 'live' })).toMatchObject({
    label: null,
    fix: null,
  });
});

test('a first import reports its share only with a known total', () => {
  expect(
    sourceStatus({
      status: 'backfilling',
      progress: { done: 64, totalEstimate: 100 },
    } as never).importPercent,
  ).toBe(64);
  expect(sourceStatus({ status: 'backfilling' }).importPercent).toBeNull();
});

test('needs you: signed out or failing', () => {
  expect(needsYou({ status: 'needsReauth' })).toBe(true);
  expect(needsYou({ status: 'error' })).toBe(true);
  expect(needsYou({ status: 'paused' })).toBe(false);
});
