import {
  parseDatabaseDescriptor,
  type PluginDatabaseDescriptor,
} from '@main/platform/database-descriptor';

export const DESCRIPTOR: PluginDatabaseDescriptor = parseDatabaseDescriptor({
  format: 1,
  objects: [
    { name: 'profiles', kind: 'table' },
    { name: 'user_overrides', kind: 'table' },
    { name: 'jobs', kind: 'table' },
    { name: 'schema_meta', kind: 'table' },
    { name: 'profile_name_idx', kind: 'index' },
    { name: 'job_status_idx', kind: 'index' },
    { name: 'ready_jobs', kind: 'view' },
    { name: 'job_after_insert', kind: 'trigger' },
  ],
  modules: [
    {
      name: 'base',
      migrations: [
        {
          version: 0,
          statements: [
            'CREATE TABLE {{profiles}} (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, rank INTEGER NOT NULL)',
            'CREATE TABLE {{user_overrides}} (profile_id TEXT PRIMARY KEY REFERENCES {{profiles}}(id), value TEXT NOT NULL)',
            'CREATE TABLE {{jobs}} (id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES {{profiles}}(id), status TEXT NOT NULL, payload BLOB)',
            'CREATE TABLE {{schema_meta}} (module TEXT PRIMARY KEY, version INTEGER NOT NULL)',
          ],
        },
        {
          version: 1,
          statements: [
            'CREATE INDEX {{profile_name_idx}} ON {{profiles}} (lower(name))',
            'CREATE INDEX {{job_status_idx}} ON {{jobs}} (status)',
            "CREATE VIEW {{ready_jobs}} AS SELECT id, profile_id FROM {{jobs}} WHERE status = 'queued'",
            "CREATE TRIGGER {{job_after_insert}} AFTER INSERT ON {{jobs}} BEGIN UPDATE {{schema_meta}} SET version = version WHERE module = 'base'; END",
          ],
        },
        {
          version: 2,
          statements: [
            "UPDATE {{jobs}} SET status = 'queued' WHERE status = 'processing'",
          ],
        },
      ],
    },
  ],
  legacy: {
    tables: [
      { name: 'profiles', columns: ['id', 'name', 'email', 'rank'] },
      { name: 'user_overrides', columns: ['profile_id', 'value'] },
      { name: 'jobs', columns: ['id', 'profile_id', 'status', 'payload'] },
      { name: 'schema_meta', columns: ['module', 'version'] },
    ],
    versionTable: 'schema_meta',
  },
});
