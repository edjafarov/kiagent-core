import { META_LEDGER_REKEYED } from '../../core/store/maintenance-keys';
import type { AppDb } from '../app-db';

/** Core-owned tables are cleared through this repository so maintenance code
 * does not assemble raw owned-table SQL in the store orchestration layer. */
export async function resetCoreStoreTables(
  db: AppDb,
  accounts: readonly { id: string }[],
  now: () => string,
): Promise<void> {
  await db.batch([
    // First, so the wipe below isn't tracked. A later enrolment starts a new
    // history, and any follower of this device takes a fresh snapshot.
    {
      sql: `UPDATE sync_state SET role = 'normal', tracking = 0, after_seq = 0,
              after_cursor = 0, history_id = NULL, master_device_id = NULL`,
    },
    ...[
      'documents_fts',
      'documents_tri',
      'documents',
      'changes',
      'consumers',
      'work_ledger',
      'vault',
      'schedule',
      'accounts',
      'attention_items',
      'attention_revisions',
      'sync_rows',
    ].map((table) => ({ sql: `DELETE FROM ${table}` })),
    { sql: `DELETE FROM meta WHERE key != 'schemaVersion'` },
    // The wiped ledger is empty, so it is trivially re-keyed (#59 §0) —
    // without this, re-drive would stay gated until the next app start.
    {
      sql: `INSERT INTO meta(key, value) VALUES(?, '1')`,
      params: [META_LEDGER_REKEYED],
    },
    ...accounts.map((account) => ({
      sql: `INSERT INTO changes(kind, ref_id, at) VALUES('accountRemoved', ?, ?)`,
      params: [account.id, now()],
    })),
  ]);
}
