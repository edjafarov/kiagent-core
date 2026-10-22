/**
 * Shapes of the calendar-out service (alpha-cent docs/superpowers/specs/
 * 2026-10-21-calendar-events-booking-design.md §5.5, §7). camelCase here;
 * the MCP tool layer maps snake_case onto these.
 */
import type { AccountId, CreatedEvent, EventCategory } from '@shared/contracts';

import type { EventDraftRow } from '../core/store/event-drafts';
import type { Busyish } from './availability';

export interface CalendarListItem {
  accountId: AccountId;
  accountEmail: string;
  source: string;
  calendarId: string;
  name: string;
  primary: boolean;
  shared: boolean;
  timeZone: string | null;
  /** Kia syncs it (Sources › account › Calendars). */
  indexed: boolean;
  /** Writer registered && the user may edit && the write scope was granted. */
  canWrite: boolean;
  isDefault: boolean;
  note?: string;
}

export interface DraftEventArgs {
  title: string;
  start: string;
  end?: string;
  allDay?: boolean;
  timeZone?: string;
  accountId?: string;
  calendarId?: string;
  category: EventCategory;
  location?: string;
  description?: string;
  attendees?: { email: string; name?: string }[];
  conference?: 'none' | 'auto';
  sourceDocumentId?: string;
  /** Revise in place: both or neither. */
  draftId?: string;
  revision?: number;
  force?: boolean;
}

export interface SimilarEvent {
  kind: 'event' | 'draft';
  title: string;
  start: string;
  calendar: string;
  draftId?: string;
  /** Internal (disclosure check on the review page); not in tool output. */
  accountId?: AccountId;
  calendarId?: string;
}

export type DraftEventResult =
  | {
      draftId: string;
      revision: number;
      mode: 'review' | 'link';
      confirmUrl?: string;
      calendar: { id: string; name: string; accountEmail: string };
      similarEvents: SimilarEvent[];
      existing?: true;
      instruction: string;
    }
  | {
      alreadyInCalendar: { title: string; start: string; calendar: string }[];
      instruction: string;
    }
  | { dismissed: true; draftId: string; instruction: string };

export interface FindFreeTimeArgs {
  from: string;
  to: string;
  durationMinutes: number;
  /** "HH:MM-HH:MM", local. */
  between?: string;
  days?: number[];
  timeZone?: string;
  calendarIds?: string[];
  limit?: number;
}

export interface FreeTimeResult {
  timeZone: string;
  coverage: {
    calendars: {
      accountEmail: string;
      calendar: string;
      indexed: true;
      lastSyncAt: string | null;
    }[];
    notIndexedWritable: { accountEmail: string; calendar: string }[];
    warnings: string[];
  };
  complete: boolean;
  slots: {
    start: string;
    end: string;
    tier: 'free' | 'maybe';
    conflicts: Busyish[];
  }[];
  busy: Busyish[];
}

/** A draft as the Outbox and the review page show it. */
export interface EventDraftView extends EventDraftRow {
  calendarName: string | null;
  accountEmail: string | null;
  source: { title: string | null; createdAt: string | null } | null;
  similarEvents: SimilarEvent[];
  /** The calendar listing the page was built from. */
  listing: CalendarListing;
  /** Wall-clock ms at which the review page gives up on slow lookups. */
  deadlineMs: number;
}

export type CalendarListing =
  | { ok: true; items: CalendarListItem[] }
  | { ok: false };

export type EventConfirmOutcome =
  | { kind: 'created'; event: CreatedEvent }
  | { kind: 'failed' | 'unknown'; error: string }
  | { kind: 'changed' | 'gone' | 'discarded' };

export type EventPeek =
  | { kind: 'ok'; view: EventDraftView }
  | { kind: 'changed' | 'gone' | 'expired' | 'invalid' };
