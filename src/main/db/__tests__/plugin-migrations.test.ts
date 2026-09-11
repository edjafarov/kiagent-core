/** @jest-environment node */
import Database from 'better-sqlite3';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { parseDatabaseDescriptor } from '@main/platform/database-descriptor';
import {
  createPluginRegistry,
  type PluginStorageMetadata,
} from '../plugin-registry';
import { DESCRIPTOR } from './plugin-test-fixture';

function tempDbPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
}

function closeAndRemove(db: Database.Database, file: string): void {
  db.close();
  for (const candidate of [file, `${file}-wal`, `${file}-shm`])
    if (fs.existsSync(candidate)) fs.rmSync(candidate);
}

describe('registered plugin schema registry', () => {
  let file: string;
  let db: Database.Database;

  beforeEach(() => {
    file = tempDbPath('kiagent-plugin-registry');
    db = new Database(file);
  });

  afterEach(() => closeAndRemove(db, file));

  it('registers a descriptor and returns immutable verified metadata before an owner can open', async () => {
    const registry = createPluginRegistry(db, { filename: file });
    const metadata = await registry.register({
      pluginId: 'people.contacts',
      descriptor: DESCRIPTOR,
      legacyPath: path.join(path.dirname(file), 'private.db'),
    });

    expect(metadata).toEqual(
      expect.objectContaining<Partial<PluginStorageMetadata>>({
        pluginId: 'people.contacts',
        state: 'registered',
        legacyPath: expect.any(String),
      }),
    );
    await expect(
      registry.open({
        pluginId: 'people.contacts',
        owner: {
          kind: 'plugin',
          extensionId: 'people.contacts',
          handle: 'owner-1',
        },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_IMPORT_INCOMPLETE' });
  });

  it('rejects descriptor drift and unowned foreign-key targets at registration', async () => {
    const registry = createPluginRegistry(db, { filename: file });
    const unownedFk = parseDatabaseDescriptor({
      ...DESCRIPTOR,
      modules: [
        {
          ...DESCRIPTOR.modules[0],
          migrations: [
            {
              ...DESCRIPTOR.modules[0].migrations[0],
              statements: [
                ...DESCRIPTOR.modules[0].migrations[0].statements,
                'CREATE TABLE {{foreign_child}} (id TEXT REFERENCES core_table(id))',
              ],
            },
          ],
        },
      ],
      objects: [
        ...DESCRIPTOR.objects,
        { name: 'foreign_child', kind: 'table' },
      ],
      legacy: DESCRIPTOR.legacy,
    });

    await expect(
      registry.register({
        pluginId: 'people.contacts',
        descriptor: DESCRIPTOR,
        legacyPath: file,
      }),
    ).resolves.toBeDefined();
    const unsafeRegistry = createPluginRegistry(db, { filename: file });
    await expect(
      unsafeRegistry.register({
        pluginId: 'unsafe.foreign',
        descriptor: unownedFk,
        legacyPath: file,
      }),
    ).rejects.toThrow(/descriptor|drift|foreign/i);
  });

  it('keeps schema DDL host-owned and validates exact registered migration statements', async () => {
    const registry = createPluginRegistry(db, { filename: file });
    await registry.register({
      pluginId: 'people.contacts',
      descriptor: DESCRIPTOR,
      legacyPath: '/tmp/private.db',
    });
    await expect(
      registry.migrate({
        pluginId: 'people.contacts',
        module: 'base',
        version: 0,
        statements: [
          'CREATE TABLE {{profiles}} (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, rank INTEGER NOT NULL)',
          'CREATE TABLE {{user_overrides}} (profile_id TEXT PRIMARY KEY REFERENCES {{profiles}}(id), value TEXT NOT NULL)',
          'CREATE TABLE {{jobs}} (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES {{profiles}}(id), status TEXT NOT NULL, payload BLOB)',
          'CREATE TABLE {{schema_meta}} (module TEXT PRIMARY KEY, version INTEGER NOT NULL)',
        ],
      }),
    ).resolves.toBeUndefined();
    await expect(
      registry.migrate({
        pluginId: 'people.contacts',
        module: 'base',
        version: 1,
        statements: ['CREATE TABLE core_owned (id INTEGER)'],
      }),
    ).rejects.toThrow(/registered|exact|migration/i);
  });

  it('rejects descriptor SQL that targets registry metadata or another plugin sequence', async () => {
    const registry = createPluginRegistry(db, { filename: file });
    const metadataDescriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [{ name: 'items', kind: 'table' }],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id INTEGER)',
                "INSERT INTO plugin_storage(plugin_id, state, descriptor_digest, descriptor_json, legacy_path, updated_at) VALUES ('attack', 'active', 'x', '{}', '/tmp/x', 'now')",
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['id'] }] },
    });
    await registry.register({
      pluginId: 'unsafe.metadata',
      descriptor: metadataDescriptor,
      legacyPath: file,
    });
    await expect(
      registry.migrate({
        pluginId: 'unsafe.metadata',
        module: 'base',
        version: 0,
        statements: metadataDescriptor.modules[0].migrations[0].statements,
      }),
    ).rejects.toThrow(/not authorized|prohibited|denied/i);

    const sequenceDescriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [{ name: 'jobs', kind: 'table' }],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{jobs}} (id INTEGER PRIMARY KEY AUTOINCREMENT)',
                "INSERT INTO sqlite_sequence(name, seq) VALUES ('p_other__jobs', 999)",
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'jobs', columns: ['id'] }] },
    });
    await registry.register({
      pluginId: 'unsafe.sequence',
      descriptor: sequenceDescriptor,
      legacyPath: file,
    });
    await expect(
      registry.migrate({
        pluginId: 'unsafe.sequence',
        module: 'base',
        version: 0,
        statements: sequenceDescriptor.modules[0].migrations[0].statements,
      }),
    ).rejects.toThrow(/not authorized|prohibited|denied/i);
  });

  it('rejects fresh cross-core foreign-key, trigger, and view bodies through native validation', async () => {
    db.exec(
      "CREATE TABLE core_secret (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO core_secret(id, value) VALUES (1, 'untouched')",
    );
    const unsafeFk = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'items', kind: 'table' },
        { name: 'core_secret', kind: 'table' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id INTEGER REFERENCES core_secret(id))',
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['id'] }] },
    });
    const fkRegistry = await registryFor(db, file, 'unsafe.fk', unsafeFk);
    await fkRegistry.migrate({
      pluginId: 'unsafe.fk',
      module: 'base',
      version: 0,
      statements: unsafeFk.modules[0].migrations[0].statements,
    });
    await expect(fkRegistry.validateSchema('unsafe.fk')).rejects.toThrow(
      /not authorized|prohibited|denied|schema|reference/i,
    );

    const triggerDescriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'items', kind: 'table' },
        { name: 'bad_trigger', kind: 'trigger' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id INTEGER)',
                "CREATE TRIGGER {{bad_trigger}} AFTER INSERT ON {{items}} BEGIN UPDATE core_secret SET value = 'changed'; END",
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['id'] }] },
    });
    const triggerRegistry = await registryFor(
      db,
      file,
      'unsafe.trigger',
      triggerDescriptor,
    );
    let triggerMigrationFailed = false;
    try {
      await triggerRegistry.migrate({
        pluginId: 'unsafe.trigger',
        module: 'base',
        version: 0,
        statements: triggerDescriptor.modules[0].migrations[0].statements,
      });
    } catch {
      triggerMigrationFailed = true;
    }
    if (!triggerMigrationFailed)
      await expect(
        triggerRegistry.validateSchema('unsafe.trigger'),
      ).rejects.toThrow(/not authorized|prohibited|reference|schema/i);

    const viewDescriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'items', kind: 'table' },
        { name: 'bad_view', kind: 'view' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id INTEGER)',
                'CREATE VIEW {{bad_view}} AS SELECT value FROM core_secret',
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['id'] }] },
    });
    const viewRegistry = await registryFor(
      db,
      file,
      'unsafe.view',
      viewDescriptor,
    );
    let viewMigrationFailed = false;
    try {
      await viewRegistry.migrate({
        pluginId: 'unsafe.view',
        module: 'base',
        version: 0,
        statements: viewDescriptor.modules[0].migrations[0].statements,
      });
    } catch {
      viewMigrationFailed = true;
    }
    if (!viewMigrationFailed)
      await expect(viewRegistry.validateSchema('unsafe.view')).rejects.toThrow(
        /not authorized|prohibited|reference|schema/i,
      );
    expect(db.prepare('SELECT value FROM core_secret').all()).toEqual([
      { value: 'untouched' },
    ]);
  });
});

async function registryFor(
  db: Database.Database,
  file: string,
  pluginId: string,
  descriptor: import('@main/platform/database-descriptor').PluginDatabaseDescriptor,
) {
  const registry = createPluginRegistry(db, { filename: file });
  await registry.register({ pluginId, descriptor, legacyPath: file });
  return registry;
}
