/**
 * The pure model behind the event review page's day view (spec
 * 2026-10-22-event-review-day-view-design.md). `buildDayModel` turns one
 * draft plus one `collectWindow` result into positions (elapsed minutes from
 * the day's first instant), lanes, outlines, the clash/free line and the
 * coverage notes. No I/O, no HTML.
 *
 * Fields beyond the plan's DayModel: `dayLabel` (head text), `Chip` (the
 * all-day strip entries) and `Block.draft`/`Chip.proposed` flags.
 */
import type { EventCategory } from '@shared/contracts';

import type { EventDraftRow } from '../core/store/event-drafts';
import { draftSpan, zonedToUtc, type Tier } from './availability';
import type { Collected } from './collect';
import {
  addDays,
  fmtTime,
  localDate,
  localDayStart,
  offsetMinutes,
  rangeNeedsOffsets,
} from './local-time';

const MIN = 60_000;
const HOUR = 60 * MIN;
export const DAY_MS = 24 * HOUR;
/** Index selects by instants; an all-day event's instants are in ITS
 *  calendar's zone, so the window is widened by the largest zone gap. */
export const WINDOW_PAD_MS = 26 * HOUR;
export const MAX_BLOCKS = 200;
export const FALLBACK_COLOR = '#4285f4';
export const BUSY_GREY = '#94a3b8';
const SCROLL_LEAD_PX = 90;
const HEX = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const safeColor = (
  c: string | null | undefined,
  fallback = FALLBACK_COLOR,
): string => (typeof c === 'string' && HEX.test(c) ? c : fallback);

export interface Chip {
  title: string;
  color: string;
  category: EventCategory | null;
  declined: boolean;
  draft: boolean;
  /** The all-day proposal itself. */
  proposed: boolean;
}

export interface Block {
  y: number;
  h: number;
  lane: number;
  lanes: number;
  title: string;
  time: string;
  color: string;
  category: EventCategory | null;
  declined: boolean;
  draft: boolean;
  outline: 'busy' | 'maybe' | null;
}

export interface DayModel {
  /** Local date of the proposal's start, YYYY-MM-DD. */
  date: string;
  /** "Friday 23 October". */
  dayLabel: string;
  timeZone: string;
  dayStartMs: number;
  dayLenMin: number;
  hours: { y: number; label: string }[];
  allDay: Chip[];
  /** At most MAX_BLOCKS, plus any clashing ones beyond that. */
  blocks: Block[];
  more: number;
  proposed: {
    /** The proposal's own title (drawn on its block). */
    title: string;
    y: number;
    h: number;
    lane: number;
    lanes: number;
    allDay: boolean;
    continues: boolean;
    time: string;
  };
  scrollPx: number;
  line: {
    kind: 'busy' | 'maybe' | 'free' | 'free-partial' | 'count' | 'spans';
    text: string;
  };
  alsoOn: string[];
  notes: string[];
  busyClash: boolean;
}

export interface Lane<T> {
  item: T;
  lane: number;
  lanes: number;
}

/** Port of alpha-cent Calendar/data.ts `layoutLanes`, over plain instants:
 *  each takes the first lane free at its start; a cluster of overlapping
 *  items shares the column width evenly. */
export function layoutLanes<T extends { start: number; end: number }>(
  items: T[],
): Lane<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start);
  const out: Lane<T>[] = [];
  let cluster: Lane<T>[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const close = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    const { start } = item;
    const end = Math.max(item.end, start + 1);
    if (start >= clusterEnd) close();
    let lane = laneEnds.findIndex((e) => e <= start);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = end;
    clusterEnd = cluster.length === 0 ? end : Math.max(clusterEnd, end);
    const p = { item, lane, lanes: 1 };
    cluster.push(p);
    out.push(p);
  }
  close();
  return out;
}

export interface DayGeometry {
  date: string;
  dayStartMs: number;
  dayEndMs: number;
  pStartMs: number;
  pEndMs: number;
  /** A clash/free claim is made: timed ≤ 24 h, or a single-day all-day. */
  inClaimScope: boolean;
}

