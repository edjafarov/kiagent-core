import type { CalendarEventMetadata } from '@shared/contracts';

import type { EventDraftRow, EventPayload } from '../core/store/event-drafts';

export type Tier = 'busy' | 'maybe' | 'ignore';

export interface Busyish {
  title: string;
  start: string;
  end: string;
  calendar: string;
  tier: Exclude<Tier, 'ignore'>;
}

/** A created placeholder not seen in sync within this long drops to maybe. */
export const UNSEEN_PLACEHOLDER_MS = 24 * 60 * 60_000;

/** Spec §7 ordered rules: the first that matches wins. */
export function classifyEvent(m: CalendarEventMetadata): Tier {
  if (
    m.status === 'cancelled' ||
    m.selfResponse === 'declined' ||
    m.transparency === 'transparent' ||
    m.eventType === 'workingLocation'
  )
    return 'ignore';
  if (m.eventType === 'outOfOffice') return 'busy';
  if (
    m.status === 'tentative' ||
    m.selfResponse === 'tentative' ||
    m.selfResponse === 'needsAction' ||
    m.allDay ||
    m.eventType === 'focusTime'
  )
    return 'maybe';
  return 'busy';
}

/** `seen` = the provider copy of a `created` draft is indexed (placeholderState). */
export function classifyDraft(
  row: EventDraftRow,
  seen: boolean,
  now: Date,
): Tier {
  const span = draftSpan(row.payload);
  if (Date.parse(span.end) <= now.getTime()) return 'ignore';
  switch (row.status) {
    case 'draft':
    case 'creating':
    case 'unknown':
      return 'maybe';
    case 'created': {
      if (seen) return 'ignore';
      const since = Date.parse(row.confirmedAt ?? row.updatedAt);
      return now.getTime() - since < UNSEEN_PLACEHOLDER_MS ? 'busy' : 'maybe';
    }
    default:
      return 'ignore';
  }
}

/** A draft's span as UTC instants; all-day dates are local midnights in the
 *  draft's zone, end exclusive. */
export function draftSpan(
  p: Pick<EventPayload, 'start' | 'end' | 'allDay' | 'timeZone'>,
): {
  start: string;
  end: string;
} {
  if (!p.allDay)
    return {
      start: new Date(p.start).toISOString(),
      end: new Date(p.end).toISOString(),
    };
  const day = (d: string) => {
    const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
    return new Date(zonedToUtc(y, m, dd, 0, 0, p.timeZone)).toISOString();
  };
  return { start: day(p.start), end: day(p.end) };
}

export interface SlotQuery {
  from: string;
  to: string;
  durationMinutes: number;
  /** Local wall clock, "HH:MM". */
  between: { start: string; end: string };
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  days: number[];
  timeZone: string;
  limit: number;
}

export interface Slot {
  start: string;
  end: string;
  tier: 'free' | 'maybe';
  conflicts: Busyish[];
}

const STEP_MIN = 30;

/** 30-minute aligned candidates in q.timeZone, inside `between` on `days`,
 *  never before now. A slot touching a busy block is dropped; one touching
 *  only maybe blocks is offered as maybe with its conflicts. Free first,
 *  then earliest. */
export function findSlots(q: SlotQuery, blocks: Busyish[], now: Date): Slot[] {
  const durMs = q.durationMinutes * 60_000;
  const lo = Math.max(Date.parse(q.from), now.getTime());
  const hi = Date.parse(q.to);
  const [bh, bm] = hm(q.between.start);
  const [eh, em] = hm(q.between.end);
  const firstMin = Math.ceil((bh * 60 + bm) / STEP_MIN) * STEP_MIN;
  const lastEndMin = eh * 60 + em;
  const spans = blocks.map((b) => ({
    b,
    s: Date.parse(b.start),
    e: Date.parse(b.end),
  }));

  const out: Slot[] = [];
  let { y, m, d } = wallParts(Date.parse(q.from), q.timeZone);
  const last = wallParts(hi, q.timeZone);
  for (;;) {
    const dayKey = y * 10_000 + m * 100 + d;
    if (dayKey > last.y * 10_000 + last.m * 100 + last.d) break;
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
    if (q.days.includes(dow)) {
      for (
        let min = firstMin;
        min + q.durationMinutes <= lastEndMin;
        min += STEP_MIN
      ) {
        const s = zonedToUtc(
          y,
          m,
          d,
          Math.floor(min / 60),
          min % 60,
          q.timeZone,
        );
        const e = s + durMs;
        if (s < lo || e > hi) continue;
        const hits = spans.filter((x) => x.s < e && x.e > s);
        if (hits.some((x) => x.b.tier === 'busy')) continue;
        out.push({
          start: new Date(s).toISOString(),
          end: new Date(e).toISOString(),
          tier: hits.length ? 'maybe' : 'free',
          conflicts: hits.map((x) => x.b),
        });
      }
    }
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    y = next.getUTCFullYear();
    m = next.getUTCMonth() + 1;
    d = next.getUTCDate();
  }
  out.sort(
    (a, b) =>
      (a.tier === b.tier ? 0 : a.tier === 'free' ? -1 : 1) ||
      Date.parse(a.start) - Date.parse(b.start),
  );
  return out.slice(0, q.limit);
}

function hm(s: string): [number, number] {
  const [h, mm] = s.split(':').map(Number);
  return [h, mm || 0];
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function wallParts(t: number, tz: string) {
  const p: Record<string, number> = {};
  for (const x of fmt(tz).formatToParts(new Date(t)))
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  return {
    y: p.year,
    m: p.month,
    d: p.day,
    h: p.hour,
    mi: p.minute,
    s: p.second,
  };
}

function offsetAt(t: number, tz: string): number {
  const w = wallParts(t, tz);
  return (
    Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000
  );
}

/** UTC ms of a local wall-clock time in `tz` (DST-correct; a wall time in a
 *  spring-forward gap lands just after it). */
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetAt(guess, tz);
  const second = guess - offsetAt(first, tz);
  return second;
}
