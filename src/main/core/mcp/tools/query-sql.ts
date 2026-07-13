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

export const querySqlDescription = `Run a read-only SELECT or WITH query against the digital-memory database. Capped at 500 rows — add your own LIMIT/ORDER BY when order matters. Use when search/count/get_related aren't expressive enough: joins, custom aggregations, time bucketing, grouping. Call \`get_schema\` FIRST for table/column names and how the tables relate — notably a document's source lives on \`accounts.source\`, reached by joining \`documents.account_id = accounts.id\` (there is no source column on documents). The connection is read-only; writes fail at the driver.`;

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
}

const MAX_ROWS = 500;

export function runQuerySql(
  conn: BetterSqlite3.Database,
  sql: string,
): QuerySqlResult {
  const stripped = sql
    .replace(/^\s+/, '')
    .replace(/^(--[^\n]*\n)+/, '') // drop ALL leading -- comment lines
    .trimStart();
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error('query_sql: only SELECT / WITH statements are allowed');
  }
  const rows = conn
    .prepare(`SELECT * FROM (${stripped}) LIMIT ${MAX_ROWS + 1}`)
    .all() as Record<string, unknown>[];
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}
