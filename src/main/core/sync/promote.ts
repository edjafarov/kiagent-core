/** Role changes in a running app (alpha-cent spec 7.8, step 2). Both run as
 *  one transaction on the writer connection. Promotion never restarts the app;
 *  demotion is followed by one.
 *
 *  Rule of the module (D2): an extension uninstall travels as a tombstone in
 *  `core.extensions` (`removed: true`), never as a row deletion. */
import type BetterSqlite3 from 'better-sqlite3';

import { SyncEpochBehind } from './role';
import { enableTracking } from './tracking';

/** Numbers are never reused: a new master counts from `epoch x 10^10`. */
export const EPOCH_GAP = 10_000_000_000;

const COUNTERS = ['changes', 'sync_rows'] as const;

export interface PromoteOptions {
  /** Publish the rows this device only applied as a follower (`sync_imported`)
   *  into the new epoch. Needed only when some other device could lack them
   *  (it skipped the interim leader); a two-device account never needs it, as
   *  the only other device is the leader these rows came from. The set is
   *  cleared either way. Default true: when unsure, relay. */
  relayImported?: boolean;
  /** The new head is not yet acknowledged by the lease holder: the device
   *  stays fenced, across a restart, until `open('head-acked')`. */
  headPending?: boolean;
}

export function promote(
  conn: BetterSqlite3.Database,
  epoch: number,
  opts: PromoteOptions = {},
): void {
  const relayImported = opts.relayImported !== false;
  conn.transaction(() => {
    const s = conn.prepare(`SELECT role, epoch, after_seq, after_cursor, pre_demote_epoch FROM sync_state`).get() as {
      role: string;
      epoch: number;
      pre_demote_epoch: number | null;
      after_seq: number;
      after_cursor: number;
    };
    // The same epoch again is the same promotion, e.g. a retried reply.
    const done = s.role === 'normal' && s.epoch === epoch;
    // The role flips first: tracking refuses a follower.
    conn
      .prepare(
        `UPDATE sync_state SET role = 'normal', master_device_id = NULL, joining = 0, epoch = ?,
                              pre_demote_epoch = NULL, head_pending = ?`,
      )
      .run(epoch, opts.headPending ? 1 : 0);
    if (done) return;
    // sqlite_sequence has no unique key, so INSERT OR REPLACE would add a second
    // row beside the existing one, and SQLite reads the first. Update what is
    // there; a table that never had an insert has no row, so only then insert.
    const raise = conn.prepare(`UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?`);
    const create = conn.prepare(
      `INSERT INTO sqlite_sequence(name, seq)
       SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)`,
    );
    for (const name of COUNTERS) {
      raise.run(epoch * EPOCH_GAP, name);
      create.run(name, epoch * EPOCH_GAP, name);
    }
    enableTracking(conn);
    // After the triggers exist, so this is the first tracked row and travels.
    conn
      .prepare(
        `INSERT OR IGNORE INTO sync_epochs(epoch, grant_seq, grant_cursor) VALUES (?, ?, ?)`,
      )
      .run(epoch, s.after_seq, s.after_cursor);
    // A device that just caught up from an interim leader still holds its own
    // rows numbered below that leader's range, above its grant: the interim
    // leader never saw them, and a pull after the new head would skip them.
    if (s.role === 'follower' && s.epoch < epoch) {
      renumberUnseen(conn, s.pre_demote_epoch ?? s.epoch, s.pre_demote_epoch !== null);
    }
    // What this device only applied from an interim leader is not in its
    // sync_rows: publish it now, numbered in the new epoch, so a device that
    // skipped that leader still gets it. Same delete-then-insert as trackKey.
    const imported = relayImported
      ? (conn.prepare(`SELECT tbl, pk FROM sync_imported ORDER BY id`).all() as {
          tbl: string;
          pk: string;
        }[])
      : [];
    const forget = conn.prepare(`DELETE FROM sync_rows WHERE tbl = ? AND pk = ?`);
    const publish = conn.prepare(`INSERT INTO sync_rows(tbl, pk) VALUES(?, ?)`);
    for (const k of imported) {
      forget.run(k.tbl, k.pk);
      publish.run(k.tbl, k.pk);
    }
    conn.exec(`DELETE FROM sync_imported`);
    // Workers re-seed from the new range and skip what the ledger said was done
    // on the master; this device's own bookkeeping would point into the old one.
    conn.exec(`DELETE FROM work_ledger; DELETE FROM consumers;`);
  })();
}

