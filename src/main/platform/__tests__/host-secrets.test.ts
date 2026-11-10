/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Cap, Query } from '@shared/contracts';
import { LONE_ROLE } from '@shared/contracts';

import { runExtensionHost } from '../extension-host-entry';
import { createHostRouter } from '../host-router';
import { buildSurfaces, createEventBus } from '../host-surfaces';
import { parseManifest } from '../manifest';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';
import { SyncReadOnly } from '../../core/sync/role';

const noop = async () => '';
const logSink = { log: () => {} } as never;

/** A secrets store over a map; `keys` records what was written. */
function fakeSecrets() {
  const rows = new Map<string, string>();
  return {
    rows,
    save: async (k: string, v: string) => void rows.set(k, v),
    load: async (k: string) => rows.get(k) ?? null,
  };
}

function fakeSync(readOnly = false) {
  const state = { readOnly };
  const listeners: ((k: string) => void)[] = [];
  return {
    state,
    readOnly: () => state.readOnly,
    onSecret: (cb: (k: string) => void) => void listeners.push(cb),
    arrive: (k: string) => listeners.forEach((l) => l(k)),
  };
}

describe('host.secrets surface', () => {
  let dir: string;
  const opened: Array<() => void | Promise<void>> = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-host-secrets-'));
  });
  afterEach(async () => {
    for (const c of opened.splice(0)) await c();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function build(
    extensionId: string,
    o: {
      secrets?: ReturnType<typeof fakeSecrets>;
      sync?: ReturnType<typeof fakeSync>;
      delivered?: unknown[][];
      granted?: Cap[];
    },
  ) {
    const built = buildSurfaces({
      extensionId,
      dataDir: dir,
      query: {} as Query,
      inference: {
        complete: noop,
        see: noop,
        read: noop,
        hear: noop,
        lane: async () => 'open' as const,
        describe: async () => null,
      },
      notify: () => {},
      bus: createEventBus(),
      deliverEvent: (...a: unknown[]) => void o.delivered?.push(a),
      attention: {} as never,
      secrets: o.secrets,
      sync: o.sync,
    } as never);
    opened.push(() => built.close());
    return {
      built,
      router: createHostRouter({
        extensionId,
        granted: new Set<Cap>(o.granted ?? ['secrets']),
        surfaces: built.surfaces,
        logSink,
        role: () => LONE_ROLE,
      }),
    };
  }

  it('put then get round-trips under secret:<id>:<name>; another extension sees nothing', async () => {
    const secrets = fakeSecrets();
    const a = build('ext.a', { secrets }).router;
    await a.dispatch('secrets', 'put', ['identity', 'v']);
    expect([...secrets.rows.keys()]).toEqual(['secret:ext.a:identity']);
    expect(await a.dispatch('secrets', 'get', ['identity'])).toBe('v');
    expect(await a.dispatch('secrets', 'get', ['nothing'])).toBeNull();
    const b = build('ext.b', { secrets }).router;
    expect(await b.dispatch('secrets', 'get', ['identity'])).toBeNull();
  });

  it('refuses a name outside /^[a-z0-9-]{1,40}$/', async () => {
    const secrets = fakeSecrets();
    const r = build('ext.a', { secrets }).router;
    for (const bad of ['', 'A', 'a:b', 'a.b', 'x'.repeat(41), 3]) {
      await expect(r.dispatch('secrets', 'put', [bad, 'v'])).rejects.toThrow('invalid secret name');
      await expect(r.dispatch('secrets', 'get', [bad])).rejects.toThrow('invalid secret name');
    }
    expect(secrets.rows.size).toBe(0);
  });

  it('put on a read-only copy rejects with SyncReadOnly and stores nothing', async () => {
    const secrets = fakeSecrets();
    const sync = fakeSync(true);
    const r = build('ext.a', { secrets, sync }).router;
    await expect(r.dispatch('secrets', 'put', ['identity', 'v'])).rejects.toBeInstanceOf(SyncReadOnly);
    expect(secrets.rows.size).toBe(0);
    sync.state.readOnly = false;
    await r.dispatch('secrets', 'put', ['identity', 'v']);
    expect(secrets.rows.size).toBe(1);
  });

  it('a watcher is told of its own put and of an imported key of its own, nothing else', async () => {
    const secrets = fakeSecrets();
    const sync = fakeSync();
    const delivered: unknown[][] = [];
    const { router } = build('ext.a', { secrets, sync, delivered });
    await router.dispatch('secrets', 'put', ['early', 'v']); // before watching
    await router.dispatch('secrets', 'watch', []);
    await router.dispatch('secrets', 'put', ['mine', 'v']);
    sync.arrive('secret:ext.a:x');
    sync.arrive('secret:ext.b:x');
    sync.arrive('secret:ext.a:sub:x'); // not this extension's name shape
    sync.arrive('gmail-1');
    expect(delivered.map((d) => [d[0], d[1]])).toEqual([
      ['platform.secrets.change', { name: 'mine' }],
      ['platform.secrets.change', { name: 'x' }],
    ]);
    await router.dispatch('secrets', 'unwatch', []);
    await router.dispatch('secrets', 'put', ['again', 'v']);
    sync.arrive('secret:ext.a:y');
    expect(delivered).toHaveLength(2);
  });

  it('closing the surface stops delivery', async () => {
    const sync = fakeSync();
    const delivered: unknown[][] = [];
    const { router, built } = build('ext.a', { secrets: fakeSecrets(), sync, delivered });
    await router.dispatch('secrets', 'watch', []);
    await built.close();
    sync.arrive('secret:ext.a:x');
    expect(delivered).toEqual([]);
  });

  it('an extension without the secrets grant is refused by the router', async () => {
    const secrets = fakeSecrets();
    const r = build('ext.a', { secrets, granted: [] }).router;
    await expect(r.dispatch('secrets', 'put', ['identity', 'v'])).rejects.toThrow(/CAP_DENIED/);
    expect(secrets.rows.size).toBe(0);
  });

  it('a surface built without a store rejects', async () => {
    const r = build('ext.a', {}).router;
    await expect(r.dispatch('secrets', 'get', ['identity'])).rejects.toThrow(/not available/);
  });
});

