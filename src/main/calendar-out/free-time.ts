/**
 * `find_free_time` (spec §7): indexed events on indexed calendars plus this
 * user's own event drafts, classified busy / maybe / ignore, then 30-minute
 * slots. Coverage is per account (an accepted limit, §7).
 */
import type { Prefs } from '@shared/contracts';

import type { CoreStore } from '../core/store/store';
import { findSlots, type Busyish } from './availability';
import { calendarPrefs, type CalendarsView } from './calendars';
import { collectWindow } from './collect';
import { TOO_FAR_COPY } from './copy';
import { systemTimeZone } from './drafting';
import type { FindFreeTimeArgs, FreeTimeResult } from './types';

export const HORIZON_MS = 300 * 24 * 60 * 60_000;

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

    const col = await collectWindow(
      { store: deps.store },
      {
        from,
        to,
        calendarIds: a.calendarIds,
        now,
        listed: await deps.calendars.list(),
      },
    );
    if ('overflow' in col) throw new Error('unreachable: no limits passed');
    const { indexed, notIndexedWritable, warnings, lastSync } = col;

    // Busy-ish blocks.
    const blocks: Busyish[] = [];
    for (const { e, tier } of col.events) {
      if (tier === 'ignore') continue;
      blocks.push({
        title: e.title ?? '',
        start: e.metadata.start,
        end: e.metadata.end,
        calendar: e.metadata.calendarName,
        tier,
      });
    }
    for (const { row: r, tier, span } of col.drafts) {
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
