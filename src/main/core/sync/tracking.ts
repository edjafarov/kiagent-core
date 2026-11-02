/** The master's change tracker (spec sections 7.2 and 7.6). Documents feed from
 *  `documents.seq`, so inserts and normal updates cost nothing. They keep two
 *  narrow triggers: deletes, and updates that deliberately leave `seq` alone. */
import { randomUUID } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3';

import { readRoleSync, SyncReadOnly } from './role';

const ON = `(SELECT tracking FROM sync_state) = 1`;

const track = (tbl: string, row: 'OLD' | 'NEW') =>
  `INSERT OR REPLACE INTO sync_rows(tbl, pk) VALUES('${tbl}', json_array(${row}.id));`;

const TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS sync_d_documents AFTER DELETE ON documents
    WHEN ${ON} BEGIN ${track('documents', 'OLD')} END;
  CREATE TRIGGER IF NOT EXISTS sync_u_documents AFTER UPDATE ON documents
    WHEN ${ON} AND NEW.seq = OLD.seq BEGIN ${track('documents', 'NEW')} END;
  CREATE TRIGGER IF NOT EXISTS sync_i_accounts AFTER INSERT ON accounts
    WHEN ${ON} BEGIN ${track('accounts', 'NEW')} END;
  CREATE TRIGGER IF NOT EXISTS sync_u_accounts AFTER UPDATE ON accounts
    WHEN ${ON} BEGIN ${track('accounts', 'NEW')} END;
  CREATE TRIGGER IF NOT EXISTS sync_d_accounts AFTER DELETE ON accounts
    WHEN ${ON} BEGIN ${track('accounts', 'OLD')} END;
`;

export function enableTracking(conn: BetterSqlite3.Database): void {
  if (readRoleSync(conn) === 'follower') {
    throw new SyncReadOnly('enableTracking');
  }
  conn.transaction(() => {
    conn.exec(TRIGGERS);
    conn
      .prepare(
        `UPDATE sync_state SET tracking = 1, history_id = COALESCE(history_id, ?)`,
      )
      .run(randomUUID());
  })();
}

export function disableTracking(conn: BetterSqlite3.Database): void {
  conn.prepare(`UPDATE sync_state SET tracking = 0`).run();
}
