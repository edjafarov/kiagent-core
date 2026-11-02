/** Role changes in a running app (alpha-cent spec 7.8, step 2). Both run as
 *  one transaction on the writer connection. Promotion never restarts the app;
 *  demotion is followed by one. */
import type BetterSqlite3 from 'better-sqlite3';

import { enableTracking } from './tracking';

/** Numbers are never reused: a new master counts from `epoch x 10^10`. */
export const EPOCH_GAP = 10_000_000_000;

const COUNTERS = ['changes', 'sync_rows'] as const;

export function promote(conn: BetterSqlite3.Database, epoch: number): void {
  conn.transaction(() => {
    const s = conn.prepare(`SELECT role, epoch, after_seq, after_cursor FROM sync_state`).get() as {
      role: string;
      epoch: number;
      after_seq: number;
      after_cursor: number;
    };
    // The same epoch again is the same promotion, e.g. a retried reply.
    const done = s.role === 'normal' && s.epoch === epoch;
    // The role flips first: tracking refuses a follower.
    conn
      .prepare(`UPDATE sync_state SET role = 'normal', master_device_id = NULL, joining = 0, epoch = ?`)
      .run(epoch);
    if (done) return;
    // A table that never had an insert has no sequence row, so this inserts.
    const raise = conn.prepare(
      `INSERT OR REPLACE INTO sqlite_sequence(name, seq)
       VALUES (?, max(coalesce((SELECT seq FROM sqlite_sequence WHERE name = ?), 0), ?))`,
    );
    for (const name of COUNTERS) raise.run(name, name, epoch * EPOCH_GAP);
    conn
      .prepare(
        `INSERT OR IGNORE INTO sync_epochs(epoch, grant_seq, grant_cursor) VALUES (?, ?, ?)`,
      )
      .run(epoch, s.after_seq, s.after_cursor);
    enableTracking(conn);
    // Workers re-seed from the new range and skip what the ledger said was done
    // on the master; this device's own bookkeeping would point into the old one.
    conn.exec(`DELETE FROM work_ledger; DELETE FROM consumers;`);
  })();
}

export function demote(conn: BetterSqlite3.Database, masterDeviceId: string): void {
  conn.transaction(() => {
    const head = conn
      .prepare(
        `SELECT (SELECT coalesce(max(seq), 0) FROM documents) AS seq,
                (SELECT coalesce(max(cursor), 0) FROM sync_rows) AS cursor`,
      )
      .get() as { seq: number; cursor: number };
    conn
      .prepare(
        `UPDATE sync_state SET role = 'follower', tracking = 0, master_device_id = ?,
                               after_seq = ?, after_cursor = ?`,
      )
      .run(masterDeviceId, head.seq, head.cursor);
  })();
}
