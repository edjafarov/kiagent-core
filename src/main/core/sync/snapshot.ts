/** Builds the file a new follower starts from (spec 7.6). A new, clean file:
 *  `VACUUM` may renumber the rowids search is pinned to, and a backup would
 *  carry free pages holding data deleted long ago. Only copied tables and the
 *  search tables' stored index data go in, so nothing is re-stemmed. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import Database from 'better-sqlite3';

import type { SyncCursor } from './delta';
import { copiedTables, isDerivedTable } from './tables';

export const SNAPSHOT_META = 'sync_snapshot_meta';

const qualify = (sql: string): string =>
  sql.replace(
    /^CREATE\s+(VIRTUAL\s+TABLE|TABLE|UNIQUE\s+INDEX|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?/i,
    (m, kind: string) => `CREATE ${kind} snap.`,
  );

export function buildSnapshot(
  dbPath: string,
  out: string,
): { bytes: number; target: SyncCursor; sha256: string } {
  fs.rmSync(out, { force: true });
  // Its own connection: the sync role's is query_only, which also forbids
  // writing an attached file. Only `snap` is written here.
  const conn = new Database(dbPath);
  try {
    conn.pragma('busy_timeout = 5000');
    conn.prepare(`ATTACH ? AS snap`).run(out);
    conn.pragma('snap.journal_mode = MEMORY');
    // Defensive mode refuses writes to FTS shadow tables, and copying them is
    // what spares a rebuild. Only for this connection's copy.
    conn.unsafeMode(true);
    const target = conn.transaction((): SyncCursor => {
      const master = conn
        .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL`)
        .all() as { type: string; name: string; tbl_name: string; sql: string }[];
      const shadow = new Set(
        (
          conn
            .prepare(`SELECT name FROM pragma_table_list WHERE schema='main' AND type='shadow'`)
            .all() as { name: string }[]
        ).map((r) => r.name),
      );
      const copied = copiedTables(conn);
      for (const t of copied) {
        const def = master.find((m) => m.type === 'table' && m.name === t);
        if (!def) throw new Error(`snapshot: no table ${t}`);
        conn.exec(qualify(def.sql));
      }
      const virtuals = master.filter(
        (m) => m.type === 'table' && isDerivedTable(m.name) && !shadow.has(m.name),
      );
      for (const v of virtuals) conn.exec(qualify(v.sql));
      for (const m of master) {
        if (m.type === 'index' && copied.includes(m.tbl_name)) {
          conn.exec(qualify(m.sql));
        }
      }
      const rowidless = new Set(
        (
          conn
            .prepare(`SELECT name FROM pragma_table_list WHERE schema='main' AND wr = 1`)
            .all() as { name: string }[]
        ).map((r) => r.name),
      );
      for (const t of copied) {
        const cols = (
          conn.prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[]
        )
          .map((c) => `"${c.name}"`)
          .join(',');
        conn.exec(
          rowidless.has(t)
            ? `INSERT INTO snap."${t}"(${cols}) SELECT ${cols} FROM main."${t}"`
            : `INSERT INTO snap."${t}"(rowid, ${cols}) SELECT rowid, ${cols} FROM main."${t}"`,
        );
      }
      for (const s of shadow) {
        if (!isDerivedTable(s)) continue;
        conn.exec(`DELETE FROM snap.${s}; INSERT INTO snap.${s} SELECT * FROM main.${s};`);
      }
      const head = conn
        .prepare(
          `SELECT (SELECT coalesce(max(seq), 0) FROM documents) AS seq,
                  (SELECT coalesce(max(cursor), 0) FROM sync_rows) AS cursor,
                  (SELECT history_id FROM sync_state) AS history`,
        )
        .get() as { seq: number; cursor: number; history: string | null };
      conn.exec(
        `CREATE TABLE snap.${SNAPSHOT_META}(after_seq INTEGER, after_cursor INTEGER, history_id TEXT)`,
      );
      conn
        .prepare(`INSERT INTO snap.${SNAPSHOT_META} VALUES(?, ?, ?)`)
        .run(head.seq, head.cursor, head.history);
      return { seq: head.seq, cursor: head.cursor };
    })();
    conn.unsafeMode(false);
    conn.exec(`DETACH snap`);
    return { bytes: fs.statSync(out).size, target, sha256: hashFile(out) };
  } finally {
    conn.close();
  }
}

export function hashFile(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}
