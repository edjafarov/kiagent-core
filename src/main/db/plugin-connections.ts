import { formatPluginSql, pluginIdentifier } from '@shared/plugin-sql';
import { openSqlite } from './sqlite-runtime';
import {
  createPluginAuthorizer,
  type PluginAuthorizerOptions,
} from './plugin-authorizer';

export interface PluginConnectionOptions extends PluginAuthorizerOptions {
  filename?: string;
}
export interface PluginConnection {
  exec(sql: string, params?: unknown[]): Promise<void>;
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<Row[]>;
  batch(
    steps: readonly {
      sql: string;
      params?: unknown[];
      mode?: 'exec' | 'query';
    }[],
  ): Promise<unknown[][]>;
  identifier(name: string): string;
  close(): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  schemaExec?(sql: string): Promise<void>;
}
function value(v: unknown): unknown {
  if (v === undefined || (typeof v === 'number' && !Number.isFinite(v)))
    throw new TypeError('unsupported SQLite parameter');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'bigint' ||
    v instanceof Uint8Array
  )
    return v;
  throw new TypeError('unsupported SQLite parameter');
}
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === 'bigint' &&
      v >= BigInt(Number.MIN_SAFE_INTEGER) &&
      v <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(v)
        : v,
    ]),
  );
}
function sqlFor(options: PluginConnectionOptions, sql: string): string {
  return formatPluginSql(options.pluginId, sql, [
    ...options.tables,
    ...(options.indexes ?? []),
    ...(options.views ?? []),
    ...(options.triggers ?? []),
  ]);
}
function rejectPrivateSchema(sql: string): void {
  const stripped = sql.replace(
    /^(?:\s|\/\*[\s\S]*?\*\/|--[^\r\n]*(?:\r\n|\n|$))+/g,
    '',
  );
  if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(stripped))
    throw Object.assign(new Error('transaction control is coordinator-owned'), {
      code: 'PLUGIN_SQL_TRANSACTION_CONTROL',
    });
  if (/^(?:CREATE|ALTER|DROP|REINDEX|VACUUM)\b/i.test(stripped))
    throw Object.assign(new Error('schema changes require host registration'), {
      code: 'PLUGIN_SQL_DDL_FORBIDDEN',
    });
  if (
    /\b(?:sqlite_master|sqlite_schema|pragma\s+database_list|attach\b|detach\b)/i.test(
      sql,
    )
  )
    throw Object.assign(
      new Error('SQLite schema and attachment access is prohibited'),
      { code: 'PLUGIN_SQL_UNAUTHORIZED' },
    );
}
export async function openPluginConnection(
  filename: string,
  options: PluginConnectionOptions,
): Promise<PluginConnection> {
  const db = openSqlite(filename);
  const authorizer = createPluginAuthorizer(options);
  let inTransaction = false;
  let closed = false;
  db.setAuthorizer?.(authorizer);
  const prepare = (sql: string) => {
    (authorizer as typeof authorizer & { reset?: () => void }).reset?.();
    rejectPrivateSchema(sql);
    return db.prepare(sqlFor(options, sql));
  };
  const control = (sql: string): void => {
    const set = (
      authorizer as typeof authorizer & {
        setPrivateTransaction: (v: boolean) => void;
      }
    ).setPrivateTransaction;
    set(true);
    try {
      db.exec(sql);
    } finally {
      set(false);
    }
  };
  return {
    exec: async (sql, params = []) => {
      const stmt = prepare(sql);
      stmt.run(...params.map(value));
    },
    query: async <Row>(sql: string, params = []) =>
      prepare(sql)
        .all(...params.map(value))
        .map(normalizeRow) as Row[],
    batch: async (steps) => {
      const nested = inTransaction;
      if (!nested) {
        control('BEGIN');
        inTransaction = true;
      }
      try {
        const out: unknown[][] = [];
        for (const step of steps) {
          const stmt = prepare(step.sql);
          out.push(
            step.mode === 'query'
              ? stmt.all(...(step.params ?? []).map(value)).map(normalizeRow)
              : [stmt.run(...(step.params ?? []).map(value))],
          );
        }
        if (!nested) {
          control('COMMIT');
          inTransaction = false;
        }
        return out;
      } catch (e) {
        if (!nested) {
          try {
            control('ROLLBACK');
            inTransaction = false;
          } catch {
            // Preserve the original batch error if rollback also fails.
          }
        }
        throw e;
      }
    },
    identifier: (name) => pluginIdentifier(options.pluginId, name),
    close: async () => {
      if (closed) return;
      closed = true;
      db.close();
    },
    begin: async () => {
      control('BEGIN');
      inTransaction = true;
    },
    commit: async () => {
      control('COMMIT');
      inTransaction = false;
    },
    rollback: async () => {
      control('ROLLBACK');
      inTransaction = false;
    },
    schemaExec: async (sql) => {
      if (inTransaction)
        throw Object.assign(
          new Error('schema changes require no active plugin transaction'),
          { code: 'PLUGIN_SQL_SCHEMA_IN_TRANSACTION' },
        );
      if (/\b(?:sqlite_master|sqlite_schema)\b/i.test(sql))
        throw Object.assign(new Error('schema metadata access is prohibited'), {
          code: 'PLUGIN_SQL_UNAUTHORIZED',
        });
      const formatted = sqlFor(options, sql);
      (
        authorizer as typeof authorizer & {
          setSchemaMode: (v: boolean) => void;
        }
      ).setSchemaMode(true);
      try {
        db.exec(formatted);
      } finally {
        (
          authorizer as typeof authorizer & {
            setSchemaMode: (v: boolean) => void;
          }
        ).setSchemaMode(false);
      }
    },
  };
}
