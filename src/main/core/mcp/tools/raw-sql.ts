/**
 * The "powerful" raw-SQL tool pair — query_sql + get_schema — bundled together
 * because they are only useful as a pair (the schema doc exists to help write
 * the SQL) and because query_sql needs an executor that the Query-only
 * buildBuiltinTools does not carry. Both MCP entry points (core/mcp/server.ts,
 * mcp/stdio-entry.ts) concat `...tools` into the shared registry.
 *
 * The tools take an injected executor: in the app it is the killable runner
 * process (core/mcp/sql-runner.ts), which owns its own SQLite handle; the
 * stdio sibling wraps its query-only corpus connection with
 * createInProcessSqlExecutor. The textual SELECT/WITH gate in runQuerySql is
 * the write guard on top of the connection's own query-only/readonly mode.
 */
import type BetterSqlite3 from 'better-sqlite3';

import type { McpTool } from '@shared/contracts';

import type { SqlExecutorHandle } from '../sql-runner';
import { getSchemaDescription, renderSchema } from './get-schema';
import {
  querySqlDescription,
  querySqlInputSchema,
  runQuerySql,
  type QuerySqlExecutor,
} from './query-sql';

/** In-process executor over a BORROWED connection (the caller owns and closes
 *  it): the stdio sibling, which has its own process and query-only connection.
 *  The app never uses it — main.ts passes the killable runner. */
export function createInProcessSqlExecutor(
  conn: BetterSqlite3.Database,
): SqlExecutorHandle {
  return {
    exec: async (sql) => runQuerySql(conn, sql),
    stop: async () => {},
  };
}

export function createRawSqlTools(exec: QuerySqlExecutor): {
  tools: McpTool[];
} {
  const tools: McpTool[] = [
    {
      name: 'query_sql',
      description: querySqlDescription,
      inputSchema: querySqlInputSchema,
      tier: 'powerful',
      call: async (args: Record<string, unknown>) =>
        exec(String((args as { sql?: unknown }).sql ?? '')),
    },
    {
      name: 'get_schema',
      description: getSchemaDescription,
      inputSchema: { type: 'object', properties: {} },
      tier: 'powerful',
      call: async () => renderSchema(),
    },
  ];
  return { tools };
}