describe('manifest tier for secrets', () => {
  const base = {
    id: 'pub.sec',
    name: 'Sec',
    version: '1.0.0',
    engine: '^2.0.0',
    entry: 'index.js',
    caps: ['secrets'],
    contributes: { senders: [] },
  };
  it('a non-bundled extension asking for secrets fails validation', () => {
    expect(() => parseManifest(base)).toThrow(/secrets.*bundled/i);
    expect(() => parseManifest(base, { tier: 'external' })).toThrow(/secrets.*bundled/i);
  });
  it('a bundled one is accepted', () => {
    expect(parseManifest(base, { tier: 'bundled' }).caps).toContain('secrets');
  });
});

describe('host.secrets in the extension process', () => {
  it('get/put go to the host and onChange rides platform.secrets.change', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    const calls: Array<[string, string, unknown[]]> = [];
    let unwatchedResolve!: () => void;
    const unwatched = new Promise<void>((r) => (unwatchedResolve = r));
    mainEp.onCall(async (ns, method, args) => {
      calls.push([ns, method, args]);
      if (method === 'unwatch') unwatchedResolve();
      return method === 'get' ? 'v1' : undefined;
    });
    let seenResolve!: () => void;
    const seenAll = new Promise<void>((r) => (seenResolve = r));
    const seen: string[] = [];
    let off: (() => void) | undefined;
    let got: unknown;
    const mod = {
      async activate(host: {
        secrets: {
          get(n: string): Promise<unknown>;
          put(n: string, v: string): Promise<void>;
          onChange(cb: (n: string) => void): () => void;
        };
      }) {
        got = await host.secrets.get('identity');
        await host.secrets.put('identity', 'v2');
        off = host.secrets.onChange((n) => {
          seen.push(n);
          if (seen.length === 2) seenResolve();
        });
        return {};
      },
    };
    runExtensionHost(child, { requireModule: () => mod, exit: jest.fn() });
    const activated = new Promise<void>((res) => {
      const o = mainEp.onNotify((m) => {
        if (m.kind === 'activated') {
          o();
          res();
        }
      });
    });
    mainEp.post({
      kind: 'bootstrap',
      v: 1,
      extensionId: 'test.s',
      entryAbsPath: '/x.js',
      dataDir: '/d',
      caps: ['secrets'] as Cap[],
    });
    await activated;
    expect(got).toBe('v1');
    expect(calls).toEqual([
      ['secrets', 'get', ['identity']],
      ['secrets', 'put', ['identity', 'v2']],
      ['secrets', 'watch', []],
    ]);
    for (const [name, at] of [['a', 1], ['b', 2]] as const)
      mainEp.post({
        kind: 'event',
        name: 'platform.secrets.change',
        payload: { name },
        meta: { from: 'platform', at },
      });
    await seenAll;
    expect(seen).toEqual(['a', 'b']);
    off!();
    await unwatched;
    expect(calls[calls.length - 1]).toEqual(['secrets', 'unwatch', []]);
  });
});
