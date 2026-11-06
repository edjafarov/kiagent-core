import fs from 'node:fs';
import path from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';

import { QUEUED_SETTINGS_SQL, queuedSettingsOf } from './settings-queue';
import { copiedSetDigest } from './tables';
import type { SyncRole } from './role';
import type { DeviceSyncStatus } from './service';

export function readSyncStatus(conn: BetterSqlite3.Database): DeviceSyncStatus {
  const s = conn.prepare(`SELECT * FROM sync_state`).get() as {
    role: SyncRole;
    tracking: number;
    history_id: string | null;
    master_device_id: string | null;
    joining: number;
    joined: number;
    after_seq: number;
    after_cursor: number;
    epoch: number;
    device_id: string | null;
    head_pending: number;
  };
  const head = conn
    .prepare(
      `SELECT (SELECT max(seq) FROM documents) AS seq,
              (SELECT max(cursor) FROM sync_rows) AS cursor`,
    )
    .get() as { seq: number | null; cursor: number | null };
  const documents = conn
    .prepare(`SELECT count(*) AS n FROM documents WHERE archived_at IS NULL`)
    .get() as { n: number };
  const accounts = conn
    .prepare(`SELECT count(*) AS n FROM accounts WHERE source <> 'worker'`)
    .get() as { n: number };
  const grant = conn
    .prepare(
      `SELECT grant_seq AS seq, grant_cursor AS cursor FROM sync_epochs WHERE epoch = ?`,
    )
    .get(s.epoch) as { seq: number; cursor: number } | undefined;
  const secrets = conn
    .prepare(`SELECT epoch, n FROM vault ORDER BY epoch DESC, n DESC LIMIT 1`)
    .get() as { epoch: number; n: number } | undefined;
  const waiting = conn
    .prepare(`SELECT count(*) AS n FROM sync_outbound`)
    .get() as { n: number };
  const elsewhere = (
    conn
      .prepare(
        `SELECT source, identifier, owner_device_id AS owner FROM accounts
          WHERE owner_device_id IS NOT NULL AND owner_device_id <> ? ORDER BY source, identifier`,
      )
      .all(s.device_id ?? '') as {
      source: string;
      identifier: string;
      owner: string;
    }[]
  ).map((r) => ({
    source: r.source,
    // The folder suffix keeps two devices' rows apart; the user never needs it.
    identifier: r.identifier.replace(/#[0-9a-f]{8}$/, ''),
    ownerDeviceId: r.owner,
  }));
  return {
    elsewhere,
    headPending: s.head_pending === 1,
    outbound: { waiting: waiting.n },
    queuedSettings: queuedSettingsOf(
      conn.prepare(QUEUED_SETTINGS_SQL).all() as Parameters<
        typeof queuedSettingsOf
      >[0],
    ),
    deviceId: s.device_id,
    copiedSet: copiedSetDigest(conn),
    secretsAfter: secrets ?? { epoch: 0, n: 0 },
    epoch: s.epoch,
    grant: grant ?? null,
    role: s.role,
    joining: s.joining === 1,
    joined: s.joined === 1,
    documents: documents.n,
    accounts: accounts.n,
    lastSwap: readSwapOutcome(conn.name),
    archiveBytes: archiveFiles(conn.name).reduce(
      (n, f) => n + fs.statSync(f).size,
      0,
    ),
    dbBytes: [conn.name, `${conn.name}-wal`].reduce(
      (n, f) => n + (fs.existsSync(f) ? fs.statSync(f).size : 0),
      0,
    ),
    tracking: s.tracking === 1,
    historyId: s.history_id,
    masterDeviceId: s.master_device_id,
    after: { seq: s.after_seq, cursor: s.after_cursor },
    head: { seq: head.seq ?? 0, cursor: head.cursor ?? 0 },
    schemaVersion: Number(
      (
        conn
          .prepare(`SELECT value FROM meta WHERE key='schemaVersion'`)
          .get() as { value: string }
      ).value,
    ),
  };
}

/** What the last boot swap decided, kept on disk so a crash right after it
 *  can't lose it (spec 7.7: the join and the swap must agree at boot). */
export const swapOutcomePath = (dbPath: string): string =>
  `${dbPath}.swap-outcome`;

export function readSwapOutcome(
  dbPath: string,
): 'swapped' | 'abandoned' | null {
  try {
    const v = fs.readFileSync(swapOutcomePath(dbPath), 'utf8');
    return v === 'swapped' || v === 'abandoned' ? v : null;
  } catch {
    return null;
  }
}

/** The old database a join set aside, with its WAL and SHM files. */
export function archiveFiles(dbPath: string): string[] {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.archive-`;
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}
