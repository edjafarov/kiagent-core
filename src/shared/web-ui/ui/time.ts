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

const isHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Runs `fn` every `ms` while the window is visible. Hidden, it stops (a
 *  hidden window has nothing to repaint); on becoming visible again it runs
 *  `fn` at once, to catch up, and resumes. Returns the stop function. */
export function everyWhileVisible(fn: () => void, ms: number): () => void {
  let timer: number | undefined;
  const start = (): void => {
    if (timer === undefined) timer = window.setInterval(fn, ms);
  };
  const stop = (): void => {
    if (timer === undefined) return;
    window.clearInterval(timer);
    timer = undefined;
  };
  const onVisibility = (): void => {
    if (isHidden()) stop();
    else if (timer === undefined) {
      fn();
      start();
    }
  };
  if (!isHidden()) start();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** One ticker per interval, however many clocks read it. */
const nowTickers = new Map<
  number,
  { subscribers: Set<(now: number) => void>; stop: () => void }
>();

function subscribeNow(
  ms: number,
  subscriber: (now: number) => void,
): () => void {
  let ticker = nowTickers.get(ms);
  if (!ticker) {
    const subscribers = new Set<(now: number) => void>();
    const stop = everyWhileVisible(() => {
      const now = Date.now();
      subscribers.forEach((notify) => notify(now));
    }, ms);
    ticker = { subscribers, stop };
    nowTickers.set(ms, ticker);
  }
  const own = ticker;
  own.subscribers.add(subscriber);
  return () => {
    own.subscribers.delete(subscriber);
    if (own.subscribers.size > 0) return;
    own.stop();
    if (nowTickers.get(ms) === own) nowTickers.delete(ms);
  };
}

/** A clock for relative times, ticking every `ms` while the window is
 *  visible; it catches up the moment the window is shown again. */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeNow(ms, setNow), [ms]);
  return now;
}
