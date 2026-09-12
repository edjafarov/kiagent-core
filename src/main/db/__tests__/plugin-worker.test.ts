/** @jest-environment node */
import { openDb } from '@main/db/app-db';
import { attachDbHost, createDbClient } from '@main/db/bridge';
import { MessageChannel } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import {
  closePluginConnectionForOwner,
  createPluginOperationHandler,
} from '../plugin-operations';
import { openPluginConnection } from '../plugin-connections';
import { createDbCoordinator } from '../coordinator';

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
    const file = path.join(
      os.tmpdir(),
      `plugin-bridge-${process.pid}-${Date.now()}.sqlite`,
    );
    const hostSeed = new Database(file);
    hostSeed.exec(
      'CREATE TABLE "p_70__items"(v INTEGER); CREATE TABLE core_items(v INTEGER)',
    );
    hostSeed.close();
    const db = await openDb(file);
    const coordinator = createDbCoordinator();
    const owner = { kind: 'plugin' as const, extensionId: 'p', handle: 'h1' };
    const core = { kind: 'core' as const, handle: 'core' };
    const connections = new Map<
      string,
      Awaited<ReturnType<typeof openPluginConnection>>
    >();
    connections.set(
      'h1',
      await openPluginConnection(file, { pluginId: 'p', tables: ['items'] }),
    );
    connections.set(
      'h2',
      await openPluginConnection(file, { pluginId: 'p', tables: ['items'] }),
    );
    const pluginHandler = createPluginOperationHandler(
      coordinator,
      connections,
    );
    const channel = new MessageChannel();
    attachDbHost(channel.port1, db, undefined, undefined, {
      coordinator,
      coreOwner: core,
      plugin: pluginHandler,
    });
    const client = createDbClient(channel.port2);
    const token = (await client.plugin?.({ op: 'begin', owner })) as string;
    await expect(
      client.plugin?.({ op: 'exec', owner, token, sql: '/*x*/ COMMIT' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_SQL_TRANSACTION_CONTROL' });
    await client.plugin?.({
      op: 'exec',
      owner,
      token,
      sql: 'INSERT INTO {{items}} VALUES (?)',
      params: [1],
    });
    const waiting = client.all('SELECT COUNT(*) AS c FROM "p_70__items"');
    const abort = new AbortController();
    const cancelled = client.plugin?.(
      {
        op: 'exec',
        owner: { kind: 'plugin', extensionId: 'p', handle: 'h2' },
        sql: 'INSERT INTO {{items}} VALUES (?)',
        params: [99],
      },
      { signal: abort.signal },
    );
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({
      code: 'DB_OPERATION_CANCELLED',
    });
    await client.plugin?.({
      op: 'batch',
      owner,
      token,
      steps: [{ sql: 'INSERT INTO {{items}} VALUES (?)', params: [2] }],
    });
    await client.plugin?.({ op: 'rollback', owner, token });
    await expect(waiting).resolves.toEqual([{ c: 0 }]);
    const committed = (await client.plugin?.({ op: 'begin', owner })) as string;
    await client.plugin?.({
      op: 'exec',
      owner,
      token: committed,
      sql: 'INSERT INTO {{items}} VALUES (?)',
      params: [3],
    });
    await client.plugin?.({ op: 'commit', owner, token: committed });
    await expect(
      client.all('SELECT COUNT(*) AS c FROM "p_70__items"'),
    ).resolves.toEqual([{ c: 1 }]);
    await client.close();
    await coordinator.close();
    await connections.get('h1')?.close();
    await connections.get('h2')?.close();
    channel.port1.close();
    channel.port2.close();
    for (const p of [file, `${file}-wal`, `${file}-shm`])
      if (fs.existsSync(p)) fs.rmSync(p);
  });

  it('rejects queued token continuations after both successful and failed finish cleanup', async () => {
    const runCase = async (kind: 'success' | 'failure') => {
      const file = path.join(
        os.tmpdir(),
        `plugin-stale-token-${kind}-${process.pid}-${Date.now()}.sqlite`,
      );
      const hostSeed = new Database(file);
      if (kind === 'success') {
        hostSeed.exec('CREATE TABLE "p_70__items" (v INTEGER)');
      } else {
        hostSeed.exec(`
          PRAGMA foreign_keys = ON;
          CREATE TABLE "p_70__parents" (id INTEGER PRIMARY KEY);
          CREATE TABLE "p_70__children" (
            id INTEGER PRIMARY KEY,
            parent_id INTEGER NOT NULL REFERENCES "p_70__parents"(id) DEFERRABLE INITIALLY DEFERRED
          );
        `);
      }
      hostSeed.close();

      const db = await openDb(file);
      const coordinator = createDbCoordinator();
      const owner = {
        kind: 'plugin' as const,
        extensionId: 'p',
        handle: `stale-${kind}`,
      };
      const connection = await openPluginConnection(file, {
        pluginId: 'p',
        tables: kind === 'success' ? ['items'] : ['parents', 'children'],
      });
      const connections = new Map<
        string,
        Awaited<ReturnType<typeof openPluginConnection>>
      >([[owner.handle!, connection]]);
      const pluginHandler = createPluginOperationHandler(
        coordinator,
        connections,
      );
      const channel = new MessageChannel();
      attachDbHost(channel.port1, db, undefined, undefined, {
        coordinator,
        plugin: pluginHandler,
      });
      const client = createDbClient(channel.port2);

      const originalCommit = connection.commit.bind(connection);
      let commitStarted!: () => void;
      const commitEntered = new Promise<void>((resolve) => {
        commitStarted = resolve;
      });
      let unblockCommit!: () => void;
      const commitGate = new Promise<void>((resolve) => {
        unblockCommit = resolve;
      });
      connection.commit = async () => {
        commitStarted();
        await commitGate;
        return originalCommit();
      };

      const token = (await client.plugin?.({ op: 'begin', owner })) as string;
      if (kind === 'success') {
        await client.plugin?.({
          op: 'exec',
          owner,
          token,
          sql: 'INSERT INTO {{items}} VALUES (?)',
          params: [1],
        });
      } else {
        await client.plugin?.({
          op: 'exec',
          owner,
          token,
          sql: 'INSERT INTO {{children}} (id, parent_id) VALUES (?, ?)',
          params: [1, 404],
        });
      }

      const finishing = client.plugin?.({ op: 'commit', owner, token });
      await commitEntered;
      // Invoke the production handler directly so the continuation is
      // definitely queued while COMMIT is held behind the test boundary.
      const continuation = pluginHandler({
        op: 'exec',
        owner,
        token,
        sql:
          kind === 'success'
            ? 'INSERT INTO {{items}} VALUES (?)'
            : 'INSERT INTO {{children}} (id, parent_id) VALUES (?, ?)',
        params: kind === 'success' ? [2] : [2, 404],
      });
      const continuationRejected = continuation.catch((error: unknown) => {
        expect(error).toMatchObject({ code: 'DB_TX_TOKEN_INVALID' });
      });
      expect(coordinator.metrics().queued).toBe(1);
      unblockCommit();

      if (kind === 'success') {
        await expect(finishing).resolves.toBeUndefined();
      } else {
        await expect(finishing).rejects.toThrow();
      }
      await continuationRejected;
      if (kind === 'success') {
        await expect(
          client.all('SELECT COUNT(*) AS c FROM "p_70__items"'),
        ).resolves.toEqual([{ c: 1 }]);
      } else {
        await expect(
          client.all('SELECT COUNT(*) AS c FROM "p_70__children"'),
        ).resolves.toEqual([{ c: 0 }]);
      }

      await client.plugin?.({ op: 'release', owner });
      await client.close();
      await coordinator.close();
      channel.port1.close();
      channel.port2.close();
      for (const p of [file, `${file}-wal`, `${file}-shm`])
        if (fs.existsSync(p)) fs.rmSync(p);
    };

    await runCase('success');
    await runCase('failure');
  });

  it('repairs a deferred foreign-key COMMIT before admitting a core writer', async () => {
    const file = path.join(
      os.tmpdir(),
      `plugin-deferred-fk-${process.pid}-${Date.now()}.sqlite`,
    );
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
    const owner = {
      kind: 'plugin' as const,
      extensionId: 'p',
      handle: 'deferred-owner',
    };
    const other = {
      kind: 'plugin' as const,
      extensionId: 'p',
      handle: 'other-owner',
    };
    const connections = new Map<
      string,
      Awaited<ReturnType<typeof openPluginConnection>>
    >();
    connections.set(
      'deferred-owner',
      await openPluginConnection(file, {
        pluginId: 'p',
        tables: ['parents', 'children'],
      }),
    );
    connections.set(
      'other-owner',
      await openPluginConnection(file, {
        pluginId: 'p',
        tables: ['parents', 'children'],
      }),
    );
    const pluginHandler = createPluginOperationHandler(
      coordinator,
      connections,
    );
    const channel = new MessageChannel();
    attachDbHost(channel.port1, db, undefined, undefined, {
      coordinator,
      coreOwner: { kind: 'core' as const, handle: 'core' },
      plugin: pluginHandler,
    });
    const client = createDbClient(channel.port2);

    const token = (await client.plugin?.({ op: 'begin', owner })) as string;
    await client.plugin?.({
      op: 'exec',
      owner,
      token,
      sql: 'INSERT INTO {{children}} (id, parent_id) VALUES (?, ?)',
      params: [1, 404],
    });
    const waitingCoreWrite = client.run('INSERT INTO core_items(v) VALUES (1)');
    await expect(
      client.plugin?.({ op: 'commit', owner, token }),
    ).rejects.toThrow();

    // The COMMIT error must not leave the deferred write or a SQLite writer
    // lock behind when the coordinator admits this already queued core write.
    await expect(waitingCoreWrite).resolves.toBeUndefined();
    await expect(
      client.all('SELECT COUNT(*) AS c FROM "p_70__children"'),
    ).resolves.toEqual([{ c: 0 }]);

    // A successful repair leaves the owner reusable. If cleanup had to poison
    // it, the only accepted outcome is an explicit terminal owner state.
    let freshError: unknown;
    let freshSucceeded = false;
    try {
      const fresh = (await client.plugin?.({ op: 'begin', owner })) as string;
      await client.plugin?.({ op: 'rollback', owner, token: fresh });
      freshSucceeded = true;
    } catch (error) {
      freshError = error;
    }

    await client.plugin?.({ op: 'release', owner: other });
    await client.plugin?.({ op: 'release', owner }).catch(() => undefined);
    await client.close();
    await coordinator.close();
    channel.port1.close();
    channel.port2.close();
    for (const p of [file, `${file}-wal`, `${file}-shm`])
      if (fs.existsSync(p)) fs.rmSync(p);
    if (!freshSucceeded)
      expect(freshError).toMatchObject({
        code: expect.stringMatching(
          /^DB_(?:OWNER_POISONED|PLUGIN_DB_NOT_OPEN)$/,
        ),
      });
  });

  it('rejects queued un-tokened work for a poisoned owner before admitting a foreign write', async () => {
    const file = path.join(
      os.tmpdir(),
      `plugin-poisoned-queue-${process.pid}-${Date.now()}.sqlite`,
    );
    const hostSeed = new Database(file);
    hostSeed.exec('CREATE TABLE "p_70__items" (v INTEGER)');
    hostSeed.close();

    const db = await openDb(file);
    const connections = new Map<
      string,
      Awaited<ReturnType<typeof openPluginConnection>>
    >();
    const coordinator = createDbCoordinator({
      leaseMs: 15,
      onOwnerFailure: (owner) =>
        closePluginConnectionForOwner(owner, connections),
    });
    const bad = {
      kind: 'plugin' as const,
      extensionId: 'p',
      handle: 'poisoned-owner',
    };
    const good = {
      kind: 'plugin' as const,
      extensionId: 'p',
      handle: 'foreign-owner',
    };
    const poisonedConnection = await openPluginConnection(file, {
      pluginId: 'p',
      tables: ['items'],
    });
    const foreignConnection = await openPluginConnection(file, {
      pluginId: 'p',
      tables: ['items'],
    });
    let poisonedWorkCalled = 0;
    const originalExec = poisonedConnection.exec.bind(poisonedConnection);
    poisonedConnection.exec = async (sql: string, params: unknown[] = []) => {
      poisonedWorkCalled += 1;
      return originalExec(sql, params);
    };
    connections.set(bad.handle!, poisonedConnection);
    connections.set(good.handle!, foreignConnection);
    const pluginHandler = createPluginOperationHandler(
      coordinator,
      connections,
    );
    const channel = new MessageChannel();
    attachDbHost(channel.port1, db, undefined, undefined, {
      coordinator,
      plugin: pluginHandler,
    });
    const client = createDbClient(channel.port2);

    const token = (await client.plugin?.({
      op: 'begin',
      owner: bad,
    })) as string;
    await client.plugin?.({
      op: 'exec',
      owner: bad,
      token,
      sql: 'INSERT INTO {{items}} VALUES (?)',
      params: [1],
    });
    poisonedWorkCalled = 0;
    poisonedConnection.rollback = async () => {
      throw new Error('injected rollback failure');
    };

    // Queue both real handler operations before the lease timer can release
    // admission, preserving the poisoned-owner job for the dequeue check.
    const poisoned = pluginHandler({
      op: 'exec',
      owner: bad,
      sql: 'INSERT INTO {{items}} VALUES (?)',
      params: [9],
    });
    const foreign = pluginHandler({
      op: 'exec',
      owner: good,
      sql: 'INSERT INTO {{items}} VALUES (?)',
      params: [2],
    });
    await expect(foreign).resolves.toBeUndefined();
    await expect(poisoned).rejects.toThrow();
    expect(poisonedWorkCalled).toBe(0);
    expect(connections.has(bad.handle!)).toBe(false);
    await expect(
      foreignConnection.query('SELECT COUNT(*) AS c FROM {{items}}'),
    ).resolves.toEqual([{ c: 1 }]);

    await client.plugin?.({ op: 'release', owner: good });
    await client.plugin?.({ op: 'release', owner: bad }).catch(() => undefined);
    await client.close();
    await coordinator.close();
    channel.port1.close();
    channel.port2.close();
    for (const p of [file, `${file}-wal`, `${file}-shm`])
      if (fs.existsSync(p)) fs.rmSync(p);
  });

  it('closes and removes the actual connection before foreign work after lease rollback failure', async () => {
    const file = path.join(
      os.tmpdir(),
      `plugin-expiry-close-${process.pid}-${Date.now()}.sqlite`,
    );
    const hostSeed = new Database(file);
    hostSeed.exec('CREATE TABLE "p_70__items" (v INTEGER)');
    hostSeed.close();

    const db = await openDb(file);
    const connections = new Map<
      string,
      Awaited<ReturnType<typeof openPluginConnection>>
    >();
    let removedExpired!: () => void;
    const expiredRemoved = new Promise<void>((resolve) => {
      removedExpired = resolve;
    });
    const coordinator = createDbCoordinator({
      leaseMs: 15,
      onOwnerFailure: async (owner) => {
        await closePluginConnectionForOwner(owner, connections);
        if (owner.kind === 'plugin' && owner.handle === 'expired-owner')
          removedExpired();
      },
    });
    const bad = {
      kind: 'plugin' as const,
      extensionId: 'p',
      handle: 'expired-owner',
    };
    const good = {
      kind: 'plugin' as const,
      extensionId: 'p',
      handle: 'foreign-owner',
    };
    const expired = await openPluginConnection(file, {
      pluginId: 'p',
      tables: ['items'],
    });
    const foreign = await openPluginConnection(file, {
      pluginId: 'p',
      tables: ['items'],
    });
    connections.set('expired-owner', expired);
    connections.set('foreign-owner', foreign);
    const pluginHandler = createPluginOperationHandler(
      coordinator,
      connections,
    );
    const channel = new MessageChannel();
    attachDbHost(channel.port1, db, undefined, undefined, {
      coordinator,
      plugin: pluginHandler,
    });
    const client = createDbClient(channel.port2);

    const token = (await client.plugin?.({
      op: 'begin',
      owner: bad,
    })) as string;
    await client.plugin?.({
      op: 'exec',
      owner: bad,
      token,
      sql: 'INSERT INTO {{items}} VALUES (?)',
      params: [1],
    });
    expired.rollback = async () => {
      throw new Error('injected rollback failure');
    };

    const waitingForeignWrite = client.plugin?.({
      op: 'exec',
      owner: good,
      sql: 'INSERT INTO {{items}} VALUES (?)',
      params: [2],
    });
    await expect(waitingForeignWrite).resolves.toBeUndefined();
    await expiredRemoved;
    expect(connections.has('expired-owner')).toBe(false);
    await expect(
      expired.exec('INSERT INTO {{items}} VALUES (?)', [3]),
    ).rejects.toThrow();
    await expect(
      client.plugin?.({
        op: 'exec',
        owner: bad,
        sql: 'INSERT INTO {{items}} VALUES (?)',
        params: [4],
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_DB_NOT_OPEN' });
    await expect(
      foreign.query('SELECT COUNT(*) AS c FROM {{items}}'),
    ).resolves.toEqual([{ c: 1 }]);

    await client.plugin?.({ op: 'release', owner: good });
    await client.plugin?.({ op: 'release', owner: bad });
    await client.close();
    await coordinator.close();
    channel.port1.close();
    channel.port2.close();
    for (const p of [file, `${file}-wal`, `${file}-shm`])
      if (fs.existsSync(p)) fs.rmSync(p);
  });
});
