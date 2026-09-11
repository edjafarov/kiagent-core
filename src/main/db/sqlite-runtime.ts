export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  setAuthorizer?(fn: (...args: unknown[]) => number): void;
  enableDefensive?(enabled?: boolean): void;
}
export interface SqliteStatement { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): { changes: number; lastInsertRowid?: bigint | number }; get(...params: unknown[]): Record<string, unknown> | undefined; }

export function openSqlite(path: string): SqliteDatabase {
  let sqlite: { DatabaseSync?: new (file: string, options?: Record<string, unknown>) => SqliteDatabase };
  try {
    // node:sqlite is intentionally loaded at runtime: the TypeScript floor is
    // Node 22 while the Electron compatibility gate supplies Node 24.
    // eslint-disable-next-line no-eval
    const runtimeRequire = eval('require') as NodeRequire;
    sqlite = runtimeRequire('node:sqlite') as typeof sqlite;
  } catch (cause) {
    throw Object.assign(new Error('node:sqlite is required for plugin database handles'), { code: 'PLUGIN_SQLITE_UNSUPPORTED', cause });
  }
  if (!sqlite.DatabaseSync) throw Object.assign(new Error('DatabaseSync is unavailable'), { code: 'PLUGIN_SQLITE_UNSUPPORTED' });
  const db = new sqlite.DatabaseSync(path, { readBigInts: true });
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.enableDefensive?.(true);
  return db;
}
