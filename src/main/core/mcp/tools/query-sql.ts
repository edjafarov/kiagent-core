/**
 * `query_sql` — the read-only raw-SQL escape hatch. A straight port of
 * kiagent-ref's tools/query-sql.ts, minus the bigint dance (greenfield ids are
 * TEXT and the store is number-native, so integer columns come back as JS
 * numbers). Two independent write guards, both retained:
 *   1. textual — the statement must start with SELECT/WITH after leading
 *      whitespace and `--` comment lines are stripped;
 *   2. driver — raw-sql.ts opens the handle readonly, so a write fails at
 *      better-sqlite3 even if the textual check is bypassed.
 * The query is wrapped as `SELECT * FROM (<sql>) LIMIT 501` so the cap applies
 * uniformly and anything that is not a valid SELECT subquery (e.g. a
 * `WITH … INSERT`) fails to parse rather than executing.
 */
import type BetterSqlite3 from 'better-sqlite3';

export const querySqlDescription = `Run a read-only SELECT or WITH query against the digital-memory database. Capped at 500 rows — add your own LIMIT/ORDER BY when order matters. Use when search/count/get_related aren't expressive enough: joins, custom aggregations, time bucketing, grouping. Call \`get_schema\` FIRST for table/column names and how the tables relate — notably a document's source lives on \`accounts.source\`, reached by joining \`documents.account_id = accounts.id\` (there is no source column on documents). Canonical starting point: \`SELECT d.id, d.title, d.created_at, d.url, a.source FROM documents d JOIN accounts a ON a.id = d.account_id WHERE d.archived_at IS NULL\` — keep \`d.url\` in the projection. Every document has a url — when presenting documents to the user, link each one, not just the first; if url is empty or non-http, cite by title and date. The connection is read-only; writes fail at the driver.`;

export const querySqlInputSchema = {
  type: 'object',
  properties: {
    sql: {
      type: 'string',
      description: 'A single read-only SELECT or WITH statement.',
    },
  },
  required: ['sql'],
} as const;

export interface QuerySqlResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
  hint?: string;
}

/** What the MCP tool (and the runner process) executes SQL with. */
export type QuerySqlExecutor = (sql: string) => Promise<QuerySqlResult>;

export const MAX_ROWS = 500;
/** One string value is cut at this many UTF-8 BYTES (never inside a code
 *  point), with TRUNCATED_MARK appended. */
export const MAX_VALUE_BYTES = 64 * 1024;
/** The serialized rows array (JSON, brackets and commas included) is cut here,
 *  so a result is bounded in BYTES as it is transferred. */
export const MAX_RESULT_BYTES = 1024 * 1024;
const TRUNCATED_MARK = '…[truncated]';

function cutValue(v: unknown): { value: unknown; cut: boolean } {
  // A UTF-16 unit is at most 3 UTF-8 bytes (a surrogate pair is 4 bytes for 2
  // units), so short strings need no byte count at all.
  if (typeof v === 'string' && v.length * 3 > MAX_VALUE_BYTES) {
    const buf = Buffer.from(v, 'utf8');
    if (buf.length > MAX_VALUE_BYTES) {
      let end = MAX_VALUE_BYTES;
      // Back up to a code-point boundary: byte `end` must not be a continuation byte.
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
      return {
        value: `${buf.toString('utf8', 0, end)}${TRUNCATED_MARK}`,
        cut: true,
      };
    }
    return { value: v, cut: false };
  }
  if (Buffer.isBuffer(v))
    return { value: `<blob ${v.length} bytes>`, cut: false };
  return { value: v, cut: false };
}

/** Same gates as before (textual SELECT/WITH + the driver's own guard), but the
 *  rows are materialized INCREMENTALLY with `.iterate()` and the result is
 *  bounded by rows, by bytes and per value — in the process that owns the
 *  connection, before anything is transferred. */
export function runQuerySqlBounded(
  conn: BetterSqlite3.Database,
  sql: string,
): { result: QuerySqlResult; bytes: number } {
  const stripped = sql
    .replace(/^\s+/, '')
    .replace(/^(--[^\n]*\n)+/, '') // drop ALL leading -- comment lines
    .trimStart();
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error('query_sql: only SELECT / WITH statements are allowed');
  }
  const stmt = conn.prepare(
    `SELECT * FROM (${stripped}) LIMIT ${MAX_ROWS + 1}`,
  );
  const rows: Record<string, unknown>[] = [];
  // Serialized size of the rows array as it will be transferred: '[' + ']'
  // plus a ',' between rows plus each row's own JSON.
  let bytes = 2;
  let rowCut = false;
  let byteCut = false;
  let valueCut = false;
  for (const raw of stmt.iterate() as IterableIterator<
    Record<string, unknown>
  >) {
    if (rows.length >= MAX_ROWS) {
      rowCut = true;
      break;
    }
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      const c = cutValue(v);
      row[k] = c.value;
      if (c.cut) valueCut = true;
    }
    const size =
      Buffer.byteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0);
    if (bytes + size > MAX_RESULT_BYTES) {
      byteCut = true;
      break; // leaving the loop resets the statement
    }
    rows.push(row);
    bytes += size;
  }
  const first = rows[0];
  const hints: string[] = [];
  if (
    first &&
    ('id' in first || 'doc_id' in first) &&
    !('url' in first) &&
    !('source_url' in first)
  ) {
    hints.push(
      'these rows look like documents — include d.url in the SELECT so each one can be cited/linked when presented.',
    );
  }
  if (rowCut) {
    hints.push(
      `result cut at ${MAX_ROWS} rows — add a LIMIT/OFFSET or narrow the WHERE.`,
    );
  }
  if (byteCut) {
    hints.push(
      rows.length === 0
        ? 'a single row exceeds 1 MiB — select fewer or shorter columns.'
        : 'result cut at 1 MiB of row data — select fewer or shorter columns, or add a LIMIT.',
    );
  }
  if (valueCut) {
    hints.push(
      'long text values were cut at 64 KiB (UTF-8 bytes) — use substr() to read a part.',
    );
  }
  return {
    result: {
      rows,
      truncated: rowCut || byteCut || valueCut,
      hint: hints.length ? hints.join(' ') : undefined,
    },
    bytes,
  };
}

export function runQuerySql(
  conn: BetterSqlite3.Database,
  sql: string,
): QuerySqlResult {
  return runQuerySqlBounded(conn, sql).result;
}