type Spanned = Pick<
  EventDraftRow['payload'],
  'start' | 'end' | 'allDay' | 'timeZone'
>;

export function dayGeometry(p: Spanned): DayGeometry {
  const span = draftSpan(p);
  const pStartMs = Date.parse(span.start);
  const pEndMs = Date.parse(span.end);
  const date = p.allDay
    ? p.start.slice(0, 10)
    : localDate(pStartMs, p.timeZone);
  const dayStartMs = localDayStart(date, p.timeZone);
  const dayEndMs = localDayStart(addDays(date, 1), p.timeZone);
  const inClaimScope = p.allDay
    ? p.end.slice(0, 10) === addDays(date, 1)
    : pEndMs - pStartMs <= DAY_MS;
  return { date, dayStartMs, dayEndMs, pStartMs, pEndMs, inClaimScope };
}

/** The collection window (spec "Two sets from one collection"). */
export function dayWindow(p: Spanned): { from: string; to: string } {
  const g = dayGeometry(p);
  const lo = g.inClaimScope ? Math.min(g.dayStartMs, g.pStartMs) : g.dayStartMs;
  const hi = g.inClaimScope ? Math.max(g.dayEndMs, g.pEndMs) : g.dayEndMs;
  return {
    from: new Date(lo - WINDOW_PAD_MS).toISOString(),
    to: new Date(hi + WINDOW_PAD_MS).toISOString(),
  };
}

interface Cand {
  label: string;
  start: number;
  end: number;
  allDay: boolean;
  tier: Tier;
  /** Title may be shown in the line ("an event" otherwise). */
  disclosable: boolean;
  color: string;
  category: EventCategory | null;
  declined: boolean;
  draft: boolean;
  dates: { start: string; end: string } | null;
}

const rangeText = (s: number, e: number, tz: string): string => {
  const off = rangeNeedsOffsets(s, e, tz);
  return `${fmtTime(s, tz, off)}–${fmtTime(e, tz, off)}`;
};

const shortDay = (date: string): string =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });

function longDay(date: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? '';
  return `${g('weekday')} ${g('day')} ${g('month')}`;
}

const NOT_SYNCED = (calendar: string, account: string) =>
  `${calendar} (${account}) is not synced by Kia — its events are unknown`;

