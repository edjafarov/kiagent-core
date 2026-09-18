/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Cap, EventMeta } from '@shared/contracts';
import type { AttentionItemWire } from '@shared/attention';

import { openDb } from '@main/db/app-db';
import type { AppDb } from '@main/db/app-db';
import { createAttentionTx } from '@main/attention/attention-tx';
import { ATTENTION_ACTION_POLICY } from '@main/attention/action-policy';
import { createAttentionService } from '@main/attention/service';

import { createHostRouter } from '../host-router';
import { buildSurfaces, createEventBus } from '../host-surfaces';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';

const logs: Array<{
  scope: string;
  level: string;
  msg: string;
  fields?: unknown;
}> = [];
const logSink = {
  log: (scope: string, level: never, msg: string, fields?: never) =>
    logs.push({ scope, level, msg, fields }),
};

const surfaces = {
  query: { count: jest.fn(async () => 3) },
  net: { fetch: jest.fn(async () => ({ status: 200 })) },
  inference: { hear: jest.fn(async () => 'transcript') },
  attention: {
    publish: jest.fn(async () => ({ rejected: [] })),
    resolve: jest.fn(async () => ({ rejected: [] })),
  },
};

function router(granted: Cap[]) {
  logs.length = 0;
  return createHostRouter({
    extensionId: 'test.basic',
    granted: new Set(granted),
    surfaces: surfaces as never,
    logSink,
  });
}

