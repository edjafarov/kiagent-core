/**
 * `list_calendars` — the calendars Kia can add events to (calendar spec
 * §5.5). Read-only.
 */
import type {
  CalendarListItem,
  CalendarToolApi,
} from '@main/calendar-out/service';

export const listCalendarsDescription = `List the user's calendars across their connected calendar accounts (Google Calendar, Outlook): calendar_id, name, account, whether Kia syncs it (indexed), whether Kia can add events to it (can_write), and which one is the default. Call it before draft_event when you are unsure which calendar fits — a shared family calendar, a work calendar — and pass that calendar_id. A note explains why a calendar can't be written (for example: reconnect the account).`;

export const listCalendarsInputSchema = {
  type: 'object',
  properties: {},
} as const;

export const calendarItemOut = (c: CalendarListItem) => ({
  account_id: c.accountId,
  account_email: c.accountEmail,
  source: c.source,
  calendar_id: c.calendarId,
  name: c.name,
  primary: c.primary,
  shared: c.shared,
  time_zone: c.timeZone,
  indexed: c.indexed,
  can_write: c.canWrite,
  is_default: c.isDefault,
  ...(c.note && { note: c.note }),
});

export function makeListCalendarsTool(calendar: CalendarToolApi) {
  return async function listCalendars(): Promise<unknown> {
    return (await calendar.listCalendars({})).map(calendarItemOut);
  };
}
