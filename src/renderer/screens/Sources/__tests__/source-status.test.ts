import { needsYou, sourceStatus } from '../source-status';

test('each status names its fixes, the main one first', () => {
  expect(sourceStatus({ status: 'needsReauth' })).toMatchObject({
    label: 'Signed out',
    tone: 'err',
    fixes: ['reconnect'],
  });
  // R4: an error can be a dead sign-in.
  expect(sourceStatus({ status: 'error' })).toMatchObject({
    fixes: ['retry', 'reconnect'],
  });
  expect(sourceStatus({ status: 'paused' })).toMatchObject({
    label: 'Paused',
    fixes: ['resume'],
  });
  expect(sourceStatus({ status: 'live' })).toMatchObject({
    label: null,
    fixes: [],
    problem: null,
  });
});

test('an error’s problem sentence is its last error when there is one', () => {
  expect(
    sourceStatus({ status: 'error', lastError: 'rate limited' }).problem,
  ).toMatchObject({ title: 'Stopped by an error', sub: 'rate limited' });
  expect(sourceStatus({ status: 'error' }).problem?.sub).toBe(
    'Nothing new arrives until it runs again.',
  );
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
