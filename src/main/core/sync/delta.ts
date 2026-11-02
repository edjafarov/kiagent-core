/** Builds and reads the delta a follower pulls (spec 7.3, 7.4 and 7.6): whole
 *  current rows above a two-part cursor, from one read transaction. Deletes
 *  come first, children before parents, then upserts parents first, so apply
 *  never trips a cascade or a natural-key constraint. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import type BetterSqlite3 from 'better-sqlite3';

import { COPIED_CORE_TABLES } from './tables';

export interface SyncCursor {
  seq: number;
  cursor: number;
}
export type DeltaResult =
  | {
      status: 'ok';
      target: SyncCursor;
      /** Where this answer actually started: `after`, or the lowest grant of
       *  the epochs the asker has not seen when that is lower (step 2). */
      from: SyncCursor;
      /** The epoch of the device that built it. */
      epoch: number;
      rows: number;
      bytes: number;
      sha256: string;
    }
  | { status: 'too-large' };

export type StageEntry =
  | { op: 'delete'; tbl: string; pk: string[] }
  | { op: 'upsert'; tbl: string; row: Record<string, unknown> };

export class SyncStageInvalid extends Error {
  constructor(why: string) {
    super(`invalid sync stage: ${why}`);
    this.name = 'SyncStageInvalid';
  }
}

interface Trailer {
  trailer: true;
  target: SyncCursor;
  epoch: number;
  rows: number;
  sha256: string;
}

/** A follower that last applied from an older epoch than this device's is
 *  served from the lowest grant of the epochs it has not seen: the new master's
 *  rows overwrite its own by key (spec 7.8). A follower already at this epoch
 *  is never rewound. */
function rewound(
  conn: BetterSqlite3.Database,
  after: SyncCursor,
  fromEpoch: number,
): { from: SyncCursor; epoch: number } {
  const epoch = (conn.prepare(`SELECT epoch FROM sync_state`).get() as { epoch: number }).epoch;
  if (fromEpoch >= epoch) return { from: after, epoch };
  const g = conn
    .prepare(
      `SELECT MIN(grant_seq) AS seq, MIN(grant_cursor) AS cursor FROM sync_epochs WHERE epoch > ?`,
    )
    .get(fromEpoch) as { seq: number | null; cursor: number | null };
  if (g.seq === null || g.cursor === null) return { from: after, epoch };
  return {
    from: { seq: Math.min(after.seq, g.seq), cursor: Math.min(after.cursor, g.cursor) },
    epoch,
  };
}

export function buildDelta(
  conn: BetterSqlite3.Database,
  asked: SyncCursor,
  fromEpoch: number,
  out: string,
  capBytes: number,
): DeltaResult {
  const fd = fs.openSync(out, 'w');
  let after = asked;
  let epoch = 0;
  const hash = createHash('sha256');
  let bytes = 0;
  let rows = 0;
  const write = (e: StageEntry): void => {
    const line = Buffer.from(`${JSON.stringify(e)}\n`);
    bytes += line.length;
    if (bytes > capBytes) throw new TooLarge();
    hash.update(line);
    fs.writeSync(fd, line);
    rows += 1;
  };

  try {
    const target = conn.transaction((): SyncCursor => {
      // Inside the read transaction, so the grant and the rows agree.
      ({ from: after, epoch } = rewound(conn, asked, fromEpoch));
      const tracked = conn
        .prepare(`SELECT tbl, pk FROM sync_rows WHERE cursor > ? ORDER BY cursor`)
        .all(after.cursor) as { tbl: string; pk: string }[];
      const keys = (tbl: string) =>
        tracked
          .filter((e) => e.tbl === tbl && COPIED_CORE_TABLES.includes(tbl))
          .map((e) => JSON.parse(e.pk) as string[]);
      const getDoc = conn.prepare(`SELECT * FROM documents WHERE id = ?`);
      const getAccount = conn.prepare(`SELECT * FROM accounts WHERE id = ?`);
      const docKeys = keys('documents');
      const accountKeys = keys('accounts');

      for (const pk of docKeys) {
        if (!getDoc.get(pk[0])) write({ op: 'delete', tbl: 'documents', pk });
      }
      for (const pk of accountKeys) {
        if (!getAccount.get(pk[0])) write({ op: 'delete', tbl: 'accounts', pk });
      }
      for (const pk of accountKeys) {
        const row = getAccount.get(pk[0]) as Record<string, unknown> | undefined;
        if (row) write({ op: 'upsert', tbl: 'accounts', row });
      }
      // A write above buffers nothing, so these iterators stream the rows.
      const fromSeq = conn
        .prepare(`SELECT * FROM documents WHERE seq > ? ORDER BY seq`)
        .iterate(after.seq) as IterableIterator<Record<string, unknown>>;
      for (const row of fromSeq) write({ op: 'upsert', tbl: 'documents', row });
      for (const pk of docKeys) {
        const row = getDoc.get(pk[0]) as Record<string, unknown> | undefined;
        if (row && (row.seq as number) <= after.seq) {
          write({ op: 'upsert', tbl: 'documents', row });
        }
      }

      const head = conn
        .prepare(
          `SELECT (SELECT max(seq) FROM documents) AS seq,
                  (SELECT max(cursor) FROM sync_rows) AS cursor`,
        )
        .get() as { seq: number | null; cursor: number | null };
      return {
        seq: Math.max(head.seq ?? 0, after.seq),
        cursor: Math.max(head.cursor ?? 0, after.cursor),
      };
    })();
    hash.update(JSON.stringify(target));
    hash.update(`epoch:${epoch}`);
    const sha256 = hash.digest('hex');
    const trailer: Trailer = { trailer: true, target, epoch, rows, sha256 };
    fs.writeSync(fd, `${JSON.stringify(trailer)}\n`);
    fs.closeSync(fd);
    return { status: 'ok', target, from: after, epoch, rows, bytes, sha256 };
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(out, { force: true });
    if (e instanceof TooLarge) return { status: 'too-large' };
    throw e;
  }
}

