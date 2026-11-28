import {
  ago,
  clockTime,
  dayGroup,
  shortDate,
  shortDay,
  startOfWeek,
} from '../time';

// Thursday 24 Sep 2026, 11:37 local.
const now = new Date(2026, 8, 24, 11, 37).getTime();
const at = (day: number, h = 10, m = 0) =>
  new Date(2026, 8, day, h, m).getTime();

test('the week starts on Monday at midnight', () => {
  expect(startOfWeek(now)).toBe(new Date(2026, 8, 21, 0, 0).getTime());
  // A Sunday belongs to the week that began six days before.
  expect(startOfWeek(at(27, 23))).toBe(new Date(2026, 8, 21).getTime());
});

test('day groups: Today, Yesterday, This week, Earlier', () => {
  expect(dayGroup(at(24, 0, 0), now)).toBe('Today');
  expect(dayGroup(at(23, 23, 59), now)).toBe('Yesterday');
  expect(dayGroup(at(23, 0, 0), now)).toBe('Yesterday');
  expect(dayGroup(at(22, 23, 59), now)).toBe('This week');
  expect(dayGroup(at(21, 0, 0), now)).toBe('This week');
  expect(dayGroup(at(20, 23, 59), now)).toBe('Earlier');
});

test('on a Monday, yesterday is still Yesterday, not Earlier', () => {
  const monday = new Date(2026, 8, 21, 9, 0).getTime();
  expect(dayGroup(at(20, 15), monday)).toBe('Yesterday');
  expect(dayGroup(at(19, 15), monday)).toBe('Earlier');
});

test('a row names the clock, the weekday or the date', () => {
  expect(clockTime(at(24, 9, 5))).toBe('09:05');
  expect(shortDay(at(24, 11, 2), now)).toBe('11:02');
  expect(shortDay(at(23, 16, 30), now)).toBe('16:30');
  expect(shortDay(at(22), now)).toBe('Tue');
  expect(shortDay(at(15), now)).toBe('15 Sep');
});

describe('ago', () => {
  const back = (ms: number) => now - ms;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  test('in words', () => {
    expect(ago(back(59_000), now, 'words')).toBe('just now');
    expect(ago(back(12 * MIN + 40_000), now, 'words')).toBe('12 min ago');
    expect(ago(back(3 * HOUR + 59 * MIN), now, 'words')).toBe('3 h ago');
    expect(ago(back(4 * DAY), now, 'words')).toBe('4 d ago');
    expect(ago(back(12 * DAY), now, 'words')).toBe('12 d ago');
    expect(ago(back(29 * DAY), now, 'words')).toBe('29 d ago');
    // 30 days before 24 Sep is 25 Aug
    expect(ago(back(30 * DAY), now, 'words')).toBe('25 Aug');
  });

  test('short', () => {
    expect(ago(back(59_000), now, 'short')).toBe('now');
    expect(ago(back(12 * MIN), now, 'short')).toBe('12m');
    expect(ago(back(3 * HOUR), now, 'short')).toBe('3h');
    expect(ago(back(6 * DAY), now, 'short')).toBe('6d');
    expect(ago(back(7 * DAY), now, 'short')).toBe('17 Sep');
  });

  test('takes an ISO string', () => {
    const iso = new Date(back(2 * HOUR)).toISOString();
    expect(ago(iso, now, 'words')).toBe('2 h ago');
  });

  test('a time ahead counts as now', () => {
    expect(ago(now + 5 * MIN, now, 'words')).toBe('just now');
    expect(ago(now + 5 * MIN, now, 'short')).toBe('now');
  });

  test('nothing to show for a missing or unreadable time', () => {
    expect(ago(null, now, 'words')).toBe('');
    expect(ago(undefined, now, 'short')).toBe('');
    expect(ago('not a date', now, 'words')).toBe('');
    expect(ago(NaN, now, 'short')).toBe('');
  });
});

test('shortDate names the year only when it is not this one', () => {
  expect(shortDate(at(2), now)).toBe('2 Sep');
  expect(shortDate(new Date(2025, 9, 2).getTime(), now)).toBe('2 Oct 2025');
  expect(shortDate(new Date(2026, 9, 2, 12).toISOString(), now)).toBe('2 Oct');
  expect(shortDate(null, now)).toBe('');
  expect(shortDate('nope', now)).toBe('');
});
