import type { AppDb } from '../app-db';

/** Core-owned tables are cleared through this repository so maintenance code
 * does not assemble raw owned-table SQL in the store orchestration layer. */
export async function resetCoreStoreTables(
  db: AppDb,
  accounts: readonly { id: string }[],
  now: () => string,
): Promise<void> {
  await db.batch([
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
    ].map((table) => ({ sql: `DELETE FROM ${table}` })),
    { sql: `DELETE FROM meta WHERE key != 'schemaVersion'` },
    ...accounts.map((account) => ({
      sql: `INSERT INTO changes(kind, ref_id, at) VALUES('accountRemoved', ?, ?)`,
      params: [account.id, now()],
    })),
  ]);
}
