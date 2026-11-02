/** One predicate decides which statuses are resting (spec 7.7 step 2): paused,
 *  needsReauth and needs-connector never start by themselves. A status literal
 *  compared anywhere else in core is a path that forgot needs-connector. */
import { execFileSync } from 'child_process';
import path from 'path';

import { isParked, isResting } from '../../engine/resting';

it('classifies the three resting statuses', () => {
  for (const s of ['paused', 'needsReauth', 'needs-connector'] as const) expect(isResting(s)).toBe(true);
  expect(isParked('needsReauth')).toBe(false);
  expect(isParked('needs-connector')).toBe(true);
  expect(isParked('paused')).toBe(true);
  for (const s of ['connecting', 'backfilling', 'live', 'error'] as const) expect(isResting(s)).toBe(false);
});

it('no other core file compares against paused or needsReauth to decide a start', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const out = (() => {
    try {
      return execFileSync(
        'grep',
        ['-rnE', "status\\s*(!==|===)\\s*'(paused|needsReauth)'", path.join(root, 'core'), '--include=*.ts'],
        { encoding: 'utf8' },
      );
    } catch {
      return '';
    }
  })();
  const strays = out
    .split('\n')
    .filter(Boolean)
    .filter((l) => !/__tests__|engine\/resting\.ts/.test(l) && !/^\S+:\d+:\s*(\/\/|\*)/.test(l));
  // Two survivors in engine.ts, neither a "may this start" question: the
  // loop-entry recheck that a pause landed, and the fetchBytes re-auth message.
  const allowed = [
    /core\/engine\/engine\.ts:\d+:\s*if \(fresh\.status === 'paused' \|\| pauseIntents/,
    /core\/engine\/engine\.ts:\d+:\s*if \(account\.status === 'needsReauth'\)/,
  ];
  expect(strays.filter((l) => !allowed.some((a) => a.test(l)))).toEqual([]);
});