describe('createHostRouter', () => {
  it('dispatches granted namespaces to the surface', async () => {
    await expect(
      router(['query']).dispatch('query', 'count', [{}]),
    ).resolves.toBe(3);
  });

  it('denies ungranted caps with CAP_DENIED and logs a permission-violation', async () => {
    const r = router(['query']);
    await expect(r.dispatch('net', 'fetch', ['http://x'])).rejects.toThrow(
      "CAP_DENIED: extension was not granted the 'net' capability",
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        scope: 'extension:test.basic',
        msg: 'permission-violation',
      }),
    );
  });

  it('denies ungranted attention without invoking the service', async () => {
    const r = router([]);
    await expect(r.dispatch('attention', 'publish', [[]])).rejects.toThrow(
      "CAP_DENIED: extension was not granted the 'attention' capability",
    );
    expect(surfaces.attention.publish).not.toHaveBeenCalled();
  });

  it('binds attention producer identity through the real surface and router', async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `kia-attention-router-${Date.now()}.db`,
    );
    const db = await openDb(dbPath);
    const service = createAttentionService({ db, onChanged: jest.fn() });
    const a = 'kiagent.a';
    const b = 'kiagent.b';
    service.setExtensions([
      {
        id: a,
        name: a,
        version: '1.0.0',
        origin: 'dev',
        enabled: true,
        status: 'activated',
        caps: ['attention'],
        sourceIds: [],
        oauthSources: [],
      },
      {
        id: b,
        name: b,
        version: '1.0.0',
        origin: 'dev',
        enabled: true,
        status: 'activated',
        caps: ['attention'],
        sourceIds: [],
        oauthSources: [],
      },
    ]);
    const item = (producer: string, id: string): AttentionItemWire => ({
      id: `${producer}:${id}`,
      producer,
      kind: 'upcoming',
      title: id,
      detail: null,
      priority: 1,
      dueAt: null,
      expiresAt: null,
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      state: 'open',
      resolvedBy: null,
      actions: [],
    });
    const built = buildSurfaces({
      extensionId: a,
      query: {} as never,
      inference: {} as never,
      notify: () => {},
      bus: createEventBus(),
      deliverEvent: () => {},
      attention: service,
    });
    const r = createHostRouter({
      extensionId: a,
      granted: new Set(['attention']),
      surfaces: built.surfaces,
      logSink,
    });

    await expect(
      r.dispatch('attention', 'publish', [[item(b, 'foreign')]]),
    ).resolves.toEqual({
      rejected: [{ id: `${b}:foreign`, reason: expect.any(String) }],
    });
    await expect(db.all('SELECT id FROM attention_items')).resolves.toEqual([]);

    await expect(
      r.dispatch('attention', 'publish', [[item(a, 'own')]]),
    ).resolves.toEqual({ rejected: [] });
    await expect(
      db.all('SELECT producer FROM attention_items'),
    ).resolves.toEqual([{ producer: a }]);

    await service.publish(b, [item(b, 'target')]);
    await expect(
      r.dispatch('attention', 'resolve', [`${b}:target`]),
    ).resolves.toEqual({
      rejected: [{ id: `${b}:target`, reason: expect.any(String) }],
    });
    await expect(service.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: `${b}:target`, state: 'open' }),
        expect.objectContaining({ id: `${a}:own`, state: 'open' }),
      ]),
    );

    await built.close();
    await service.dispose();
    await db.close();
    fs.rmSync(dbPath, { force: true });
  });

  it('K8b rejects the admitted extension call but commits and lists the row', async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `kia-attention-cancel-${Date.now()}-${Math.random()}.db`,
    );
    const db = await openDb(dbPath);
    if (!db._conn) throw new Error('in-process database connection missing');
    const tx = createAttentionTx(db._conn, {
      policy: ATTENTION_ACTION_POLICY,
      now: Date.now,
    });
    let markAdmitted!: () => void;
    const admitted = new Promise<void>((resolve) => {
      markAdmitted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proc = jest.fn(async (name: string, args: unknown) => {
      if (name === 'attention.publish') {
        markAdmitted();
        await gate;
        return tx.publish(args as Parameters<typeof tx.publish>[0]);
      }
      if (name === 'attention.list')
        return tx.list(args as Parameters<typeof tx.list>[0]);
      throw new Error(`unexpected attention procedure ${name}`);
    });
    const gatedDb = { ...db, _conn: undefined, proc } as AppDb;
    const service = createAttentionService({
      db: gatedDb,
      onChanged: jest.fn(),
    });
    const extensionId = 'test.attention';
    service.setExtensions([
      {
        id: extensionId,
        name: extensionId,
        version: '1.0.0',
        origin: 'dev',
        enabled: true,
        status: 'activated',
        caps: ['attention'],
        sourceIds: [],
        oauthSources: [],
      },
    ]);
    const item: AttentionItemWire = {
      id: `${extensionId}:cancelled`,
      producer: extensionId,
      kind: 'upcoming',
      title: 'cancelled',
      detail: null,
      priority: 1,
      dueAt: null,
      expiresAt: null,
      createdAt: 1,
      updatedAt: 1,
      revision: 1,
      state: 'open',
      resolvedBy: null,
      actions: [],
    };
    const built = buildSurfaces({
      extensionId,
      query: {} as never,
      inference: {} as never,
      notify: () => {},
      bus: createEventBus(),
      deliverEvent: () => {},
      attention: service,
    });
    const routerWithService = createHostRouter({
      extensionId,
      granted: new Set(['attention']),
      surfaces: built.surfaces,
      logSink,
    });
    const { main, child } = createInMemoryHostPair();
    const mainEndpoint = createRpcEndpoint(main);
    const childEndpoint = createRpcEndpoint(child);
    let markHostAborted!: () => void;
    const hostAborted = new Promise<void>((resolve) => {
      markHostAborted = resolve;
    });
    let markHostDone!: () => void;
    const hostDone = new Promise<void>((resolve) => {
      markHostDone = resolve;
    });
    mainEndpoint.onCall((ns, method, args, context) => {
      context.signal.addEventListener('abort', markHostAborted, {
        once: true,
      });
      const routed = routerWithService.dispatch(ns, method, args, context);
      routed.then(markHostDone, markHostDone);
      return routed;
    });
    const controller = new AbortController();
    const call = childEndpoint.call('attention', 'publish', [[item]], {
      signal: controller.signal,
    });
    await admitted;
    const rejection = call.then(
      () => {
        throw new Error('expected the extension-side call to reject');
      },
      (error) =>
        expect(error).toMatchObject({
          name: 'AbortError',
          code: 'RPC_ABORTED',
        }),
    );
    controller.abort();
    await hostAborted;
    release();
    await rejection;
    await hostDone;
    await expect(
      db.all('SELECT id, state FROM attention_items WHERE id = ?', [item.id]),
    ).resolves.toEqual([{ id: item.id, state: 'open' }]);
    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ id: item.id, state: 'open' }),
    ]);

    mainEndpoint.dispose('test complete');
    childEndpoint.dispose('test complete');
    await built.close();
    await service.dispose();
    await db.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(`${dbPath}${suffix}`)) fs.rmSync(`${dbPath}${suffix}`);
    }
  });

  it("inference.hear rides the namespace's existing gate — granted dispatches, ungranted is CAP_DENIED", async () => {
    await expect(
      router(['inference']).dispatch('inference', 'hear', [new Uint8Array()]),
    ).resolves.toBe('transcript');
    await expect(
      router([]).dispatch('inference', 'hear', [new Uint8Array()]),
    ).rejects.toThrow(
      "CAP_DENIED: extension was not granted the 'inference' capability",
    );
  });

  it('base.log is always available and unknown ns fail', async () => {
    const r = router([]);
    await expect(
      r.dispatch('base', 'log', ['info', 'hi']),
    ).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'hi' }));
    await expect(r.dispatch('teleport', 'go', [])).rejects.toThrow(
      /unknown namespace/,
    );
  });

  it('ungranted ns with nonexistent method fails with CAP_DENIED, not unknown method', async () => {
    const r = router([]);
    await expect(r.dispatch('query', 'nope', [])).rejects.toThrow(
      "CAP_DENIED: extension was not granted the 'query' capability",
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        scope: 'extension:test.basic',
        msg: 'permission-violation',
        fields: { ns: 'query', method: 'nope' },
      }),
    );
  });

  it('granted ns with nonexistent method fails with unknown method', async () => {
    const r = router(['query']);
    await expect(r.dispatch('query', 'nope', [])).rejects.toThrow(
      /unknown method/,
    );
    expect(logs).not.toContainEqual(
      expect.objectContaining({ msg: 'permission-violation' }),
    );
  });

  it('__proto__ dispatch rejected as unknown namespace', async () => {
    const r = router([]);
    await expect(r.dispatch('__proto__', 'anything', [])).rejects.toThrow(
      /unknown namespace/,
    );
  });

  it('granted ns + "__proto__" method fails cleanly with unknown method, not a TypeError (F5)', async () => {
    const r = router(['query']);
    // Before the fix: `surfaces.query['__proto__']` resolves to
    // Object.prototype (truthy, not a function) via the prototype chain,
    // so `fn(...args)` throws a raw TypeError instead of the clean
    // 'unknown method' error.
    await expect(r.dispatch('query', '__proto__', [])).rejects.toThrow(
      /unknown method/,
    );
  });

  // #112 regression: `dispatch` calls `fn(...args)` with no arity check of
  // its own — a compromised child is not bound by the typed, two-argument
  // `CapSurfaces.events.emit(event, payload)` wrapper and can push extra
  // elements onto the RPC `args` array. This reproduces that attack
  // directly against the router/real-surface dispatch path (not the typed
  // wrapper, which a hostile child never goes through) and pins that the
  // smuggled third argument never reaches `EventMeta.from`.
  it('a hostile dispatch smuggling a third arg past events.emit cannot choose its own EventMeta.from (#112)', async () => {
    const bus = createEventBus();
    const delivered: Array<{ payload: unknown; meta: EventMeta }> = [];
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kia-router-events-'),
    );
    const { surfaces: eventSurfaces } = buildSurfaces({
      extensionId: 'kiagent.a',
      dataDir,
      query: {} as never,
      inference: {} as never,
      notify: () => {},
      bus,
      deliverEvent: (_name, payload, meta) => delivered.push({ payload, meta }),
      attention: {
        publish: async () => ({ rejected: [] }),
        resolve: async () => ({ rejected: [] }),
      } as never,
    });
    // Self-subscribe so the emit below is observed the same way a peer
    // extension's subscription would be.
    eventSurfaces.events.on('x.record');

    const r = createHostRouter({
      extensionId: 'kiagent.a',
      granted: new Set(['events']),
      surfaces: eventSurfaces,
      logSink,
    });

    // The attack: a THIRD array element — the typed surface's `emit` only
    // declares two parameters, so this simulates a hostile child sending
    // an RPC call the typed wrapper could never construct.
    await r.dispatch('events', 'emit', [
      'x.record',
      { producer: 'kiagent.b' },
      'kiagent.b', // smuggled forged `from` — must be dropped, not honored
    ]);
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });

    expect(delivered).toEqual([
      {
        payload: { producer: 'kiagent.b' },
        meta: { from: 'kiagent.a', at: expect.any(Number) },
      },
    ]);
  });

  it('fails closed when migration registration is not injected', async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kia-router-migrate-'),
    );
    const { surfaces: migrationSurfaces, close } = buildSurfaces({
      extensionId: 'test.migrate',
      dataDir,
      query: {} as never,
      inference: {} as never,
      notify: () => {},
      bus: createEventBus(),
      deliverEvent: () => {},
      attention: {
        publish: async () => ({ rejected: [] }),
        resolve: async () => ({ rejected: [] }),
      } as never,
    });
    await expect(
      migrationSurfaces.db.migrate('missing', 1, [
        'CREATE TABLE injected (id INTEGER)',
      ]),
    ).rejects.toMatchObject({ code: 'PLUGIN_MIGRATION_NOT_REGISTERED' });
    await expect(
      migrationSurfaces.db.query(
        'SELECT name FROM sqlite_master WHERE name = ?',
        ['injected'],
      ),
    ).rejects.toThrow(/worker owner is wired/);
    await close();
  });

  it('routes cancellation to the method-specific overload positions', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const db = {
      exec: jest.fn(async (...args: unknown[]) => {
        calls.push({ method: 'exec', args });
      }),
      query: jest.fn(async (...args: unknown[]) => {
        calls.push({ method: 'query', args });
        return [];
      }),
      batch: jest.fn(async (...args: unknown[]) => {
        calls.push({ method: 'batch', args });
        return [];
      }),
    };
    const routerWithDb = createHostRouter({
      extensionId: 'test.db',
      granted: new Set(['db']),
      surfaces: { db } as never,
      logSink,
    });
    const { signal } = new AbortController();
    await routerWithDb.dispatch('db', 'exec', ['SELECT 1'], { signal });
    await routerWithDb.dispatch('db', 'query', ['SELECT 1', []], { signal });
    await routerWithDb.dispatch('db', 'batch', [[{ sql: 'SELECT 1' }]], {
      signal,
    });
    expect(calls[0].args[3]).toBe(signal);
    expect(calls[1].args[3]).toBe(signal);
    expect(calls[2].args[2]).toBe(signal);
  });

  it('does not append extension cancellation to attention mutations', async () => {
    const calls: unknown[][] = [];
    const { signal } = new AbortController();
    const r = createHostRouter({
      extensionId: 'test.attention',
      granted: new Set(['attention']),
      surfaces: {
        attention: {
          publish: jest.fn(async (...args: unknown[]) => {
            calls.push(args);
            return { rejected: [] };
          }),
          resolve: jest.fn(async (...args: unknown[]) => {
            calls.push(args);
            return { rejected: [] };
          }),
        },
      } as never,
      logSink,
    });
    await r.dispatch('attention', 'publish', [[]], { signal });
    expect(calls).toEqual([[[]]]);
  });

  it('routes a tokenized query signal after omitted params', async () => {
    const query = jest.fn(async (...args: unknown[]) => args);
    const routerWithDb = createHostRouter({
      extensionId: 'test.db',
      granted: new Set(['db']),
      surfaces: { db: { query } } as never,
      logSink,
    });
    const { signal } = new AbortController();

    await routerWithDb.dispatch('db', 'query', ['tx-1', 'SELECT 1'], {
      transactionId: 'tx-1',
      signal,
    });

    expect(query).toHaveBeenCalledWith('tx-1', 'SELECT 1', undefined, signal);
  });

  it('routes cancellation for token overloads and migrate without shifting user arguments', async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const db = {
      exec: jest.fn(async (...args: unknown[]) => {
        calls.push({ method: 'exec', args });
      }),
      batch: jest.fn(async (...args: unknown[]) => {
        calls.push({ method: 'batch', args });
        return [];
      }),
      migrate: jest.fn(async (...args: unknown[]) => {
        calls.push({ method: 'migrate', args });
      }),
    };
    const routerWithDb = createHostRouter({
      extensionId: 'test.db',
      granted: new Set(['db']),
      surfaces: { db } as never,
      logSink,
    });
    const { signal } = new AbortController();

    await routerWithDb.dispatch(
      'db',
      'exec',
      ['tx-1', 'INSERT INTO t VALUES (?)', [1]],
      { transactionId: 'tx-1', signal },
    );
    await routerWithDb.dispatch(
      'db',
      'batch',
      ['tx-1', [{ sql: 'SELECT 1' }]],
      { transactionId: 'tx-1', signal },
    );
    await routerWithDb.dispatch(
      'db',
      'migrate',
      ['base', 1, ['CREATE TABLE t (id INTEGER)']],
      { signal },
    );

    expect(calls[0].args).toEqual([
      'tx-1',
      'INSERT INTO t VALUES (?)',
      [1],
      signal,
    ]);
    expect(calls[1].args).toEqual(['tx-1', [{ sql: 'SELECT 1' }], signal]);
    expect(calls[2].args).toEqual([
      'base',
      1,
      ['CREATE TABLE t (id INTEGER)'],
      signal,
    ]);
  });

  it('enforces transaction context for raw transaction controls', async () => {
    const { signal } = new AbortController();
    const r = createHostRouter({
      extensionId: 'test.db',
      granted: new Set(['db']),
      surfaces: {
        db: {
          begin: jest.fn(),
          commit: jest.fn(),
          rollback: jest.fn(),
        },
      } as never,
      logSink,
    });
    await expect(
      r.dispatch('db', 'begin', [], { transactionId: 'held-token', signal }),
    ).rejects.toMatchObject({ code: 'HOST_CALL_IN_TRANSACTION' });
    await expect(
      r.dispatch('db', 'commit', ['other-token'], {
        transactionId: 'held-token',
        signal,
      }),
    ).rejects.toMatchObject({ code: 'HOST_CALL_IN_TRANSACTION' });
    await expect(
      r.dispatch('db', 'rollback', ['held-token'], {
        transactionId: 'held-token',
        signal,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects raw begin without an RPC transaction context', async () => {
    const begin = jest.fn(async () => 'usable-token');
    const r = createHostRouter({
      extensionId: 'test.db',
      granted: new Set(['db']),
      surfaces: { db: { begin } } as never,
      logSink,
    });

    await expect(r.dispatch('db', 'begin', [])).rejects.toMatchObject({
      code: 'HOST_CALL_IN_TRANSACTION',
    });
    expect(begin).not.toHaveBeenCalled();
  });

  it('rejects a token overload from a different RPC transaction context', async () => {
    const exec = jest.fn(async () => undefined);
    const { signal } = new AbortController();
    const r = createHostRouter({
      extensionId: 'test.db',
      granted: new Set(['db']),
      surfaces: { db: { exec } } as never,
      logSink,
    });

    await expect(
      r.dispatch('db', 'exec', ['foreign-token', 'SELECT 1'], {
        transactionId: 'caller-token',
        signal,
      }),
    ).rejects.toMatchObject({ code: 'HOST_CALL_IN_TRANSACTION' });
    expect(exec).not.toHaveBeenCalled();
  });
});
