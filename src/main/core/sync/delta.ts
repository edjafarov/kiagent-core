/** Builds and reads the delta a follower pulls (spec 7.3, 7.4 and 7.6): whole
 *  current rows above a two-part cursor, from one read transaction. Deletes
 *  come first, children before parents, then upserts parents first, so apply
 *  never trips a cascade or a natural-key constraint. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import type BetterSqlite3 from 'better-sqlite3';

import { copiedTables, primaryKeyColumns } from './tables';

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
  | { op: 'delete'; tbl: string; pk: unknown[] }
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
    if (e.op === 'upsert') e = { ...e, row: encodeRow(e.row) };
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
      const tables = copiedTables(conn);
      const keys = (tbl: string) =>
        tracked.filter((e) => e.tbl === tbl).map((e) => JSON.parse(e.pk) as unknown[]);
      const getters = new Map<string, BetterSqlite3.Statement>();
      const getRow = (tbl: string, pk: unknown[]): Record<string, unknown> | undefined => {
        let stmt = getters.get(tbl);
        if (!stmt) {
          const cols = primaryKeyColumns(conn, tbl);
          stmt = conn.prepare(
            `SELECT * FROM "${tbl}" WHERE ${cols.map((c) => `"${c}" = ?`).join(' AND ')}`,
          );
          getters.set(tbl, stmt);
        }
        return stmt.get(...pk) as Record<string, unknown> | undefined;
      };

      // Children first: the list is parents-first, so walk it backwards.
      for (const tbl of [...tables].reverse()) {
        for (const pk of keys(tbl)) {
          if (!getRow(tbl, pk)) write({ op: 'delete', tbl, pk });
        }
      }
      for (const tbl of tables) {
        if (tbl === 'documents') {
          // A write above buffers nothing, so these iterators stream the rows.
          const fromSeq = conn
            .prepare(`SELECT * FROM documents WHERE seq > ? ORDER BY seq`)
            .iterate(after.seq) as IterableIterator<Record<string, unknown>>;
          for (const row of fromSeq) write({ op: 'upsert', tbl, row });
          for (const pk of keys(tbl)) {
            const row = getRow(tbl, pk);
            if (row && (row.seq as number) <= after.seq) write({ op: 'upsert', tbl, row });
          }
          continue;
        }
        const sent = new Set<string>();
        for (const pk of keys(tbl)) {
          const row = getRow(tbl, pk);
          if (row) write({ op: 'upsert', tbl, row });
          sent.add(JSON.stringify(pk));
        }
        if (tbl === 'sync_epochs') {
          // The grant ledger travels whole above the asker's epoch. A device
          // that only applied an interim leader's grant never tracked it, and
          // a returning leader restamps its unseen rows from the lowest grant
          // above the epoch it last led in.
          const grants = conn
            .prepare(`SELECT * FROM sync_epochs WHERE epoch > ? ORDER BY epoch`)
            .all(fromEpoch) as Record<string, unknown>[];
          for (const row of grants) {
            if (!sent.has(JSON.stringify([row.epoch]))) write({ op: 'upsert', tbl, row });
          }
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

/** A BLOB column crosses the stage as `{"$b64": ...}`; JSON would turn a Buffer
 *  into an array of numbers that SQLite can't bind. */
function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(row)) {
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      out ??= { ...row };
      out[k] = { $b64: Buffer.from(v).toString('base64') };
    }
  }
  return out ?? row;
}

const isBlob = (v: unknown): v is { $b64: string } =>
  !!v && typeof v === 'object' && typeof (v as { $b64?: unknown }).$b64 === 'string';

function decodeEntry(e: StageEntry): StageEntry {
  if (e.op !== 'upsert') return e;
  for (const [k, v] of Object.entries(e.row)) {
    if (isBlob(v)) e.row[k] = Buffer.from(v.$b64, 'base64');
  }
  return e;
}

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
    yield decodeEntry(JSON.parse(line.toString('utf8')) as StageEntry);
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
