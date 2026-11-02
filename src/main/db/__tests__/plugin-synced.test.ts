/** @jest-environment node */
/** Step 2: plugin tables a descriptor names under `synced` (alpha-cent spec 7.8). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type BetterSqlite3 from 'better-sqlite3';

import { migrate } from '@main/core/store/schema';
import { enableTracking } from '@main/core/sync/tracking';
import { parseDatabaseDescriptor } from '@main/platform/database-descriptor';
import {
  BLOBS,
  descriptor,
  NOTES,
  PLUGIN,
  physical,
  registerPlugin,
} from '@main/core/sync/__tests__/synced-plugin';

import { openDb, type AppDb } from '../app-db';
import { openPluginConnection } from '../plugin-connections';
import { createPluginRegistry } from '../plugin-registry';

let dir: string;
let file: string;
let db: AppDb;
const conn = (): BetterSqlite3.Database => db._conn!;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-synced-'));
  file = path.join(dir, 'core.db');
  db = await openDb(file);
  migrate(conn());
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const open = async (
  registry: Awaited<ReturnType<typeof registerPlugin>>,
  readOnly: () => boolean,
) => {
  const registration = await registry.open({
    pluginId: PLUGIN,
    owner: { kind: 'plugin', extensionId: PLUGIN, handle: 'h' },
  });
  return openPluginConnection(file, { ...registration, readOnly });
};
const tracked = () =>
  conn().prepare(`SELECT tbl, pk FROM sync_rows ORDER BY cursor`).all() as { tbl: string; pk: string }[];

describe('descriptor `synced`', () => {
  it('is accepted and kept; ownerCapture too', () => {
    const d = descriptor({ ownerCapture: ['blobs'] });
    expect(d.synced).toEqual(['notes', 'blobs']);
    expect(d.ownerCapture).toEqual(['blobs']);
  });

  it('a synced table without a primary key is refused at registration', () => {
    expect(() =>
      parseDatabaseDescriptor({
        format: 1,
        objects: [{ name: 'loose', kind: 'table' }],
        modules: [{ name: 'm', migrations: [{ version: 0, statements: ['CREATE TABLE {{loose}} (a TEXT, b TEXT)'] }] }],
        legacy: { tables: [] },
        synced: ['loose'],
      }),
    ).toThrow(/primary key/i);
  });

  it('a synced name that is not a table of the descriptor is refused', () => {
    expect(() => descriptor({ synced: ['notes', 'ghost'] })).toThrow(/synced/);
  });

  it('ownerCapture outside synced is refused', () => {
    expect(() => descriptor({ ownerCapture: ['local_x'] })).toThrow(/ownerCapture/);
  });

  it('adding synced to a registered descriptor is not an append-only violation', async () => {
    const registry = await registerPlugin(file, conn(), descriptor({ synced: [] }));
    await expect(
      registry.register({ pluginId: PLUGIN, descriptor: descriptor(), legacyPath: file }),
    ).resolves.toMatchObject({ pluginId: PLUGIN, state: 'active' });
    const reg = await registry.open({
      pluginId: PLUGIN,
      owner: { kind: 'plugin', extensionId: PLUGIN, handle: 'h' },
    });
    expect(reg.synced).toEqual(['notes', 'blobs']);
  });
});

describe('plugin connection authorizer', () => {
  it('trigger writes to sync_rows pass the authorizer', async () => {
    const registry = await registerPlugin(file, conn());
    enableTracking(conn());
    const c = await open(registry, () => false);
    await c.exec('INSERT INTO {{notes}}(account_id, key, body) VALUES(?, ?, ?)', ['a', 'k', 'x']);
    await c.exec('UPDATE {{notes}} SET body = ?', ['y']);
    await c.exec('DELETE FROM {{notes}}');
    expect(tracked().map((r) => r.tbl)).toEqual([physical('notes')]);
    // The plugin cannot reach those tables itself.
    await expect(c.exec('INSERT INTO sync_rows(tbl, pk) VALUES(?, ?)', ['x', '[]'])).rejects.toThrow();
    await expect(c.query('SELECT * FROM sync_state')).rejects.toThrow();
    await c.close();
  });

  it('a follower plugin write to a synced table is refused; ownerCapture is not; the same connection writes after promote', async () => {
    const registry = await registerPlugin(file, conn(), descriptor({ ownerCapture: ['blobs'] }));
    let follower = true;
    const c = await open(registry, () => follower);
    await expect(
      c.exec('INSERT INTO {{notes}}(account_id, key, body) VALUES(?, ?, ?)', ['a', 'k', 'x']),
    ).rejects.toMatchObject({ name: 'SyncReadOnly' });
    await expect(c.exec('UPDATE {{notes}} SET body = ?', ['y'])).rejects.toMatchObject({ name: 'SyncReadOnly' });
    await expect(c.exec('DELETE FROM {{notes}}')).rejects.toMatchObject({ name: 'SyncReadOnly' });
    await c.exec('INSERT INTO {{blobs}}(id, data) VALUES(?, ?)', ['b', new Uint8Array([1])]);
    await c.exec('INSERT INTO {{local_x}}(id, v) VALUES(?, ?)', ['l', 'v']);
    await expect(c.query('SELECT count(*) AS n FROM {{notes}}')).resolves.toEqual([{ n: 0 }]);
    follower = false;
    await c.exec('INSERT INTO {{notes}}(account_id, key, body) VALUES(?, ?, ?)', ['a', 'k', 'x']);
    await expect(c.query('SELECT count(*) AS n FROM {{notes}}')).resolves.toEqual([{ n: 1 }]);
    await c.close();
  });
});

describe('beforeStatement', () => {
  it('refreshes the cached answer before every statement', async () => {
    const registry = await registerPlugin(file, conn());
    let cached = false;
    const registration = await registry.open({
      pluginId: PLUGIN,
      owner: { kind: 'plugin', extensionId: PLUGIN, handle: 'h' },
    });
    const c = await openPluginConnection(file, {
      ...registration,
      readOnly: () => cached,
      beforeStatement: () => {
        cached = (conn().prepare(`SELECT role FROM sync_state`).get() as { role: string }).role === 'follower';
      },
    });
    await c.exec('INSERT INTO {{notes}}(account_id, key, body) VALUES(?, ?, ?)', ['a', 'k', 'x']);
    conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();
    await expect(c.exec('DELETE FROM {{notes}}')).rejects.toMatchObject({ name: 'SyncReadOnly' });
    conn().prepare(`UPDATE sync_state SET role = 'normal'`).run();
    await c.exec('DELETE FROM {{notes}}');
    await c.close();
  });
});

describe('registry and tracking', () => {
  it('a later migration adding a synced table generates its triggers while tracking', async () => {
    const registry = await registerPlugin(file, conn(), descriptor({}, ['notes', 'local_x']));
    enableTracking(conn());
    const next = parseDatabaseDescriptor({
      format: 1,
      objects: [
        { name: 'notes', kind: 'table' },
        { name: 'local_x', kind: 'table' },
        { name: 'blobs', kind: 'table' },
      ],
      modules: [
        {
          name: 'base',
          migrations: [
            { version: 0, statements: [NOTES, 'CREATE TABLE {{local_x}} (id TEXT PRIMARY KEY, v TEXT)'] },
            { version: 1, statements: [BLOBS] },
          ],
        },
      ],
      legacy: { tables: [] },
      synced: ['notes', 'blobs'],
    });
    await createPluginRegistry(conn(), { filename: file }).register({
      pluginId: PLUGIN,
      descriptor: next,
      legacyPath: file,
    });
    void registry;
    const reg = createPluginRegistry(conn(), { filename: file });
    await reg.migrate({ pluginId: PLUGIN, module: 'base', version: 1, statements: [BLOBS] });
    const have = conn()
      .prepare(`SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE ?`)
      .get(`sync_%${physical('blobs')}`) as { n: number };
    expect(have.n).toBe(3);
  });
});
