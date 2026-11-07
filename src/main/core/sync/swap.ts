/** Turns this device into a follower at boot, before the database is opened
 *  (spec 7.5, 7.6 and 14). The snapshot gains this device's own local tables,
 *  the old file is renamed to an archive, and the new one takes its place. A
 *  small journal makes every step safe to die on. */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { hashFile, SNAPSHOT_META } from './snapshot';
import { pauseMovedAccounts } from './sources';
import { readSwapRecord, swapOutcomePath } from './status';
import {
  COPIED_CORE_TABLES,
  isDerivedTable,
  LOCAL_CORE_TABLES,
  ownerCaptureTables,
  primaryKeyColumns,
} from './tables';

export const SWAP_STEPS = ['committed', 'merged', 'archived', 'replaced', 'outcome'] as const;
type SwapStep =
  | (typeof SWAP_STEPS)[number]
  | 'incoming-renamed'
  | 'journaled'
  | 'abandon-outcome'
  | 'abandon-journal'
  | 'abandon-cleaned'
  | 'restore-merged'
  | 'restore-moved';

interface Journal {
  masterDeviceId: string;
  /** Set once the merged file is complete; the renames can then be redone. */
  merged: boolean;
  /** The snapshot's hash: the merge writes it into the merged file as proof. */
  sha256?: string;
  replacesCopy?: boolean;
  archive: string;
  /** Set by a keep-archive swap: the old file always becomes a tagged archive. */
  keepArchive?: boolean;
  markId?: string;
  attempt?: number;
  /** When the swap was prepared; the sidecar carries it. */
  at?: string;
}

export interface KeepArchiveOpts {
  keepArchive: true;
  markId: string;
  attempt: number;
}

const journalPath = (db: string) => `${db}.swap.json`;
const incomingPath = (db: string) => `${db}.swap-incoming`;
const mergedPath = (db: string) => `${db}.swap-merged`;

/** Written by the merge transaction itself; a merged file counts as merged
 *  only when this holds the journal's snapshot hash. Dropped after install. */
const MERGE_MARKER = 'sync_swap_merged';

const hasMergeMarker = (file: string, sha256: string | undefined): boolean => {
  if (!sha256 || !fs.existsSync(file)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true });
    const r = db.prepare(`SELECT sha256 FROM ${MERGE_MARKER}`).all() as { sha256: string }[];
    return r.length === 1 && r[0].sha256 === sha256;
  } catch {
    return false;
  } finally {
    db?.close();
  }
};

const dropMergeMarker = (file: string): void => {
  const db = new Database(file);
  try {
    db.exec(`DROP TABLE IF EXISTS ${MERGE_MARKER}`);
  } finally {
    db.close();
  }
};

/** The swap's result, durable before the journal goes: the join reads it at
 *  boot and must never be told nothing happened when it did. */
const writeOutcome = (db: string, v: 'swapped' | 'abandoned', j: Journal): void => {
  const tmp = `${swapOutcomePath(db)}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ outcome: v, markId: j.markId ?? null, attempt: j.attempt ?? null }),
  );
  fs.renameSync(tmp, swapOutcomePath(db));
};

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

const sidecarPath = (archive: string) => `${archive}.passed-over.json`;

/** Written from the journal, tmp + rename, before the archive moves, so no
 *  crash point leaves a tagged history looking plain. Idempotent. */
function ensureSidecar(j: Journal): void {
  if (!j.keepArchive || fs.existsSync(sidecarPath(j.archive))) return;
  const tmp = `${sidecarPath(j.archive)}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ markId: j.markId, holder: j.masterDeviceId, at: j.at, attempt: j.attempt }),
  );
  fs.renameSync(tmp, sidecarPath(j.archive));
}

const defaultFree = (dbPath: string) => () => {
  const s = fs.statfsSync(path.dirname(dbPath));
  return Number(s.bavail) * Number(s.bsize);
};

const readJournalLoose = (dbPath: string): Partial<Journal> | null => {
  if (!fs.existsSync(journalPath(dbPath))) return null;
  try {
    return JSON.parse(fs.readFileSync(journalPath(dbPath), 'utf8')) as Journal;
  } catch {
    return {}; // unreadable: pending, and nobody's own
  }
};

