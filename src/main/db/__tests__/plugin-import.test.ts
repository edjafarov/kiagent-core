/** @jest-environment node */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDatabaseDescriptor } from '@main/platform/database-descriptor';
import { createPluginRegistry } from '../plugin-registry';
import {
  importLegacyPluginStorage,
  type PluginImportProgress,
} from '../plugin-import';
import { DESCRIPTOR } from './plugin-test-fixture';

function tempPath(prefix: string): string {
  return path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
}

function createLegacyFixture(file: string): {
  db: Database.Database;
  rows: Record<string, unknown>[];
} {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, rank INTEGER NOT NULL);
    CREATE TABLE user_overrides (profile_id TEXT PRIMARY KEY REFERENCES profiles(id), value TEXT NOT NULL);
    CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profiles(id), status TEXT NOT NULL, payload BLOB);
    CREATE TABLE schema_meta (module TEXT PRIMARY KEY, version INTEGER NOT NULL);
  `);
  db.prepare('INSERT INTO schema_meta(module, version) VALUES (?, ?)').run(
    'base',
    0,
  );
  db.prepare(
    'INSERT INTO profiles(id, name, email, rank) VALUES (?, ?, ?, ?)',
  ).run('p-1', 'Ada', 'ada@example.test', 1);
  db.prepare('INSERT INTO user_overrides(profile_id, value) VALUES (?, ?)').run(
    'p-1',
    'edited by user',
  );
  db.prepare(
    'INSERT INTO jobs(profile_id, status, payload) VALUES (?, ?, ?)',
  ).run('p-1', 'queued', Buffer.from([1, 2, 3]));
  db.prepare('INSERT INTO jobs(id, profile_id, status) VALUES (?, ?, ?)').run(
    900,
    'p-1',
    'discarded',
  );
  db.prepare('DELETE FROM jobs WHERE id = ?').run(900);

  // Keep authoritative rows in the source WAL. The importer must copy the
  // database together with this WAL and retain the same snapshot on resume.
  const writer = db.transaction(() => {
    db.prepare(
      'INSERT INTO profiles(id, name, email, rank) VALUES (?, ?, ?, ?)',
    ).run('p-2', 'Grace', 'grace@example.test', 2);
    db.prepare(
      'INSERT INTO user_overrides(profile_id, value) VALUES (?, ?)',
    ).run('p-2', 'queued override');
    db.prepare(
      'INSERT INTO jobs(profile_id, status, payload) VALUES (?, ?, ?)',
    ).run('p-2', 'processing', Buffer.from([9, 8, 7]));
  });
  writer();

  const rows = db
    .prepare('SELECT id, name, email, rank FROM profiles ORDER BY id')
    .all() as Record<string, unknown>[];
  return { db, rows };
}

function rowidDescriptor() {
  return parseDatabaseDescriptor({
    format: 1,
    objects: [{ name: 'items', kind: 'table' }],
    modules: [
      {
        name: 'base',
        migrations: [
          {
            version: 0,
            statements: [
              'CREATE TABLE {{items}} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
            ],
          },
        ],
      },
    ],
    legacy: { tables: [{ name: 'items', columns: ['id', 'payload'] }] },
  });
}

describe('registered legacy plugin import', () => {
  let sourceFile: string;
  let targetFile: string;
  let source: Database.Database;
  let target: Database.Database;

  beforeEach(() => {
    sourceFile = tempPath('kiagent-legacy-private');
    targetFile = tempPath('kiagent-shared-target');
    ({ db: source } = createLegacyFixture(sourceFile));
    target = new Database(targetFile);
    target.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    for (const db of [source, target]) db.close();
    for (const file of [sourceFile, targetFile]) {
      for (const candidate of [file, `${file}-wal`, `${file}-shm`])
        if (fs.existsSync(candidate)) fs.rmSync(candidate);
    }
  });

  it('resumes after an interruption without opening a partial namespace', async () => {
    const registry = createPluginRegistry(target, { filename: targetFile });
    registry.register({
      pluginId: 'people.contacts',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    let chunks = 0;
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'people.contacts',
        descriptor: DESCRIPTOR,
        legacyPath: sourceFile,
        afterChunk(progress: PluginImportProgress) {
          chunks++;
          if (chunks === 1) throw new Error('test interruption');
          void progress;
        },
      }),
    ).rejects.toThrow('test interruption');
    expect(registry.diagnostics('people.contacts')).toEqual(
      expect.objectContaining({ state: 'importing' }),
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

    await importLegacyPluginStorage(registry, {
      pluginId: 'people.contacts',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    const imported = target
      .prepare(
        'SELECT id, name, email, rank FROM "p_70656f706c652e636f6e7461637473__profiles" ORDER BY id',
      )
      .all();
    expect(imported).toEqual([
      { id: 'p-1', name: 'Ada', email: 'ada@example.test', rank: 1 },
      { id: 'p-2', name: 'Grace', email: 'grace@example.test', rank: 2 },
    ]);
    expect(registry.diagnostics('people.contacts')).toEqual(
      expect.objectContaining({ state: 'active' }),
    );
    expect(fs.existsSync(sourceFile)).toBe(true);
  });

  it('rejects pre-existing target rows before applying bootstrap migrations', async () => {
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'people.nonempty',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    await registry.migrate({
      pluginId: 'people.nonempty',
      module: 'base',
      version: 0,
      statements: DESCRIPTOR.modules[0].migrations[0].statements,
    });
    target
      .prepare(
        'INSERT INTO "p_70656f706c652e6e6f6e656d707479__profiles" VALUES (?, ?, ?, ?)',
      )
      .run('existing', 'Existing', 'existing@example.test', 1);
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'people.nonempty',
        descriptor: DESCRIPTOR,
        legacyPath: sourceFile,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_TARGET_NONEMPTY' });
    expect(registry.diagnostics('people.nonempty').state).toBe('registered');
  });

  it('preserves user overrides, queued and processing jobs, foreign keys and AUTOINCREMENT high water mark', async () => {
    const registry = createPluginRegistry(target, { filename: targetFile });
    registry.register({
      pluginId: 'people.contacts',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    await importLegacyPluginStorage(registry, {
      pluginId: 'people.contacts',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    const prefix = 'p_70656f706c652e636f6e7461637473__';
    expect(
      target
        .prepare(
          `SELECT profile_id, value FROM "${prefix}user_overrides" ORDER BY profile_id`,
        )
        .all(),
    ).toEqual([
      { profile_id: 'p-1', value: 'edited by user' },
      { profile_id: 'p-2', value: 'queued override' },
    ]);
    expect(
      target
        .prepare(
          `SELECT profile_id, status, hex(payload) AS payload FROM "${prefix}jobs" ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { profile_id: 'p-1', status: 'queued', payload: '010203' },
      { profile_id: 'p-2', status: 'queued', payload: '090807' },
    ]);
    expect(
      target
        .prepare(`PRAGMA foreign_key_check("${prefix}user_overrides")`)
        .all(),
    ).toEqual([]);
    expect(
      target
        .prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`)
        .all(`${prefix}jobs`),
    ).toEqual([{ seq: 901 }]);
    expect(
      target
        .prepare(
          `INSERT INTO "${prefix}jobs"(profile_id, status) VALUES (?, ?)`,
        )
        .run('p-1', 'queued').lastInsertRowid,
    ).toBe(902);
  });

  it('rejects a changed source identity and leaves the import resumable for recovery', async () => {
    const registry = createPluginRegistry(target, { filename: targetFile });
    registry.register({
      pluginId: 'people.contacts',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'people.contacts',
        descriptor: DESCRIPTOR,
        legacyPath: sourceFile,
        afterChunk: () => {
          throw new Error('test interruption');
        },
      }),
    ).rejects.toThrow();
    source.close();
    fs.renameSync(sourceFile, `${sourceFile}.moved`);
    fs.renameSync(`${sourceFile}.moved`, sourceFile);
    const changed = new Database(sourceFile);
    changed.pragma('journal_mode = WAL');
    changed
      .prepare(
        'INSERT INTO profiles(id, name, email, rank) VALUES (?, ?, ?, ?)',
      )
      .run('p-3', 'Changed', 'changed@example.test', 3);
    changed.close();
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'people.contacts',
        descriptor: DESCRIPTOR,
        legacyPath: sourceFile,
      }),
    ).rejects.toMatchObject({
      code: 'PLUGIN_DB_IMPORT_SOURCE_CHANGED',
    });
  });

  it('does not trust a partially published snapshot artifact on resume', async () => {
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'snapshot.integrity',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    await expect(
      importLegacyPluginStorage(
        registry,
        {
          pluginId: 'snapshot.integrity',
          descriptor: DESCRIPTOR,
          legacyPath: sourceFile,
        },
        {
          chunkSize: 1,
          afterChunk: () => {
            throw new Error('snapshot interruption');
          },
        },
      ),
    ).rejects.toThrow('snapshot interruption');
    const { progress } = registry.diagnostics('snapshot.integrity');
    expect(progress?.snapshotPath).toBeTruthy();
    fs.writeFileSync(progress!.snapshotPath, 'incomplete backup');
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'snapshot.integrity',
        descriptor: DESCRIPTOR,
        legacyPath: sourceFile,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_IMPORT_SNAPSHOT_INVALID' });
    if (fs.existsSync(progress!.snapshotPath))
      fs.rmSync(progress!.snapshotPath);
  });

  it('cleans an interrupted native snapshot before progress publication', async () => {
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'snapshot.before-publish',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    let temporaryPath = '';
    let finalPath = '';
    await expect(
      importLegacyPluginStorage(
        registry,
        {
          pluginId: 'snapshot.before-publish',
          descriptor: DESCRIPTOR,
          legacyPath: sourceFile,
        },
        {
          beforeSnapshotPublish(temporary, snapshot) {
            temporaryPath = temporary;
            finalPath = snapshot;
            throw new Error('snapshot publication interruption');
          },
        },
      ),
    ).rejects.toThrow('snapshot publication interruption');
    expect(fs.existsSync(temporaryPath)).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(registry.diagnostics('snapshot.before-publish').state).toBe(
      'registered',
    );
    expect(
      registry.diagnostics('snapshot.before-publish').progress,
    ).toBeUndefined();

    await importLegacyPluginStorage(registry, {
      pluginId: 'snapshot.before-publish',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    expect(registry.diagnostics('snapshot.before-publish').state).toBe(
      'active',
    );
  });

  it('rejects a source whose old version contains a later registered column', async () => {
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'items', kind: 'table' },
        { name: 'schema_meta', kind: 'table' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id INTEGER PRIMARY KEY, name TEXT)',
                'CREATE TABLE {{schema_meta}} (module TEXT PRIMARY KEY, version INTEGER NOT NULL)',
              ],
            },
            {
              version: 1,
              statements: ['ALTER TABLE {{items}} ADD COLUMN note TEXT'],
            },
          ],
        },
      ],
      legacy: {
        tables: [
          { name: 'items', columns: ['id', 'name', 'note'] },
          { name: 'schema_meta', columns: ['module', 'version'] },
        ],
        versionTable: 'schema_meta',
      },
    });
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source.exec(
      "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, note TEXT); CREATE TABLE schema_meta (module TEXT PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO schema_meta(module, version) VALUES ('base', 0); INSERT INTO items VALUES (1, 'old', 'future')",
    );
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'legacy.future-column',
      descriptor,
      legacyPath: sourceFile,
    });
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'legacy.future-column',
        descriptor,
        legacyPath: sourceFile,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH' });
  });

  it('rejects an unregistered source version gap before copying rows', async () => {
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'items', kind: 'table' },
        { name: 'schema_meta', kind: 'table' },
        { name: 'items_index', kind: 'index' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id INTEGER PRIMARY KEY)',
                'CREATE TABLE {{schema_meta}} (module TEXT PRIMARY KEY, version INTEGER NOT NULL)',
              ],
            },
            {
              version: 2,
              statements: ['CREATE INDEX {{items_index}} ON {{items}} (id)'],
            },
          ],
        },
      ],
      legacy: {
        tables: [
          { name: 'items', columns: ['id'] },
          { name: 'schema_meta', columns: ['module', 'version'] },
        ],
        versionTable: 'schema_meta',
      },
    });
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source.exec(
      "CREATE TABLE items (id INTEGER PRIMARY KEY); CREATE TABLE schema_meta (module TEXT PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO schema_meta(module, version) VALUES ('base', 1); INSERT INTO items VALUES (1)",
    );
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'legacy.version-gap',
      descriptor,
      legacyPath: sourceFile,
    });
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'legacy.version-gap',
        descriptor,
        legacyPath: sourceFile,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH' });
  });

  it('rejects unknown legacy columns instead of silently dropping data', async () => {
    source.prepare('ALTER TABLE profiles ADD COLUMN undocumented TEXT').run();
    source.exec('CREATE TABLE undocumented_legacy (id TEXT)');
    expect(
      source
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'undocumented_legacy'",
        )
        .all(),
    ).toEqual([{ name: 'undocumented_legacy' }]);
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'people.contacts',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'people.contacts',
        descriptor: parseDatabaseDescriptor(DESCRIPTOR),
        legacyPath: sourceFile,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_IMPORT_SCHEMA_MISMATCH' });
  });

  it('does not execute ATTACH side effects while reconstructing registered history', async () => {
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    const outside = tempPath('kiagent-import-attach-outside');
    const escapedOutside = outside.replaceAll("'", "''");
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                `ATTACH '${escapedOutside}' AS outside`,
                'CREATE TABLE outside.leaked (value TEXT)',
              ],
            },
          ],
        },
      ],
      legacy: { tables: [] },
    });
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'unsafe.attach',
      descriptor,
      legacyPath: sourceFile,
    });
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'unsafe.attach',
        descriptor,
        legacyPath: sourceFile,
      }),
    ).rejects.toThrow();
    expect(fs.existsSync(outside)).toBe(false);
    for (const candidate of [outside, `${outside}-wal`, `${outside}-shm`])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
  });

  it('persists a mid-table 500-row boundary and resumes through a new registry while core work runs between chunks', async () => {
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source.pragma('journal_mode = WAL');
    source.pragma('foreign_keys = ON');
    source.exec(
      'CREATE TABLE profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, rank INTEGER NOT NULL); CREATE TABLE user_overrides (profile_id TEXT PRIMARY KEY REFERENCES profiles(id), value TEXT NOT NULL); CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profiles(id), status TEXT NOT NULL, payload BLOB); CREATE TABLE schema_meta (module TEXT PRIMARY KEY, version INTEGER NOT NULL);',
    );
    const seed = source.transaction(() => {
      source
        .prepare('INSERT INTO schema_meta(module, version) VALUES (?, ?)')
        .run('base', 0);
      const insert = source.prepare(
        'INSERT INTO profiles(id, name, email, rank) VALUES (?, ?, ?, ?)',
      );
      for (let i = 0; i < 1001; i++)
        insert.run(`large-${i}`, `Large ${i}`, `large-${i}@example.test`, i);
    });
    seed();
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'people.large',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    let firstRunChunks = 0;
    await expect(
      importLegacyPluginStorage(
        registry,
        {
          pluginId: 'people.large',
          descriptor: DESCRIPTOR,
          legacyPath: sourceFile,
          afterChunk(progress) {
            firstRunChunks++;
            if (firstRunChunks === 1)
              throw new Error(`interrupt after ${progress.rowsCopied}`);
          },
        },
        { chunkSize: 500 },
      ),
    ).rejects.toThrow('interrupt after 500');
    expect(registry.diagnostics('people.large')).toEqual(
      expect.objectContaining({
        state: 'importing',
        progress: expect.objectContaining({
          tableName: 'profiles',
          rowsCopied: 500,
        }),
      }),
    );
    expect(
      target
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'p_%'")
        .all(),
    ).toHaveLength(9);
    expect(
      registry
        .host((db) => db.prepare('PRAGMA table_list').all(), {
          pluginId: 'people.large',
          descriptor: DESCRIPTOR,
        })
        .some((row) => row.name === 'p_70656f706c652e6c61726765__profiles'),
    ).toBe(true);

    target.close();
    target = new Database(targetFile);
    target.pragma('journal_mode = WAL');
    target.exec('CREATE TABLE core_between_chunks (marker TEXT NOT NULL)');
    const resumed = createPluginRegistry(target, { filename: targetFile });
    let resumedChunks = 0;
    await importLegacyPluginStorage(
      resumed,
      {
        pluginId: 'people.large',
        descriptor: DESCRIPTOR,
        legacyPath: sourceFile,
        afterChunk(progress) {
          resumedChunks++;
          if (resumedChunks === 1) {
            target
              .prepare('INSERT INTO core_between_chunks(marker) VALUES (?)')
              .run('admitted-between-chunks');
            expect(resumed.diagnostics('people.large')).toEqual(
              expect.objectContaining({
                state: 'importing',
                progress: expect.objectContaining({
                  rowsCopied: progress.rowsCopied,
                }),
              }),
            );
          }
        },
      },
      { chunkSize: 500, admit: async (work) => work() },
    );
    expect(resumedChunks).toBeGreaterThan(1);
    expect(
      target.prepare('SELECT marker FROM core_between_chunks').all(),
    ).toEqual([{ marker: 'admitted-between-chunks' }]);
    expect(
      resumed.host(
        (db) =>
          Number(
            (
              db
                .prepare(
                  'SELECT COUNT(*) AS count FROM "p_70656f706c652e6c61726765__profiles"',
                )
                .get() as { count: bigint }
            ).count,
          ),
        { pluginId: 'people.large', descriptor: DESCRIPTOR },
      ),
    ).toBe(1001);
    expect(
      resumed.host(
        (db) =>
          db
            .prepare(
              'SELECT COUNT(*) AS count, COUNT(DISTINCT id) AS distinct_count FROM "p_70656f706c652e6c61726765__profiles"',
            )
            .get(),
        { pluginId: 'people.large', descriptor: DESCRIPTOR },
      ),
    ).toEqual({ count: 1001n, distinct_count: 1001n });
    expect(resumed.diagnostics('people.large')).toEqual(
      expect.objectContaining({ state: 'active' }),
    );
  });

  it('reconstructs an older registered shape and applies its later column migration', async () => {
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'items', kind: 'table' },
        { name: 'schema_meta', kind: 'table' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
                'CREATE TABLE {{schema_meta}} (module TEXT PRIMARY KEY, version INTEGER NOT NULL)',
              ],
            },
            {
              version: 1,
              statements: [
                "ALTER TABLE {{items}} ADD COLUMN note TEXT NOT NULL DEFAULT 'new'",
              ],
            },
          ],
        },
      ],
      legacy: {
        tables: [
          { name: 'items', columns: ['id', 'name', 'note'] },
          { name: 'schema_meta', columns: ['module', 'version'] },
        ],
        versionTable: 'schema_meta',
      },
    });
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source.pragma('journal_mode = WAL');
    source.exec(
      'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE schema_meta (module TEXT PRIMARY KEY, version INTEGER NOT NULL)',
    );
    source
      .prepare('INSERT INTO schema_meta(module, version) VALUES (?, ?)')
      .run('base', 0);
    source
      .prepare('INSERT INTO items(id, name) VALUES (?, ?)')
      .run(7, 'old row');
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'legacy.shape',
      descriptor,
      legacyPath: sourceFile,
    });
    await importLegacyPluginStorage(registry, {
      pluginId: 'legacy.shape',
      descriptor,
      legacyPath: sourceFile,
    });
    expect(
      registry.host(
        (db) =>
          db
            .prepare(
              'SELECT id, name, note FROM "p_6c65676163792e7368617065__items"',
            )
            .all(),
        { pluginId: 'legacy.shape', descriptor },
      ),
    ).toEqual([{ id: 7n, name: 'old row', note: 'new' }]);
    expect(registry.diagnostics('legacy.shape')).toEqual(
      expect.objectContaining({ state: 'active' }),
    );
  });

  it('activates a fresh registered namespace when no legacy private database exists', async () => {
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'fresh.namespace',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    await importLegacyPluginStorage(registry, {
      pluginId: 'fresh.namespace',
      descriptor: DESCRIPTOR,
      legacyPath: sourceFile,
    });
    expect(registry.diagnostics('fresh.namespace')).toEqual(
      expect.objectContaining({ state: 'active' }),
    );
    expect(
      registry
        .host((db) => db.prepare('PRAGMA table_list').all(), {
          pluginId: 'fresh.namespace',
          descriptor: DESCRIPTOR,
        })
        .some(
          (row) => row.name === 'p_66726573682e6e616d657370616365__profiles',
        ),
    ).toBe(true);
  });

  it('preserves hidden rowids and composite WITHOUT ROWID keys while removing bootstrap seeds before FK copy', async () => {
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'hidden', kind: 'table' },
        { name: 'composite', kind: 'table' },
        { name: 'parent', kind: 'table' },
        { name: 'child', kind: 'table' },
        { name: 'schema_meta', kind: 'table' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{hidden}} (value TEXT)',
                'CREATE TABLE {{composite}} (a TEXT, b INTEGER, payload BLOB, PRIMARY KEY (a, b)) WITHOUT ROWID',
                'CREATE TABLE {{parent}} (id INTEGER PRIMARY KEY)',
                'INSERT INTO {{parent}}(id) VALUES (1)',
                'CREATE TABLE {{child}} (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES {{parent}}(id))',
                'INSERT INTO {{child}}(id, parent_id) VALUES (1, 1)',
                'CREATE TABLE {{schema_meta}} (module TEXT PRIMARY KEY, version INTEGER NOT NULL)',
              ],
            },
          ],
        },
      ],
      legacy: {
        tables: [
          { name: 'hidden', columns: ['value'] },
          { name: 'composite', columns: ['a', 'b', 'payload'] },
          { name: 'parent', columns: ['id'] },
          { name: 'child', columns: ['id', 'parent_id'] },
          { name: 'schema_meta', columns: ['module', 'version'] },
        ],
        versionTable: 'schema_meta',
      },
    });
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source.pragma('journal_mode = WAL');
    source.pragma('foreign_keys = ON');
    source.exec(
      'CREATE TABLE hidden (value TEXT); CREATE TABLE composite (a TEXT, b INTEGER, payload BLOB, PRIMARY KEY (a, b)) WITHOUT ROWID; CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id)); CREATE TABLE schema_meta (module TEXT PRIMARY KEY, version INTEGER NOT NULL)',
    );
    source
      .prepare('INSERT INTO schema_meta(module, version) VALUES (?, ?)')
      .run('base', 0);
    source.prepare('INSERT INTO hidden(value) VALUES (?)').run('deleted');
    source
      .prepare('INSERT INTO hidden(value) VALUES (?)')
      .run('preserve-rowid');
    source
      .prepare('INSERT INTO hidden(value) VALUES (?)')
      .run('preserve-rowid-2');
    source.prepare('DELETE FROM hidden WHERE value = ?').run('deleted');
    source
      .prepare('INSERT INTO composite(a, b, payload) VALUES (?, ?, ?)')
      .run('a', 1, Buffer.from([1, 2]));
    source
      .prepare('INSERT INTO composite(a, b, payload) VALUES (?, ?, ?)')
      .run('b', 2, null);
    source.prepare('INSERT INTO parent(id) VALUES (?)').run(9);
    source.prepare('INSERT INTO child(id, parent_id) VALUES (?, ?)').run(9, 9);
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'legacy.identity',
      descriptor,
      legacyPath: sourceFile,
    });
    await importLegacyPluginStorage(registry, {
      pluginId: 'legacy.identity',
      descriptor,
      legacyPath: sourceFile,
    });
    const scope = { pluginId: 'legacy.identity', descriptor };
    expect(
      registry.host(
        (db) =>
          db
            .prepare(
              'SELECT rowid, value FROM "p_6c65676163792e6964656e74697479__hidden" ORDER BY rowid',
            )
            .all(),
        scope,
      ),
    ).toEqual([
      { rowid: 2n, value: 'preserve-rowid' },
      { rowid: 3n, value: 'preserve-rowid-2' },
    ]);
    expect(
      registry.host(
        (db) =>
          db
            .prepare(
              'SELECT a, b, payload FROM "p_6c65676163792e6964656e74697479__composite" ORDER BY a',
            )
            .all(),
        scope,
      ),
    ).toEqual([
      { a: 'a', b: 1n, payload: new Uint8Array([1, 2]) },
      { a: 'b', b: 2n, payload: null },
    ]);
    expect(
      registry.host(
        (db) =>
          db
            .prepare(
              'SELECT id FROM "p_6c65676163792e6964656e74697479__parent"',
            )
            .all(),
        scope,
      ),
    ).toEqual([{ id: 9n }]);
    expect(
      registry.host(
        (db) => db.prepare('PRAGMA foreign_key_check').all(),
        scope,
      ),
    ).toEqual([]);
  });

  it('imports a table with a user rowid column through its unshadowed alias', async () => {
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [{ name: 'shadowed', kind: 'table' }],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{shadowed}} (rowid TEXT, value TEXT)',
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'shadowed', columns: ['rowid', 'value'] }] },
    });
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source.prepare('CREATE TABLE shadowed (rowid TEXT, value TEXT)').run();
    source
      .prepare('INSERT INTO shadowed(rowid, value) VALUES (?, ?)')
      .run('deleted-user-rowid', 'deleted');
    source
      .prepare('INSERT INTO shadowed(rowid, value) VALUES (?, ?)')
      .run('user-rowid', 'preserved');
    source.prepare('DELETE FROM shadowed WHERE value = ?').run('deleted');
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'legacy.shadowed-rowid',
      descriptor,
      legacyPath: sourceFile,
    });
    await importLegacyPluginStorage(registry, {
      pluginId: 'legacy.shadowed-rowid',
      descriptor,
      legacyPath: sourceFile,
    });
    expect(
      registry.host(
        (db) =>
          db
            .prepare(
              'SELECT _rowid_ AS physical_rowid, "rowid", value FROM "p_6c65676163792e736861646f7765642d726f776964__shadowed" ORDER BY _rowid_',
            )
            .all(),
        { pluginId: 'legacy.shadowed-rowid', descriptor },
      ),
    ).toEqual([
      { physical_rowid: 2n, rowid: 'user-rowid', value: 'preserved' },
    ]);
  });

  it('preserves the physical rowid when user columns use both internal and rowid names', async () => {
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [{ name: 'shadowed', kind: 'table' }],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{shadowed}} (__kiagent_rowid TEXT, rowid TEXT, value TEXT)',
              ],
            },
          ],
        },
      ],
      legacy: {
        tables: [
          {
            name: 'shadowed',
            columns: ['__kiagent_rowid', 'rowid', 'value'],
          },
        ],
      },
    });
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source.exec(
      'CREATE TABLE shadowed (__kiagent_rowid TEXT, rowid TEXT, value TEXT)',
    );
    source
      .prepare(
        'INSERT INTO shadowed(__kiagent_rowid, rowid, value) VALUES (?, ?, ?)',
      )
      .run('deleted-internal', 'deleted-rowid', 'deleted');
    source
      .prepare(
        'INSERT INTO shadowed(__kiagent_rowid, rowid, value) VALUES (?, ?, ?)',
      )
      .run('user-internal', 'user-rowid', 'preserved');
    source.prepare('DELETE FROM shadowed WHERE value = ?').run('deleted');
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'legacy.internal-rowid-collision',
      descriptor,
      legacyPath: sourceFile,
    });
    await importLegacyPluginStorage(registry, {
      pluginId: 'legacy.internal-rowid-collision',
      descriptor,
      legacyPath: sourceFile,
    });
    expect(
      registry.host(
        (db) =>
          db
            .prepare(
              'SELECT _rowid_ AS physical_rowid, "__kiagent_rowid", "rowid", value FROM "p_6c65676163792e696e7465726e616c2d726f7769642d636f6c6c6973696f6e__shadowed" ORDER BY _rowid_',
            )
            .all(),
        { pluginId: 'legacy.internal-rowid-collision', descriptor },
      ),
    ).toEqual([
      {
        physical_rowid: 2n,
        __kiagent_rowid: 'user-internal',
        rowid: 'user-rowid',
        value: 'preserved',
      },
    ]);
  });

  it('preserves rowid order for a TEXT primary-key rowid table', async () => {
    const descriptor = rowidDescriptor();
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source
      .prepare(
        'CREATE TABLE items (id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
      )
      .run();
    source
      .prepare('INSERT INTO items(id, payload) VALUES (?, ?)')
      .run('b', 'first');
    source
      .prepare('INSERT INTO items(id, payload) VALUES (?, ?)')
      .run('a', 'second');
    source
      .prepare('INSERT INTO items(id, payload) VALUES (?, ?)')
      .run('c', 'third');
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'rowid.order',
      descriptor,
      legacyPath: sourceFile,
    });
    await importLegacyPluginStorage(registry, {
      pluginId: 'rowid.order',
      descriptor,
      legacyPath: sourceFile,
    });
    expect(
      registry.host(
        (db) =>
          db
            .prepare(
              `SELECT _rowid_ AS rowid, id FROM "${registry.physicalName('rowid.order', 'items')}" ORDER BY rowid`,
            )
            .all(),
        { pluginId: 'rowid.order', descriptor },
      ),
    ).toEqual([
      { rowid: 1n, id: 'b' },
      { rowid: 2n, id: 'a' },
      { rowid: 3n, id: 'c' },
    ]);
  });

  it('resumes a rowid-ordered import without renumbering across a chunk boundary', async () => {
    const descriptor = rowidDescriptor();
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source
      .prepare(
        'CREATE TABLE items (id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
      )
      .run();
    for (const [id, payload] of [
      ['b', 'first'],
      ['a', 'second'],
      ['d', 'third'],
      ['c', 'fourth'],
    ])
      source
        .prepare('INSERT INTO items(id, payload) VALUES (?, ?)')
        .run(id, payload);
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'rowid.resume',
      descriptor,
      legacyPath: sourceFile,
    });
    let chunks = 0;
    await expect(
      importLegacyPluginStorage(
        registry,
        { pluginId: 'rowid.resume', descriptor, legacyPath: sourceFile },
        {
          chunkSize: 2,
          afterChunk: () => {
            chunks++;
            if (chunks === 1) throw new Error('rowid interruption');
          },
        },
      ),
    ).rejects.toThrow('rowid interruption');
    await importLegacyPluginStorage(registry, {
      pluginId: 'rowid.resume',
      descriptor,
      legacyPath: sourceFile,
    });
    expect(
      registry.host(
        (db) =>
          db
            .prepare(
              `SELECT _rowid_ AS rowid, id FROM "${registry.physicalName('rowid.resume', 'items')}" ORDER BY rowid`,
            )
            .all(),
        { pluginId: 'rowid.resume', descriptor },
      ),
    ).toEqual([
      { rowid: 1n, id: 'b' },
      { rowid: 2n, id: 'a' },
      { rowid: 3n, id: 'd' },
      { rowid: 4n, id: 'c' },
    ]);
  });

  it('fails loudly when a target trigger changes an imported rowid', async () => {
    const descriptor = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'items', kind: 'table' },
        { name: 'move_rowid', kind: 'trigger' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            {
              version: 0,
              statements: [
                'CREATE TABLE {{items}} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
                '/* keep this trigger active during row copy */ CREATE TRIGGER {{move_rowid}} AFTER INSERT ON {{items}} BEGIN UPDATE {{items}} SET rowid = rowid + 100 WHERE id = NEW.id; END',
              ],
            },
          ],
        },
      ],
      legacy: { tables: [{ name: 'items', columns: ['id', 'payload'] }] },
    });
    source.close();
    for (const candidate of [
      sourceFile,
      `${sourceFile}-wal`,
      `${sourceFile}-shm`,
    ])
      if (fs.existsSync(candidate)) fs.rmSync(candidate);
    source = new Database(sourceFile);
    source
      .prepare(
        'CREATE TABLE items (id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
      )
      .run();
    source
      .prepare('INSERT INTO items(id, payload) VALUES (?, ?)')
      .run('one', 'payload');
    const registry = createPluginRegistry(target, { filename: targetFile });
    await registry.register({
      pluginId: 'rowid.digest',
      descriptor,
      legacyPath: sourceFile,
    });
    await expect(
      importLegacyPluginStorage(registry, {
        pluginId: 'rowid.digest',
        descriptor,
        legacyPath: sourceFile,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_IMPORT_DIGEST_MISMATCH' });
  });
});
