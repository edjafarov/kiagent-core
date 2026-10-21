/**
 * `find_free_time` (spec §7): indexed events on indexed calendars plus this
 * user's own event drafts, classified busy / maybe / ignore, then 30-minute
 * slots. Coverage is per account (an accepted limit, §7).
 */
import type { Prefs } from '@shared/contracts';

import type { CoreStore } from '../core/store/store';
import {
  classifyDraft,
  classifyEvent,
  draftSpan,
  findSlots,
  type Busyish,
} from './availability';
import { calendarPrefs, type CalendarsView } from './calendars';
import { NO_WRITER_NOTE, TOO_FAR_COPY } from './copy';
import { systemTimeZone } from './drafting';
import { placeholderState } from './placeholder';
import type { FindFreeTimeArgs, FreeTimeResult } from './types';

export const HORIZON_MS = 300 * 24 * 60 * 60_000;
const STALE_SYNC_MS = 2 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export function createFreeTime(deps: {
  store: CoreStore;
  calendars: CalendarsView;
  prefs: Prefs;
  now: () => Date;
}) {
  return async function findFreeTime(
    a: FindFreeTimeArgs,
  ): Promise<FreeTimeResult> {
    const now = deps.now();
    const fromMs = Date.parse(a.from);
    const toMs = Date.parse(a.to);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs <= fromMs)
      throw new Error('from and to must be date-times, with to after from');
    if (toMs > now.getTime() + HORIZON_MS) throw new Error(TOO_FAR_COPY);
    if (!(a.durationMinutes > 0))
      throw new Error('duration_minutes must be positive');

    const prefs = calendarPrefs(deps.prefs);
    const timeZone = a.timeZone ?? prefs.timeZone ?? systemTimeZone();
    const wh = prefs.workingHours;
    const between = a.between
      ? parseBetween(a.between)
      : wh
        ? { start: wh.start, end: wh.end }
        : { start: '09:00', end: '18:00' };
    const days = a.days ?? wh?.days ?? [1, 2, 3, 4, 5];
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();

    // Coverage — which calendars Kia actually sees.
    const listed = await deps.calendars.list();
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
        warnings.push(
          `${c.accountEmail}: ${c.note ?? 'calendars unavailable'}`,
        );
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

    // Busy-ish blocks.
    const blocks: Busyish[] = [];
    for (const e of await deps.store.calendarIndex.overlap(from, to)) {
      const key = `${e.accountId}|${e.metadata.calendarId}`;
      if (
        !indexedKey.has(key) &&
        !(wholeAccount.has(e.accountId) && wanted(e.metadata.calendarId))
      )
        continue;
      const tier = classifyEvent(e.metadata);
      if (tier === 'ignore') continue;
      blocks.push({
        title: e.title ?? '',
        start: e.metadata.start,
        end: e.metadata.end,
        calendar: e.metadata.calendarName,
        tier,
      });
    }
    // Drafts: a conservative SQL window (all-day dates are zone-local),
    // then the exact span from the one helper.
    const drafts = await deps.store.eventDrafts.inWindow(
      new Date(fromMs - DAY_MS).toISOString(),
      new Date(toMs + DAY_MS).toISOString(),
    );
    for (const r of drafts) {
      if (!wanted(r.payload.calendarId)) continue;
      const span = draftSpan(r.payload);
      if (!(Date.parse(span.start) < toMs && Date.parse(span.end) > fromMs))
        continue;
      const seen =
        r.status === 'created' &&
        (await placeholderState(deps.store, r)) === 'seen';
      const tier = classifyDraft(r, seen, now);
      if (tier === 'ignore') continue;
      blocks.push({
        title:
          r.status === 'created'
            ? `${r.payload.title} (added by Kia, not seen in sync yet)`
            : `${r.payload.title} (Kia draft, not added yet)`,
        start: span.start,
        end: span.end,
        calendar:
          indexed.find((c) => c.calendarId === r.payload.calendarId)?.name ??
          '',
        tier,
      });
    }
    blocks.sort((x, y) => Date.parse(x.start) - Date.parse(y.start));

    const slots = findSlots(
      {
        from,
        to,
        durationMinutes: a.durationMinutes,
        between,
        days,
        timeZone,
        limit: a.limit ?? 6,
      },
      blocks,
      now,
    );
    return {
      timeZone,
      coverage: {
        calendars: indexed.map((c) => ({
          accountEmail: c.accountEmail,
          calendar: c.name,
          indexed: true as const,
          lastSyncAt: lastSync.get(c.accountId) ?? null,
        })),
        notIndexedWritable,
        warnings,
      },
      complete: warnings.length === 0,
      slots,
      busy: blocks,
    };
  };
}

function parseBetween(s: string): { start: string; end: string } {
  const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`between must look like "09:00-18:00", got '${s}'`);
  return { start: m[1], end: m[2] };
}

function hoursAgo(now: Date, iso: string): string {
  const h = Math.round((now.getTime() - Date.parse(iso)) / 3_600_000);
  return h >= 48 ? `${Math.round(h / 24)} days` : `${h} h`;
}