const isOwnJournal = (j: Partial<Journal>, markId: string, attempt: number): boolean =>
  j.keepArchive === true && j.markId === markId && j.attempt === attempt;

/** A pending swap or restore that this mark and attempt did not prepare. */
const foreignPending = (dbPath: string, markId: string, attempt: number): boolean => {
  if (fs.existsSync(restorePath(dbPath))) return true;
  const j = readJournalLoose(dbPath);
  return j !== null && !isOwnJournal(j, markId, attempt);
};

/** `opts` may stand in the fifth place when `freeBytes` is not needed. */
export function prepareSwap(
  dbPath: string,
  file: string,
  sha256: string,
  masterDeviceId: string,
  freeOrOpts?: (() => number) | KeepArchiveOpts,
  maybeOpts?: KeepArchiveOpts,
): 'ready' | 'no-disk' | 'invalid' | 'pending' {
  const freeBytes = typeof freeOrOpts === 'function' ? freeOrOpts : defaultFree(dbPath);
  const opts = typeof freeOrOpts === 'function' || freeOrOpts === undefined ? maybeOpts : freeOrOpts;
  // A keep-archive swap never replaces a journal that is not its own: that
  // one is another swap (or a restore) the caller must discard on purpose.
  if (opts?.keepArchive && foreignPending(dbPath, opts.markId, opts.attempt)) return 'pending';
  if (hashFile(file) !== sha256) return 'invalid';
  // The file was already downloaded here, so only the local tables are new.
  // They can't outgrow the database they come from.
  const wal = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
  const needed = fs.statSync(dbPath).size + wal;
  if (freeBytes() < needed) return 'no-disk';
  fs.renameSync(file, incomingPath(dbPath));
  fs.rmSync(swapOutcomePath(dbPath), { force: true });
  const now = new Date();
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  // A second archive within the same second must not replace the first.
  let archive = `${dbPath}.archive-${stamp}`;
  for (let i = 1; fs.existsSync(archive) || fs.existsSync(sidecarPath(archive)); i++) {
    archive = `${dbPath}.archive-${stamp}-${i}`;
  }
  writeJournal(dbPath, {
    masterDeviceId,
    merged: false,
    sha256,
    replacesCopy: opts?.keepArchive ? false : roleOf(dbPath) === 'follower',
    archive,
    ...(opts?.keepArchive
      ? { keepArchive: true, markId: opts.markId, attempt: opts.attempt, at: now.toISOString() }
      : {}),
  });
  return 'ready';
}

/** Without a journal nothing is in progress, so a downloaded or half-merged
 *  snapshot is debris (a crash between the two writes in `prepareSwap`, or
 *  during a failed swap's cleanup). True when something was removed. */
export function dropOrphanIncoming(dbPath: string): boolean {
  if (fs.existsSync(journalPath(dbPath))) return false;
  let removed = false;
  for (const f of [
    incomingPath(dbPath),
    mergedPath(dbPath),
    `${mergedPath(dbPath)}-wal`,
    `${mergedPath(dbPath)}-shm`,
  ]) {
    if (!fs.existsSync(f)) continue;
    fs.rmSync(f, { force: true });
    removed = true;
  }
  return removed;
}

/** Whether a swap or a restore is waiting, and what the last swap decided.
 *  While a swap is pending `markId`/`attempt` come from its journal (null for an
 *  ordinary swap). A sidecar archive is proof that a swap completed only when
 *  nothing is pending: while `pending` is set, the archive may belong to an
 *  earlier attempt. */
export function swapStatus(dbPath: string): {
  pending: 'swap' | 'restore' | null;
  outcome: 'ok' | 'failed' | null;
  markId: string | null;
  attempt: number | null;
} {
  const r = readSwapRecord(dbPath);
  const outcome = r ? (r.outcome === 'swapped' ? 'ok' : 'failed') : null;
  if (fs.existsSync(restorePath(dbPath))) {
    return { pending: 'restore', outcome, markId: null, attempt: null };
  }
  if (fs.existsSync(journalPath(dbPath))) {
    let j: Partial<Journal> = {};
    try {
      j = JSON.parse(fs.readFileSync(journalPath(dbPath), 'utf8')) as Journal;
    } catch {
      /* unreadable journal: still pending */
    }
    return { pending: 'swap', outcome, markId: j.markId ?? null, attempt: j.attempt ?? null };
  }
  return { pending: null, outcome, markId: r?.markId ?? null, attempt: r?.attempt ?? null };
}

