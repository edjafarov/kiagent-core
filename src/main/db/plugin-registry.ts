import crypto from 'node:crypto';
import path from 'node:path';
import { formatPluginSql, pluginIdentifier } from '@shared/plugin-sql';
import {
  parseDatabaseDescriptor,
  type PluginDatabaseDescriptor,
} from '@main/platform/database-descriptor';
import type { DbOwner } from './coordinator';
import type { PluginConnectionOptions } from './plugin-connections';
import { openSqlite, type SqliteDatabase } from './sqlite-runtime';
import { createPluginAuthorizer, ownedNamespace } from './plugin-authorizer';

export type PluginStorageState =
  | 'registered'
  | 'importing'
  | 'active'
  | 'reset'
  | 'tombstoned';

export interface PluginStorageMetadata {
  pluginId: string;
  state: PluginStorageState;
  descriptorDigest: string;
  legacyPath: string;
  generation: number;
}

export interface RegisterPluginStorageInput {
  pluginId: string;
  descriptor: PluginDatabaseDescriptor;
  legacyPath: string;
}

export interface PreparePluginStorageInput {
  pluginId: string;
  descriptor?: PluginDatabaseDescriptor;
  legacyPath?: string;
}

export interface OpenPluginStorageInput {
  pluginId: string;
  owner: DbOwner;
}

export interface PluginMigrationInput {
  pluginId: string;
  module: string;
  version: number;
  statements: readonly string[];
  deferTriggers?: boolean;
}

export interface PluginImportProgress {
  pluginId: string;
  sourceIdentity: string;
  snapshotPath: string;
  descriptorDigest: string;
  moduleName: string;
  tableName: string;
  lastKey: string | null;
  rowsCopied: number;
  sourceDigest: string | null;
  targetDigest: string | null;
}

export interface PluginRegistry {
  register(input: RegisterPluginStorageInput): Promise<PluginStorageMetadata>;
  preparePluginStorage(
    input: PreparePluginStorageInput,
  ): Promise<PluginStorageMetadata>;
  open(input: OpenPluginStorageInput): Promise<PluginConnectionOptions>;
  migrate(input: PluginMigrationInput): Promise<void>;
  diagnostics(
    pluginId: string,
  ): PluginStorageMetadata & { progress?: PluginImportProgress };
  setImporting(pluginId: string, progress: PluginImportProgress): Promise<void>;
  saveImportProgress(progress: PluginImportProgress): Promise<void>;
  completeImport(pluginId: string): Promise<PluginStorageMetadata>;
  atomic<T>(
    work: () => T,
    scope?: { pluginId: string; descriptor: PluginDatabaseDescriptor },
  ): T;
  descriptor(pluginId: string): PluginDatabaseDescriptor;
  physicalName(pluginId: string, logicalName: string): string;
  reset(pluginId: string): Promise<void>;
  close(): Promise<void>;
  assertImportInput(
    pluginId: string,
    descriptor: PluginDatabaseDescriptor,
    legacyPath: string,
  ): PluginStorageMetadata;
  validateSchema(pluginId: string): Promise<void>;
  /** Worker-only access for registry/import code; never placed on PluginDb. */
  host<T>(
    work: (db: SqliteDatabase) => T,
    scope?: { pluginId: string; descriptor: PluginDatabaseDescriptor },
  ): T;
}

const REGISTRY_SCHEMA = `
CREATE TABLE IF NOT EXISTS plugin_storage (
  plugin_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('registered','importing','active','reset','tombstoned')),
  descriptor_digest TEXT NOT NULL,
  descriptor_json TEXT NOT NULL,
  legacy_path TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_schema_versions (
  plugin_id TEXT NOT NULL,
  module_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  statements_digest TEXT NOT NULL,
  PRIMARY KEY (plugin_id, module_name)
);
CREATE TABLE IF NOT EXISTS plugin_import_progress (
  plugin_id TEXT PRIMARY KEY,
  source_identity TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  descriptor_digest TEXT NOT NULL,
  module_name TEXT NOT NULL,
  table_name TEXT NOT NULL,
  last_key TEXT,
  rows_copied INTEGER NOT NULL,
  source_digest TEXT,
  target_digest TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS plugin_deferred_migrations (
  plugin_id TEXT NOT NULL,
  module_name TEXT NOT NULL,
  version INTEGER NOT NULL,
  statement_index INTEGER NOT NULL,
  statement_sql TEXT NOT NULL,
  PRIMARY KEY (plugin_id, module_name, version, statement_index)
);
`;

