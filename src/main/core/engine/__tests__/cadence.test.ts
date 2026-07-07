import { everyToMs, nextRun } from '../cadence';

describe('cadence', () => {
  it('parses interval strings', () => {
    expect(everyToMs('15m')).toBe(15 * 60_000);
    expect(everyToMs('1h')).toBe(3_600_000);
    expect(everyToMs('2d')).toBe(2 * 86_400_000);
    expect(() => everyToMs('soon')).toThrow();
  });

  it('manual never runs', () => {
    expect(nextRun('manual', null, new Date())).toBeNull();
  });

  it('every: overdue jobs run now, fresh jobs run after the interval', () => {
    const now = new Date('2026-07-02T12:00:00Z');
    expect(nextRun({ every: '1h' }, null, now)).toEqual(now); // never ran → due
    const recent = nextRun({ every: '1h' }, '2026-07-02T11:30:00Z', now);
    expect(recent).toEqual(new Date('2026-07-02T12:30:00Z'));
  });

  it('cron: nightly at 03:00 fires next at 03:00', () => {
    const now = new Date('2026-07-02T12:00:00');
    const next = nextRun({ cron: '0 3 * * *' }, null, now)!;
    expect(next.getHours()).toBe(3);
    expect(next.getMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(now.getTime());
  });
});
