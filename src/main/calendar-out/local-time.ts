/**
 * DST-safe local-time helpers for the event review day view. Everything is
 * derived from `Intl` so odd zones (missing midnights, 30-minute shifts,
 * repeated hours) resolve the way the user's clock does.
 */

const dateFmt = new Map<string, Intl.DateTimeFormat>();
const offsetFmt = new Map<string, Intl.DateTimeFormat>();
const timeFmt = new Map<string, Intl.DateTimeFormat>();

function cached(
  cache: Map<string, Intl.DateTimeFormat>,
  tz: string,
  opts: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  let f = cache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz });
    cache.set(tz, f);
  }
  return f;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

/** YYYY-MM-DD of `ms` on the wall clock of `tz`. */
export function localDate(ms: number, tz: string): string {
  const f = cached(dateFmt, tz, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Minutes east of UTC at instant `ms` (Berlin summer = 120). */
export function offsetMinutes(ms: number, tz: string): number {
  const f = cached(offsetFmt, tz, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms)))
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / MIN);
}

/** The earliest instant whose local date in `tz` is `date` — or, for a
 *  date the zone skipped (Pacific/Apia 2011-12-30), the start of the next
 *  date. An impossible date (11-31) rolls over like Date.UTC does. */
export function localDayStart(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const want = addDays(
    `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    0,
  );
  // No zone is more than 14 h ahead of UTC or 12 h behind, so 15 h before UTC
  // midnight is still an earlier local date and 39 h after is a later one.
  let t = Date.UTC(y, m - 1, d) - 15 * HOUR;
  const stop = t + 54 * HOUR;
  while (t < stop && localDate(t, tz) < want) t += HOUR;
  for (let i = 0; i < 60 && localDate(t - MIN, tz) >= want; i += 1) t -= MIN;
  return t;
}

/** "14:00", or "02:40 GMT+2" with the offset. 24 h, en-GB. */
export function fmtTime(ms: number, tz: string, withOffset: boolean): string {
  const f = cached(timeFmt, tz, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });
  const parts = f.formatToParts(new Date(ms));
  const hh = parts.find((x) => x.type === 'hour')?.value ?? '';
  const mm = parts.find((x) => x.type === 'minute')?.value ?? '';
  const hm = `${hh}:${mm}`;
  const off = parts.find((x) => x.type === 'timeZoneName')?.value ?? '';
  return withOffset && off ? `${hm} ${off}` : hm;
}

/** True when the same wall time occurs at a second instant (repeated hour). */
function wallTimeRepeats(ms: number, tz: string): boolean {
  const o = offsetMinutes(ms, tz);
  for (const probe of [-6 * HOUR, 6 * HOUR]) {
    const o2 = offsetMinutes(ms + probe, tz);
    if (o2 === o) continue;
    const other = ms + (o - o2) * MIN;
    if (
      offsetMinutes(other, tz) === o2 &&
      localDate(other, tz) === localDate(ms, tz)
    )
      return true;
  }
  return false;
}

/** Whether a range must print UTC offsets to be unambiguous. */
export function rangeNeedsOffsets(
  startMs: number,
  endMs: number,
  tz: string,
): boolean {
  return (
    offsetMinutes(startMs, tz) !== offsetMinutes(endMs, tz) ||
    wallTimeRepeats(startMs, tz) ||
    wallTimeRepeats(endMs, tz)
  );
}
