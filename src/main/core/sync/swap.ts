/** Turns this device into a follower at boot, before the database is opened
 *  (spec 7.5, 7.6 and 14). The snapshot gains this device's own local tables,
 *  the old file is renamed to an archive, and the new one takes its place. A
 *  small journal makes every step safe to die on. */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { hashFile, SNAPSHOT_META } from './snapshot';
import { COPIED_CORE_TABLES, isDerivedTable } from './tables';

export const SWAP_STEPS = ['committed', 'merged', 'archived', 'replaced'] as const;
type SwapStep = (typeof SWAP_STEPS)[number] | 'restore-moved';

interface Journal {
  masterDeviceId: string;
  /** Set once the merged file is complete; the renames can then be redone. */
  merged: boolean;
  replacesCopy?: boolean;
  archive: string;
}

const journalPath = (db: string) => `${db}.swap.json`;
const incomingPath = (db: string) => `${db}.swap-incoming`;
const mergedPath = (db: string) => `${db}.swap-merged`;

const writeJournal = (db: string, j: Journal): void => {
  const tmp = `${journalPath(db)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j));
  fs.renameSync(tmp, journalPath(db));
};

const roleOf = (dbPath: string): string | undefined => {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare(`SELECT role FROM sync_state`).get() as { role: string } | undefined)?.role;
  } finally {
    db.close();
  }
};

export function prepareSwap(
  dbPath: string,
  file: string,
  sha256: string,
  masterDeviceId: string,
  freeBytes: () => number = () => {
    const s = fs.statfsSync(path.dirname(dbPath));
    return Number(s.bavail) * Number(s.bsize);
  },
): 'ready' | 'no-disk' | 'invalid' {
  if (hashFile(file) !== sha256) return 'invalid';
  // The file was already downloaded here, so only the local tables are new.
  // They can't outgrow the database they come from.
  const wal = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
  const needed = fs.statSync(dbPath).size + wal;
  if (freeBytes() < needed) return 'no-disk';
  fs.renameSync(file, incomingPath(dbPath));
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  writeJournal(dbPath, {
    masterDeviceId,
    merged: false,
    replacesCopy: roleOf(dbPath) === 'follower',
    archive: `${dbPath}.archive-${stamp}`,
  });
  return 'ready';
}

/** Adds every local table of `old` to the snapshot at `file`. */
function mergeLocalTables(file: string, old: string, masterDeviceId: string): void {
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = OFF');
    // The merge commits, then the journal says so; a crash in between leaves a
    // file that's already merged, which is recognised by its dropped table.
    const pending = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`)
      .get(SNAPSHOT_META);
    if (!pending) return;
    db.prepare(`ATTACH ? AS old`).run(old);
    db.unsafeMode(true);
    db.transaction(() => {
      const meta = db.prepare(`SELECT * FROM ${SNAPSHOT_META}`).get() as {
        after_seq: number;
        after_cursor: number;
        history_id: string | null;
      };
      const copied = (name: string) =>
        COPIED_CORE_TABLES.includes(name) || isDerivedTable(name);
      const defs = db
        .prepare(
          `SELECT type, name, tbl_name, sql FROM old.sqlite_master
           WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as { type: string; name: string; tbl_name: string; sql: string }[];
      const shadow = new Set(
        (
          db
            .prepare(`SELECT name FROM pragma_table_list WHERE schema='old' AND type='shadow'`)
            .all() as { name: string }[]
        ).map((r) => r.name),
      );
      const localTables = defs.filter(
        (d) => d.type === 'table' && !copied(d.name) && !shadow.has(d.name),
      );
      const isVirtual = (sql: string) => /^CREATE\s+VIRTUAL/i.test(sql);
      for (const t of localTables) db.exec(t.sql);
      for (const t of localTables) {
        if (isVirtual(t.sql)) continue;
        db.exec(`INSERT INTO main."${t.name}" SELECT * FROM old."${t.name}"`);
      }
      for (const s of shadow) {
        if (copied(s)) continue;
        db.exec(`DELETE FROM main."${s}"; INSERT INTO main."${s}" SELECT * FROM old."${s}";`);
      }
      for (const d of defs) {
        if (d.type === 'table') continue;
        if (d.name.startsWith('sync_')) continue;
        if (d.type === 'index' && copied(d.tbl_name)) continue;
        db.exec(d.sql);
      }
      db.exec(
        `DELETE FROM main.sqlite_sequence;
         INSERT INTO main.sqlite_sequence(name, seq) SELECT name, seq FROM old.sqlite_sequence;`,
      );
      // Followers read `changes` through headSeq and the feed. Delete rather
      // than drop, so sqlite_sequence keeps numbers from being reused.
      const now = new Date().toISOString();
      db.exec(`DELETE FROM main.changes`);
      db.prepare(
        `INSERT INTO main.changes(seq, kind, ref_id, at)
         SELECT seq, 'document', id, ? FROM main.documents WHERE seq > 0`,
      ).run(now);
      db.prepare(
        `UPDATE main.sync_state SET role = 'follower', tracking = 0, after_seq = ?,
           after_cursor = ?, history_id = ?, master_device_id = ?`,
      ).run(meta.after_seq, meta.after_cursor, meta.history_id, masterDeviceId);
      db.exec(`DROP TABLE main.${SNAPSHOT_META}`);
    })();
    db.unsafeMode(false);
    db.exec(`DETACH old`);
  } finally {
    db.close();
  }
}

const moveIfThere = (from: string, to: string): void => {
  if (fs.existsSync(from)) fs.renameSync(from, to);
};

const restorePath = (db: string) => `${db}.restore.json`;

/** Stop copying: at the next boot the archive becomes the database again and
 *  the copy is deleted, since all of it lives on the master. */
export function prepareRestore(dbPath: string): 'ready' | 'no-archive' {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.archive-`;
  const newest = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && /\d$/.test(f))
    .sort()
    .pop();
  if (!newest) return 'no-archive';
  const tmp = `${restorePath(dbPath)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ archive: path.join(dir, newest) }));
  fs.renameSync(tmp, restorePath(dbPath));
  return 'ready';
}

function applyRestore(dbPath: string, crashAt: (step: SwapStep) => void): 'restored' {
  const { archive } = JSON.parse(fs.readFileSync(restorePath(dbPath), 'utf8')) as {
    archive: string;
  };
  // Each step is checked, so a retry skips what already happened.
  if (fs.existsSync(archive)) {
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${ext}`, { force: true });
    moveIfThere(archive, dbPath);
    moveIfThere(`${archive}-wal`, `${dbPath}-wal`);
    moveIfThere(`${archive}-shm`, `${dbPath}-shm`);
    crashAt('restore-moved');
  }
  fs.rmSync(restorePath(dbPath), { force: true });
  return 'restored';
}

