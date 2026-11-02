import type BetterSqlite3 from 'better-sqlite3';

import type { SyncRole } from './role';
import type { SyncStatus } from './service';

export function readSyncStatus(conn: BetterSqlite3.Database): SyncStatus {
  const s = conn.prepare(`SELECT * FROM sync_state`).get() as {
    role: SyncRole;
    tracking: number;
    history_id: string | null;
    master_device_id: string | null;
    after_seq: number;
    after_cursor: number;
  };
  const head = conn
    .prepare(
      `SELECT (SELECT max(seq) FROM documents) AS seq,
              (SELECT max(cursor) FROM sync_rows) AS cursor`,
    )
    .get() as { seq: number | null; cursor: number | null };
  return {
    role: s.role,
    tracking: s.tracking === 1,
    historyId: s.history_id,
    masterDeviceId: s.master_device_id,
    after: { seq: s.after_seq, cursor: s.after_cursor },
    head: { seq: head.seq ?? 0, cursor: head.cursor ?? 0 },
    schemaVersion: Number(
      (conn.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get() as { value: string }).value,
    ),
  };
}
