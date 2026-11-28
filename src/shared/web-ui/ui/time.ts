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

type When = number | string | null | undefined;

/** Epoch ms from epoch ms or an ISO string; NaN when there is none. */
function toMs(at: When): number {
  if (typeof at === 'number') return at;
  return at ? Date.parse(at) : NaN;
}

/** "2 Oct", with the year once it is not the current one; empty when
 *  there is no date. */
export function shortDate(at: When, now: number): string {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return '';
  const year = new Date(ms).getFullYear();
  return year === new Date(now).getFullYear()
    ? dayMonth(ms)
    : `${dayMonth(ms)} ${year}`;
}

/** How long ago, floored. 'words' is for a sentence ("12 min ago"),
 *  'short' for a column ("12m"). Old enough, both give the date: from a
 *  week on in 'short', from 30 days on in 'words'. A time ahead reads as
 *  now. Empty when there is no time: the caller owns its placeholder. */
export function ago(at: When, now: number, form: 'words' | 'short'): string {
  const ms = toMs(at);
  if (!Number.isFinite(ms)) return '';
  const age = Math.max(0, now - ms);
  const words = form === 'words';
  if (age >= (words ? 30 : 7) * DAY_MS) return shortDate(ms, now);
  if (age < 60_000) return words ? 'just now' : 'now';
  const [n, unit] =
    age < 3_600_000
      ? [Math.floor(age / 60_000), words ? ' min' : 'm']
      : age < DAY_MS
        ? [Math.floor(age / 3_600_000), words ? ' h' : 'h']
        : [Math.floor(age / DAY_MS), words ? ' d' : 'd'];
  return words ? `${n}${unit} ago` : `${n}${unit}`;
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
