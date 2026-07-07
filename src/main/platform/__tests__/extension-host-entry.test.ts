/** @jest-environment node */
import type { Cap } from '@shared/contracts';
import type { ChildToMain, Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';

const BOOT = {
  kind: 'bootstrap' as const,
  v: 1 as const,
  extensionId: 'test.basic',
  entryAbsPath: '/virtual/entry.js',
  dataDir: '/virtual/data',
  caps: ['query', 'net'] as Cap[],
};

/** Boots the child runtime in-process against a scripted module. */
function boot(mod: unknown, extraDeps: { mainApi?: unknown } = {}) {
  const { main, child } = createInMemoryHostPair();
  const mainEp = createRpcEndpoint(main);
  const exit = jest.fn();
  const requireModule = jest.fn(() => mod);
  runExtensionHost(child, { requireModule, exit, ...extraDeps });
  const waitFor = <K extends ChildToMain['kind']>(kind: K) =>
    new Promise<Extract<ChildToMain, { kind: K }>>((resolve) => {
      const off = mainEp.onNotify((m) => {
        if (m.kind === kind) {
          off();
          resolve(m as never);
        }
      });
    });
  return { mainEp, exit, requireModule, waitFor };
}

describe('runExtensionHost — bootstrap/activate', () => {
  it('requires the entry, activates, and reports contribution descriptors', async () => {
    const activate = jest.fn(async () => ({
      sources: [],
      tools: [
        {
          name: 'echo',
          description: 'd',
          inputSchema: {},
          call: async (a: unknown) => a,
        },
      ],
    }));
    const { mainEp, waitFor, requireModule } = boot({ default: { activate } });
    const activated = waitFor('activated');
    const ready = waitFor('ready');
    mainEp.post(BOOT);
    await ready;
    const { contributions } = (await activated) as {
      contributions: Contributions;
    };
    expect(requireModule).toHaveBeenCalledWith('/virtual/entry.js');
    expect(contributions.tools).toEqual([
      { name: 'echo', description: 'd', inputSchema: {}, tier: undefined },
    ]);
    expect(activate).toHaveBeenCalled();
  });

  it('host proxy: activate() can call query through the endpoint; self is local', async () => {
    let seenSelf: unknown;
    const mod = {
      async activate(host: {
        self: { id: string; dataDir: string };
        query: { count(q: unknown): Promise<number> };
      }) {
        seenSelf = host.self;
        const n = await host.query.count({});
        return {
          tools: [
            {
              name: 't',
              description: String(n),
              inputSchema: {},
              call: async () => n,
            },
          ],
        };
      },
    };
    const { mainEp, waitFor } = boot(mod);
    mainEp.onCall(async (ns, method) =>
      ns === 'query' && method === 'count' ? 42 : null,
    );
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    const { contributions } = (await activated) as {
      contributions: Contributions;
    };
    expect(seenSelf).toEqual({ id: 'test.basic', dataDir: '/virtual/data' });
    expect(contributions.tools[0].description).toBe('42');
  });

  it('tool calls dispatch to the kept tool object', async () => {
    const mod = {
      async activate() {
        return {
          tools: [
            {
              name: 'sum',
              description: '',
              inputSchema: {},
              call: async (a: { x: number }) => a.x + 1,
            },
          ],
        };
      },
    };
    const { mainEp, waitFor } = boot(mod);
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    await activated;
    await expect(mainEp.call('tool', 'sum', [{ x: 4 }])).resolves.toBe(5);
  });

  it('a throwing activate sends errored; deactivate runs the hook then exits 0', async () => {
    const bad = boot({
      activate: async () => {
        throw new Error('boom');
      },
    });
    const errored = bad.waitFor('errored');
    bad.mainEp.post(BOOT);
    expect((await errored).error).toMatch(/boom/);

    const deactivate = jest.fn();
    const good = boot({ activate: async () => ({}), deactivate });
    const activated = good.waitFor('activated');
    good.mainEp.post(BOOT);
    await activated;
    good.mainEp.post({ kind: 'deactivate' });
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(deactivate).toHaveBeenCalled();
    expect(good.exit).toHaveBeenCalledWith(0);
  });

  it('events: remote emissions dispatch to locally-registered callbacks', async () => {
    const seen: unknown[] = [];
    const mod = {
      async activate(host: {
        events: { on(e: string, cb: (p: unknown) => void): () => void };
      }) {
        host.events.on('ping', (p) => seen.push(p));
        return {};
      },
    };
    const { mainEp, waitFor } = boot(mod);
    mainEp.onCall(async () => undefined); // accepts the events.on registration
    const activated = waitFor('activated');
    mainEp.post({ ...BOOT, caps: [...BOOT.caps, 'events'] as Cap[] });
    await activated;
    mainEp.post({ kind: 'event', name: 'ping', payload: { n: 1 } });
    await new Promise((r) => {
      setTimeout(r, 10);
    });
    expect(seen).toEqual([{ n: 1 }]);
  });

  it('passes extras.mainProcess to activate() when the cap is granted and mainApi is provided', async () => {
    const seen: unknown[] = [];
    const mod = {
      activate: async (host: unknown, extras?: { mainProcess: unknown }) => {
        seen.push(extras?.mainProcess);
        return { sources: [], tools: [] };
      },
    };
    const { mainEp, waitFor } = boot(mod, { mainApi: { marker: 42 } });
    const activated = waitFor('activated');
    mainEp.post({ ...BOOT, caps: ['unsafe.mainProcess'] as Cap[] });
    await activated;
    expect(seen).toEqual([{ marker: 42 }]);
  });

  it('passes no extras when the cap is absent, even if mainApi is provided', async () => {
    const seen: unknown[] = [];
    const mod = {
      activate: async (host: unknown, extras?: { mainProcess: unknown }) => {
        seen.push(extras?.mainProcess);
        return { sources: [], tools: [] };
      },
    };
    const { mainEp, waitFor } = boot(mod, { mainApi: { marker: 42 } });
    const activated = waitFor('activated');
    mainEp.post({ ...BOOT, caps: ['net'] as Cap[] });
    await activated;
    expect(seen).toEqual([undefined]);
  });

  it('passes no extras when mainApi is not provided, even with the cap', async () => {
    const seen: unknown[] = [];
    const mod = {
      activate: async (host: unknown, extras?: { mainProcess: unknown }) => {
        seen.push(extras?.mainProcess);
        return { sources: [], tools: [] };
      },
    };
    const { mainEp, waitFor } = boot(mod);
    const activated = waitFor('activated');
    mainEp.post({ ...BOOT, caps: ['unsafe.mainProcess'] as Cap[] });
    await activated;
    expect(seen).toEqual([undefined]);
  });
});

describe('runExtensionHost — source runner', () => {
  const account = {
    id: 'acc1',
    source: 'basicsrc',
    identifier: 'x',
    config: {},
    status: 'connecting',
    cursor: null,
    createdAt: 'now',
  };

  function sourceMod() {
    const pulled: unknown[] = [];
    const mod = {
      async activate() {
        return {
          sources: [
            {
              descriptor: {
                id: 'basicsrc',
                name: 'Basic',
                documentTypes: ['t'],
                auth: 'password' as const,
              },
              async connect(auth: {
                prompt(s: unknown): Promise<Record<string, unknown>>;
              }) {
                const a = await auth.prompt({ fields: ['password'] });
                return { identifier: `user-${a.password}` };
              },
              async *pull(
                session: {
                  credentials(): Promise<unknown>;
                  signal: AbortSignal;
                },
                cursor: { n: number } | null,
              ) {
                pulled.push(cursor);
                const creds = (await session.credentials()) as {
                  password?: string;
                } | null;
                yield {
                  phase: 'backfill',
                  items: [
                    { v: `a-${creds?.password}` },
                    { v: 'skip' },
                    { v: 'b' },
                  ],
                  cursor: { n: 1 },
                };
                if (session.signal.aborted) return;
                yield { phase: 'live', items: [{ v: 'c' }], cursor: { n: 2 } };
              },
              toDocument(item: { v: string }) {
                if (item.v === 'skip') return null;
                if (item.v === 'b') {
                  return [
                    {
                      externalId: 'b1',
                      type: 't',
                      title: 'b1',
                      markdown: 'b1',
                      metadata: {},
                      createdAt: null,
                    },
                    {
                      externalId: 'b2',
                      type: 't',
                      title: 'b2',
                      markdown: 'b2',
                      metadata: {},
                      createdAt: null,
                    },
                  ];
                }
                return {
                  externalId: item.v,
                  type: 't',
                  title: item.v,
                  markdown: item.v,
                  metadata: {},
                  createdAt: null,
                };
              },
              async fetchBytes(_s: unknown, doc: { id: string }) {
                return new Uint8Array([1, 2, Number(doc.id.length)]);
              },
            },
          ],
        };
      },
    };
    return { mod, pulled };
  }

  it('connect proxies auth verbs; pull is demand-driven with toDocument applied child-side', async () => {
    const { mod, pulled } = sourceMod();
    const { mainEp, waitFor } = boot(mod);
    mainEp.onCall(async (ns, method, _args) => {
      if (ns === 'auth' && method === 'prompt') return { password: 'pw' };
      if (ns === 'session' && method === 'credentials')
        return { password: 'tok' };
      if (ns === 'session' && method === 'log') return undefined;
      throw new Error(`unexpected ${ns}.${method}`);
    });
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    await activated;

    await expect(
      mainEp.call('source', 'connect', [11, 'basicsrc']),
    ).resolves.toEqual({
      identifier: 'user-pw',
    });

    await mainEp.call('source', 'pull-open', [21, 'basicsrc', account, null]);
    // After pull-open, generator body has not run yet (demand-driven)
    await new Promise((r) => setImmediate(r));
    expect(pulled).toEqual([]);

    const batch1 = waitFor('src-batch');
    mainEp.post({ kind: 'src-next', pullId: 21 });
    const b1 = await batch1;
    // 3 items → skip dropped, 'b' fanned out to 2 docs → 3 DocumentInputs
    expect(
      b1.batch.items.map((i: { externalId: string }) => i.externalId),
    ).toEqual(['a-tok', 'b1', 'b2']);
    expect(b1.batch.cursor).toEqual({ n: 1 });
    // After first src-next, pulled has one entry
    expect(pulled).toEqual([null]);

    const batch2 = waitFor('src-batch');
    mainEp.post({ kind: 'src-next', pullId: 21 });
    expect((await batch2).batch.phase).toBe('live');

    const done = waitFor('src-done');
    mainEp.post({ kind: 'src-next', pullId: 21 });
    await done;
  });

  it('src-abort deletes pull state; post-abort src-next is no-op; fetch-bytes round-trips bytes', async () => {
    const { mod } = sourceMod();
    const { mainEp, waitFor } = boot(mod);
    mainEp.onCall(async (ns, method) => {
      if (ns === 'session' && method === 'credentials') return null;
      return undefined;
    });
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    await activated;

    // Collect all src-* messages for pullId 31 to assert post-abort is silent
    const src31Messages: unknown[] = [];
    mainEp.onNotify((m: unknown) => {
      const msg = m as any;
      if (msg.pullId === 31) {
        src31Messages.push(m);
      }
    });

    await mainEp.call('source', 'pull-open', [31, 'basicsrc', account, null]);
    const batch1 = waitFor('src-batch');
    mainEp.post({ kind: 'src-next', pullId: 31 });
    await batch1;
    expect(src31Messages).toHaveLength(1); // one src-batch

    // Abort the pull (deletes entry from Map)
    mainEp.post({ kind: 'src-abort', pullId: 31 });
    // Post another src-next — hits if (!pull) return guard, produces nothing
    mainEp.post({ kind: 'src-next', pullId: 31 });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    // Assert no src-done or src-error arrived — entry was cleaned up
    expect(src31Messages).toHaveLength(1);

    const bytes = (await mainEp.call('source', 'fetch-bytes', [
      41,
      'basicsrc',
      account,
      { id: 'doc99' },
    ])) as Uint8Array;
    expect([...bytes]).toEqual([1, 2, 5]);
  });

  it('a throwing pull surfaces as src-error', async () => {
    const mod = {
      async activate() {
        return {
          sources: [
            {
              descriptor: {
                id: 's',
                name: 's',
                documentTypes: [],
                auth: 'none' as const,
              },
              async connect() {
                return { identifier: 'i' };
              },
              // eslint-disable-next-line require-yield
              async *pull(): AsyncGenerator<never> {
                throw new Error('pull broke');
              },
              toDocument: () => null,
            },
          ],
        };
      },
    };
    const { mainEp, waitFor } = boot(mod);
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    await activated;
    await mainEp.call('source', 'pull-open', [51, 's', account, null]);
    const err = waitFor('src-error');
    mainEp.post({ kind: 'src-next', pullId: 51 });
    expect((await err).error).toMatch(/pull broke/);
  });
});
