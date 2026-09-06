/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Cap, EventMeta } from '@shared/contracts';

import { createHostRouter } from '../host-router';
import { buildSurfaces, createEventBus } from '../host-surfaces';

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
} as never;

function router(granted: Cap[]) {
  logs.length = 0;
  return createHostRouter({
    extensionId: 'test.basic',
    granted: new Set(granted),
    surfaces,
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
});
