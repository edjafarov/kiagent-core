import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { formatPluginSql } from '@shared/plugin-sql';
import type { PluginDatabaseDescriptor } from '@main/platform/database-descriptor';
import {
  descriptorDigest,
  type PluginImportProgress,
  type PluginRegistry,
} from './plugin-registry';
import { createPluginAuthorizer } from './plugin-authorizer';
import { openSqlite, type SqliteDatabase } from './sqlite-runtime';

export type { PluginImportProgress } from './plugin-registry';

export interface LegacyImportOptions {
  chunkSize?: number;
  afterChunk?: (progress: PluginImportProgress) => void | Promise<void>;
  /** Test-owned seam immediately before an unpublished snapshot is renamed. */
  beforeSnapshotPublish?: (
    temporaryPath: string,
    snapshotPath: string,
  ) => void | Promise<void>;
  /** Admit one bounded write at a time so core work can run between chunks. */
  admit?: <T>(work: () => T | Promise<T>) => Promise<T>;
}

export interface LegacyImportInput {
  pluginId: string;
  descriptor: PluginDatabaseDescriptor;
  legacyPath: string;
  afterChunk?: LegacyImportOptions['afterChunk'];
}

const MAX_CHUNK_SIZE = 500;
const NAME = /^[a-z][a-z0-9_]*$/;

function fail(message: string, code: string): never {
  throw Object.assign(new Error(message), { code });
}

