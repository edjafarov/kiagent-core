/** @jest-environment node */
import { openDb } from '@main/db/app-db';
import { attachDbHost, createDbClient } from '@main/db/bridge';
import { MessageChannel } from 'node:worker_threads';
import { createDbCoordinator } from '../coordinator';
import { openPluginConnection } from '../plugin-connections';
import { createPluginOperationHandler } from '../plugin-operations';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';

async function closeFailedPluginOwner(
  owner: { kind: 'core' | 'plugin'; handle?: string; extensionId?: string },
  connections: Map<string, Awaited<ReturnType<typeof openPluginConnection>>>,
): Promise<void> {
  if (owner.kind !== 'plugin') return;
  const key = owner.handle ?? owner.extensionId!;
  const connection = connections.get(key);
  connections.delete(key);
  try { await connection?.close(); } catch { /* preserve the rollback error */ }
}

describe('plugin bridge requests', () => {
  it('routes a host-authorized plugin request through AppDb.plugin', async () => {
    const db = await openDb(':memory:');
    const channel = new MessageChannel();
    attachDbHost(channel.port1, db, undefined, undefined, {
      plugin: async (request) => ({ accepted: request.op }),
    });
    const client = createDbClient(channel.port2);
    await expect(client.plugin?.({ op: 'diagnostics' })).resolves.toEqual({
      accepted: 'diagnostics',
    });
    await db.close();
    channel.port1.close();
    channel.port2.close();
  });

  it('parks core work behind a plugin transaction on the production bridge', async () => {
    const file = path.join(os.tmpdir(), `plugin-bridge-${process.pid}-${Date.now()}.sqlite`);
    const hostSeed = new Database(file);
    hostSeed.exec('CREATE TABLE "p_70__items"(v INTEGER); CREATE TABLE core_items(v INTEGER)');
    hostSeed.close();
    const db = await openDb(file);
    const coordinator = createDbCoordinator();
    const owner = { kind: 'plugin' as const, extensionId: 'p', handle: 'h1' };
    const core = { kind: 'core' as const, handle: 'core' };
    const connections = new Map<string, Awaited<ReturnType<typeof openPluginConnection>>>();
    connections.set('h1', await openPluginConnection(file, { pluginId: 'p', tables: ['items'] }));
    connections.set('h2', await openPluginConnection(file, { pluginId: 'p', tables: ['items'] }));
    const pluginHandler = createPluginOperationHandler(coordinator, connections);
    const channel = new MessageChannel();
    attachDbHost(channel.port1, db, undefined, undefined, {
      coordinator,
      coreOwner: core,
      plugin: pluginHandler,
    });
    const client = createDbClient(channel.port2);
    const token = (await client.plugin?.({ op: 'begin', owner })) as string;
    await expect(client.plugin?.({ op: 'exec', owner, token, sql: '/*x*/ COMMIT' })).rejects.toMatchObject({ code: 'PLUGIN_SQL_TRANSACTION_CONTROL' });
    await client.plugin?.({ op: 'exec', owner, token, sql: 'INSERT INTO {{items}} VALUES (?)', params: [1] });
    const waiting = client.all('SELECT COUNT(*) AS c FROM "p_70__items"');
    const abort = new AbortController();
    const cancelled = client.plugin?.({ op: 'exec', owner: { kind: 'plugin', extensionId: 'p', handle: 'h2' }, sql: 'INSERT INTO {{items}} VALUES (?)', params: [99] }, { signal: abort.signal });
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'DB_OPERATION_CANCELLED' });
    await client.plugin?.({ op: 'batch', owner, token, steps: [{ sql: 'INSERT INTO {{items}} VALUES (?)', params: [2] }] });
    await client.plugin?.({ op: 'rollback', owner, token });
    await expect(waiting).resolves.toEqual([{ c: 0 }]);
    const committed = (await client.plugin?.({ op: 'begin', owner })) as string;
    await client.plugin?.({ op: 'exec', owner, token: committed, sql: 'INSERT INTO {{items}} VALUES (?)', params: [3] });
    await client.plugin?.({ op: 'commit', owner, token: committed });
    await expect(client.all('SELECT COUNT(*) AS c FROM "p_70__items"')).resolves.toEqual([{ c: 1 }]);
    await client.close();
    await coordinator.close();
    await connections.get('h1')?.close();
    await connections.get('h2')?.close();
    channel.port1.close();
    channel.port2.close();
    for (const p of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(p)) fs.rmSync(p);
  });

  it('repairs a deferred foreign-key COMMIT before admitting a core writer', async () => {
    const file = path.join(os.tmpdir(), `plugin-deferred-fk-${process.pid}-${Date.now()}.sqlite`);
    const hostSeed = new Database(file);
    hostSeed.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE "p_70__parents" (id INTEGER PRIMARY KEY);
      CREATE TABLE "p_70__children" (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES "p_70__parents"(id) DEFERRABLE INITIALLY DEFERRED
      );
      CREATE TABLE core_items (v INTEGER);
    `);
    hostSeed.close();

    const db = await openDb(file);
    db._conn?.pragma('busy_timeout = 25');
    const coordinator = createDbCoordinator();
    const owner = { kind: 'plugin' as const, extensionId: 'p', handle: 'deferred-owner' };
    const other = { kind: 'plugin' as const, extensionId: 'p', handle: 'other-owner' };
    const connections = new Map<string, Awaited<ReturnType<typeof openPluginConnection>>>();
    connections.set('deferred-owner', await openPluginConnection(file, {
      pluginId: 'p', tables: ['parents', 'children'],
    }));
    connections.set('other-owner', await openPluginConnection(file, {
      pluginId: 'p', tables: ['parents', 'children'],
    }));
    const pluginHandler = createPluginOperationHandler(coordinator, connections);
    const channel = new MessageChannel();
    attachDbHost(channel.port1, db, undefined, undefined, {
      coordinator,
      coreOwner: { kind: 'core' as const, handle: 'core' },
      plugin: pluginHandler,
    });
    const client = createDbClient(channel.port2);

    const token = (await client.plugin?.({ op: 'begin', owner })) as string;
    await client.plugin?.({
      op: 'exec', owner, token,
      sql: 'INSERT INTO {{children}} (id, parent_id) VALUES (?, ?)',
      params: [1, 404],
    });
    const waitingCoreWrite = client.run('INSERT INTO core_items(v) VALUES (1)');
    await expect(client.plugin?.({ op: 'commit', owner, token })).rejects.toThrow();

    // The COMMIT error must not leave the deferred write or a SQLite writer
    // lock behind when the coordinator admits this already queued core write.
    await expect(waitingCoreWrite).resolves.toBeUndefined();
    await expect(client.all('SELECT COUNT(*) AS c FROM "p_70__children"')).resolves.toEqual([{ c: 0 }]);

    // A successful repair leaves the owner reusable. If cleanup had to poison
    // it, the only accepted outcome is an explicit terminal owner state.
    let freshError: unknown;
    try {
      const fresh = (await client.plugin?.({ op: 'begin', owner })) as string;
      await client.plugin?.({ op: 'rollback', owner, token: fresh });
    } catch (error) {
      freshError = error;
    }

    await client.plugin?.({ op: 'release', owner: other });
    await client.plugin?.({ op: 'release', owner }).catch(() => undefined);
    await client.close();
    await coordinator.close();
    channel.port1.close();
    channel.port2.close();
    for (const p of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(p)) fs.rmSync(p);
    expect(freshError).toMatchObject({
      code: expect.stringMatching(/^DB_(?:OWNER_POISONED|PLUGIN_DB_NOT_OPEN)$/),
    });
  });

  it('closes and removes the actual connection before foreign work after lease rollback failure', async () => {
    const file = path.join(os.tmpdir(), `plugin-expiry-close-${process.pid}-${Date.now()}.sqlite`);
    const hostSeed = new Database(file);
    hostSeed.exec('CREATE TABLE "p_70__items" (v INTEGER)');
    hostSeed.close();

    const db = await openDb(file);
    const connections = new Map<string, Awaited<ReturnType<typeof openPluginConnection>>>();
    const coordinator = createDbCoordinator({
      leaseMs: 15,
      onOwnerFailure: (owner) => closeFailedPluginOwner(owner, connections),
    });
    const bad = { kind: 'plugin' as const, extensionId: 'p', handle: 'expired-owner' };
    const good = { kind: 'plugin' as const, extensionId: 'p', handle: 'foreign-owner' };
    const expired = await openPluginConnection(file, { pluginId: 'p', tables: ['items'] });
    const foreign = await openPluginConnection(file, { pluginId: 'p', tables: ['items'] });
    connections.set('expired-owner', expired);
    connections.set('foreign-owner', foreign);
    const pluginHandler = createPluginOperationHandler(coordinator, connections);
    const channel = new MessageChannel();
    attachDbHost(channel.port1, db, undefined, undefined, {
      coordinator,
      plugin: pluginHandler,
    });
    const client = createDbClient(channel.port2);

    const token = (await client.plugin?.({ op: 'begin', owner: bad })) as string;
    await client.plugin?.({
      op: 'exec', owner: bad, token,
      sql: 'INSERT INTO {{items}} VALUES (?)', params: [1],
    });
    expired.rollback = async () => { throw new Error('injected rollback failure'); };

    const waitingForeignWrite = client.plugin?.({
      op: 'exec', owner: good,
      sql: 'INSERT INTO {{items}} VALUES (?)', params: [2],
    });
    await expect(waitingForeignWrite).resolves.toBeUndefined();
    expect(connections.has('expired-owner')).toBe(false);
    await expect(expired.exec('INSERT INTO {{items}} VALUES (?)', [3])).rejects.toThrow();
    await expect(client.plugin?.({
      op: 'exec', owner: bad,
      sql: 'INSERT INTO {{items}} VALUES (?)', params: [4],
    })).rejects.toMatchObject({ code: 'PLUGIN_DB_NOT_OPEN' });
    await expect(foreign.query('SELECT COUNT(*) AS c FROM {{items}}')).resolves.toEqual([{ c: 1 }]);

    await client.plugin?.({ op: 'release', owner: good });
    await client.plugin?.({ op: 'release', owner: bad });
    await client.close();
    await coordinator.close();
    channel.port1.close();
    channel.port2.close();
    for (const p of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(p)) fs.rmSync(p);
  });
});
