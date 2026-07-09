import fs from 'node:fs';
import Database from 'better-sqlite3';
import { migrate } from '@main/core/store/schema';

export type AppDbParam =
  | string
  | number
  | bigint
  | boolean
  | Buffer
  | Date
  | null;

/** A literal SQL parameter, or a reference to a column of an earlier batch
 *  step's first result row (`{ $fromStep: 0, column: 'id' }`) — how a
 *  RETURNING id feeds dependent writes inside one atomic batch. */
export type BatchParam = AppDbParam | { $fromStep: number; column: string };

export interface BatchStep {
  sql: string;
  params?: BatchParam[];
}

export interface BatchStepResult {
  /** First result row for reader statements (SELECT / … RETURNING), else null. */
  row: Record<string, unknown> | null;
  /** Rows written for non-reader statements; 0 for reader statements. */
  changes: number;
}

export interface AppDb {
  exec(sql: string): Promise<void>;
  all(sql: string, params?: AppDbParam[]): Promise<Record<string, unknown>[]>;
  run(sql: string, params?: AppDbParam[]): Promise<void>;
  /** Runs all steps inside ONE SQLite transaction (all-or-nothing). The only
   *  multi-statement atomicity primitive — `_conn.transaction()` must not be
   *  used by callers, so the same code works against the worker-hosted DB. */
  batch(steps: BatchStep[]): Promise<BatchStepResult[]>;
  isOpen(): boolean;
  close(): Promise<void>;
  /** Raw better-sqlite3 handle — present only on the in-process implementation
   *  (tests, the stdio MCP server, the DB worker host). Production main-process
   *  code must not touch it: the worker-backed AppDb has none. */
  readonly _conn?: Database.Database;
}

function coerceParam(v: AppDbParam): string | number | bigint | Buffer | null {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// JS strings are UTF-16 and tolerate unpaired surrogates; a lone surrogate
// cannot be encoded to UTF-8, so it must be stripped before it reaches SQLite.
// Old emails occasionally arrive with a header value (subject, from) containing
// a lone high or low surrogate. We strip lone surrogates from every string
// *before* JSON.stringify, via a replacer. Paired surrogates (proper emoji)
// don't match either alternation and survive untouched.
// eslint-disable-next-line no-misleading-character-class
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function safeJsonStringify(v: unknown): string {
  return JSON.stringify(v, (_key, value) =>
    typeof value === 'string' ? value.replace(LONE_SURROGATE, '�') : value,
  );
}

function resolveBatchParam(
  p: BatchParam,
  results: BatchStepResult[],
): ReturnType<typeof coerceParam> {
  if (
    p !== null &&
    typeof p === 'object' &&
    !(p instanceof Date) &&
    !Buffer.isBuffer(p) &&
    '$fromStep' in p
  ) {
    const src = results[p.$fromStep];
    if (!src?.row || !(p.column in src.row)) {
      throw new Error(
        `batch: $fromStep ${p.$fromStep} has no result column '${p.column}'`,
      );
    }
    return src.row[p.column] as ReturnType<typeof coerceParam>;
  }
  return coerceParam(p);
}

function wrapConn(conn: Database.Database): AppDb {
  // Statements compile on every prepare(); the hot upsert path runs the same
  // handful of SQL strings ~200k times per backfill, so cache by SQL text.
  // The cap guards against unbounded dynamic SQL (saveSyncState builds its
  // UPSERT column list at runtime) — on overflow just start over.
  const stmtCache = new Map<string, Database.Statement>();
  const prep = (sql: string): Database.Statement => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = conn.prepare(sql);
      if (stmtCache.size >= 512) stmtCache.clear();
      stmtCache.set(sql, stmt);
    }
    return stmt;
  };

  const runBatch = conn.transaction((steps: BatchStep[]): BatchStepResult[] => {
    const results: BatchStepResult[] = [];
    for (const step of steps) {
      const stmt = prep(step.sql);
      const params = (step.params ?? []).map((p) =>
        resolveBatchParam(p, results),
      );
      if (stmt.reader) {
        const row =
          (stmt.get(...params) as Record<string, unknown> | undefined) ?? null;
        results.push({ row, changes: 0 });
      } else {
        const info = stmt.run(...params);
        results.push({ row: null, changes: Number(info.changes) });
      }
    }
    return results;
  });

  return {
    _conn: conn,
    exec: async (sql) => {
      conn.exec(sql);
    },
    all: async (sql, params = []) =>
      prep(sql).all(...params.map(coerceParam)) as Record<string, unknown>[],
    run: async (sql, params = []) => {
      prep(sql).run(...params.map(coerceParam));
    },
    batch: async (steps) => runBatch(steps),
    isOpen: () => conn.open,
    close: async () => {
      conn.close();
    },
  };
}

export async function openDb(filePath: string): Promise<AppDb> {
  const conn = new Database(filePath);
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('busy_timeout = 5000');
  conn.defaultSafeIntegers(true);

  // Apply core's schema on the raw handle — identical DDL to `openStore`.
  // `migrate` is a versioned, transactional, raw-handle routine (it sets
  // `foreign_keys = ON`, tracks `meta.schemaVersion`, and reads via prepared
  // statements) so it cannot cleanly route through the async AppDb surface;
  // running it directly on `conn` is idempotent and keeps both the in-process
  // and (future) worker-hosted paths byte-identical.
  migrate(conn);

  return wrapConn(conn);
}

/**
 * Open the corpus for a SECONDARY process (the stdio MCP server) that only
 * ever reads. Deliberately:
 *  - does NOT run migrations — the GUI app owns the schema;
 *  - does NOT set journal_mode — the file is already WAL from the GUI app;
 *  - opens read-WRITE (not `readonly:true`) so SQLite can recover/checkpoint a
 *    dirty `-wal` when the GUI app is closed (a strict readonly open fails on
 *    WAL recovery). Treated as read-only by convention: callers issue only
 *    SELECT, and query_sql keeps its own readonly handle.
 * Concurrent with a running GUI app this is just a second WAL reader, which
 * SQLite supports.
 */
export async function openCorpusReadConnection(
  filePath: string,
): Promise<AppDb> {
  // Fail fast (and deterministically) if the GUI app never created the corpus.
  // better-sqlite3's `fileMustExist` raises at open, but an explicit check
  // gives a clearer message for the stdio entry's stderr and is not subject to
  // driver-state quirks.
  if (!fs.existsSync(filePath)) {
    throw new Error(`corpus database not found: ${filePath}`);
  }
  const conn = new Database(filePath, { fileMustExist: true });
  conn.pragma('busy_timeout = 5000');
  conn.defaultSafeIntegers(true);
  return wrapConn(conn);
}