/** `crashAt` exists for the crash tests: it runs after each named step. */
export function applyPendingSwap(
  dbPath: string,
  crashAt: (step: SwapStep) => void = () => undefined,
): 'none' | 'swapped' | 'abandoned' | 'restored' {
  if (fs.existsSync(restorePath(dbPath))) return applyRestore(dbPath, crashAt);
  if (!fs.existsSync(journalPath(dbPath))) return 'none';
  const j = JSON.parse(fs.readFileSync(journalPath(dbPath), 'utf8')) as Journal;
  const merged = mergedPath(dbPath);

  if (!j.merged) {
    try {
      // Fold the old WAL in first, so the archive is one standalone file.
      const old = new Database(dbPath);
      old.pragma('wal_checkpoint(TRUNCATE)');
      old.close();
      // A move, so no second copy of the data. The merge is one transaction, so
      // a crash during it leaves this file as it arrived.
      if (fs.existsSync(incomingPath(dbPath))) {
        fs.renameSync(incomingPath(dbPath), merged);
      }
      mergeLocalTables(merged, dbPath, j.masterDeviceId);
    } catch {
      // Nothing has touched the old database, so it stays this device's data.
      // Retrying would fail the same way at every boot.
      fs.rmSync(incomingPath(dbPath), { force: true });
      fs.rmSync(merged, { force: true });
      fs.rmSync(`${merged}-wal`, { force: true });
      fs.rmSync(`${merged}-shm`, { force: true });
      fs.rmSync(journalPath(dbPath), { force: true });
      return 'abandoned';
    }
    crashAt('committed');
    writeJournal(dbPath, { ...j, merged: true });
    crashAt('merged');
  }
  // Each rename is checked, so a retry after a crash skips what already moved.
  if (j.replacesCopy && fs.existsSync(merged)) {
    // A copy being copied again holds nothing of its own, and the user's real
    // data is already in an archive.
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${ext}`, { force: true });
    crashAt('archived');
  } else if (!j.replacesCopy && !fs.existsSync(j.archive)) {
    moveIfThere(dbPath, j.archive);
    moveIfThere(`${dbPath}-wal`, `${j.archive}-wal`);
    moveIfThere(`${dbPath}-shm`, `${j.archive}-shm`);
    crashAt('archived');
  }
  if (fs.existsSync(merged)) {
    fs.renameSync(merged, dbPath);
    crashAt('replaced');
  }
  fs.rmSync(journalPath(dbPath), { force: true });
  return 'swapped';
}
