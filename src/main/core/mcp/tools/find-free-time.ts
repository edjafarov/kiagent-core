/**
 * `find_free_time` — busy / maybe / free time across the user's synced
 * calendars plus Kia's own event drafts (calendar spec §7). Read-only.
 */
import type { CalendarToolApi } from '@main/calendar-out/service';

export const findFreeTimeDescription = `Find free time slots in the user's calendars for a meeting or appointment. Looks at every calendar Kia syncs plus events Kia drafted but the user hasn't added yet. Slots are 30-minute aligned, free ones first, then "maybe" ones with the conflicts that make them uncertain (tentative or unanswered invites, all-day entries, pending drafts).
Defaults: working hours from the user's settings, else 09:00–18:00 Mon–Fri, in the user's time zone. Family plans often need evenings or weekends — pass between (e.g. "17:00-21:00") and days (1=Mon … 7=Sun) for those.
If complete is false, Kia cannot see every calendar (see coverage.warnings): call free slots "free as far as Kia can see" and say so to the user — never present them as certainly free. Kia never knows other people's availability. Also search recent correspondence for plans that are not in any calendar yet ("I'll pick Anna up at 4") and treat them as maybe-busy.
For booking: propose 2–3 options to the other person in a draft reply (draft_reply / draft_message), in their language; tell the user — not the correspondent — about maybe conflicts and coverage warnings. Up to about 300 days ahead.`;

export const findFreeTimeInputSchema = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'Window start, ISO date-time' },
    to: { type: 'string', description: 'Window end, ISO date-time' },
    duration_minutes: { type: 'number', description: 'Length of the slot' },
    between: {
      type: 'string',
      description: 'Local hours, "HH:MM-HH:MM" (default: working hours)',
    },
    days: {
      type: 'array',
      items: { type: 'number' },
      description: 'ISO weekdays, 1=Mon … 7=Sun (default: working days)',
    },
    time_zone: {
      type: 'string',
      description: 'IANA zone (default: the user’s)',
    },
    calendar_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Only these calendars (default: all synced)',
    },
    limit: { type: 'number', description: 'Max slots (default 6)' },
  },
  required: ['from', 'to', 'duration_minutes'],
} as const;

const busyOut = (b: {
  title: string;
  start: string;
  end: string;
  tier: string;
  calendar: string;
}) => ({
  title: b.title,
  start: b.start,
  end: b.end,
  tier: b.tier,
  calendar: b.calendar,
});

export function makeFindFreeTimeTool(calendar: CalendarToolApi) {
  return async function findFreeTime(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as {
      from?: string;
      to?: string;
      duration_minutes?: number;
      between?: string;
      days?: number[];
      time_zone?: string;
      calendar_ids?: string[];
      limit?: number;
    };
    if (!a.from || !a.to)
      throw new Error('find_free_time: from and to are required');
    if (typeof a.duration_minutes !== 'number')
      throw new Error('find_free_time: duration_minutes is required');
    const r = await calendar.findFreeTime({
      from: a.from,
      to: a.to,
      durationMinutes: a.duration_minutes,
      between: a.between,
      days: a.days,
      timeZone: a.time_zone,
      calendarIds: a.calendar_ids,
      limit: a.limit,
    });
    return {
      time_zone: r.timeZone,
      coverage: {
        calendars: r.coverage.calendars.map((c) => ({
          account_email: c.accountEmail,
          calendar: c.calendar,
          indexed: c.indexed,
          last_sync_at: c.lastSyncAt,
        })),
        not_indexed_writable: r.coverage.notIndexedWritable.map((c) => ({
          account_email: c.accountEmail,
          calendar: c.calendar,
        })),
        warnings: r.coverage.warnings,
      },
      complete: r.complete,
      slots: r.slots.map((s) => ({
        start: s.start,
        end: s.end,
        tier: s.tier,
        conflicts: s.conflicts.map(busyOut),
      })),
      busy: r.busy.map(busyOut),
    };
  };
}
