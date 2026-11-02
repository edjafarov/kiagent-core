/** Which core tables leave the master in phase 3 (spec section 7.6). Explicit
 *  on purpose: a new core table stays on its device until someone decides
 *  otherwise, and tracking.test.ts fails until it is classified here. */
export const COPIED_CORE_TABLES: readonly string[] = ['accounts', 'documents'];

export const LOCAL_CORE_TABLES: readonly string[] = [
  'attention_items',
  'attention_revisions',
  'changes',
  'consents',
  'consumers',
  'event_drafts',
  'meta',
  'outbox',
  'schedule',
  'sync_epochs', // copied from Task 3 on, with its trigger
  'sync_moved',
  'sync_offers',
  'sync_rows',
  'sync_state',
  'vault',
  'work_attempts',
  'work_ledger',
];

/** Search tables: in a snapshot, maintained by apply, never sent as rows. */
export function isDerivedTable(name: string): boolean {
  return /^documents_(fts|tri)(_|$)/.test(name);
}
