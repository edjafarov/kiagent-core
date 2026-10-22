/** @jest-environment node */
import { draftSpan } from '../availability';
import {
  addDays,
  fmtTime,
  localDate,
  localDayStart,
  offsetMinutes,
  rangeNeedsOffsets,
} from '../local-time';
import { whenText } from '../pages';

const dayMin = (d: string, tz: string) =>
  (localDayStart(addDays(d, 1), tz) - localDayStart(d, tz)) / 60_000;

describe('local-time', () => {
  it('measures odd day lengths', () => {
    expect(dayMin('2026-10-25', 'Europe/Berlin')).toBe(1500);
    expect(dayMin('2026-03-29', 'Europe/Berlin')).toBe(1380);
    expect(dayMin('2026-10-04', 'Australia/Lord_Howe')).toBe(1410);
    expect(dayMin('2026-06-01', 'Europe/Berlin')).toBe(1440);
  });

  it('handles a missing and an ambiguous midnight (Havana)', () => {
    expect(
      new Date(localDayStart('2026-03-08', 'America/Havana')).toISOString(),
    ).toBe('2026-03-08T05:00:00.000Z');
    expect(
      localDate(
        localDayStart('2026-03-08', 'America/Havana'),
        'America/Havana',
      ),
    ).toBe('2026-03-08');
    const s = localDayStart('2026-11-01', 'America/Havana');
    expect(localDate(s, 'America/Havana')).toBe('2026-11-01');
    expect(localDate(s - 60_000, 'America/Havana')).toBe('2026-10-31');
    // the earlier of the two 00:00s is at the higher (summer) offset
    expect(offsetMinutes(s, 'America/Havana')).toBe(-240);
  });

  it('formats times, with offsets on request', () => {
    const t = Date.parse('2026-10-25T00:40:00Z');
    expect(fmtTime(t, 'Europe/Berlin', false)).toBe('02:40');
    expect(fmtTime(t, 'Europe/Berlin', true)).toBe('02:40 GMT+2');
    expect(
      fmtTime(Date.parse('2026-10-24T22:00:00Z'), 'Europe/Berlin', false),
    ).toBe('00:00');
  });

  it('flags ranges that need offsets', () => {
    const tz = 'Europe/Berlin';
    expect(
      rangeNeedsOffsets(
        Date.parse('2026-10-25T00:40:00Z'),
        Date.parse('2026-10-25T01:20:00Z'),
        tz,
      ),
    ).toBe(true);
    // both in the repeated hour, same offset
    expect(
      rangeNeedsOffsets(
        Date.parse('2026-10-25T00:10:00Z'),
        Date.parse('2026-10-25T00:30:00Z'),
        tz,
      ),
    ).toBe(true);
    expect(
      rangeNeedsOffsets(
        Date.parse('2026-10-26T09:00:00Z'),
        Date.parse('2026-10-26T10:00:00Z'),
        tz,
      ),
    ).toBe(false);
  });

  it('draftSpan uses the real day start for all-day spans', () => {
    const s = draftSpan({
      start: '2026-03-07',
      end: '2026-03-08',
      allDay: true,
      timeZone: 'America/Havana',
    });
    expect(s.end).toBe(
      new Date(localDayStart('2026-03-08', 'America/Havana')).toISOString(),
    );
    expect(s.end).toBe('2026-03-08T05:00:00.000Z');
  });
});

describe('whenText', () => {
  const p = (start: string, end: string, timeZone = 'Europe/Berlin') =>
    ({ start, end, allDay: false, timeZone }) as Parameters<typeof whenText>[0];

  it('plain case is unchanged', () => {
    expect(
      whenText(p('2026-11-03T18:00:00+01:00', '2026-11-03T19:30:00+01:00')),
    ).toBe('Tue 3 Nov, 18:00–19:30 (Europe/Berlin)');
  });
  it('prints offsets across the fall-back', () => {
    expect(
      whenText(p('2026-10-25T02:40:00+02:00', '2026-10-25T02:20:00+01:00')),
    ).toBe('Sun 25 Oct, 02:40 GMT+2–02:20 GMT+1 (Europe/Berlin)');
  });
  it('names both days for an overnight event', () => {
    expect(
      whenText(p('2026-10-23T23:00:00+02:00', '2026-10-24T01:00:00+02:00')),
    ).toBe('Fri 23 Oct, 23:00 – Sat 24 Oct, 01:00 (Europe/Berlin)');
  });
});
