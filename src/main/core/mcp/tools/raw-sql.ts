/**
 * The "powerful" raw-SQL tool pair — query_sql + get_schema — bundled together
 * because they are only useful as a pair (the schema doc exists to help write
 * the SQL) and because query_sql needs a raw SQLite handle that the Query-only
 * buildBuiltinTools does not carry. Both MCP entry points (core/mcp/server.ts,
 * mcp/stdio-entry.ts) concat `...tools` into the shared registry.
 *
 * The tools take an executor: in the app it is the killable runner process
 * (core/mcp/sql-runner.ts), which owns the SQLite handle; the stdio sibling
 * and tests use createInProcessSqlExecutor. The in-process handle is opened
 * readonly for a driver-level write guard. A strict
 * readonly open can fail WAL recovery (SQLITE_CANTOPEN) when the -wal is dirty
 * and no writer is present, because a readonly connection cannot create the
 * -shm; in that case we fall back to the same read-write-but-treated-readonly
 * open openCorpusReadConnection uses (app-db.ts). On that fallback the textual
 * SELECT/WITH gate in runQuerySql remains the write guard. In practice a writer
 * (db worker / stdio store) always opens first, so the readonly path is taken.
 */
import Database from 'better-sqlite3';
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

function openReadHandle(dbPath: string): BetterSqlite3.Database {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? '';
    if (code === 'SQLITE_CANTOPEN') {
      // Readonly WAL recovery failed — reopen read-write (treated read-only by
      // convention; the textual gate still blocks non-SELECT).
      return new Database(dbPath, { fileMustExist: true });
    }
    throw err;
  }
}

/** In-process executor: the stdio sibling (its own process, over its own
 *  connection) and tests that inject one explicitly. The MCP server never
 *  builds one itself, and the app never uses it — main.ts passes the killable
 *  runner. A string source is opened lazily and owned (closed by stop()); a
 *  connection is borrowed. */
export function createInProcessSqlExecutor(
  source: string | BetterSqlite3.Database,
): SqlExecutorHandle {
  const owned = typeof source === 'string';
  let conn: BetterSqlite3.Database | null = owned ? null : source;
  return {
    exec: async (sql) => {
      if (!conn) conn = openReadHandle(source as string);
      return runQuerySql(conn, sql);
    },
    stop: async () => {
      if (owned && conn) {
        conn.close();
        conn = null;
      }
    },
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
