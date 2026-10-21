/**
 * The host-side calendar writer registry (platform 2.16.0). An entry is the
 * HOST view of a connector's CalendarWriter: credentials are resolved here,
 * in main, per call — the caller names the account and never handles a
 * secret. `createEvent` is reachable only from the event-draft confirm path
 * (calendar-out/service.ts); `listCalendars` is a read the tool layer uses.
 */
import type {
  AccountId,
  CreatedEvent,
  EventIntent,
  WritableCalendar,
} from '@shared/contracts';

export interface HostCalendarWriter {
  listCalendars(accountId: AccountId): Promise<WritableCalendar[]>;
  createEvent(intent: EventIntent): Promise<CreatedEvent>;
}

export interface CalendarWriterRegistry {
  register(sourceId: string, w: HostCalendarWriter): void;
  unregister(sourceId: string): void;
  get(sourceId: string): HostCalendarWriter | undefined;
  sources(): string[];
}

export function createCalendarWriterRegistry(): CalendarWriterRegistry {
  const writers = new Map<string, HostCalendarWriter>();
  return {
    register: (id, w) => void writers.set(id, w),
    unregister: (id) => void writers.delete(id),
    get: (id) => writers.get(id),
    sources: () => [...writers.keys()],
  };
}
