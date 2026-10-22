/**
 * The selection / coverage half of `find_free_time`, shared with the event
 * review page's day view so the two can never disagree about which calendars
 * count and which events block time.
 */
import type { IndexedEvent } from '../core/store/calendar-index';
import type { EventDraftRow } from '../core/store/event-drafts';
import type { CoreStore } from '../core/store/store';
import {
  classifyDraft,
  classifyEvent,
  draftSpan,
  type Tier,
} from './availability';
import { NO_WRITER_NOTE } from './copy';
import { placeholderState } from './placeholder';
import type { CalendarListItem } from './types';

export const STALE_SYNC_MS = 2 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface Collected {
  /** Counted calendars (find_free_time `coverage.calendars`). */
  indexed: CalendarListItem[];
  notIndexedWritable: { accountEmail: string; calendar: string }[];
  warnings: string[];
  lastSync: Map<string, string | null>;
  /** Cancelled events are dropped; `ignore` tier is kept for the caller. */
  events: { e: IndexedEvent; tier: Tier; disclosable: boolean }[];
  drafts: {
    row: EventDraftRow;
    tier: Tier;
    span: { start: string; end: string };
    seen: boolean;
    disclosable: boolean;
  }[];
}

export async function collectWindow(
  deps: { store: CoreStore },
  a: {
    from: string;
    to: string;
    calendarIds?: string[];
    now: Date;
    listed: CalendarListItem[];
    limits?: { events: number; drafts: number };
  },
): Promise<Collected | { overflow: true }> {
  const { now, listed } = a;
  const fromMs = Date.parse(a.from);
  const toMs = Date.parse(a.to);
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  // Coverage — which calendars Kia actually sees.
  const cals = listed.filter((c) => c.calendarId !== '');
  // Accounts whose calendars could not be listed (or that have no writer):
  // their indexed events still count, whatever calendar they are on.
  const unlisted = listed.filter((c) => c.calendarId === '');
  const wholeAccount = new Set(unlisted.map((c) => c.accountId));
  const wanted = (id: string) => !a.calendarIds || a.calendarIds.includes(id);
  const indexed = cals.filter((c) => c.indexed && wanted(c.calendarId));
  const indexedKey = new Set(
    indexed.map((c) => `${c.accountId}|${c.calendarId}`),
  );
  const warnings: string[] = [];
  for (const c of unlisted)
    if (c.note !== NO_WRITER_NOTE)
      warnings.push(`${c.accountEmail}: ${c.note ?? 'calendars unavailable'}`);
  const notIndexedWritable = cals
    .filter((c) => !c.indexed && c.canWrite && wanted(c.calendarId))
    .map((c) => ({ accountEmail: c.accountEmail, calendar: c.name }));
  for (const c of notIndexedWritable)
    warnings.push(
      `${c.calendar} (${c.accountEmail}) is not synced by Kia — its events are unknown`,
    );
  // Every account whose events count, writer or not, gets a freshness check.
  const accountIds = [
    ...new Set([...indexed.map((c) => c.accountId), ...wholeAccount]),
  ];
  const lastSync = new Map<string, string | null>();
  for (const id of accountIds) {
    const acc = await deps.store.account(id);
    const at = acc?.lastSyncAt ?? null;
    lastSync.set(id, at);
    const email = acc?.identifier ?? id;
    if (!at) warnings.push(`${email} has never synced`);
    else if (now.getTime() - Date.parse(at) > STALE_SYNC_MS)
      warnings.push(`${email} last synced ${hoursAgo(now, at)} ago`);
  }

  const events: Collected['events'] = [];
  const rows = await deps.store.calendarIndex.overlap(
    from,
    to,
    undefined,
    a.limits ? a.limits.events + 1 : undefined,
  );
  if (a.limits && rows.length > a.limits.events) return { overflow: true };
  for (const e of rows) {
    const key = `${e.accountId}|${e.metadata.calendarId}`;
    const listedKey = indexedKey.has(key);
    if (
      !listedKey &&
      !(wholeAccount.has(e.accountId) && wanted(e.metadata.calendarId))
    )
      continue;
    if (e.metadata.status === 'cancelled') continue;
    events.push({ e, tier: classifyEvent(e.metadata), disclosable: listedKey });
  }

  // Drafts: a conservative SQL window (all-day dates are zone-local),
  // then the exact span from the one helper.
  const draftRows = await deps.store.eventDrafts.inWindow(
    new Date(fromMs - DAY_MS).toISOString(),
    new Date(toMs + DAY_MS).toISOString(),
    a.limits ? a.limits.drafts + 1 : undefined,
  );
  if (a.limits && draftRows.length > a.limits.drafts) return { overflow: true };
  const drafts: Collected['drafts'] = [];
  for (const r of draftRows) {
    if (!wanted(r.payload.calendarId)) continue;
    const span = draftSpan(r.payload);
    if (!(Date.parse(span.start) < toMs && Date.parse(span.end) > fromMs))
      continue;
    const seen =
      r.status === 'created' &&
      (await placeholderState(deps.store, r)) === 'seen';
    drafts.push({
      row: r,
      tier: classifyDraft(r, seen, now),
      span,
      seen,
      disclosable: indexedKey.has(`${r.accountId}|${r.payload.calendarId}`),
    });
  }

  return { indexed, notIndexedWritable, warnings, lastSync, events, drafts };
}

function hoursAgo(now: Date, iso: string): string {
  const h = Math.round((now.getTime() - Date.parse(iso)) / 3_600_000);
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`;
}