export function buildDayModel(
  draft: EventDraftRow,
  c: Collected,
  tz: string,
): DayModel {
  const p = draft.payload;
  const g = dayGeometry({ ...p, timeZone: tz });
  const { date, dayStartMs, dayEndMs, pStartMs, pEndMs } = g;
  const dayLenMin = Math.round((dayEndMs - dayStartMs) / MIN);
  const yOf = (t: number) =>
    Math.min(dayLenMin, Math.max(0, (t - dayStartMs) / MIN));

  // Hour lines at every instant of the day whose local minute is 0.
  const hours: DayModel['hours'] = [];
  let off = offsetMinutes(dayStartMs, tz);
  for (let t = dayStartMs; t < dayEndMs; t += MIN) {
    if (t % (15 * MIN) === 0) off = offsetMinutes(t, tz);
    if ((((t / MIN + off) % 60) + 60) % 60 === 0)
      hours.push({ y: (t - dayStartMs) / MIN, label: fmtTime(t, tz, false) });
  }

  // Candidates: everything collected, minus this draft and ignored drafts.
  const cands: Cand[] = [];
  for (const { e, tier, disclosable } of c.events) {
    const m = e.metadata;
    cands.push({
      label: disclosable ? e.title || '(No title)' : 'Busy',
      start: Date.parse(m.start),
      end: Date.parse(m.end),
      allDay: m.allDay,
      tier,
      disclosable,
      color: disclosable ? safeColor(m.calendarColor) : BUSY_GREY,
      category: disclosable ? (m.category ?? null) : null,
      declined: m.selfResponse === 'declined',
      draft: false,
      dates:
        m.allDay && m.startDate && m.endDate
          ? { start: m.startDate, end: m.endDate }
          : null,
    });
  }
  for (const d of c.drafts) {
    if (d.row.id === draft.id || d.tier === 'ignore') continue;
    const dp = d.row.payload;
    const suffix =
      d.row.status === 'created'
        ? ' (added by Kia, not seen in sync yet)'
        : ' (Kia draft, not added yet)';
    cands.push({
      label: d.disclosable ? `${dp.title}${suffix}` : 'Kia draft',
      start: Date.parse(d.span.start),
      end: Date.parse(d.span.end),
      allDay: dp.allDay,
      tier: d.tier,
      disclosable: d.disclosable,
      color: BUSY_GREY,
      category: d.disclosable ? dp.category : null,
      declined: false,
      draft: true,
      dates: dp.allDay
        ? { start: dp.start.slice(0, 10), end: dp.end.slice(0, 10) }
        : null,
    });
  }
  const lineTitle = (x: Cand) => (x.disclosable ? x.label : 'an event');
  const overlapsDay = (x: Cand) => x.start < dayEndMs && x.end > dayStartMs;
  const inStrip = (x: Cand) =>
    x.dates ? x.dates.start <= date && date < x.dates.end : overlapsDay(x);

  // Clash set: judged against the proposed span, independent of the drawn day.
  const clashes = g.inClaimScope
    ? cands.filter(
        (x) => x.tier !== 'ignore' && x.start < pEndMs && x.end > pStartMs,
      )
    : [];
  const timedProposal = !p.allDay;
  const busy = timedProposal ? clashes.filter((x) => x.tier === 'busy') : [];
  const maybe = timedProposal
    ? clashes.filter((x) => x.tier === 'maybe' && !x.allDay)
    : [];
  const outlineOf = (x: Cand): Block['outline'] =>
    busy.includes(x) ? 'busy' : maybe.includes(x) ? 'maybe' : null;

  const alsoOn: string[] = [];
  if (timedProposal)
    for (const x of clashes)
      if (x.tier === 'maybe' && x.allDay && !inStrip(x)) {
        const when = x.dates
          ? x.dates.start > date
            ? x.dates.start
            : addDays(x.dates.end, -1)
          : localDate(x.start, tz);
        alsoOn.push(`Also on ${shortDay(when)}: ${lineTitle(x)} (all day)`);
      }

  // Draw set.
  const chips: Chip[] = [];
  if (p.allDay)
    chips.push({
      title: p.title,
      color: safeColor(null),
      category: p.category,
      declined: false,
      draft: false,
      proposed: true,
    });
  const timed: { cand: Cand; start: number; end: number }[] = [];
  for (const x of cands) {
    if (x.allDay) {
      if (inStrip(x))
        chips.push({
          title: x.label,
          color: x.color,
          category: x.category,
          declined: x.declined,
          draft: x.draft,
          proposed: false,
        });
    } else if (overlapsDay(x)) {
      timed.push({
        cand: x,
        start: Math.max(x.start, dayStartMs),
        end: Math.min(x.end, dayEndMs),
      });
    }
  }

  // Cap: clashing blocks always survive, then the rest by start.
  const isClash = (t: { cand: Cand }) => outlineOf(t.cand) !== null;
  const must = timed.filter(isClash);
  const rest = timed
    .filter((t) => !isClash(t))
    .sort((a, b) => a.start - b.start);
  const kept = [
    ...must,
    ...rest.slice(0, Math.max(0, MAX_BLOCKS - must.length)),
  ];
  const more = timed.length - kept.length;

  const proposal = timedProposal
    ? { start: Math.max(pStartMs, dayStartMs), end: Math.min(pEndMs, dayEndMs) }
    : null;
  const laid = layoutLanes([
    ...kept.map((k) => ({ ...k, proposed: false })),
    ...(proposal ? [{ ...proposal, cand: null, proposed: true }] : []),
  ]);

  const blocks: Block[] = [];
  let proposedLane = { lane: 0, lanes: 1 };
  for (const l of laid) {
    if (l.item.proposed) {
      proposedLane = { lane: l.lane, lanes: l.lanes };
      continue;
    }
    const x = l.item.cand!;
    blocks.push({
      y: yOf(l.item.start),
      h: Math.max(6, (l.item.end - l.item.start) / MIN - 1),
      lane: l.lane,
      lanes: l.lanes,
      title: x.label,
      time: rangeText(x.start, x.end, tz),
      color: x.color,
      category: x.category,
      declined: x.declined,
      draft: x.draft,
      outline: outlineOf(x),
    });
  }

  const continues = !p.allDay && pEndMs > dayEndMs;
  const y08 = yOf(
    zonedToUtc(
      ...(date.split('-').map(Number) as [number, number, number]),
      8,
      0,
      tz,
    ),
  );
  const pY = proposal ? yOf(proposal.start) : y08;
  const proposed: DayModel['proposed'] = proposal
    ? {
        title: p.title,
        y: pY,
        h: Math.max(6, (proposal.end - proposal.start) / MIN - 1),
        ...proposedLane,
        allDay: false,
        continues,
        time: `${rangeText(pStartMs, pEndMs, tz)}${continues ? ' continues →' : ''}`,
      }
    : {
        title: p.title,
        y: y08,
        h: 0,
        lane: 0,
        lanes: 1,
        allDay: true,
        continues: false,
        time: 'All day',
      };

  // Coverage notes: "Not checked" first, then every other warning verbatim.
  const notChecked = c.notIndexedWritable.map(
    (n) => `Not checked: ${n.calendar} (${n.accountEmail})`,
  );
  const hidden = new Set(
    c.notIndexedWritable.map((n) => NOT_SYNCED(n.calendar, n.accountEmail)),
  );
  const notes = [...notChecked, ...c.warnings.filter((w) => !hidden.has(w))];

  const freeLine = (): DayModel['line'] =>
    notes.length
      ? { kind: 'free-partial', text: 'Free as far as Kia can see' }
      : { kind: 'free', text: 'Free — nothing else at this time' };
  const names = (xs: Cand[]) => xs.map(lineTitle).join(', ');
  let line: DayModel['line'];
  if (!g.inClaimScope)
    line = {
      kind: 'spans',
      text: "Spans several days — Kia didn't check them all",
    };
  else if (p.allDay) {
    const n = clashes.length;
    line = n
      ? {
          kind: 'count',
          text: `That day: ${n} ${n === 1 ? 'event' : 'events'}`,
        }
      : freeLine();
  } else if (busy.length) {
    const sorted = [...busy].sort((a, b) => a.start - b.start);
    const one = sorted[0];
    const head =
      sorted.length === 1
        ? `Overlaps ${lineTitle(one)}${one.allDay ? ' (all day)' : ` ${rangeText(one.start, one.end, tz)}`}`
        : `Overlaps ${sorted.length} events: ${names(sorted)}`;
    line = {
      kind: 'busy',
      text: maybe.length ? `${head} · may overlap ${maybe.length} more` : head,
    };
  } else if (maybe.length) {
    const sorted = [...maybe].sort((a, b) => a.start - b.start);
    line = {
      kind: 'maybe',
      text:
        sorted.length === 1
          ? `May overlap ${lineTitle(sorted[0])} — not confirmed`
          : `May overlap ${sorted.length} events: ${names(sorted)} — not confirmed`,
    };
  } else line = freeLine();

  return {
    date,
    dayLabel: longDay(date),
    timeZone: tz,
    dayStartMs,
    dayLenMin,
    hours,
    allDay: chips,
    blocks: blocks.sort((a, b) => a.y - b.y),
    more,
    proposed,
    scrollPx: Math.max(0, Math.round(pY - SCROLL_LEAD_PX)),
    line,
    alsoOn,
    notes,
    busyClash: busy.length > 0,
  };
}