/** Removes the outcome only when it is the one for this mark and attempt. */
export async function clearSwapStatus(dbPath: string, markId: string, attempt: number): Promise<void> {
  const r = readSwapRecord(dbPath);
  if (r && r.markId === markId && r.attempt === attempt) {
    fs.rmSync(swapOutcomePath(dbPath), { force: true });
  }
}

/** Proof that a keep-archive swap for this mark and attempt moved the old file. */
export async function findPassedOverArchive(
  dbPath: string,
  markId: string,
  attempt: number,
): Promise<boolean> {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.archive-`;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith(prefix) || !f.endsWith('.passed-over.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as {
        markId?: string;
        attempt?: number;
      };
      if (s.markId === markId && s.attempt === attempt) return true;
    } catch {
      /* unreadable sidecar: not proof */
    }
  }
  return false;
}

/** Adds every local table of `old` to the snapshot at `file`. */
function mergeLocalTables(
  file: string,
  old: string,
  masterDeviceId: string,
  sha256: string,
  keepArchive = false,
): void {
  const db = new Database(file);
  try {
    db.pragma('foreign_keys = OFF');
    // No metadata means this is not a snapshot: never read that as "merged".
    const pending = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE name = ?`)
      .get(SNAPSHOT_META);
    if (!pending) throw new Error('swap: not a snapshot');
    db.prepare(`ATTACH ? AS old`).run(old);
    db.unsafeMode(true);
    db.transaction(() => {
      const meta = db.prepare(`SELECT * FROM ${SNAPSHOT_META}`).get() as {
        after_seq: number;
        after_cursor: number;
        history_id: string | null;
        epoch: number;
        copied: string;
      };
      // The plugin tables the old file's descriptors name travel with the
      // snapshot; every other plugin table stays this device's own.
      // Classified by the master's list carried in the snapshot: a table it
      // newly syncs must come from the snapshot and not be created again from
      // this device's own copy of it.
      const copiedNames = new Set(JSON.parse(meta.copied) as string[]);
      const copied = (name: string) => copiedNames.has(name) || isDerivedTable(name);
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
        (d) => d.type === 'table' && !copied(d.name) && !shadow.has(d.name) && d.name !== MERGE_MARKER,
      );
      const isVirtual = (sql: string) => /^CREATE\s+VIRTUAL/i.test(sql);
      // A keep-archive swap takes the snapshot's join state: the old file's
      // published rows stay in the archive, so a later promote can't publish
      // a key or a delete that exists only there.
      const dropsRows = (name: string) =>
        keepArchive && (name === 'sync_rows' || name === 'sync_imported');
      for (const t of localTables) db.exec(t.sql);
      for (const t of localTables) {
        if (isVirtual(t.sql) || dropsRows(t.name)) continue;
        db.exec(`INSERT INTO main."${t.name}" SELECT * FROM old."${t.name}"`);
      }
      for (const s of shadow) {
        if (copied(s)) continue;
        db.exec(`DELETE FROM main."${s}"; INSERT INTO main."${s}" SELECT * FROM old."${s}";`);
      }
      // Owner-capture tables (step 3): the master's rows come with the
      // snapshot, and this device's own rows of them stay, listed in
      // `sync_retained` so the extension can send each one to the leader.
      for (const t of ownerCaptureTables(db, 'old')) {
        if (!copiedNames.has(t)) continue; // not synced there: already carried
        const mine = db.prepare(`SELECT 1 FROM main.sqlite_master WHERE type='table' AND name = ?`).get(t);
        if (!mine) continue;
        const pk = primaryKeyColumns(db, t, 'old');
        if (pk.length === 0) continue;
        const rows = db.prepare(`SELECT ${pk.map((c) => `"${c}"`).join(', ')} FROM old."${t}"`).all() as Record<string, unknown>[];
        db.exec(`INSERT OR IGNORE INTO main."${t}" SELECT * FROM old."${t}"`);
        // An old file from before this table existed has none to copy.
        db.exec(`CREATE TABLE IF NOT EXISTS main.sync_retained (tbl TEXT NOT NULL, pk TEXT NOT NULL, PRIMARY KEY (tbl, pk))`);
        const note = db.prepare(`INSERT OR IGNORE INTO main.sync_retained(tbl, pk) VALUES(?, ?)`);
        for (const r of rows) note.run(t, JSON.stringify(pk.map((c) => r[c])));
      }
      for (const d of defs) {
        if (d.type === 'table') continue;
        if (d.name.startsWith('sync_')) continue;
        if (d.type === 'index' && copied(d.tbl_name)) continue;
        db.exec(d.sql);
      }
      db.exec(
        `DELETE FROM main.sqlite_sequence;
         INSERT INTO main.sqlite_sequence(name, seq) SELECT name, seq FROM old.sqlite_sequence
          WHERE ${keepArchive ? `name <> 'sync_rows'` : '1'};`,
      );
      if (keepArchive) {
        db.prepare(`INSERT INTO main.sqlite_sequence(name, seq) VALUES('sync_rows', ?)`).run(
          meta.after_cursor,
        );
      }
      // Followers read `changes` through headSeq and the feed. Delete rather
      // than drop, so sqlite_sequence keeps numbers from being reused.
      const now = new Date().toISOString();
      db.exec(`DELETE FROM main.changes`);
      db.prepare(
        `INSERT INTO main.changes(seq, kind, ref_id, at)
         SELECT seq, 'document', id, ? FROM main.documents WHERE seq > 0`,
      ).run(now);
      db.prepare(
        `UPDATE main.sync_state SET role = 'follower', tracking = 0, joining = 0,
           after_seq = ?, after_cursor = ?, history_id = ?, master_device_id = ?, epoch = ?,
           pre_demote_epoch = NULL${keepArchive ? ', joined = 1' : ''}`,
      ).run(meta.after_seq, meta.after_cursor, meta.history_id, masterDeviceId, meta.epoch);
      db.exec(`DROP TABLE main.${SNAPSHOT_META}`);
      db.exec(`CREATE TABLE main.${MERGE_MARKER}(sha256 TEXT NOT NULL)`);
      db.prepare(`INSERT INTO main.${MERGE_MARKER}(sha256) VALUES(?)`).run(sha256);
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
    // An archive with a sidecar is a history the account abandoned: never restored.
    .filter((f) => f.startsWith(prefix) && /\d$/.test(f) && !fs.existsSync(sidecarPath(path.join(dir, f))))
    .sort()
    .pop();
  if (!newest) return 'no-archive';
  const tmp = `${restorePath(dbPath)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ archive: path.join(dir, newest) }));
  fs.renameSync(tmp, restorePath(dbPath));
  return 'ready';
}

/** What the current file keeps writing for the user while it is a copy, and
 *  so replaces the archive's: outbox and drafts, attention, and every plugin
 *  or meeting table. Everything else a restore keeps from the archive: the
 *  logins, the sync tables, `changes` and the work ledgers, which describe the
 *  archive's own documents, `schedule`, `consents` and `meta`. */
const CARRIED_CORE_TABLES: readonly string[] = [
  'outbox',
  'event_drafts',
  'attention_items',
  'attention_revisions',
];

const carriedOnRestore = (name: string): boolean =>
  CARRIED_CORE_TABLES.includes(name) ||
  (!COPIED_CORE_TABLES.includes(name) &&
    !LOCAL_CORE_TABLES.includes(name) &&
    !isDerivedTable(name) &&
    !name.startsWith('sync_') &&
    !name.startsWith('sqlite_'));

/** Folds what the current file wrote since joining into the archive, in one
 *  transaction, and makes the archive ready to be the database again. A
 *  failure rolls back, and nothing has moved yet. */
function mergeIntoArchive(archive: string, current: string): void {
  const db = new Database(archive);
  try {
    db.pragma('foreign_keys = OFF');
    db.prepare(`ATTACH ? AS cur`).run(current);
    db.unsafeMode(true);
    db.transaction(() => {
      const defs = db
        .prepare(
          `SELECT type, name, tbl_name, sql FROM cur.sqlite_master
           WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as { type: string; name: string; tbl_name: string; sql: string }[];
      const have = new Set(
        (db.prepare(`SELECT name FROM main.sqlite_master`).all() as { name: string }[]).map(
          (r) => r.name,
        ),
      );
      const shadow = new Set(
        (
          db
            .prepare(`SELECT name FROM pragma_table_list WHERE schema='cur' AND type='shadow'`)
            .all() as { name: string }[]
        ).map((r) => r.name),
      );
      const isVirtual = (sql: string) => /^CREATE\s+VIRTUAL/i.test(sql);
      const tables = defs.filter(
        (d) => d.type === 'table' && !shadow.has(d.name) && carriedOnRestore(d.name),
      );
      const cols = (schema: string, t: string) =>
        (
          db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(t, schema) as {
            name: string;
          }[]
        ).map((c) => c.name);
      for (const t of tables) {
        const fresh = !have.has(t.name);
        if (fresh) db.exec(t.sql);
        if (isVirtual(t.sql)) {
          // Their rows live in shadow tables; copying those spares a rebuild.
          for (const sh of shadow) {
            if (!sh.startsWith(`${t.name}_`)) continue;
            db.exec(`DELETE FROM main."${sh}"; INSERT INTO main."${sh}" SELECT * FROM cur."${sh}";`);
          }
          continue;
        }
        const common = cols('main', t.name).filter((c) => cols('cur', t.name).includes(c));
        const list = common.map((c) => `"${c}"`).join(', ');
        db.exec(`DELETE FROM main."${t.name}"`);
        if (list) db.exec(`INSERT INTO main."${t.name}"(${list}) SELECT ${list} FROM cur."${t.name}"`);
        if (fresh) {
          for (const d of defs) {
            if ((d.type === 'index' || d.type === 'trigger') && d.tbl_name === t.name) db.exec(d.sql);
          }
        }
      }
      const names = tables.map((t) => `'${t.name.replace(/'/g, "''")}'`).join(', ');
      if (names) {
        db.exec(
          `DELETE FROM main.sqlite_sequence WHERE name IN (${names});
           INSERT INTO main.sqlite_sequence(name, seq)
             SELECT name, seq FROM cur.sqlite_sequence WHERE name IN (${names});`,
        );
      }
      db.exec(`UPDATE main.sync_state SET joining = 0`);
      pauseMovedAccounts(db);
    })();
    db.unsafeMode(false);
    db.exec(`DETACH cur`);
  } finally {
    db.close();
  }
}

