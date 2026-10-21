import type { EventDraftRow } from '../core/store/event-drafts';
import type { CoreStore } from '../core/store/store';

/**
 * Has the provider copy of a `created` draft been indexed (spec §5.4, §7)?
 * The ONE answer both dedupe and availability use. Account-scoped, by
 * eventId / iCalUID, archived rows included — once seen, retired for good.
 */
export async function placeholderState(
  store: Pick<CoreStore, 'calendarIndex'>,
  row: EventDraftRow,
): Promise<'seen' | 'unseen'> {
  if (!row.created) return 'unseen';
  return (await store.calendarIndex.seen(
    row.accountId,
    row.created.eventId,
    row.created.iCalUID,
  ))
    ? 'seen'
    : 'unseen';
}