function quote(name: string): string {
  if (!NAME.test(name) && name !== HIDDEN_ROWID)
    fail(
      `invalid legacy identifier ${name}`,
      'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
    );
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteInternal(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function physicalQuote(
  registry: PluginRegistry,
  pluginId: string,
  name: string,
): string {
  return `"${registry.physicalName(pluginId, name).replaceAll('"', '""')}"`;
}

function stable(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return `bigint:${value.toString()}`;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return `blob:${Buffer.from(value).toString('base64')}`;
  if (typeof value === 'number')
    return Number.isInteger(value)
      ? `integer:${BigInt(value).toString()}`
      : `real:${value}`;
  if (typeof value === 'string') return `text:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `boolean:${value ? 1 : 0}`;
  return `other:${JSON.stringify(value)}`;
}

function digestRows(rows: readonly Record<string, unknown>[]): string {
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    for (const [key, value] of Object.entries(row))
      hash.update(`${key.length}:${key}:${stable(value)};`);
    hash.update('\n');
  }
  return hash.digest('hex');
}

function extendDigest(
  previous: string | null,
  rows: readonly Record<string, unknown>[],
): string {
  return crypto
    .createHash('sha256')
    .update(`${previous ?? ''}:${digestRows(rows)}`)
    .digest('hex');
}

function sourceIdentity(filename: string): string {
  const hash = crypto.createHash('sha256');
  for (const file of [filename, `${filename}-wal`]) {
    try {
      const stat = fs.statSync(file);
      hash.update(
        `${file}|${stat.dev}|${stat.ino}|${stat.size}|${stat.mtimeMs}|`,
      );
      const fd = fs.openSync(file, 'r');
      try {
        const window = 64 * 1024;
        const length = Math.min(window, stat.size);
        const head = Buffer.alloc(length);
        fs.readSync(fd, head, 0, length, 0);
        hash.update(head);
        if (stat.size > length) {
          const tail = Buffer.alloc(length);
          fs.readSync(fd, tail, 0, length, stat.size - length);
          hash.update(tail);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        hash.update(`${file}|absent|`);
        continue;
      }
      fail(
        `unable to read legacy source identity ${file}`,
        'PLUGIN_DB_IMPORT_SOURCE_UNAVAILABLE',
      );
    }
  }
  return hash.digest('hex');
}

function snapshotPathFor(
  legacyPath: string,
  pluginId: string,
  identity: string,
): string {
  const suffix = crypto
    .createHash('sha256')
    .update(`${pluginId}:${identity}`)
    .digest('hex')
    .slice(0, 16);
  return path.join(
    path.dirname(legacyPath),
    `.kiagent-${suffix}-legacy-snapshot.sqlite`,
  );
}

async function createFixedSnapshot(
  legacyPath: string,
  snapshotPath: string,
  beforePublish?: LegacyImportOptions['beforeSnapshotPublish'],
): Promise<void> {
  const validate = (filename: string): void => {
    let check: Database.Database | undefined;
    try {
      check = new Database(filename, { fileMustExist: true, readonly: true });
      const result = check.pragma('quick_check', { simple: true });
      if (String(result).toLowerCase() !== 'ok')
        throw new Error('quick_check failed');
    } catch (cause) {
      fail(
        `legacy snapshot is incomplete or corrupt: ${String(cause)}`,
        'PLUGIN_DB_IMPORT_SNAPSHOT_INVALID',
      );
    } finally {
      check?.close();
    }
  };
  if (fs.existsSync(snapshotPath)) {
    validate(snapshotPath);
    return;
  }
  const source = new Database(legacyPath, {
    fileMustExist: true,
    readonly: true,
  });
  const temporary = `${snapshotPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.partial`;
  try {
    await source.backup(temporary);
    validate(temporary);
    const fd = fs.openSync(temporary, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    await beforePublish?.(temporary, snapshotPath);
    fs.renameSync(temporary, snapshotPath);
    const dir = fs.openSync(path.dirname(snapshotPath), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } catch (cause) {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    if (
      (cause as { code?: string }).code === 'PLUGIN_DB_IMPORT_SNAPSHOT_INVALID'
    )
      throw cause;
    fail(
      `unable to publish legacy snapshot: ${String(cause)}`,
      'PLUGIN_DB_IMPORT_SNAPSHOT_INVALID',
    );
  } finally {
    source.close();
  }
}

function tableInfo(
  db: Database.Database,
  table: string,
): {
  columns: string[];
  primaryKey: string[];
  withoutRowid: boolean;
  rowidAlias?: string;
} {
  const rows = db.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{
    name: string;
    pk: number;
  }>;
  if (!rows.length)
    fail(
      `legacy table ${table} is missing`,
      'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
    );
  let withoutRowid = false;
  try {
    const list = db
      .prepare(`PRAGMA table_list(${quote(table)})`)
      .all() as Array<{ wr?: number }>;
    withoutRowid = Number(list[0]?.wr ?? 0) === 1;
  } catch {
    /* supported SQLite in production exposes table_list */
  }
  const columns = rows.map((row) => row.name);
  const primaryKey = rows
    .filter((row) => Number(row.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((row) => row.name);
  const rowidAlias = withoutRowid
    ? undefined
    : ['rowid', '_rowid_', 'oid'].find(
        (alias) => !columns.some((column) => column.toLowerCase() === alias),
      );
  if (!withoutRowid && !primaryKey.length && !rowidAlias)
    fail(
      `legacy table ${table} shadows every SQLite rowid alias and has no primary key`,
      'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
    );
  return { columns, primaryKey, withoutRowid, rowidAlias };
}

function encodeKey(values: unknown[]): string {
  return JSON.stringify(
    values.map((value) => {
      if (typeof value === 'bigint')
        return { type: 'bigint', value: value.toString() };
      if (Buffer.isBuffer(value) || value instanceof Uint8Array)
        return { type: 'blob', value: Buffer.from(value).toString('base64') };
      return { type: typeof value, value };
    }),
  );
}

function rowKey(
  row: Record<string, unknown>,
  columns: string[],
  rowidAlias = HIDDEN_ROWID,
): string {
  return encodeKey(
    columns.map((column) =>
      column === HIDDEN_ROWID ? row[rowidAlias] : row[column],
    ),
  );
}

function digestRow(
  row: Record<string, unknown>,
  columns: string[],
  rowid: unknown,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(columns.map((column) => [column, row[column]])),
    ...(rowid === undefined ? {} : { __kiagent_rowid: rowid }),
  };
}

const HIDDEN_ROWID = '__kiagent_rowid';

function rowidProjectionAlias(columns: string[]): string {
  const names = new Set(columns.map((column) => column.toLowerCase()));
  let suffix = 0;
  let alias = `${HIDDEN_ROWID}_${suffix}`;
  while (names.has(alias.toLowerCase())) {
    suffix += 1;
    alias = `${HIDDEN_ROWID}_${suffix}`;
  }
  return alias;
}

function decodeKey(value: string | null): unknown[] {
  if (!value) return [];
  return (JSON.parse(value) as Array<{ type: string; value: unknown }>).map(
    (item) =>
      item.type === 'bigint'
        ? BigInt(String(item.value))
        : item.type === 'blob'
          ? Buffer.from(String(item.value), 'base64')
          : item.value,
  );
}

function keyPredicate(
  columns: string[],
  cursor: unknown[],
): { sql: string; params: unknown[] } {
  if (!cursor.length) return { sql: '', params: [] };
  const terms: string[] = [];
  const params: unknown[] = [];
  for (let i = 0; i < columns.length; i++) {
    const equal = columns
      .slice(0, i)
      .map((column) => `${quote(column)} = ?`)
      .join(' AND ');
    terms.push(`(${equal ? `${equal} AND ` : ''}${quote(columns[i])} > ?)`);
    params.push(...cursor.slice(0, i + 1));
  }
  return { sql: `WHERE ${terms.join(' OR ')}`, params };
}

function sourceHasTable(db: Database.Database, tableName: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
}

function validateLegacySchema(
  db: Database.Database,
  descriptor: PluginDatabaseDescriptor,
  sourceVersions: ReadonlyMap<string, number>,
): void {
  const expected = reconstructHistoricalTables(descriptor, sourceVersions);
  const known = new Set([
    ...descriptor.objects.map((object) => object.name),
    ...descriptor.legacy.tables.map((table) => table.name),
  ]);
  const objects = db
    .prepare(
      `SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`,
    )
    .all() as Array<{ name: string; type: string }>;
  for (const object of objects)
    if (!known.has(object.name))
      fail(
        `unknown legacy ${object.type} ${object.name}`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
  for (const table of descriptor.legacy.tables) {
    if (!sourceHasTable(db, table.name)) {
      if (!expected.has(table.name)) continue;
      fail(
        `legacy table ${table.name} is missing`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
    }
    const actual = tableInfo(db, table.name).columns;
    if (actual.some((column) => !table.columns.includes(column)))
      fail(
        `legacy table ${table.name} has unknown columns`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
    const expectedColumns = expected.get(table.name) ?? [];
    if (
      actual.length !== expectedColumns.length ||
      actual.some((column, index) => column !== expectedColumns[index])
    )
      fail(
        `legacy table ${table.name} does not match its registered source version`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
  }
}

function reconstructHistoricalTables(
  descriptor: PluginDatabaseDescriptor,
  sourceVersions: ReadonlyMap<string, number>,
): Map<string, string[]> {
  const probe = openSqlite(':memory:');
  const authorizer = createPluginAuthorizer({
    pluginId: '__legacy_probe__',
    tables: descriptor.objects
      .filter((object) => object.kind === 'table')
      .map((object) => object.name),
    indexes: descriptor.objects
      .filter((object) => object.kind === 'index')
      .map((object) => object.name),
    views: descriptor.objects
      .filter((object) => object.kind === 'view')
      .map((object) => object.name),
    triggers: descriptor.objects
      .filter((object) => object.kind === 'trigger')
      .map((object) => object.name),
  });
  probe.setAuthorizer?.(authorizer);
  const setSchemaMode = (enabled: boolean) =>
    (
      authorizer as typeof authorizer & {
        setSchemaMode: (value: boolean) => void;
      }
    ).setSchemaMode(enabled);
  const setPrivateTransaction = (enabled: boolean) =>
    (
      authorizer as typeof authorizer & {
        setPrivateTransaction: (value: boolean) => void;
      }
    ).setPrivateTransaction(enabled);
  const resetAuthorizer = () =>
    (authorizer as typeof authorizer & { reset: () => void }).reset();
  const setMetadataMode = (enabled: boolean) =>
    (
      authorizer as typeof authorizer & {
        setHostMetadataMode: (value: boolean) => void;
      }
    ).setHostMetadataMode(enabled);
  const control = (sql: 'BEGIN' | 'COMMIT' | 'ROLLBACK') => {
    resetAuthorizer();
    setPrivateTransaction(true);
    try {
      probe.exec(sql);
    } finally {
      setPrivateTransaction(false);
    }
  };
  try {
    control('BEGIN');
    const objects = descriptor.objects.map((object) => object.name);
    for (const module of descriptor.modules) {
      const version = sourceVersions.get(module.name) ?? 0;
      for (const migration of module.migrations) {
        if (migration.version > version) continue;
        for (const statement of migration.statements) {
          resetAuthorizer();
          setSchemaMode(true);
          try {
            probe.exec(formatPluginSql('__legacy_probe__', statement, objects));
          } finally {
            setSchemaMode(false);
          }
        }
      }
    }
    control('COMMIT');
    const result = new Map<string, string[]>();
    const prefix = `p_${Buffer.from('__legacy_probe__', 'utf8').toString('hex')}__`;
    setMetadataMode(true);
    try {
      for (const table of descriptor.legacy.tables) {
        resetAuthorizer();
        const rows = probe
          .prepare(`PRAGMA table_info("${prefix}${table.name}")`)
          .all() as Array<{ name: string }>;
        if (rows.length)
          result.set(
            table.name,
            rows.map((row) => row.name),
          );
      }
    } finally {
      setMetadataMode(false);
    }
    return result;
  } catch (cause) {
    try {
      control('ROLLBACK');
    } catch {
      // Preserve the original schema reconstruction failure.
    }
    throw cause;
  } finally {
    probe.close();
  }
}

function validateHistoricalShape(
  registry: PluginRegistry,
  pluginId: string,
  descriptor: PluginDatabaseDescriptor,
  source: Database.Database,
): void {
  const scope = { pluginId, descriptor };
  for (const table of descriptor.legacy.tables) {
    if (!sourceHasTable(source, table.name)) continue;
    const sourceColumns = new Set(tableInfo(source, table.name).columns);
    const targetInfo = registry.host(
      (db) =>
        db
          .prepare(
            `PRAGMA table_info(${physicalQuote(registry, pluginId, table.name)})`,
          )
          .all() as Array<{
          name: string;
          notnull: number;
          dflt_value: unknown;
          pk: number;
        }>,
      scope,
    );
    for (const column of targetInfo) {
      if (sourceColumns.has(column.name)) continue;
      // A historical schema may omit a later column only when the registered
      // target migration supplies a safe default. A required, default-less
      // column would otherwise turn the omission into silent data loss.
      if (column.notnull && column.dflt_value === null)
        fail(
          `legacy table ${table.name} is missing required historical column ${column.name}`,
          'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
        );
    }
  }
}

function sourceVersion(
  db: Database.Database,
  descriptor: PluginDatabaseDescriptor,
  moduleName: string,
): number {
  if (descriptor.legacy.versionTable) {
    const table = descriptor.legacy.versionTable;
    const info = tableInfo(db, table);
    if (!info.columns.includes('module') || !info.columns.includes('version'))
      fail(
        `legacy version table ${table} must expose module/version`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
    const registered = new Map(
      descriptor.modules.map((module) => [
        module.name,
        new Set(module.migrations.map((migration) => migration.version)),
      ]),
    );
    const versionRows = db
      .prepare(`SELECT module, version FROM ${quote(table)}`)
      .all() as Array<{ module?: string; version?: number | bigint }>;
    for (const versionRow of versionRows) {
      const rowModuleName = String(versionRow.module ?? '');
      const versions = registered.get(rowModuleName);
      const version = Number(versionRow.version);
      if (
        versions === undefined ||
        !Number.isSafeInteger(version) ||
        version < 0 ||
        !versions.has(version)
      )
        fail(
          `legacy source requires unknown ${rowModuleName} version ${String(versionRow.version)}`,
          'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
        );
    }
    const moduleRows = versionRows.filter(
      (versionRow) => String(versionRow.module ?? '') === moduleName,
    );
    if (moduleRows.length > 1)
      fail(
        `legacy version table has duplicate rows for ${moduleName}`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
    const row = db
      .prepare(`SELECT version FROM ${quote(table)} WHERE module = ?`)
      .get(moduleName) as { version?: number | bigint } | undefined;
    if (!row) return 0;
    const version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 0)
      fail(
        `invalid legacy version for ${moduleName}`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
    const versions = registered.get(moduleName);
    if (!versions?.has(version))
      fail(
        `legacy source requires unknown ${moduleName} version ${version}`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
    return version;
  }
  if (descriptor.legacy.userVersionModule === moduleName) {
    const version = Number(db.pragma('user_version', { simple: true }));
    const versions = new Set(
      descriptor.modules
        .find((module) => module.name === moduleName)
        ?.migrations.map((migration) => migration.version),
    );
    if (!Number.isSafeInteger(version) || version < 0 || !versions.has(version))
      fail(
        `legacy source requires unknown ${moduleName} version ${version}`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
    return version;
  }
  return 0;
}

function persistProgress(
  db: SqliteDatabase,
  progress: PluginImportProgress,
): void {
  db.prepare(
    `UPDATE plugin_import_progress SET source_identity=?,snapshot_path=?,descriptor_digest=?,module_name=?,table_name=?,last_key=?,rows_copied=?,source_digest=?,target_digest=?,updated_at=? WHERE plugin_id=?`,
  ).run(
    progress.sourceIdentity,
    progress.snapshotPath,
    progress.descriptorDigest,
    progress.moduleName,
    progress.tableName,
    progress.lastKey,
    progress.rowsCopied,
    progress.sourceDigest,
    progress.targetDigest,
    new Date().toISOString(),
    progress.pluginId,
  );
}

function ensureTargetFresh(
  registry: PluginRegistry,
  pluginId: string,
  descriptor: PluginDatabaseDescriptor,
): void {
  const scope = { pluginId, descriptor };
  const tables = registry.host(
    (db) => db.prepare('PRAGMA table_list').all() as Array<{ name: string }>,
    scope,
  );
  const names = new Set(tables.map((table) => table.name));
  for (const table of descriptor.legacy.tables) {
    const physical = registry.physicalName(pluginId, table.name);
    if (!names.has(physical)) continue;
    const count = registry.host(
      (db) =>
        Number(
          (
            db
              .prepare(
                `SELECT COUNT(*) AS count FROM ${physicalQuote(registry, pluginId, table.name)}`,
              )
              .get() as { count: bigint | number }
          ).count,
        ),
      scope,
    );
    if (count !== 0)
      fail(
        `target plugin table ${table.name} already contains data`,
        'PLUGIN_DB_TARGET_NONEMPTY',
      );
  }
}

function clearBootstrapRows(
  registry: PluginRegistry,
  pluginId: string,
  descriptor: PluginDatabaseDescriptor,
): void {
  const scope = { pluginId, descriptor };
  registry.atomic(() => {
    registry.host((db) => {
      // Remove bootstrap rows in reverse dependency order so a fresh
      // namespace with seeded parent/child tables can be cleared safely.
      for (const table of [...descriptor.legacy.tables].reverse())
        db.exec(`DELETE FROM ${physicalQuote(registry, pluginId, table.name)}`);
    }, scope);
  }, scope);
}

function applySequence(
  registry: PluginRegistry,
  pluginId: string,
  descriptor: PluginDatabaseDescriptor,
  source: Database.Database,
): void {
  let rows: Array<{ name: string; seq: number | bigint }> = [];
  try {
    rows = source
      .prepare('SELECT name, seq FROM sqlite_sequence')
      .all() as typeof rows;
  } catch {
    return;
  }
  const allowed = new Set(descriptor.legacy.tables.map((table) => table.name));
  const scope = { pluginId, descriptor };
  registry.atomic(() => {
    registry.host((db) => {
      for (const row of rows) {
        if (!allowed.has(row.name)) continue;
        const physical = registry.physicalName(pluginId, row.name);
        const updated = db
          .prepare('UPDATE sqlite_sequence SET seq = ? WHERE name = ?')
          .run(row.seq, physical);
        if (updated.changes === 0)
          db.prepare(
            'INSERT INTO sqlite_sequence(name, seq) VALUES (?, ?)',
          ).run(physical, row.seq);
      }
    }, scope);
  }, scope);
}

function copyTableChunk(
  registry: PluginRegistry,
  pluginId: string,
  descriptor: PluginDatabaseDescriptor,
  source: Database.Database,
  table: { name: string; columns: string[] },
  progress: PluginImportProgress,
  chunkSize: number,
  admit?: LegacyImportOptions['admit'],
): Promise<{ progress: PluginImportProgress; count: number }> {
  const info = tableInfo(source, table.name);
  const scope = { pluginId, descriptor };
  const targetInfo = registry.host((db) => {
    const targetTable = physicalQuote(registry, pluginId, table.name);
    const targetColumns = db
      .prepare(`PRAGMA table_info(${targetTable})`)
      .all() as Array<{ name: string }>;
    const targetTables = db
      .prepare(`PRAGMA table_list(${targetTable})`)
      .all() as Array<{ wr?: number }>;
    return {
      columns: targetColumns.map((column) => column.name),
      withoutRowid: Number(targetTables[0]?.wr ?? 0) === 1,
    };
  }, scope);
  const targetColumns = new Set(targetInfo.columns);
  const columns = info.columns.filter((column) => targetColumns.has(column));
  if (!columns.length || columns.length !== info.columns.length)
    fail(
      `legacy table ${table.name} has no importable columns`,
      'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
    );
  const order = info.withoutRowid
    ? info.primaryKey.length
      ? info.primaryKey
      : info.columns
    : [HIDDEN_ROWID];
  const usesHiddenRowid = order[0] === HIDDEN_ROWID;
  const projectionAlias = rowidProjectionAlias([
    ...info.columns,
    ...targetInfo.columns,
  ]);
  const selectColumns =
    info.withoutRowid || !usesHiddenRowid
      ? info.columns.map(quote)
      : [
          `${quoteInternal(info.rowidAlias!)} AS "${projectionAlias}"`,
          ...info.columns.map(quote),
        ];
  const cursor =
    progress.tableName === table.name ? decodeKey(progress.lastKey) : [];
  const predicate =
    order[0] === HIDDEN_ROWID
      ? !cursor.length
        ? { sql: '', params: [] }
        : {
            sql: `WHERE ${quoteInternal(info.rowidAlias!)} > ?`,
            params: cursor,
          }
      : keyPredicate(order, cursor);
  const orderSql = order.map((column) =>
    column === HIDDEN_ROWID ? quoteInternal(info.rowidAlias!) : quote(column),
  );
  const rows = source
    .prepare(
      `SELECT ${selectColumns.join(', ')} FROM ${quote(table.name)} ${predicate.sql} ORDER BY ${orderSql.join(', ')} LIMIT ?`,
    )
    .all(...predicate.params, chunkSize) as Array<Record<string, unknown>>;
  if (!rows.length) return Promise.resolve({ progress, count: 0 });
  const physical = physicalQuote(registry, pluginId, table.name);
  const targetRowidAlias =
    targetInfo.withoutRowid || !usesHiddenRowid
      ? undefined
      : ['rowid', '_rowid_', 'oid'].find(
          (alias) =>
            !targetInfo.columns.some(
              (column) => column.toLowerCase() === alias,
            ),
        );
  if (usesHiddenRowid && (targetInfo.withoutRowid || !targetRowidAlias))
    fail(
      `target table ${table.name} shadows every SQLite rowid alias and has no primary key`,
      'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
    );
  const insertColumns =
    info.withoutRowid || !usesHiddenRowid
      ? columns.map(quote)
      : [quoteInternal(targetRowidAlias!), ...columns.map(quote)];
  const statement = `INSERT INTO ${physical} (${insertColumns.join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`;
  const last = rows[rows.length - 1];
  const sourceDigest = extendDigest(
    progress.tableName === table.name ? progress.sourceDigest : null,
    rows.map((row) =>
      digestRow(
        row,
        columns,
        order[0] === HIDDEN_ROWID ? row[projectionAlias] : undefined,
      ),
    ),
  );
  let next: PluginImportProgress = {
    ...progress,
    tableName: table.name,
    lastKey: encodeKey(
      order.map((column) =>
        column === HIDDEN_ROWID ? last[projectionAlias] : last[column],
      ),
    ),
    rowsCopied:
      (progress.tableName === table.name ? progress.rowsCopied : 0) +
      rows.length,
    sourceDigest,
    targetDigest: null,
  };
  const write = () =>
    registry.atomic(() => {
      registry.host((db) => {
        const insert = db.prepare(statement);
        for (const row of rows)
          insert.run(
            ...(!usesHiddenRowid
              ? columns.map((column) => row[column])
              : [
                  row[projectionAlias],
                  ...columns.map((column) => row[column]),
                ]),
          );
        const keyValues = rows.map((row) =>
          order.map((column) =>
            column === HIDDEN_ROWID ? row[projectionAlias] : row[column],
          ),
        );
        const where =
          order[0] === HIDDEN_ROWID
            ? `${quoteInternal(targetRowidAlias!)} IN (${keyValues.map(() => '?').join(', ')})`
            : keyValues
                .map(
                  (_values) =>
                    `(${order.map((column) => `${quote(column)} = ?`).join(' AND ')})`,
                )
                .join(' OR ');
        const targetRows = db
          .prepare(
            `SELECT ${selectColumns.join(', ')} FROM ${physical} WHERE ${where}`,
          )
          .all(
            ...(order[0] === HIDDEN_ROWID
              ? keyValues.map((values) => values[0])
              : keyValues.flat()),
          ) as Array<Record<string, unknown>>;
        const targetByKey = new Map(
          targetRows.map((row) => [rowKey(row, order, projectionAlias), row]),
        );
        const targetDigestRows = rows.map((row) => {
          const target = targetByKey.get(rowKey(row, order, projectionAlias));
          if (!target)
            fail(
              `target plugin table ${table.name} lost an imported row`,
              'PLUGIN_DB_IMPORT_DIGEST_MISMATCH',
            );
          return digestRow(
            target,
            columns,
            order[0] === HIDDEN_ROWID ? target[projectionAlias] : undefined,
          );
        });
        next = {
          ...next,
          targetDigest: extendDigest(
            progress.tableName === table.name ? progress.targetDigest : null,
            targetDigestRows,
          ),
        };
        persistProgress(db, next);
      }, scope);
    }, scope);
  return (admit ? admit(write) : Promise.resolve(write())).then(() => ({
    progress: next,
    count: rows.length,
  }));
}

export async function importLegacyPluginStorage(
  registry: PluginRegistry,
  input: LegacyImportInput,
  options: LegacyImportOptions = {},
): Promise<void> {
  const admitWork = <T>(work: () => T | Promise<T>): Promise<T> =>
    options.admit ? options.admit(work) : Promise.resolve(work());
  const descriptor = await admitWork(() => registry.descriptor(input.pluginId));
  await admitWork(() =>
    registry.assertImportInput(
      input.pluginId,
      input.descriptor,
      input.legacyPath,
    ),
  );
  const digest = descriptorDigest(descriptor);
  const chunkSize = Math.min(
    MAX_CHUNK_SIZE,
    Math.max(1, Math.floor(options.chunkSize ?? MAX_CHUNK_SIZE)),
  );
  const current = await admitWork(() => registry.diagnostics(input.pluginId));
  if (current.state === 'active') return;
  if (!fs.existsSync(input.legacyPath)) {
    // A newly installed profile has no legacy file. Build the registered
    // namespace from its exact bootstrap migrations and activate it after the
    // same deferred-trigger/schema validation used by an import.
    await admitWork(() =>
      ensureTargetFresh(registry, input.pluginId, descriptor),
    );
    for (const module of descriptor.modules)
      for (const migration of module.migrations) {
        await admitWork(() =>
          registry.migrate({
            pluginId: input.pluginId,
            module: module.name,
            version: migration.version,
            statements: migration.statements,
            deferTriggers: true,
          }),
        );
      }
    for (const module of descriptor.modules)
      for (const migration of module.migrations) {
        await admitWork(() =>
          registry.migrate({
            pluginId: input.pluginId,
            module: module.name,
            version: migration.version,
            statements: migration.statements,
          }),
        );
      }
    await admitWork(() => registry.validateSchema(input.pluginId));
    await admitWork(() => registry.completeImport(input.pluginId));
    return;
  }
  const existing = current.progress;
  const identity = sourceIdentity(input.legacyPath);
  if (
    existing &&
    (existing.sourceIdentity !== identity ||
      existing.descriptorDigest !== digest)
  )
    fail(
      'legacy source or descriptor changed during resumable import',
      'PLUGIN_DB_IMPORT_SOURCE_CHANGED',
    );
  const snapshotPath =
    existing?.snapshotPath ??
    snapshotPathFor(input.legacyPath, input.pluginId, identity);
  await createFixedSnapshot(
    input.legacyPath,
    snapshotPath,
    options.beforeSnapshotPublish,
  );
  let progress = existing;
  const source = new Database(snapshotPath, {
    fileMustExist: true,
    readonly: true,
  });
  source.defaultSafeIntegers(true);
  try {
    const versions = new Map(
      descriptor.modules.map((module) => [
        module.name,
        sourceVersion(source, descriptor, module.name),
      ]),
    );
    validateLegacySchema(source, descriptor, versions);
    if (!existing)
      await admitWork(() =>
        ensureTargetFresh(registry, input.pluginId, descriptor),
      );
    if (!progress) {
      progress = {
        pluginId: input.pluginId,
        sourceIdentity: identity,
        snapshotPath,
        descriptorDigest: digest,
        moduleName: descriptor.modules[0]?.name ?? '',
        tableName: descriptor.legacy.tables[0]?.name ?? '',
        lastKey: null,
        rowsCopied: 0,
        sourceDigest: null,
        targetDigest: null,
      };
      await admitWork(() => registry.setImporting(input.pluginId, progress!));
    }
    for (const module of descriptor.modules) {
      const version = versions.get(module.name) ?? 0;
      for (const migration of module.migrations.filter(
        (entry) => entry.version <= version,
      )) {
        await admitWork(() =>
          registry.migrate({
            pluginId: input.pluginId,
            module: module.name,
            version: migration.version,
            statements: migration.statements,
            deferTriggers: true,
          }),
        );
      }
    }
    await admitWork(() =>
      validateHistoricalShape(registry, input.pluginId, descriptor, source),
    );
    if (!existing)
      await admitWork(() =>
        clearBootstrapRows(registry, input.pluginId, descriptor),
      );
    const start = Math.max(
      0,
      descriptor.legacy.tables.findIndex(
        (table) => table.name === progress!.tableName,
      ),
    );
    for (
      let tableIndex = start;
      tableIndex < descriptor.legacy.tables.length;
      tableIndex++
    ) {
      const table = descriptor.legacy.tables[tableIndex];
      if (!sourceHasTable(source, table.name)) {
        progress = {
          ...progress!,
          moduleName: descriptor.modules[0]?.name ?? '',
          tableName: descriptor.legacy.tables[tableIndex + 1]?.name ?? '',
          lastKey: null,
          rowsCopied: 0,
          sourceDigest: null,
          targetDigest: null,
        };
        if (descriptor.legacy.tables[tableIndex + 1])
          await admitWork(() =>
            registry.atomic(
              () =>
                registry.host((db) => persistProgress(db, progress!), {
                  pluginId: input.pluginId,
                  descriptor,
                }),
              { pluginId: input.pluginId, descriptor },
            ),
          );
        continue;
      }
      for (;;) {
        const result = await copyTableChunk(
          registry,
          input.pluginId,
          descriptor,
          source,
          table,
          progress!,
          chunkSize,
          options.admit,
        );
        if (!result.count) break;
        progress = result.progress;
        await (input.afterChunk ?? options.afterChunk)?.(progress);
        // Give worker messages, timers, and queued core admission work a turn
        // between bounded SQLite transactions.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (result.count < chunkSize) break;
      }
      if (progress!.sourceDigest !== progress!.targetDigest)
        fail(
          `legacy table ${table.name} content digest mismatch`,
          'PLUGIN_DB_IMPORT_DIGEST_MISMATCH',
        );
      progress = {
        ...progress!,
        moduleName: descriptor.modules[0]?.name ?? '',
        tableName: descriptor.legacy.tables[tableIndex + 1]?.name ?? '',
        lastKey: null,
        rowsCopied: 0,
        sourceDigest: null,
        targetDigest: null,
      };
      if (descriptor.legacy.tables[tableIndex + 1])
        await admitWork(() =>
          registry.atomic(
            () =>
              registry.host((db) => persistProgress(db, progress!), {
                pluginId: input.pluginId,
                descriptor,
              }),
            { pluginId: input.pluginId, descriptor },
          ),
        );
    }
    await admitWork(() =>
      applySequence(registry, input.pluginId, descriptor, source),
    );
    for (const module of descriptor.modules) {
      const sourceVersionNumber = versions.get(module.name) ?? 0;
      for (const migration of module.migrations.filter(
        (entry) =>
          entry.version > sourceVersionNumber ||
          (entry.version <= sourceVersionNumber &&
            entry.statements.some((statement) =>
              /^\s*CREATE\s+TRIGGER\b/i.test(statement),
            )),
      ))
        await admitWork(() =>
          registry.migrate({
            pluginId: input.pluginId,
            module: module.name,
            version: migration.version,
            statements: migration.statements,
          }),
        );
    }
    await admitWork(() =>
      registry.host((db) => db.exec('PRAGMA foreign_keys = ON'), {
        pluginId: input.pluginId,
        descriptor,
      }),
    );
    const fkErrors = await admitWork(() =>
      registry.host((db) => db.prepare('PRAGMA foreign_key_check').all(), {
        pluginId: input.pluginId,
        descriptor,
      }),
    );
    if (fkErrors.length)
      fail(
        'legacy import failed foreign-key validation',
        'PLUGIN_DB_IMPORT_FOREIGN_KEY',
      );
    await admitWork(() => registry.validateSchema(input.pluginId));
    await admitWork(() => registry.completeImport(input.pluginId));
  } finally {
    source.close();
    if (
      (await admitWork(() => registry.diagnostics(input.pluginId))).state ===
      'active'
    )
      await fsp.rm(snapshotPath, { force: true }).catch(() => undefined);
  }
}