/** The one way a device starts leading. A follower is promoted into `epoch`
 *  (and stays pending an acknowledgement of its head); a lone device is seeded
 *  as the first leader; a device already leading is left alone. */
export function lead(
  conn: BetterSqlite3.Database,
  epoch: number,
  opts: { relayImported?: boolean } = {},
): 'promoted' | 'seeded' | 'noop' {
  const s = conn
    .prepare(`SELECT role, tracking, epoch FROM sync_state`)
    .get() as { role: string; tracking: number; epoch: number };
  if (s.role === 'follower') {
    if (epoch <= s.epoch) throw new SyncEpochBehind();
    promote(conn, epoch, { ...opts, headPending: true });
    return 'promoted';
  }
  if (s.tracking === 1) return 'noop';
  conn.transaction(() => {
    enableTracking(conn);
    conn
      .prepare(
        `INSERT OR IGNORE INTO sync_epochs(epoch, grant_seq, grant_cursor)
         SELECT ?, after_seq, after_cursor FROM sync_state`,
      )
      .run(epoch);
  })();
  return 'seeded';
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
                               after_seq = ?, after_cursor = ?, head_pending = 0,
                               pre_demote_epoch = CASE WHEN role = 'normal' THEN epoch ELSE pre_demote_epoch END`,
      )
      .run(masterDeviceId, head.seq, head.cursor);
  })();
}

/** Gives the rows this device wrote after the first takeover it missed, still
 *  in the old numbering, fresh numbers in the new epoch so they travel. That
 *  takeover is the lowest grant above the epoch this device last led in
 *  (`fromEpoch`), not the latest: with several takeovers since, the earliest
 *  one is where its unseen rows start. A row the interim leader also changed is
 *  already merged here, so what is sent is the current value. A follower that
 *  was not led past has no such rows. `above` is false for a device that never
 *  led: it uses the grant of the epoch it applied from, as before. */
function renumberUnseen(conn: BetterSqlite3.Database, fromEpoch: number, above: boolean): void {
  const row = above
    ? (conn
        .prepare(
          `SELECT epoch, grant_seq AS seq, grant_cursor AS cursor FROM sync_epochs
           WHERE epoch > ? ORDER BY epoch LIMIT 1`,
        )
        .get(fromEpoch) as { epoch: number; seq: number; cursor: number } | undefined)
    : (conn
        .prepare(
          `SELECT epoch, grant_seq AS seq, grant_cursor AS cursor FROM sync_epochs WHERE epoch = ?`,
        )
        .get(fromEpoch) as { epoch: number; seq: number; cursor: number } | undefined);
  if (!row) return;
  const grant = row;
  const below = row.epoch * EPOCH_GAP;
  // Same as tracking.trackKey: delete then insert, so the key gets a new cursor.
  const keys = conn
    .prepare(`SELECT tbl, pk FROM sync_rows WHERE cursor > ? AND cursor < ? ORDER BY cursor`)
    .all(grant.cursor, below) as { tbl: string; pk: string }[];
  const drop = conn.prepare(`DELETE FROM sync_rows WHERE tbl = ? AND pk = ?`);
  const add = conn.prepare(`INSERT INTO sync_rows(tbl, pk) VALUES(?, ?)`);
  for (const k of keys) {
    drop.run(k.tbl, k.pk);
    add.run(k.tbl, k.pk);
  }
  // Documents feed from `seq`, which comes from `changes`: a new change row
  // gives the number. The seq update is not tracked by design.
  const docs = conn
    .prepare(`SELECT id FROM documents WHERE seq > ? AND seq < ? ORDER BY seq`)
    .all(grant.seq, below) as { id: string }[];
  const change = conn.prepare(`INSERT INTO changes(kind, ref_id, at) VALUES('document', ?, ?)`);
  const set = conn.prepare(`UPDATE documents SET seq = ? WHERE id = ?`);
  const at = new Date().toISOString();
  for (const d of docs) set.run(change.run(d.id, at).lastInsertRowid, d.id);
}
