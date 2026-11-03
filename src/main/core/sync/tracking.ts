/** The master's change tracker (spec sections 7.2, 7.6 and 7.8). */
import { randomUUID } from 'node:crypto';

import type BetterSqlite3 from 'better-sqlite3';

import { readRoleSync, SyncReadOnly } from './role';
import { copiedTables, primaryKeyColumns } from './tables';

const ON = `(SELECT tracking FROM sync_state) = 1`;

const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const lit = (tbl: string): string => `'${tbl.replaceAll("'", "''")}'`;

/** Delete then insert, never `INSERT OR REPLACE`: SQLite applies the OUTER
 *  statement's conflict policy to a trigger body, so a plugin upsert turned
 *  the REPLACE into ABORT and every write of an already-tracked row failed. */
const trackKey = (tbl: string, row: 'OLD' | 'NEW', pk: string[]): string => {
  const key = `json_array(${pk.map((c) => `${row}.${q(c)}`).join(', ')})`;
  return `DELETE FROM sync_rows WHERE tbl = ${lit(tbl)} AND pk = ${key};
      INSERT INTO sync_rows(tbl, pk) VALUES(${lit(tbl)}, ${key});`;
};

const NAMES = (tbl: string): string[] => ['i', 'u', 'd'].map((k) => q(`sync_${k}_${tbl}`));
/** Drops then creates: an install made by an older build gets the current body. */
const recreate = (tbl: string, body: string): string =>
  NAMES(tbl).map((n) => `DROP TRIGGER IF EXISTS ${n};`).join('\n') +
  body.replaceAll('CREATE TRIGGER IF NOT EXISTS', 'CREATE TRIGGER');

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
  if (tbl === 'documents') return recreate('documents', DOCUMENT_TRIGGERS);
  const pk = primaryKeyColumns(conn, tbl);
  if (pk.length === 0) throw new Error(`sync: ${tbl} has no primary key`);
  const moved = pk.map((c) => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(' OR ');
  return recreate(tbl, `
  CREATE TRIGGER IF NOT EXISTS ${q(`sync_i_${tbl}`)} AFTER INSERT ON ${q(tbl)}
    WHEN ${ON} BEGIN ${trackKey(tbl, 'NEW', pk)} END;
  CREATE TRIGGER IF NOT EXISTS ${q(`sync_u_${tbl}`)} AFTER UPDATE ON ${q(tbl)}
    WHEN ${ON} BEGIN
      ${trackKey(tbl, 'NEW', pk)}
      DELETE FROM sync_rows
       WHERE (${moved}) AND tbl = ${lit(tbl)}
         AND pk = json_array(${pk.map((c) => `OLD.${q(c)}`).join(', ')});
      INSERT INTO sync_rows(tbl, pk)
        SELECT ${lit(tbl)}, json_array(${pk.map((c) => `OLD.${q(c)}`).join(', ')})
         WHERE ${moved};
    END;
  CREATE TRIGGER IF NOT EXISTS ${q(`sync_d_${tbl}`)} AFTER DELETE ON ${q(tbl)}
    WHEN ${ON} BEGIN ${trackKey(tbl, 'OLD', pk)} END;
`);
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
    stampUnversionedLogins(conn);
  })();
}

/** Logins saved before this device led, or copied to it, carry no version yet.
 *  They get `(epoch, 1..k)` above whatever this epoch already holds, in the
 *  same transaction as the switch, so they travel on the first pull. */
function stampUnversionedLogins(conn: BetterSqlite3.Database): void {
  const { epoch } = conn.prepare(`SELECT epoch FROM sync_state`).get() as { epoch: number };
  const rows = conn
    .prepare(`SELECT rowid AS r FROM vault WHERE epoch = 0 AND n = 0 ORDER BY rowid`)
    .all() as { r: number }[];
  if (rows.length === 0) return;
  let n = (
    conn.prepare(`SELECT coalesce(max(n), 0) AS m FROM vault WHERE epoch = ?`).get(epoch) as { m: number }
  ).m;
  const set = conn.prepare(`UPDATE vault SET epoch = ?, n = ? WHERE rowid = ?`);
  for (const { r } of rows) set.run(epoch, (n += 1), r);
}

export function disableTracking(conn: BetterSqlite3.Database): void {
  conn.prepare(`UPDATE sync_state SET tracking = 0`).run();
}