function error(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function now(): string {
  return new Date().toISOString();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function descriptorDigest(descriptor: PluginDatabaseDescriptor): string {
  return crypto
    .createHash('sha256')
    .update(canonical(descriptor))
    .digest('hex');
}

function statementsDigest(statements: readonly string[]): string {
  return crypto
    .createHash('sha256')
    .update(canonical(statements))
    .digest('hex');
}

function rowMetadata(row: Record<string, unknown>): PluginStorageMetadata {
  return {
    pluginId: String(row.plugin_id),
    state: String(row.state) as PluginStorageState,
    descriptorDigest: String(row.descriptor_digest),
    legacyPath: String(row.legacy_path),
    generation: Number(row.generation),
  };
}

function ensureLegacyPath(legacyPath: string): string {
  if (!path.isAbsolute(legacyPath))
    throw error(
      'legacy path must be host-derived and absolute',
      'PLUGIN_DB_LEGACY_PATH_INVALID',
    );
  return legacyPath;
}

function validateRegisteredReferences(
  descriptor: PluginDatabaseDescriptor,
): void {
  const objects = new Set(descriptor.objects.map((object) => object.name));
  for (const module of descriptor.modules)
    for (const migration of module.migrations)
      for (const statement of migration.statements) {
        const references = [
          ...statement.matchAll(
            /\bREFERENCES\s+(?:\{\{([a-z][a-z0-9_]*)\}\}|"?([a-z][a-z0-9_]*)"?)/gi,
          ),
        ];
        for (const match of references) {
          const target = match[1] ?? match[2];
          if (!objects.has(target))
            throw error(
              `migration references an unowned foreign-key target ${target}`,
              'PLUGIN_DB_DESCRIPTOR_FOREIGN_KEY',
            );
        }
      }
}

function isAppendOnlyDescriptor(
  oldDescriptor: PluginDatabaseDescriptor,
  next: PluginDatabaseDescriptor,
): boolean {
  const nextObjects = new Map(
    next.objects.map((object) => [object.name, object.kind]),
  );
  if (
    oldDescriptor.objects.some(
      (object) => nextObjects.get(object.name) !== object.kind,
    )
  )
    return false;
  const nextModules = new Map(
    next.modules.map((module) => [module.name, module]),
  );
  for (const oldModule of oldDescriptor.modules) {
    const nextModule = nextModules.get(oldModule.name);
    if (
      !nextModule ||
      nextModule.migrations.length < oldModule.migrations.length
    )
      return false;
    for (let index = 0; index < oldModule.migrations.length; index++) {
      if (
        canonical(oldModule.migrations[index]) !==
        canonical(nextModule.migrations[index])
      )
        return false;
    }
  }
  const nextTables = new Map(
    next.legacy.tables.map((table) => [table.name, table.columns]),
  );
  for (const oldTable of oldDescriptor.legacy.tables) {
    const columns = nextTables.get(oldTable.name);
    if (
      !columns ||
      oldTable.columns.some((column) => !columns.includes(column))
    )
      return false;
  }
  return true;
}

const REGISTRY_TABLES = [
  'plugin_storage',
  'plugin_schema_versions',
  'plugin_import_progress',
  'plugin_deferred_migrations',
] as const;

export function createPluginRegistry(
  _coreDb: unknown,
  options: { filename: string },
): PluginRegistry {
  if (!path.isAbsolute(options.filename))
    throw error(
      'registry database path must be absolute',
      'PLUGIN_DB_REGISTRY_PATH_INVALID',
    );
  const db = openSqlite(options.filename);
  const authorizer = createPluginAuthorizer({
    pluginId: '__host__',
    tables: [],
    hostMetadataTables: REGISTRY_TABLES,
  });
  db.setAuthorizer?.(authorizer);
  const setSchemaMode = (enabled: boolean) =>
    (
      authorizer as typeof authorizer & {
        setSchemaMode: (value: boolean) => void;
      }
    ).setSchemaMode(enabled);
  const rawSetMetadataMode = (enabled: boolean) =>
    (
      authorizer as typeof authorizer & {
        setHostMetadataMode: (value: boolean) => void;
      }
    ).setHostMetadataMode(enabled);
  let metadataDepth = 0;
  const setMetadataMode = (enabled: boolean) => {
    if (enabled) {
      metadataDepth++;
      rawSetMetadataMode(true);
    } else {
      metadataDepth = Math.max(0, metadataDepth - 1);
      if (metadataDepth === 0) rawSetMetadataMode(false);
    }
  };
  const setPrivateTransaction = (enabled: boolean) =>
    (
      authorizer as typeof authorizer & {
        setPrivateTransaction: (value: boolean) => void;
      }
    ).setPrivateTransaction(enabled);
  const resetAuthorizer = () =>
    (authorizer as typeof authorizer & { reset: () => void }).reset();
  const transactionControl = (sql: 'BEGIN' | 'COMMIT' | 'ROLLBACK') => {
    resetAuthorizer();
    setPrivateTransaction(true);
    try {
      db.exec(sql);
    } finally {
      setPrivateTransaction(false);
    }
  };
  const setOwnedObjects = (names: readonly string[]) =>
    (
      authorizer as typeof authorizer & {
        setOwnedObjects: (names: readonly string[]) => void;
      }
    ).setOwnedObjects(names);
  const registrySchema = () => {
    setMetadataMode(true);
    setSchemaMode(true);
    try {
      db.exec(REGISTRY_SCHEMA);
    } finally {
      setSchemaMode(false);
      setMetadataMode(false);
    }
  };
  const metadata = <T>(work: () => T): T => {
    resetAuthorizer();
    setMetadataMode(true);
    try {
      return work();
    } finally {
      setMetadataMode(false);
    }
  };
  registrySchema();
  const storageById = (pluginId: string): Record<string, unknown> | undefined =>
    metadata(
      () =>
        db
          .prepare('SELECT * FROM plugin_storage WHERE plugin_id = ?')
          .get(pluginId) as Record<string, unknown> | undefined,
    );
  const descriptorFor = (pluginId: string): PluginDatabaseDescriptor => {
    const row = storageById(pluginId);
    if (!row)
      throw error(
        `plugin storage is not registered: ${pluginId}`,
        'PLUGIN_DB_NOT_REGISTERED',
      );
    return parseDatabaseDescriptor(JSON.parse(String(row.descriptor_json)));
  };
  const metadataFor = (pluginId: string): PluginStorageMetadata => {
    const row = storageById(pluginId);
    if (!row)
      throw error(
        `plugin storage is not registered: ${pluginId}`,
        'PLUGIN_DB_NOT_REGISTERED',
      );
    return rowMetadata(row);
  };
  const metadataWithProgress = (
    pluginId: string,
  ): PluginStorageMetadata & { progress?: PluginImportProgress } => {
    const metadataRecord = metadataFor(pluginId);
    const progress = metadata(
      () =>
        db
          .prepare('SELECT * FROM plugin_import_progress WHERE plugin_id = ?')
          .get(pluginId) as Record<string, unknown> | undefined,
    );
    return progress
      ? {
          ...metadataRecord,
          progress: {
            pluginId: String(progress.plugin_id),
            sourceIdentity: String(progress.source_identity),
            snapshotPath: String(progress.snapshot_path),
            descriptorDigest: String(progress.descriptor_digest),
            moduleName: String(progress.module_name),
            tableName: String(progress.table_name),
            lastKey:
              progress.last_key === null ? null : String(progress.last_key),
            rowsCopied: Number(progress.rows_copied),
            sourceDigest:
              progress.source_digest === null
                ? null
                : String(progress.source_digest),
            targetDigest:
              progress.target_digest === null
                ? null
                : String(progress.target_digest),
          },
        }
      : metadataRecord;
  };
  const verifyRegisteredObjects = (
    pluginId: string,
    descriptor: PluginDatabaseDescriptor,
  ): void => {
    const actual = new Map(
      metadata(
        () =>
          db
            .prepare('SELECT name, type FROM sqlite_master WHERE name LIKE ?')
            .all(`${ownedNamespace(pluginId)}%`) as Array<{
            name: string;
            type: string;
          }>,
      ).map((row) => [String(row.name), String(row.type)]),
    );
    for (const object of descriptor.objects) {
      const physical = pluginIdentifier(pluginId, object.name).replaceAll(
        '"',
        '',
      );
      const actualKind = actual.get(physical);
      if (!actualKind)
        throw error(
          `registered ${object.kind} ${object.name} does not exist in sqlite_master`,
          'PLUGIN_DB_SCHEMA_OBJECT_MISSING',
        );
      if (actualKind !== object.kind)
        throw error(
          `registered ${object.name} has sqlite kind ${actualKind}, expected ${object.kind}`,
          'PLUGIN_DB_SCHEMA_OBJECT_KIND',
        );
    }
  };
  const withTransaction = <T>(
    work: () => T,
    scope?: { pluginId: string; descriptor: PluginDatabaseDescriptor },
  ): T => {
    if (scope)
      setOwnedObjects(
        scope.descriptor.objects.map((object) =>
          pluginIdentifier(scope.pluginId, object.name).replaceAll('"', ''),
        ),
      );
    try {
      transactionControl('BEGIN');
      const result = work();
      transactionControl('COMMIT');
      return result;
    } catch (cause) {
      try {
        transactionControl('ROLLBACK');
      } catch {
        // The original transaction error is authoritative.
      }
      throw cause;
    } finally {
      setOwnedObjects([]);
    }
  };
  const validateSchemaInternal = async (
    pluginId: string,
    descriptor: PluginDatabaseDescriptor,
  ): Promise<void> => {
    const physical = (name: string) =>
      pluginIdentifier(pluginId, name).replaceAll('"', '');
    const names = new Set(
      descriptor.objects.map((object) => physical(object.name)),
    );
    setOwnedObjects([...names]);
    try {
      for (const table of descriptor.objects.filter(
        (object) => object.kind === 'table',
      )) {
        const tableName = physical(table.name);
        const columns = metadata(() =>
          (
            db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
              name: string;
            }>
          ).map((row) => row.name),
        );
        const escaped = columns.map(
          (column) => `"${column.replaceAll('"', '""')}"`,
        );
        const values = columns.map(() => 'NULL').join(', ');
        resetAuthorizer();
        db.prepare(
          `EXPLAIN INSERT INTO "${tableName}" (${escaped.join(', ')}) VALUES (${values})`,
        );
        for (const column of escaped) {
          resetAuthorizer();
          db.prepare(`EXPLAIN UPDATE "${tableName}" SET ${column}=${column}`);
        }
        resetAuthorizer();
        db.prepare(`EXPLAIN DELETE FROM "${tableName}"`);
        const foreignKeys = metadata(
          () =>
            db
              .prepare(`PRAGMA foreign_key_list("${tableName}")`)
              .all() as Array<{ table?: string }>,
        );
        for (const foreignKey of foreignKeys)
          if (foreignKey.table && !names.has(String(foreignKey.table)))
            throw error(
              `owned table ${table.name} references non-owned table ${String(foreignKey.table)}`,
              'PLUGIN_DB_SCHEMA_REFERENCE',
            );
      }
      for (const view of descriptor.objects.filter(
        (object) => object.kind === 'view',
      )) {
        resetAuthorizer();
        db.prepare(`EXPLAIN SELECT * FROM "${physical(view.name)}"`);
      }
      const triggerRows = metadata(
        () =>
          db
            .prepare(
              "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE ?",
            )
            .all(`${ownedNamespace(pluginId)}%`) as Array<{
            name: string;
            sql: string;
          }>,
      );
      for (const trigger of triggerRows) {
        const match = trigger.sql.match(
          /\bINSTEAD\s+OF\s+(INSERT|UPDATE|DELETE)\s+ON\s+["`]?([^\s"`(]+)["`]?/i,
        );
        if (!match) continue;
        const target = match[2];
        if (!names.has(target))
          throw error(
            `trigger ${trigger.name} references a non-owned view ${target}`,
            'PLUGIN_DB_SCHEMA_REFERENCE',
          );
        const viewColumns = metadata(() =>
          (
            db.prepare(`PRAGMA table_info("${target}")`).all() as Array<{
              name: string;
            }>
          ).map((row) => row.name),
        );
        const event = match[1].toUpperCase();
        resetAuthorizer();
        if (event === 'INSERT') {
          if (viewColumns.length)
            db.prepare(
              `EXPLAIN INSERT INTO "${target}" (${viewColumns.map((column) => `"${column}"`).join(', ')}) VALUES (${viewColumns.map(() => 'NULL').join(', ')})`,
            );
          else db.prepare(`EXPLAIN INSERT INTO "${target}" DEFAULT VALUES`);
        } else if (event === 'UPDATE') {
          for (const column of viewColumns) {
            resetAuthorizer();
            db.prepare(
              `EXPLAIN UPDATE "${target}" SET "${column}"="${column}"`,
            );
          }
        } else db.prepare(`EXPLAIN DELETE FROM "${target}"`);
      }
    } finally {
      setOwnedObjects([]);
    }
  };
  const appendOnlyMigrations = (
    previous: PluginDatabaseDescriptor,
    next: PluginDatabaseDescriptor,
  ): Array<{ module: string; version: number; statements: string[] }> => {
    const priorModules = new Map(
      previous.modules.map((module) => [module.name, module]),
    );
    const appended: Array<{
      module: string;
      version: number;
      statements: string[];
    }> = [];
    for (const module of next.modules) {
      const priorLength = priorModules.get(module.name)?.migrations.length ?? 0;
      for (const migration of module.migrations.slice(priorLength))
        appended.push({
          module: module.name,
          version: migration.version,
          statements: migration.statements,
        });
    }
    return appended;
  };
  const upgradeActiveDescriptor = async (
    pluginId: string,
    previous: PluginDatabaseDescriptor,
    next: PluginDatabaseDescriptor,
    digest: string,
  ): Promise<PluginStorageMetadata> => {
    const appended = appendOnlyMigrations(previous, next);
    withTransaction(
      () => {
        metadata(() =>
          db
            .prepare(
              "UPDATE plugin_storage SET state='registered', descriptor_digest=?, descriptor_json=?, updated_at=? WHERE plugin_id=?",
            )
            .run(digest, canonical(next), now(), pluginId),
        );
        setSchemaMode(true);
        try {
          for (const migration of appended) {
            for (const statement of migration.statements) {
              resetAuthorizer();
              db.exec(
                formatPluginSql(
                  pluginId,
                  statement,
                  next.objects.map((object) => object.name),
                ),
              );
            }
            metadata(() =>
              db
                .prepare(
                  `INSERT INTO plugin_schema_versions(plugin_id,module_name,version,statements_digest)
                   VALUES (?, ?, ?, ?) ON CONFLICT(plugin_id,module_name) DO UPDATE SET version=excluded.version, statements_digest=excluded.statements_digest`,
                )
                .run(
                  pluginId,
                  migration.module,
                  migration.version,
                  statementsDigest(migration.statements),
                ),
            );
          }
          verifyRegisteredObjects(pluginId, next);
        } finally {
          setSchemaMode(false);
        }
      },
      { pluginId, descriptor: next },
    );
    await validateSchemaInternal(pluginId, next);
    withTransaction(() => {
      metadata(() =>
        db
          .prepare(
            "UPDATE plugin_storage SET state='active', generation=generation+1, updated_at=? WHERE plugin_id=?",
          )
          .run(now(), pluginId),
      );
    });
    return metadataFor(pluginId);
  };
  return {
    register: async (input) => {
      const descriptor = parseDatabaseDescriptor(input.descriptor);
      validateRegisteredReferences(descriptor);
      const legacyPath = ensureLegacyPath(input.legacyPath);
      const digest = descriptorDigest(descriptor);
      const current = storageById(input.pluginId);
      if (current) {
        if (
          String(current.state) === 'tombstoned' ||
          String(current.state) === 'reset'
        ) {
          throw error(
            'plugin storage has a reset tombstone and cannot be reimported automatically',
            'PLUGIN_DB_RESET_TOMBSTONE',
          );
        }
        if (String(current.legacy_path) !== legacyPath)
          throw error(
            'registered plugin descriptor or legacy source changed',
            'PLUGIN_DB_DESCRIPTOR_DRIFT',
          );
        if (String(current.descriptor_digest) !== digest) {
          const prior = parseDatabaseDescriptor(
            JSON.parse(String(current.descriptor_json)),
          );
          if (
            String(current.state) === 'importing' ||
            !isAppendOnlyDescriptor(prior, descriptor)
          )
            throw error(
              'registered plugin descriptor or legacy source changed',
              'PLUGIN_DB_DESCRIPTOR_DRIFT',
            );
          if (String(current.state) === 'active')
            return upgradeActiveDescriptor(
              input.pluginId,
              prior,
              descriptor,
              digest,
            );
          metadata(() =>
            db
              .prepare(
                'UPDATE plugin_storage SET descriptor_digest=?, descriptor_json=?, updated_at=? WHERE plugin_id=?',
              )
              .run(digest, canonical(descriptor), now(), input.pluginId),
          );
          return metadataFor(input.pluginId);
        }
        return rowMetadata(current);
      }
      metadata(() =>
        db
          .prepare(
            `INSERT INTO plugin_storage(plugin_id,state,descriptor_digest,descriptor_json,legacy_path,generation,updated_at)
        VALUES (?, 'registered', ?, ?, ?, 0, ?)`,
          )
          .run(
            input.pluginId,
            digest,
            canonical(descriptor),
            legacyPath,
            now(),
          ),
      );
      return metadataFor(input.pluginId);
    },
    preparePluginStorage: async (input) => {
      const storedMetadata = metadataFor(input.pluginId);
      if (
        input.descriptor &&
        descriptorDigest(parseDatabaseDescriptor(input.descriptor)) !==
          storedMetadata.descriptorDigest
      ) {
        throw error(
          'plugin descriptor differs from the registered immutable descriptor',
          'PLUGIN_DB_DESCRIPTOR_DRIFT',
        );
      }
      if (
        input.legacyPath &&
        path.resolve(input.legacyPath) !== storedMetadata.legacyPath
      ) {
        throw error(
          'plugin legacy path differs from the host-derived registered path',
          'PLUGIN_DB_LEGACY_PATH_DRIFT',
        );
      }
      return storedMetadata;
    },
    open: async (input) => {
      const current = metadataFor(input.pluginId);
      if (current.state !== 'active')
        throw error(
          `plugin namespace is unavailable while ${current.state}`,
          'PLUGIN_DB_IMPORT_INCOMPLETE',
        );
      if (
        input.owner.kind !== 'plugin' ||
        input.owner.extensionId !== input.pluginId
      )
        throw error(
          'plugin owner does not match registered id',
          'PLUGIN_DB_OWNER_INVALID',
        );
      const descriptor = descriptorFor(input.pluginId);
      return {
        pluginId: input.pluginId,
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
      };
    },
    migrate: async (input) => {
      const metadataRecord = metadataFor(input.pluginId);
      if (
        metadataRecord.state !== 'active' &&
        metadataRecord.state !== 'registered' &&
        metadataRecord.state !== 'importing'
      )
        throw error(
          'plugin namespace is not migratable in its current state',
          'PLUGIN_DB_IMPORT_INCOMPLETE',
        );
      const descriptor = descriptorFor(input.pluginId);
      const module = descriptor.modules.find(
        (candidate) => candidate.name === input.module,
      );
      const migration = module?.migrations.find(
        (candidate) => candidate.version === input.version,
      );
      if (
        !migration ||
        canonical(migration.statements) !== canonical(input.statements)
      )
        throw error(
          'migration statements do not exactly match registered descriptor',
          'PLUGIN_MIGRATION_NOT_REGISTERED',
        );
      const formatted = migration.statements.map((statement) =>
        formatPluginSql(
          input.pluginId,
          statement,
          descriptor.objects.map((object) => object.name),
        ),
      );
      const currentVersion = metadata(
        () =>
          db
            .prepare(
              'SELECT version, statements_digest FROM plugin_schema_versions WHERE plugin_id=? AND module_name=?',
            )
            .get(input.pluginId, input.module) as
            | { version?: number; statements_digest?: string }
            | undefined,
      );
      const pending = metadata(
        () =>
          db
            .prepare(
              'SELECT statement_sql FROM plugin_deferred_migrations WHERE plugin_id=? AND module_name=? AND version=? ORDER BY statement_index',
            )
            .all(input.pluginId, input.module, input.version) as Array<{
            statement_sql: string;
          }>,
      );
      if (!input.deferTriggers && pending.length) {
        setSchemaMode(true);
        try {
          withTransaction(
            () => {
              for (const row of pending) {
                resetAuthorizer();
                db.exec(row.statement_sql);
              }
              metadata(() =>
                db
                  .prepare(
                    'DELETE FROM plugin_deferred_migrations WHERE plugin_id=? AND module_name=? AND version=?',
                  )
                  .run(input.pluginId, input.module, input.version),
              );
            },
            { pluginId: input.pluginId, descriptor },
          );
        } finally {
          setSchemaMode(false);
        }
      }
      if (currentVersion && Number(currentVersion.version) > input.version)
        return;
      if (
        currentVersion &&
        Number(currentVersion.version) === input.version &&
        currentVersion.statements_digest === statementsDigest(input.statements)
      )
        return;
      if (currentVersion && Number(currentVersion.version) === input.version)
        throw error(
          'applied migration ledger differs from the registered migration',
          'PLUGIN_MIGRATION_LEDGER_MISMATCH',
        );
      setSchemaMode(true);
      try {
        withTransaction(
          () => {
            for (const [index, statement] of formatted.entries()) {
              if (
                input.deferTriggers &&
                /^\s*CREATE\s+TRIGGER\b/i.test(statement)
              ) {
                metadata(() =>
                  db
                    .prepare(
                      'INSERT OR REPLACE INTO plugin_deferred_migrations(plugin_id,module_name,version,statement_index,statement_sql) VALUES (?,?,?,?,?)',
                    )
                    .run(
                      input.pluginId,
                      input.module,
                      input.version,
                      index,
                      statement,
                    ),
                );
                continue;
              }
              resetAuthorizer();
              db.exec(statement);
            }
            metadata(() =>
              db
                .prepare(
                  `INSERT INTO plugin_schema_versions(plugin_id,module_name,version,statements_digest)
            VALUES (?, ?, ?, ?) ON CONFLICT(plugin_id,module_name) DO UPDATE SET version=excluded.version, statements_digest=excluded.statements_digest`,
                )
                .run(
                  input.pluginId,
                  input.module,
                  input.version,
                  statementsDigest(input.statements),
                ),
            );
          },
          { pluginId: input.pluginId, descriptor },
        );
      } finally {
        setSchemaMode(false);
      }
    },
    diagnostics: metadataWithProgress,
    setImporting: async (pluginId, progress) => {
      withTransaction(() => {
        const current = metadataFor(pluginId);
        if (current.state === 'active') return;
        metadata(() => {
          db.prepare(
            "UPDATE plugin_storage SET state = 'importing', updated_at = ? WHERE plugin_id = ?",
          ).run(now(), pluginId);
          db.prepare(
            `INSERT INTO plugin_import_progress(plugin_id,source_identity,snapshot_path,descriptor_digest,module_name,table_name,last_key,rows_copied,source_digest,target_digest,updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(plugin_id) DO UPDATE SET source_identity=excluded.source_identity,snapshot_path=excluded.snapshot_path,descriptor_digest=excluded.descriptor_digest,module_name=excluded.module_name,table_name=excluded.table_name,last_key=excluded.last_key,rows_copied=excluded.rows_copied,source_digest=excluded.source_digest,target_digest=excluded.target_digest,updated_at=excluded.updated_at`,
          ).run(
            pluginId,
            progress.sourceIdentity,
            progress.snapshotPath,
            progress.descriptorDigest,
            progress.moduleName,
            progress.tableName,
            progress.lastKey,
            progress.rowsCopied,
            progress.sourceDigest,
            progress.targetDigest,
            now(),
          );
        });
      });
    },
    saveImportProgress: async (progress) => {
      withTransaction(() => {
        const current = metadataFor(progress.pluginId);
        if (current.state !== 'importing')
          throw error(
            'plugin import is not active',
            'PLUGIN_DB_IMPORT_STATE_INVALID',
          );
        if (current.descriptorDigest !== progress.descriptorDigest)
          throw error(
            'plugin descriptor changed during import',
            'PLUGIN_DB_IMPORT_DESCRIPTOR_CHANGED',
          );
        metadata(() =>
          db
            .prepare(
              `UPDATE plugin_import_progress SET source_identity=?,snapshot_path=?,descriptor_digest=?,module_name=?,table_name=?,last_key=?,rows_copied=?,source_digest=?,target_digest=?,updated_at=? WHERE plugin_id=?`,
            )
            .run(
              progress.sourceIdentity,
              progress.snapshotPath,
              progress.descriptorDigest,
              progress.moduleName,
              progress.tableName,
              progress.lastKey,
              progress.rowsCopied,
              progress.sourceDigest,
              progress.targetDigest,
              now(),
              progress.pluginId,
            ),
        );
      });
    },
    completeImport: async (pluginId) => {
      const result = withTransaction(() => {
        const current = metadataFor(pluginId);
        if (current.state !== 'importing' && current.state !== 'registered')
          throw error(
            'plugin import cannot be activated from its current state',
            'PLUGIN_DB_IMPORT_STATE_INVALID',
          );
        metadata(() => {
          db.prepare(
            "UPDATE plugin_storage SET state = 'active', generation = generation + 1, updated_at = ? WHERE plugin_id = ?",
          ).run(now(), pluginId);
          db.prepare(
            'DELETE FROM plugin_import_progress WHERE plugin_id = ?',
          ).run(pluginId);
        });
        return metadataFor(pluginId);
      });
      return result;
    },
    atomic: withTransaction,
    descriptor: descriptorFor,
    physicalName: (pluginId, logicalName) =>
      pluginIdentifier(pluginId, logicalName).replaceAll('"', ''),
    reset: async (pluginId) => {
      withTransaction(() => {
        const current = metadataFor(pluginId);
        metadata(() => {
          db.prepare(
            "UPDATE plugin_storage SET state = 'tombstoned', generation = generation + 1, updated_at = ? WHERE plugin_id = ?",
          ).run(now(), pluginId);
          db.prepare(
            'DELETE FROM plugin_import_progress WHERE plugin_id = ?',
          ).run(pluginId);
        });
        void current;
      });
    },
    close: async () => {
      db.close();
    },
    host: <T>(
      work: (connection: SqliteDatabase) => T,
      scope?: { pluginId: string; descriptor: PluginDatabaseDescriptor },
    ): T => {
      if (scope)
        setOwnedObjects(
          scope.descriptor.objects.map((object) =>
            pluginIdentifier(scope.pluginId, object.name).replaceAll('"', ''),
          ),
        );
      resetAuthorizer();
      setMetadataMode(true);
      try {
        return work(db);
      } finally {
        setMetadataMode(false);
        setOwnedObjects([]);
      }
    },
    assertImportInput: (pluginId, descriptor, legacyPath) => {
      const storedMetadata = metadataFor(pluginId);
      const verified = parseDatabaseDescriptor(descriptor);
      if (descriptorDigest(verified) !== storedMetadata.descriptorDigest)
        throw error(
          'import descriptor differs from registered immutable descriptor',
          'PLUGIN_DB_IMPORT_DESCRIPTOR_CHANGED',
        );
      if (path.resolve(legacyPath) !== storedMetadata.legacyPath)
        throw error(
          'import source differs from host-derived registered legacy path',
          'PLUGIN_DB_IMPORT_SOURCE_CHANGED',
        );
      if (storedMetadata.state === 'active') return storedMetadata;
      if (
        storedMetadata.state === 'reset' ||
        storedMetadata.state === 'tombstoned'
      )
        throw error(
          'plugin storage has a reset tombstone and cannot be reimported automatically',
          'PLUGIN_DB_RESET_TOMBSTONE',
        );
      return storedMetadata;
    },
    validateSchema: async (pluginId) =>
      validateSchemaInternal(pluginId, descriptorFor(pluginId)),
  };
}

export function legacyPathForProfile(profileDir: string): string {
  return path.join(profileDir, 'private.db');
}
