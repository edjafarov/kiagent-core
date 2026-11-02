/** A registered plugin with synced tables, for the sync suites. It goes through
 *  the real registry (register, migrate, complete) on the core database file. */
import type BetterSqlite3 from 'better-sqlite3';

import { pluginIdentifier } from '@shared/plugin-sql';

import { createPluginRegistry } from '../../../db/plugin-registry';
import {
  parseDatabaseDescriptor,
  type PluginDatabaseDescriptor,
} from '../../../platform/database-descriptor';

export const PLUGIN = 'test.syncplug';
export const physical = (name: string, plugin = PLUGIN): string =>
  pluginIdentifier(plugin, name).replaceAll('"', '');

export const NOTES =
  'CREATE TABLE {{notes}} (account_id TEXT NOT NULL, key TEXT NOT NULL, body TEXT, PRIMARY KEY (account_id, key))';
export const BLOBS = 'CREATE TABLE {{blobs}} (id TEXT PRIMARY KEY, data BLOB)';
export const LOCAL = 'CREATE TABLE {{local_x}} (id TEXT PRIMARY KEY, v TEXT)';

export function descriptor(
  extra: Record<string, unknown> = {},
  objects: string[] = ['notes', 'blobs', 'local_x'],
): PluginDatabaseDescriptor {
  const sql: Record<string, string> = { notes: NOTES, blobs: BLOBS, local_x: LOCAL };
  return parseDatabaseDescriptor({
    format: 1,
    objects: objects.map((name) => ({ name, kind: 'table' })),
    modules: [
      {
        name: 'base',
        migrations: [{ version: 0, statements: objects.map((n) => sql[n]) }],
      },
    ],
    legacy: { tables: [] },
    synced: ['notes', 'blobs'].filter((n) => objects.includes(n)),
    ...extra,
  });
}

export async function registerPlugin(
  file: string,
  conn: BetterSqlite3.Database,
  d: PluginDatabaseDescriptor = descriptor(),
  pluginId = PLUGIN,
) {
  const registry = createPluginRegistry(conn, { filename: file });
  await registry.register({ pluginId, descriptor: d, legacyPath: file });
  for (const m of d.modules)
    for (const mig of m.migrations)
      await registry.migrate({
        pluginId,
        module: m.name,
        version: mig.version,
        statements: mig.statements,
      });
  await registry.completeImport(pluginId);
  return registry;
}

export function addOutbox(
  c: BetterSqlite3.Database,
  accountId: string,
  id: string,
  status = 'draft',
): void {
  c.prepare(
    `INSERT INTO outbox(id, account_id, kind, recipient_display, body_markdown, confirm_mode,
                        status, created_via, created_at, expires_at)
     VALUES(?, ?, 'reply', 'r', 'body', 'review', ?, 'test', 'x', 'y')`,
  ).run(id, accountId, status);
}

export function addDraft(c: BetterSqlite3.Database, accountId: string, id: string): void {
  c.prepare(
    `INSERT INTO event_drafts(id, account_id, payload_json, fingerprint, confirm_mode, status,
                              created_via, created_at, updated_at, expires_at, touched_at, touched_via)
     VALUES(?, ?, '{}', 'f', 'review', 'draft', 'test', 'x', 'x', 'y', 'x', 'test')`,
  ).run(id, accountId);
}

export function addAttention(c: BetterSqlite3.Database, id: string): void {
  c.prepare(
    `INSERT INTO attention_items(id, producer, payload_json, state, revision, transition_at)
     VALUES(?, 'p', '{}', 'open', 1, 1)`,
  ).run(id);
  c.prepare(
    `INSERT INTO attention_revisions(id, producer, revision, state, transition_at)
     VALUES(?, 'p', 1, 'open', 1)`,
  ).run(id);
}
