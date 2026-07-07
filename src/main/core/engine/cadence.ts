import type { Cadence } from '@shared/contracts';

/** '15m' | '1h' | '2d' → milliseconds. */
export function everyToMs(every: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(every.trim());
  if (!m) throw new Error(`bad cadence interval: ${every}`);
  const n = Number(m[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * unit;
}

/** Minimal 5-field cron (min hour dom mon dow); '*' or a number per field. */
function cronNext(expr: string, from: Date): Date {
  const [min, hour, dom, mon, dow] = expr.trim().split(/\s+/);
  const matches = (field: string, value: number): boolean =>
    field === '*' || Number(field) === value;
  const d = new Date(from.getTime() + 60_000);
  d.setSeconds(0, 0);
  // Bounded scan (400 days of minutes is overkill; a year covers any 5-field cron).
  for (let i = 0; i < 366 * 24 * 60; i += 1) {
    if (
      matches(min, d.getMinutes()) &&
      matches(hour, d.getHours()) &&
      matches(dom, d.getDate()) &&
      matches(mon, d.getMonth() + 1) &&
      matches(dow, d.getDay())
    ) {
      return d;
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`cron never fires: ${expr}`);
}

/** When should a job with this cadence run next, given its last run? */
export function nextRun(cadence: Cadence, lastRun: string | null, now: Date): Date | null {
  if (cadence === 'manual') return null;
  if ('every' in cadence) {
    const base = lastRun ? new Date(lastRun) : new Date(0);
    const next = new Date(base.getTime() + everyToMs(cadence.every));
    return next < now ? now : next;
  }
  return cronNext(cadence.cron, lastRun ? new Date(lastRun) : now);
}
