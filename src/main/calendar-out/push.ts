import type { Pushes, PushChannel } from '@shared/ipc';

import type { EventDraftStore } from '../core/store/event-drafts';

/** Same window as `wireOutboxPush`. */
const COALESCE_MS = 50;

/**
 * `store.eventDrafts.onChange` → a coalesced `push:calendar-out-changed`:
 * one broadcast per burst, timed from the first change in it. Returns the
 * unsubscribe.
 */
export function wireCalendarOutPush(
  store: { eventDrafts: Pick<EventDraftStore, 'onChange'> },
  broadcast: <C extends PushChannel>(channel: C, payload: Pushes[C]) => void,
): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  return store.eventDrafts.onChange(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      broadcast('push:calendar-out-changed', undefined);
    }, COALESCE_MS);
  });
}
