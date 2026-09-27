// When something happened, in the words every list shares: day groups
// (Today, Yesterday, This week, Earlier), clock times and short days.
import { useEffect, useState } from 'react';

export type DayGroupName = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

const DAY_MS = 86_400_000;
const WEEKDAYS = 'Sun Mon Tue Wed Thu Fri Sat'.split(' ');
const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

function midnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Monday 00:00 of the week holding `now`. */
export function startOfWeek(now: number): number {
  const d = new Date(midnight(now));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

export function dayGroup(ms: number, now: number): DayGroupName {
  const today = midnight(now);
  if (ms >= today) return 'Today';
  // Local midnight a day back, so a DST change never moves the line.
  const yesterday = midnight(today - DAY_MS / 2);
  if (ms >= yesterday) return 'Yesterday';
  if (ms >= startOfWeek(now)) return 'This week';
  return 'Earlier';
}

/** "09:05", 24-hour. */
export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "30 Sep" — three-letter months everywhere (Intl's en-GB says "Sept"). */
export function dayMonth(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The day a row names: the clock for today and yesterday (the group
 *  already says which), the weekday within this week, else "15 Sep". */
export function shortDay(ms: number, now: number): string {
  const group = dayGroup(ms, now);
  const d = new Date(ms);
  if (group === 'Today' || group === 'Yesterday') return clockTime(ms);
  if (group === 'This week') return WEEKDAYS[d.getDay()];
  return dayMonth(ms);
}

/** A clock for relative times, ticking every `ms`. */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}