function applyRestore(
  dbPath: string,
  crashAt: (step: SwapStep) => void,
): 'restored' | 'abandoned' {
  const j = JSON.parse(fs.readFileSync(restorePath(dbPath), 'utf8')) as {
    archive: string;
    merged?: boolean;
  };
  const { archive } = j;
  // Each step is checked, so a retry skips what already happened.
  if (fs.existsSync(archive)) {
    if (!j.merged) {
      try {
        mergeIntoArchive(archive, dbPath);
      } catch {
        // Nothing has moved: the current file stays the database.
        fs.rmSync(restorePath(dbPath), { force: true });
        return 'abandoned';
      }
      const tmp = `${restorePath(dbPath)}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...j, merged: true }));
      fs.renameSync(tmp, restorePath(dbPath));
      crashAt('restore-merged');
    }
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(`${dbPath}${ext}`, { force: true });
    moveIfThere(archive, dbPath);
    moveIfThere(`${archive}-wal`, `${dbPath}-wal`);
    moveIfThere(`${archive}-shm`, `${dbPath}-shm`);
    crashAt('restore-moved');
  }
  fs.rmSync(swapOutcomePath(dbPath), { force: true });
  fs.rmSync(restorePath(dbPath), { force: true });
  return 'restored';
}

/** Stop syncing before the swap happened: forget the downloaded snapshot and
 *  the journal, so the next boot opens this device's own database as it is. */
export function dropPendingSwap(dbPath: string): void {
  for (const f of [
    incomingPath(dbPath),
    mergedPath(dbPath),
    `${mergedPath(dbPath)}-wal`,
    `${mergedPath(dbPath)}-shm`,
    journalPath(dbPath),
    swapOutcomePath(dbPath),
  ]) {
    fs.rmSync(f, { force: true });
  }
}

/** Drops a pending swap or restore that recovery did not prepare, so its own
 *  keep-archive swap can take its place. The journal goes first, then the
 *  payload files: a crash between leaves either the journal (applied as
 *  before) or orphan files that boot's `dropOrphanIncoming` removes. It never
 *  touches an archive, a sidecar, the outcome record or the live database.
 *  `'own'`: the pending journal is this mark and attempt's; nothing is touched. */
export function discardForeignPending(
  dbPath: string,
  markId: string,
  attempt: number,
): 'dropped-swap' | 'dropped-restore' | 'none' | 'own' {
  const j = readJournalLoose(dbPath);
  if (j && isOwnJournal(j, markId, attempt)) return 'own';
  let result: 'dropped-swap' | 'dropped-restore' | 'none' = 'none';
  if (fs.existsSync(restorePath(dbPath))) {
    fs.rmSync(restorePath(dbPath), { force: true });
    result = 'dropped-restore';
  }
  fs.rmSync(`${restorePath(dbPath)}.tmp`, { force: true });
  if (j) {
    fs.rmSync(journalPath(dbPath), { force: true });
    if (result === 'none') result = 'dropped-swap';
  }
  fs.rmSync(`${journalPath(dbPath)}.tmp`, { force: true });
  // Journal gone: the payload is debris whichever kind was pending.
  dropOrphanIncoming(dbPath);
  return result;
}

/** `crashAt` exists for the crash tests: it runs after each named step. */
export function applyPendingSwap(
  dbPath: string,
  crashAt: (step: SwapStep) => void = () => undefined,
): 'none' | 'swapped' | 'abandoned' | 'restored' {
  if (fs.existsSync(restorePath(dbPath))) return applyRestore(dbPath, crashAt);
  if (!fs.existsSync(journalPath(dbPath))) {
    dropOrphanIncoming(dbPath);
    return 'none';
  }
  const j = JSON.parse(fs.readFileSync(journalPath(dbPath), 'utf8')) as Journal;
  const merged = mergedPath(dbPath);

  if (!j.merged) {
    // A crash injected inside the try is a crash, not a failed merge.
    let injected: { e: unknown } | null = null;
    try {
      // Fold the old WAL in first, so the archive is one standalone file.
      const old = new Database(dbPath);
      old.pragma('wal_checkpoint(TRUNCATE)');
      old.close();
      // A merged file counts only with the marker the merge transaction wrote
      // for this swap's snapshot; anything else is debris and goes.
      if (fs.existsSync(merged) && !hasMergeMarker(merged, j.sha256)) {
        for (const ext of ['', '-wal', '-shm']) fs.rmSync(`${merged}${ext}`, { force: true });
      }
      if (!fs.existsSync(merged)) {
        if (!fs.existsSync(incomingPath(dbPath))) throw new Error('swap: no snapshot to merge');
        // Merged where it lies, so a crash leaves either an untouched snapshot
        // or one carrying its marker; then a rename.
        if (!hasMergeMarker(incomingPath(dbPath), j.sha256)) {
          mergeLocalTables(incomingPath(dbPath), dbPath, j.masterDeviceId, j.sha256 ?? '', j.keepArchive === true);
        }
        fs.renameSync(incomingPath(dbPath), merged);
        try {
          crashAt('incoming-renamed');
        } catch (e) {
          injected = { e };
          throw e;
        }
      }
    } catch {
      if (injected) throw (injected as { e: unknown }).e;
      // Nothing has touched the old database, so it stays this device's data.
      // Retrying would fail the same way at every boot.
      // The outcome and the journal go first: a journal that outlives the
      // files would make the next boot merge into a file that isn't there.
      writeOutcome(dbPath, 'abandoned', j);
      crashAt('abandon-outcome');
      fs.rmSync(journalPath(dbPath), { force: true });
      crashAt('abandon-journal');
      dropOrphanIncoming(dbPath);
      crashAt('abandon-cleaned');
      return 'abandoned';
    }
    crashAt('committed');
    writeJournal(dbPath, { ...j, merged: true });
    crashAt('journaled');
    ensureSidecar(j);
    crashAt('merged');
  }
  // After a crash between the journal and the sidecar, before the archive moves.
  ensureSidecar(j);
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
  // The proof has done its job; later swaps must not meet it.
  if (fs.existsSync(dbPath)) dropMergeMarker(dbPath);
  writeOutcome(dbPath, 'swapped', j);
  crashAt('outcome');
  fs.rmSync(journalPath(dbPath), { force: true });
  return 'swapped';
}
