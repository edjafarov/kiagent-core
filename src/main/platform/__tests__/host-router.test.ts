/** @jest-environment node */
import type { Cap } from '@shared/contracts';

import { createHostRouter } from '../host-router';

const logs: Array<{ scope: string; level: string; msg: string; fields?: unknown }> = [];
const logSink = { log: (scope: string, level: never, msg: string, fields?: never) => logs.push({ scope, level, msg, fields }) };

const surfaces = {
  query: { count: jest.fn(async () => 3) },
  net: { fetch: jest.fn(async () => ({ status: 200 })) },
} as never;

function router(granted: Cap[]) {
  logs.length = 0;
  return createHostRouter({ extensionId: 'test.basic', granted: new Set(granted), surfaces, logSink });
}

describe('createHostRouter', () => {
  it('dispatches granted namespaces to the surface', async () => {
    await expect(router(['query']).dispatch('query', 'count', [{}])).resolves.toBe(3);
  });

  it('denies ungranted caps with CAP_DENIED and logs a permission-violation', async () => {
    const r = router(['query']);
    await expect(r.dispatch('net', 'fetch', ['http://x'])).rejects.toThrow(
      "CAP_DENIED: extension was not granted the 'net' capability",
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ scope: 'extension:test.basic', msg: 'permission-violation' }),
    );
  });

  it('base.log is always available and unknown ns fail', async () => {
    const r = router([]);
    await expect(r.dispatch('base', 'log', ['info', 'hi'])).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'hi' }));
    await expect(r.dispatch('teleport', 'go', [])).rejects.toThrow(/unknown namespace/);
  });

  it('ungranted ns with nonexistent method fails with CAP_DENIED, not unknown method', async () => {
    const r = router([]);
    await expect(r.dispatch('query', 'nope', [])).rejects.toThrow(
      "CAP_DENIED: extension was not granted the 'query' capability",
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ scope: 'extension:test.basic', msg: 'permission-violation', fields: { ns: 'query', method: 'nope' } }),
    );
  });

  it('granted ns with nonexistent method fails with unknown method', async () => {
    const r = router(['query']);
    await expect(r.dispatch('query', 'nope', [])).rejects.toThrow(/unknown method/);
    expect(logs).not.toContainEqual(expect.objectContaining({ msg: 'permission-violation' }));
  });

  it('__proto__ dispatch rejected as unknown namespace', async () => {
    const r = router([]);
    await expect(r.dispatch('__proto__', 'anything', [])).rejects.toThrow(/unknown namespace/);
  });

  it('granted ns + "__proto__" method fails cleanly with unknown method, not a TypeError (F5)', async () => {
    const r = router(['query']);
    // Before the fix: `surfaces.query['__proto__']` resolves to
    // Object.prototype (truthy, not a function) via the prototype chain,
    // so `fn(...args)` throws a raw TypeError instead of the clean
    // 'unknown method' error.
    await expect(r.dispatch('query', '__proto__', [])).rejects.toThrow(/unknown method/);
  });
});
