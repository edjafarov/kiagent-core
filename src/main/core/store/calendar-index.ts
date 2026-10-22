/**
 * Read-only lookups over indexed `calendar.event` documents for event
 * drafting and availability (alpha-cent docs/superpowers/specs/
 * 2026-10-21-calendar-events-booking-design.md §5.4, §7). Composed into
 * CoreStore as `store.calendarIndex`.
 *
 * `created_at` of a calendar.event is its start, so "real overlap" is
 * start < to AND end > from — long events that began before `from` are
 * still found. julianday() compares instants whatever their ISO spelling.
 */
import type { AccountId, CalendarEventMetadata } from '@shared/contracts';

import type { AppDb } from '../../db/app-db';

export interface IndexedEvent {
  documentId: string;
  accountId: AccountId;
  title: string | null;
  metadata: CalendarEventMetadata;
}

export interface CalendarIndex {
  /** Live events overlapping [from, to), optionally for one account. */
  overlap(
    from: string,
    to: string,
    accountId?: AccountId,
    limit?: number,
  ): Promise<IndexedEvent[]>;
  /** Live events of the account with this iCalUID. */
  byICalUID(accountId: AccountId, iCalUID: string): Promise<IndexedEvent[]>;
  /** Was the provider copy ever indexed? Includes ARCHIVED rows (§5.4). */
  seen(
    accountId: AccountId,
    eventId: string,
    iCalUID: string | null,
  ): Promise<boolean>;
  /** At least one live event of the account on this calendar. */
  hasEvents(accountId: AccountId, calendarId: string): Promise<boolean>;
}

type Raw = {
  id: string;
  account_id: string;
  title: string | null;
  metadata: string;
};

const toEvent = (r: Raw): IndexedEvent => ({
  documentId: r.id,
  accountId: r.account_id as AccountId,
  title: r.title,
  metadata: JSON.parse(r.metadata) as CalendarEventMetadata,
});

const LIVE_EVENTS = `type = 'calendar.event' AND archived_at IS NULL`;

export function createCalendarIndex(db: AppDb): CalendarIndex {
  return {
    async overlap(from, to, accountId, limit) {
      const rows = (await db.all(
        `SELECT id, account_id, title, metadata FROM documents
          WHERE ${LIVE_EVENTS}
            AND julianday(created_at) < julianday(?)
            AND julianday(json_extract(metadata, '$.end')) > julianday(?)
            ${accountId ? 'AND account_id = ?' : ''}
          ORDER BY created_at${limit === undefined ? '' : ' LIMIT ?'}`,
        [
          to,
          from,
          ...(accountId ? [accountId] : []),
          ...(limit === undefined ? [] : [limit]),
        ],
      )) as Raw[];
      return rows.map(toEvent);
    },
    async byICalUID(accountId, iCalUID) {
      const rows = (await db.all(
        `SELECT id, account_id, title, metadata FROM documents
          WHERE ${LIVE_EVENTS} AND account_id = ?
            AND json_extract(metadata, '$.iCalUID') = ?`,
        [accountId, iCalUID],
      )) as Raw[];
      return rows.map(toEvent);
    },
    async seen(accountId, eventId, iCalUID) {
      const rows = await db.all(
        `SELECT 1 FROM documents
          WHERE type = 'calendar.event' AND account_id = ?
            AND (json_extract(metadata, '$.eventId') = ?
                 OR (? IS NOT NULL AND json_extract(metadata, '$.iCalUID') = ?))
          LIMIT 1`,
        [accountId, eventId, iCalUID, iCalUID],
      );
      return rows.length > 0;
    },
    async hasEvents(accountId, calendarId) {
      const rows = await db.all(
        `SELECT 1 FROM documents
          WHERE ${LIVE_EVENTS} AND account_id = ?
            AND json_extract(metadata, '$.calendarId') = ?
          LIMIT 1`,
        [accountId, calendarId],
      );
      return rows.length > 0;
    },
  };
}
