/**
 * IPC delegate for the Outbox's Calendar group (calendar spec §5.6), modelled
 * on `outboundInvokeHandlers`. The renderer names a draft id and the revision
 * it saw; every confirm runs the same gate and create as the review page
 * (`CalendarOutService.confirmById`), so a changed draft comes back
 * `changed` and nothing is added.
 */
import type { InvokeHandlers } from '@shared/ipc';

import type { CoreStore } from '../core/store/store';
import type { CalendarOutService } from './service';

export function calendarOutInvokeHandlers(deps: {
  service: CalendarOutService;
  store: CoreStore;
}): Pick<
  InvokeHandlers,
  | 'calendar-out:list'
  | 'calendar-out:confirm'
  | 'calendar-out:confirm-all'
  | 'calendar-out:retry'
  | 'calendar-out:discard'
  | 'calendar-out:restore'
  | 'calendar-out:list-calendars'
> {
  const { service, store } = deps;
  return {
    'calendar-out:list': () => service.listPending(),
    'calendar-out:confirm': ({ id, revision }) =>
      service.confirmById(id, revision),
    'calendar-out:confirm-all': async ({ items }) => {
      // Re-checked here, not trusted from the renderer: an event that
      // invites people is only ever added one by one.
      for (const { id } of items) {
        const row = await store.eventDrafts.get(id);
        if (row && row.payload.attendees.length > 0)
          throw new Error(
            'Events that invite people are added one at a time — nothing was added.',
          );
      }
      const out = { created: 0, failed: 0, changed: 0 };
      for (const { id, revision } of items) {
        const r = await service.confirmById(id, revision);
        if (r.kind === 'created') out.created += 1;
        else if (r.kind === 'failed' || r.kind === 'unknown') out.failed += 1;
        else out.changed += 1;
      }
      return out;
    },
    'calendar-out:retry': ({ id }) => service.retryById(id),
    'calendar-out:discard': async ({ id }) => {
      await service.discardById(id);
    },
    'calendar-out:restore': async ({ id }) => {
      await service.restoreById(id);
    },
    'calendar-out:list-calendars': () => service.listCalendars({}),
  };
}