class TooLarge extends Error {}

/** Reads a stage by bytes, on \n only: JSON leaves U+2028 unescaped, and a
 *  line-reader would split on it. Bounded memory, because a stage can be 250 MB
 *  and parsed rows take several times that. */
function* lines(file: string): Generator<Buffer> {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let pending: Buffer[] = [];
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      let at = 0;
      for (;;) {
        const end = chunk.subarray(at, n).indexOf(10);
        if (end === -1) break;
        pending.push(chunk.subarray(at, at + end + 1));
        yield Buffer.concat(pending);
        pending = [];
        at += end + 1;
      }
      if (at < n) pending.push(Buffer.from(chunk.subarray(at, n)));
    }
    if (pending.length > 0) yield Buffer.concat(pending);
  } finally {
    fs.closeSync(fd);
  }
}

/** Checks the whole file before anything is written. */
export function validateStage(file: string): { target: SyncCursor; epoch: number; rows: number } {
  const hash = createHash('sha256');
  let last: Buffer | null = null;
  let count = 0;
  for (const line of lines(file)) {
    if (last) {
      hash.update(last);
      count += 1;
    }
    last = line;
  }
  if (!last || last[last.length - 1] !== 10) throw new SyncStageInvalid('truncated');
  let trailer: Trailer;
  try {
    trailer = JSON.parse(last.toString('utf8')) as Trailer;
  } catch {
    throw new SyncStageInvalid('no trailer');
  }
  if (!trailer || trailer.trailer !== true) throw new SyncStageInvalid('no trailer');
  hash.update(JSON.stringify(trailer.target));
  hash.update(`epoch:${trailer.epoch}`);
  if (hash.digest('hex') !== trailer.sha256) throw new SyncStageInvalid('checksum');
  if (count !== trailer.rows) throw new SyncStageInvalid('row count');
  if (!Number.isSafeInteger(trailer.epoch) || trailer.epoch < 0) throw new SyncStageInvalid('epoch');
  return { target: trailer.target, epoch: trailer.epoch, rows: count };
}

/** Yields a validated stage's entries one at a time. */
export function* stageEntries(file: string, rows: number): Generator<StageEntry> {
  let i = 0;
  for (const line of lines(file)) {
    if (i === rows) return;
    i += 1;
    yield JSON.parse(line.toString('utf8')) as StageEntry;
  }
}

export function readStage(file: string): {
  entries: StageEntry[];
  target: SyncCursor;
  epoch: number;
} {
  const { target, epoch, rows } = validateStage(file);
  return { entries: [...stageEntries(file, rows)], target, epoch };
}
