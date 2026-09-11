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

  it('keeps core schema metadata and transaction control outside descriptor authority', async () => {
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
                'CREATE TABLE {{items}} (name TEXT)',
                'INSERT INTO {{items}} SELECT name FROM sqlite_master',
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['name'] }] },
    });
    const metadataRegistry = await registryFor(
      db,
      file,
      'unsafe.sqlite-master',
      metadataDescriptor,
    );
    await expect(
      metadataRegistry.migrate({
        pluginId: 'unsafe.sqlite-master',
        module: 'base',
        version: 0,
        statements: metadataDescriptor.modules[0].migrations[0].statements,
      }),
    ).rejects.toThrow(/not authorized|prohibited|denied/i);

    const transactionDescriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'items', kind: 'table' },
        { name: 'later', kind: 'table' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id INTEGER)',
                'COMMIT',
                'CREATE TABLE {{later}} (id INTEGER)',
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['id'] }] },
    });
    const transactionRegistry = await registryFor(
      db,
      file,
      'unsafe.transaction',
      transactionDescriptor,
    );
    await expect(
      transactionRegistry.migrate({
        pluginId: 'unsafe.transaction',
        module: 'base',
        version: 0,
        statements: transactionDescriptor.modules[0].migrations[0].statements,
      }),
    ).rejects.toThrow(/transaction|not authorized|active/i);
    const transactionPhysical = transactionRegistry.physicalName(
      'unsafe.transaction',
      'items',
    );
    expect(
      db
        .prepare('SELECT name FROM sqlite_master WHERE name = ?')
        .all(transactionPhysical),
    ).toEqual([]);
  });

  it('compiles all INSTEAD OF view trigger bodies before activation', async () => {
    db.exec(
      "CREATE TABLE core_secret (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO core_secret(id, value) VALUES (1, 'untouched')",
    );
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'items', kind: 'table' },
        { name: 'item_view', kind: 'view' },
        { name: 'view_insert', kind: 'trigger' },
        { name: 'view_update', kind: 'trigger' },
        { name: 'view_delete', kind: 'trigger' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id INTEGER PRIMARY KEY, value TEXT)',
                'CREATE VIEW {{item_view}} AS SELECT id, value FROM {{items}}',
                "CREATE TRIGGER {{view_insert}} INSTEAD OF INSERT ON {{item_view}} BEGIN UPDATE core_secret SET value = 'inserted'; END",
                "CREATE TRIGGER {{view_update}} INSTEAD OF UPDATE ON {{item_view}} BEGIN UPDATE core_secret SET value = 'updated'; END",
                "CREATE TRIGGER {{view_delete}} INSTEAD OF DELETE ON {{item_view}} BEGIN UPDATE core_secret SET value = 'deleted'; END",
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['id', 'value'] }] },
    });
    const registry = await registryFor(
      db,
      file,
      'unsafe.view-trigger',
      descriptor,
    );
    let migrationFailed = false;
    try {
      await registry.migrate({
        pluginId: 'unsafe.view-trigger',
        module: 'base',
        version: 0,
        statements: descriptor.modules[0].migrations[0].statements,
      });
    } catch {
      migrationFailed = true;
    }
    if (!migrationFailed)
      await expect(
        registry.validateSchema('unsafe.view-trigger'),
      ).rejects.toThrow(/not authorized|prohibited|reference|schema/i);
    expect(db.prepare('SELECT value FROM core_secret').all()).toEqual([
      { value: 'untouched' },
    ]);
  });

  it('applies append-only schema upgrades before exposing new objects and honors tombstones', async () => {
    const v1 = parseDatabaseDescriptor({
      format: 1,
      objects: [{ name: 'items', kind: 'table' }],
      modules: [
        {
          name: 'base',
          migrations: [
            { version: 0, statements: ['CREATE TABLE {{items}} (id INTEGER)'] },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['id'] }] },
    });
    const v2 = parseDatabaseDescriptor({
      ...v1,
      objects: [...v1.objects, { name: 'extras', kind: 'table' }],
      modules: [
        {
          ...v1.modules[0],
          migrations: [
            ...v1.modules[0].migrations,
            {
              version: 1,
              statements: ['CREATE TABLE {{extras}} (id INTEGER)'],
            },
          ],
        },
      ],
    });
    const registry = await registryFor(db, file, 'upgrade.plugin', v1);
    await registry.migrate({
      pluginId: 'upgrade.plugin',
      module: 'base',
      version: 0,
      statements: v1.modules[0].migrations[0].statements,
    });
    await registry.completeImport('upgrade.plugin');
    await expect(
      registry.register({
        pluginId: 'upgrade.plugin',
        descriptor: v2,
        legacyPath: file,
      }),
    ).resolves.toEqual(expect.objectContaining({ state: 'active' }));
    await expect(
      registry.preparePluginStorage({
        pluginId: 'upgrade.plugin',
        descriptor: v2,
      }),
    ).resolves.toEqual(expect.objectContaining({ state: 'active' }));
    await expect(
      registry.validateSchema('upgrade.plugin'),
    ).resolves.toBeUndefined();

    const tombstoneRegistry = await registryFor(
      db,
      file,
      'tombstone.plugin',
      v1,
    );
    await tombstoneRegistry.migrate({
      pluginId: 'tombstone.plugin',
      module: 'base',
      version: 0,
      statements: v1.modules[0].migrations[0].statements,
    });
    await tombstoneRegistry.completeImport('tombstone.plugin');
    await tombstoneRegistry.reset('tombstone.plugin');
    await expect(
      tombstoneRegistry.register({
        pluginId: 'tombstone.plugin',
        descriptor: v2,
        legacyPath: file,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_RESET_TOMBSTONE' });
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

  it('allows the registered text cleanup functions used by host migrations', async () => {
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [{ name: 'items', kind: 'table' }],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (value TEXT, cleaned TEXT)',
                "INSERT INTO {{items}}(value, cleaned) VALUES ('  Alpha  ', rtrim(trim('  Beta  '), replace('x', 'x', ''))) ",
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['value', 'cleaned'] }] },
    });
    const registry = await registryFor(db, file, 'text-cleanup', descriptor);
    await expect(
      registry.migrate({
        pluginId: 'text-cleanup',
        module: 'base',
        version: 0,
        statements: descriptor.modules[0].migrations[0].statements,
      }),
    ).resolves.toBeUndefined();
    expect(
      registry.host(
        (connection) =>
          connection
            .prepare(
              'SELECT value, cleaned FROM "p_746578742d636c65616e7570__items"',
            )
            .all(),
        { pluginId: 'text-cleanup', descriptor },
      ),
    ).toEqual([{ value: '  Alpha  ', cleaned: 'Beta' }]);
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
