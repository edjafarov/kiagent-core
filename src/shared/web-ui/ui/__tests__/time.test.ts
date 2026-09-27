import { clockTime, dayGroup, shortDay, startOfWeek } from '../time';

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
