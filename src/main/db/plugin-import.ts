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
import type { SqliteDatabase } from './sqlite-runtime';

export type { PluginImportProgress } from './plugin-registry';

export interface LegacyImportOptions {
  chunkSize?: number;
  afterChunk?: (progress: PluginImportProgress) => void | Promise<void>;
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
  if (!NAME.test(name))
    fail(
      `invalid legacy identifier ${name}`,
      'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
    );
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
    } catch {
      /* absent WAL is part of the identity too */
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
): Promise<void> {
  if (fs.existsSync(snapshotPath)) return;
  const source = new Database(legacyPath, {
    fileMustExist: true,
    readonly: true,
  });
  try {
    await source.backup(snapshotPath);
  } finally {
    source.close();
  }
}

function tableInfo(
  db: Database.Database,
  table: string,
): { columns: string[]; primaryKey: string[]; withoutRowid: boolean } {
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
  return {
    columns: rows.map((row) => row.name),
    primaryKey: rows
      .filter((row) => Number(row.pk) > 0)
      .sort((a, b) => Number(a.pk) - Number(b.pk))
      .map((row) => row.name),
    withoutRowid,
  };
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

function rowKey(row: Record<string, unknown>, columns: string[]): string {
  return encodeKey(columns.map((column) => row[column]));
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
    for (const column of expected.get(table.name) ?? []) {
      if (!actual.includes(column)) {
        fail(
          `legacy table ${table.name} is missing historical column ${column}`,
          'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
        );
      }
    }
  }
}

function reconstructHistoricalTables(
  descriptor: PluginDatabaseDescriptor,
  sourceVersions: ReadonlyMap<string, number>,
): Map<string, string[]> {
  const probe = new Database(':memory:');
  try {
    const objects = descriptor.objects.map((object) => object.name);
    for (const module of descriptor.modules) {
      const version = sourceVersions.get(module.name) ?? 0;
      for (const migration of module.migrations) {
        if (migration.version > version) continue;
        for (const statement of migration.statements)
          probe.exec(formatPluginSql('__legacy_probe__', statement, objects));
      }
    }
    const result = new Map<string, string[]>();
    const prefix = `p_${Buffer.from('__legacy_probe__', 'utf8').toString('hex')}__`;
    for (const table of descriptor.legacy.tables) {
      const rows = probe
        .prepare(`PRAGMA table_info("${prefix}${table.name}")`)
        .all() as Array<{ name: string }>;
      if (rows.length)
        result.set(
          table.name,
          rows.map((row) => row.name),
        );
    }
    return result;
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
        Math.max(
          -1,
          ...module.migrations.map((migration) => migration.version),
        ),
      ]),
    );
    const versionRows = db
      .prepare(`SELECT module, version FROM ${quote(table)}`)
      .all() as Array<{ module?: string; version?: number | bigint }>;
    for (const versionRow of versionRows) {
      const rowModuleName = String(versionRow.module ?? '');
      const max = registered.get(rowModuleName);
      const version = Number(versionRow.version);
      if (
        max === undefined ||
        !Number.isSafeInteger(version) ||
        version < 0 ||
        version > max
      )
        fail(
          `legacy source requires unknown ${rowModuleName} version ${String(versionRow.version)}`,
          'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
        );
    }
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
    const max = registered.get(moduleName) ?? -1;
    if (version > max)
      fail(
        `legacy source requires unknown ${moduleName} version ${version}`,
        'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
      );
    return version;
  }
  if (descriptor.legacy.userVersionModule === moduleName) {
    const version = Number(db.pragma('user_version', { simple: true }));
    const max = Math.max(
      -1,
      ...(descriptor.modules
        .find((module) => module.name === moduleName)
        ?.migrations.map((migration) => migration.version) ?? []),
    );
    if (!Number.isSafeInteger(version) || version < 0 || version > max)
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
  const targetColumns = new Set(
    registry
      .host(
        (db) =>
          db
            .prepare(
              `PRAGMA table_info(${physicalQuote(registry, pluginId, table.name)})`,
            )
            .all() as Array<{ name: string }>,
        scope,
      )
      .map((column) => column.name),
  );
  const columns = info.columns.filter(
    (column) => table.columns.includes(column) && targetColumns.has(column),
  );
  if (!columns.length)
    fail(
      `legacy table ${table.name} has no importable columns`,
      'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH',
    );
  const order = info.primaryKey.length
    ? info.primaryKey
    : info.withoutRowid
      ? info.columns
      : ['rowid'];
  const selectColumns = info.withoutRowid
    ? info.columns.map(quote)
    : ['rowid AS __kiagent_rowid', ...info.columns.map(quote)];
  const cursor =
    progress.tableName === table.name ? decodeKey(progress.lastKey) : [];
  const predicate =
    order[0] === 'rowid'
      ? !cursor.length
        ? { sql: '', params: [] }
        : { sql: 'WHERE rowid > ?', params: cursor }
      : keyPredicate(order, cursor);
  const rows = source
    .prepare(
      `SELECT ${selectColumns.join(', ')} FROM ${quote(table.name)} ${predicate.sql} ORDER BY ${order.map(quote).join(', ')} LIMIT ?`,
    )
    .all(...predicate.params, chunkSize) as Array<Record<string, unknown>>;
  if (!rows.length) return Promise.resolve({ progress, count: 0 });
  const physical = physicalQuote(registry, pluginId, table.name);
  const insertColumns = info.withoutRowid
    ? columns.map(quote)
    : ['rowid', ...columns.map(quote)];
  const statement = `INSERT INTO ${physical} (${insertColumns.join(', ')}) VALUES (${insertColumns.map(() => '?').join(', ')})`;
  const last = rows[rows.length - 1];
  const sourceDigest = extendDigest(
    progress.tableName === table.name ? progress.sourceDigest : null,
    rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, row[column]])),
    ),
  );
  let next: PluginImportProgress = {
    ...progress,
    tableName: table.name,
    lastKey: encodeKey(
      order.map((column) =>
        column === 'rowid' ? last.__kiagent_rowid : last[column],
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
            ...(info.withoutRowid
              ? columns.map((column) => row[column])
              : [row.__kiagent_rowid, ...columns.map((column) => row[column])]),
          );
        const keyValues = rows.map((row) =>
          order.map((column) =>
            column === 'rowid' ? row.__kiagent_rowid : row[column],
          ),
        );
        const where =
          order[0] === 'rowid'
            ? `rowid IN (${keyValues.map(() => '?').join(', ')})`
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
            ...(order[0] === 'rowid'
              ? keyValues.map((values) => values[0])
              : keyValues.flat()),
          ) as Array<Record<string, unknown>>;
        const targetByKey = new Map(
          targetRows.map((row) => [rowKey(row, order), row]),
        );
        const targetDigestRows = rows.map((row) => {
          const target = targetByKey.get(rowKey(row, order));
          if (!target)
            fail(
              `target plugin table ${table.name} lost an imported row`,
              'PLUGIN_DB_IMPORT_DIGEST_MISMATCH',
            );
          return Object.fromEntries(
            columns.map((column) => [column, target[column]]),
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
  await createFixedSnapshot(input.legacyPath, snapshotPath);
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
