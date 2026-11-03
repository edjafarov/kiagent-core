/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Cap, Query } from '@shared/contracts';

import { runExtensionHost } from '../extension-host-entry';
import { createHostRouter } from '../host-router';
import { buildSurfaces, createEventBus } from '../host-surfaces';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';
import { createPrefs, type UserPrefsStore } from '../../core/prefs';

function fakeStore(initial: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = { ...initial };
  const s: UserPrefsStore & { rows: Record<string, unknown> } = {
    rows,
    all: async () => JSON.parse(JSON.stringify(rows)),
    set: async (k, v) => {
      rows[k] = v;
    },
    canWrite: () => true,
  };
  return s;
}

const noop = async () => '';
const logSink = { log: () => {} } as never;

describe('host.prefs surface', () => {
  let dir: string;
  let store: ReturnType<typeof fakeStore>;
  let prefs: ReturnType<typeof createPrefs>;
  const opened: Array<() => void | Promise<void>> = [];
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-host-prefs-'));
    store = fakeStore();
    prefs = createPrefs(dir, store);
    await prefs.ready;
  });
  afterEach(async () => {
    for (const c of opened.splice(0)) await c();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function surfaceFor(extensionId: string, delivered: unknown[][] = []) {
    const built = buildSurfaces({
      extensionId,
      dataDir: dir,
      query: {} as Query,
      inference: { complete: noop, see: noop, read: noop, hear: noop, lane: async () => 'open' as const, describe: async () => null },
      notify: () => {},
      bus: createEventBus(),
      deliverEvent: (...a: unknown[]) => void delivered.push(a),
      attention: {} as never,
      prefs,
    } as never);
    opened.push(() => built.close());
    return createHostRouter({
      extensionId,
      granted: new Set<Cap>(['prefs']),
      surfaces: built.surfaces,
      logSink,
    });
  }

  it("set('a', 1) stores <extensionId>.a and get reads it back", async () => {
    const r = surfaceFor('ext.id');
    await r.dispatch('prefs', 'set', ['a', 1]);
    expect(store.rows['ext.id.a']).toBe(1);
    expect(await r.dispatch('prefs', 'get', ['a'])).toBe(1);
    expect(await r.dispatch('prefs', 'get', ['nothing'])).toBeUndefined();
  });

  it('another extension cannot read it, not even by naming the full key', async () => {
    await surfaceFor('ext.id').dispatch('prefs', 'set', ['a', 1]);
    const other = surfaceFor('other.id');
    expect(await other.dispatch('prefs', 'get', ['a'])).toBeUndefined();
    await expect(other.dispatch('prefs', 'get', ['ext.id.a'])).rejects.toThrow(/name/);
    // 'ext' + name 'id.a' would alias 'ext.id' + 'a': dotted names are refused.
    const ext = surfaceFor('ext');
    await expect(ext.dispatch('prefs', 'get', ['id.a'])).rejects.toThrow(/name/);
    await expect(ext.dispatch('prefs', 'set', ['id.a', 2])).rejects.toThrow(/name/);
  });

  it('an empty or non-string name, or a non-JSON value, is refused', async () => {
    const r = surfaceFor('ext.id');
    await expect(r.dispatch('prefs', 'set', ['', 1])).rejects.toThrow(/name/);
    await expect(r.dispatch('prefs', 'set', [3, 1])).rejects.toThrow(/name/);
    await expect(r.dispatch('prefs', 'set', ['a', () => 1])).rejects.toThrow(/JSON/);
    expect(store.rows).toEqual({});
  });

  it('without the prefs capability the namespace is denied', async () => {
    const built = buildSurfaces({
      extensionId: 'ext.id', dataDir: dir, query: {} as Query,
      inference: { complete: noop, see: noop, read: noop, hear: noop, lane: async () => 'open' as const, describe: async () => null },
      notify: () => {}, bus: createEventBus(), deliverEvent: () => {}, attention: {} as never, prefs,
    } as never);
    opened.push(() => built.close());
    const r = createHostRouter({ extensionId: 'ext.id', granted: new Set<Cap>(), surfaces: built.surfaces, logSink });
    await expect(r.dispatch('prefs', 'get', ['a'])).rejects.toThrow(/CAP_DENIED/);
  });

  it("a watching extension is told after refreshUser about its own keys only", async () => {
    const delivered: unknown[][] = [];
    const r = surfaceFor('ext.id', delivered);
    surfaceFor('other.id'); // a second extension, not watching
    await r.dispatch('prefs', 'watch', []);
    store.rows['ext.id.a'] = 7;
    store.rows['other.id.a'] = 8;
    store.rows['ext.id.sub.deep'] = 9; // belongs to extension 'ext.id.sub'
    await prefs.refreshUser();
    expect(delivered.map((d) => [d[0], d[1]])).toEqual([['platform.prefs.change', { name: 'a', value: 7 }]]);
    await r.dispatch('prefs', 'unwatch', []);
    store.rows['ext.id.a'] = 10;
    await prefs.refreshUser();
    expect(delivered).toHaveLength(1);
  });

  it('closing the surface stops delivery', async () => {
    const delivered: unknown[][] = [];
    const built = buildSurfaces({
      extensionId: 'ext.id', dataDir: dir, query: {} as Query,
      inference: { complete: noop, see: noop, read: noop, hear: noop, lane: async () => 'open' as const, describe: async () => null },
      notify: () => {}, bus: createEventBus(), deliverEvent: (...a: unknown[]) => void delivered.push(a), attention: {} as never, prefs,
    } as never);
    await (built.surfaces.prefs.watch as () => unknown)();
    await built.close();
    store.rows['ext.id.a'] = 1;
    await prefs.refreshUser();
    expect(delivered).toEqual([]);
  });
});

