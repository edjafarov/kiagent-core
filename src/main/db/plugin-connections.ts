import { formatPluginSql, pluginIdentifier } from '@shared/plugin-sql';
import { openSqlite, type SqliteDatabase } from './sqlite-runtime';
import { createPluginAuthorizer, type PluginAuthorizerOptions } from './plugin-authorizer';

export interface PluginConnectionOptions extends PluginAuthorizerOptions { filename?: string; }
export interface PluginConnection {
  exec(sql: string, params?: unknown[]): Promise<void>;
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
  batch(steps: readonly { sql: string; params?: unknown[]; mode?: 'exec' | 'query' }[]): Promise<unknown[][]>;
  identifier(name: string): string;
  close(): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}
function value(v: unknown): unknown {
  if (v === undefined || (typeof v === 'number' && !Number.isFinite(v))) throw new TypeError('unsupported SQLite parameter');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || v instanceof Uint8Array) return v;
  throw new TypeError('unsupported SQLite parameter');
}
function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [
    k,
    typeof v === 'bigint' && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v,
  ]));
}
function sqlFor(options: PluginConnectionOptions, sql: string): string { return formatPluginSql(options.pluginId, sql, [...options.tables, ...(options.views ?? []), ...(options.triggers ?? [])]); }
function rejectPrivateSchema(sql: string): void {
  if (/^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)) throw Object.assign(new Error('transaction control is coordinator-owned'), { code: 'PLUGIN_SQL_TRANSACTION_CONTROL' });
  if (/\b(?:sqlite_master|sqlite_schema|pragma\s+database_list|attach\b|detach\b)/i.test(sql)) throw Object.assign(new Error('SQLite schema and attachment access is prohibited'), { code: 'PLUGIN_SQL_UNAUTHORIZED' });
}
export async function openPluginConnection(filename: string, options: PluginConnectionOptions): Promise<PluginConnection> {
  const db = openSqlite(filename);
  db.setAuthorizer?.(createPluginAuthorizer(options));
  const prepare = (sql: string) => { rejectPrivateSchema(sql); return db.prepare(sqlFor(options, sql)); };
  return {
    exec: async (sql, params = []) => { const stmt = prepare(sql); stmt.run(...params.map(value)); },
    query: async <Row>(sql: string, params = []) => prepare(sql).all(...params.map(value)).map(normalizeRow) as Row[],
    batch: async (steps) => { db.exec('BEGIN'); try { const out: unknown[][] = []; for (const step of steps) { const stmt = prepare(step.sql); out.push(step.mode === 'query' ? stmt.all(...(step.params ?? []).map(value)).map(normalizeRow) : [stmt.run(...(step.params ?? []).map(value))]); } db.exec('COMMIT'); return out; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; } },
    identifier: (name) => pluginIdentifier(options.pluginId, name),
    close: async () => db.close(),
    begin: async () => db.exec('BEGIN'),
    commit: async () => db.exec('COMMIT'),
    rollback: async () => db.exec('ROLLBACK'),
  };
}
