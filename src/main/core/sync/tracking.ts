/** The master's change tracker (spec sections 7.2, 7.6 and 7.8). */
import { randomUUID } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3';

import { readRoleSync, SyncReadOnly } from './role';
import { copiedTables, primaryKeyColumns } from './tables';

const ON = `(SELECT tracking FROM sync_state) = 1`;

const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const trackKey = (tbl: string, row: 'OLD' | 'NEW', pk: string[]): string =>
  `INSERT OR REPLACE INTO sync_rows(tbl, pk) VALUES('${tbl.replaceAll("'", "''")}', json_array(${pk
    .map((c) => `${row}.${q(c)}`)
    .join(', ')}));`;

/** Documents feed from `documents.seq`, so inserts and normal updates cost
 *  nothing. They keep two narrow triggers: deletes, and updates that
 *  deliberately leave `seq` alone. */
const DOCUMENT_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS sync_d_documents AFTER DELETE ON documents
    WHEN ${ON} BEGIN ${trackKey('documents', 'OLD', ['id'])} END;
  CREATE TRIGGER IF NOT EXISTS sync_u_documents AFTER UPDATE ON documents
    WHEN ${ON} AND NEW.seq = OLD.seq BEGIN ${trackKey('documents', 'NEW', ['id'])} END;
`;

/** Insert, update and delete triggers for one copied table, built from its
 *  primary key (step 2). An update that moves the key tracks both keys, so
 *  the old one travels as a delete. */
export function syncTriggers(conn: BetterSqlite3.Database, tbl: string): string {
  if (tbl === 'documents') return DOCUMENT_TRIGGERS;
  const pk = primaryKeyColumns(conn, tbl);
  if (pk.length === 0) throw new Error(`sync: ${tbl} has no primary key`);
  const moved = pk.map((c) => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(' OR ');
  return `
  CREATE TRIGGER IF NOT EXISTS ${q(`sync_i_${tbl}`)} AFTER INSERT ON ${q(tbl)}
    WHEN ${ON} BEGIN ${trackKey(tbl, 'NEW', pk)} END;
  CREATE TRIGGER IF NOT EXISTS ${q(`sync_u_${tbl}`)} AFTER UPDATE ON ${q(tbl)}
    WHEN ${ON} BEGIN
      ${trackKey(tbl, 'NEW', pk)}
      INSERT OR REPLACE INTO sync_rows(tbl, pk)
        SELECT '${tbl.replaceAll("'", "''")}', json_array(${pk.map((c) => `OLD.${q(c)}`).join(', ')})
         WHERE ${moved};
    END;
  CREATE TRIGGER IF NOT EXISTS ${q(`sync_d_${tbl}`)} AFTER DELETE ON ${q(tbl)}
    WHEN ${ON} BEGIN ${trackKey(tbl, 'OLD', pk)} END;
`;
}

/** Creates the triggers for every copied table that doesn't have them yet. */
export function createSyncTriggers(conn: BetterSqlite3.Database): void {
  for (const tbl of copiedTables(conn)) conn.exec(syncTriggers(conn, tbl));
}

/** After a plugin's schema changed: while this device tracks, a new synced
 *  table gets its triggers. Does nothing before tracking or without a core
 *  schema (the registry is also used on bare files). */
export function ensureSyncTriggers(conn: BetterSqlite3.Database): void {
  const state = conn
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'`)
    .get();
  if (!state) return;
  const on = conn.prepare(`SELECT tracking FROM sync_state`).get() as { tracking: number } | undefined;
  if (on?.tracking !== 1) return;
  conn.transaction(() => createSyncTriggers(conn))();
}

export function enableTracking(conn: BetterSqlite3.Database): void {
  if (readRoleSync(conn) === 'follower') {
    throw new SyncReadOnly('enableTracking');
  }
  conn.transaction(() => {
    createSyncTriggers(conn);
    conn
      .prepare(
        `UPDATE sync_state SET tracking = 1, joined = 1,
                              history_id = COALESCE(history_id, ?)`,
      )
      .run(randomUUID());
  })();
}

export function disableTracking(conn: BetterSqlite3.Database): void {
  conn.prepare(`UPDATE sync_state SET tracking = 0`).run();
}