describe('host.prefs in the extension process', () => {
  it('get/set go to the host as prefs.get/prefs.set and onChange rides the platform.prefs.change event', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    const calls: Array<[string, string, unknown[]]> = [];
    mainEp.onCall(async (ns, method, args) => {
      calls.push([ns, method, args]);
      return method === 'get' ? 41 : undefined;
    });
    const seen: unknown[][] = [];
    let off: (() => void) | undefined;
    let got: unknown;
    const mod = {
      async activate(host: { prefs: { get(n: string): Promise<unknown>; set(n: string, v: unknown): Promise<void>; onChange(cb: (n: string, v: unknown) => void): () => void } }) {
        got = await host.prefs.get('a');
        await host.prefs.set('a', 2);
        off = host.prefs.onChange((n, v) => seen.push([n, v]));
        return {};
      },
    };
    runExtensionHost(child, { requireModule: () => mod, exit: jest.fn() });
    const activated = new Promise<void>((res) => {
      const o = mainEp.onNotify((m) => {
        if (m.kind === 'activated') { o(); res(); }
      });
    });
    mainEp.post({ kind: 'bootstrap', v: 1, extensionId: 'test.p', entryAbsPath: '/x.js', dataDir: '/d', caps: ['prefs'] as Cap[] });
    await activated;
    expect(got).toBe(41);
    expect(calls).toEqual([
      ['prefs', 'get', ['a']],
      ['prefs', 'set', ['a', 2]],
      ['prefs', 'watch', []],
    ]);
    mainEp.post({ kind: 'event', name: 'platform.prefs.change', payload: { name: 'a', value: 3 }, meta: { from: 'platform', at: 1 } });
    mainEp.post({ kind: 'event', name: 'platform.prefs.change', payload: { name: 'b', value: undefined }, meta: { from: 'platform', at: 2 } });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([['a', 3], ['b', undefined]]);
    off!();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls[calls.length - 1]).toEqual(['prefs', 'unwatch', []]);
  });
});
