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
});
