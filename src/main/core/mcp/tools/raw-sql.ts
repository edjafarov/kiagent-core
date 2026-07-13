/**
 * The "powerful" raw-SQL tool pair — query_sql + get_schema — bundled together
 * because they are only useful as a pair (the schema doc exists to help write
 * the SQL) and because query_sql needs a raw SQLite handle that the Query-only
 * buildBuiltinTools does not carry. Both MCP entry points (core/mcp/server.ts,
 * mcp/stdio-entry.ts) concat `...tools` into the shared registry and call
 * `dispose()` on teardown.
 *
 * The handle is opened readonly for a driver-level write guard. A strict
 * readonly open can fail WAL recovery (SQLITE_CANTOPEN) when the -wal is dirty
 * and no writer is present, because a readonly connection cannot create the
 * -shm; in that case we fall back to the same read-write-but-treated-readonly
 * open openCorpusReadConnection uses (app-db.ts). On that fallback the textual
 * SELECT/WITH gate in runQuerySql remains the write guard. In practice a writer
 * (db worker / stdio store) always opens first, so the readonly path is taken.
 */
import Database from 'better-sqlite3';

import type { McpTool } from '@shared/contracts';

import { getSchemaDescription, renderSchema } from './get-schema';
import {
  querySqlDescription,
  querySqlInputSchema,
  runQuerySql,
} from './query-sql';

function openReadHandle(dbPath: string): Database.Database {
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

export function createRawSqlTools(dbPath: string): {
  tools: McpTool[];
  dispose: () => Promise<void>;
} {
  const conn = openReadHandle(dbPath);

  const tools: McpTool[] = [
    {
      name: 'query_sql',
      description: querySqlDescription,
      inputSchema: querySqlInputSchema,
      tier: 'powerful',
      call: async (args: Record<string, unknown>) =>
        runQuerySql(conn, String((args as { sql?: unknown }).sql ?? '')),
    },
    {
      name: 'get_schema',
      description: getSchemaDescription,
      inputSchema: { type: 'object', properties: {} },
      tier: 'powerful',
      call: async () => renderSchema(),
    },
  ];

  return {
    tools,
    dispose: async () => {
      conn.close();
    },
  };
}
