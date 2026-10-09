/** @jest-environment node */
import type { Cap, ExtensionStatus, Session, Source } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createExtensionHost } from '../host-process';
import { createHungTransport, createInMemoryHostPair } from '../transport';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const IDLE = 40;

function makeDormantHost(
  mod: unknown,
  overrides: Record<string, unknown> = {},
) {
  const statuses: ExtensionStatus[] = [];
  const dormant: boolean[] = [];
  const registered: Contributions[] = [];
  const unregistered: number[] = [];
  const logs: string[] = [];
  let makeSource!: (e: Contributions['sources'][number]) => Source;
  let spawns = 0;
  const host = createExtensionHost({
    extensionId: 'kia.test',
    entryAbsPath: '/virtual/e.js',
    dataDir: '/virtual/d',
    caps: ['net'] as Cap[],
    transportFactory: () => {
      spawns += 1;
      const pair = createInMemoryHostPair();
      runExtensionHost(pair.child, {
        requireModule: () => mod,
        exit: (c) => pair.simulateExit(c),
      });
      return pair.main;
    },
    makeSurfaces: () => ({ surfaces: {} as never, close: jest.fn() }),
    logSink: { log: (_s: string, _l: string, msg: string) => logs.push(msg) },
    onStatus: (s: ExtensionStatus) => statuses.push(s),
    onDormant: (d: boolean) => dormant.push(d),
    registerContributions: (c: Contributions, ms: typeof makeSource) => {
      registered.push(c);
      makeSource = ms;
      return () => unregistered.push(1);
    },
    killAfterMs: 50,
    readyTimeoutMs: 1000,
    activateTimeoutMs: 1000,
    dormancy: { idleMs: IDLE },
    ...overrides,
  });
  return {
    host,
    statuses,
    dormant,
    registered,
    unregistered,
    logs,
    spawns: () => spawns,
    source: () => makeSource,
  };
}

const toolModule = {
  async activate() {
    return {
      sources: [],
      tools: [
        {
          name: 't',
          description: '',
          inputSchema: {},
          call: async (a: unknown) => ({ echoed: a }),
        },
      ],
    };
  },
};

describe('host soft stop (#137)', () => {
  it('an idle host goes dormant: child exits, registrations stay, no status change', async () => {
    const h = makeDormantHost(toolModule);
    await h.host.start();
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([true]);
    expect(h.unregistered).toEqual([]);
    expect(h.statuses).toEqual(['activating', 'activated']);
    await h.host.stop();
  });

  it('without dormancy a host never sleeps', async () => {
    const h = makeDormantHost(toolModule, { dormancy: undefined });
    await h.host.start();
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([]);
    await h.host.stop();
  });

  it('does not sleep while a tool call is in flight; sleeps once it settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const mod = {
      async activate() {
        return {
          sources: [],
          tools: [
            {
              name: 'slow',
              description: '',
              inputSchema: {},
              call: async () => {
                await gate;
                return 1;
              },
            },
          ],
        };
      },
    };
    const h = makeDormantHost(mod);
    await h.host.start();
    const call = h.host.callTool('slow', {});
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([]);
    release();
    await expect(call).resolves.toBe(1);
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([true]);
    await h.host.stop();
  });

  it('a pull session is in flight from open to end; a live pull never idles', async () => {
    const mod = {
      async activate() {
        return {
          sources: [
            {
              descriptor: {
                id: 'live',
                name: 'Live',
                documentTypes: ['x'],
                auth: 'none',
              },
              async connect() {
                return { identifier: 'x' };
              },
              async *pull(session: Session) {
                yield { phase: 'live', items: [], cursor: 1 };
                await new Promise((r) =>
                  session.signal.addEventListener('abort', r),
                );
              },
              toDocument: (i: unknown) => i,
            },
          ],
          tools: [],
        };
      },
    };
    const h = makeDormantHost(mod);
    await h.host.start();
    const ac = new AbortController();
    const session = {
      account: { id: 'a1' },
      signal: ac.signal,
      credentials: async () => null,
      log: () => {},
    } as unknown as Session;
    const src = h.source()(h.registered[0].sources[0]);
    const it = src.pull(session, null)[Symbol.asyncIterator]();
    await it.next();
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([]); // the open live pull holds the host
    ac.abort();
    await it.next();
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([true]);
    await h.host.stop();
  });

  it.each([
    [
      'events.on',
      ['events'],
      { events: { on: jest.fn(), off: jest.fn(), emit: jest.fn() } },
      (host: { events: { on(e: string, cb: () => void): void } }) =>
        host.events.on('x', () => {}),
    ],
    [
      'attention.publish',
      ['attention'],
      {
        attention: {
          publish: async () => ({ rejected: [] }),
          resolve: async () => ({ rejected: [] }),
        },
      },
      (host: { attention: { publish(i: unknown[]): Promise<unknown> } }) =>
        void host.attention.publish([]),
    ],
    [
      'files.watch',
      ['files'],
      { files: { watch: jest.fn(async () => ({ watchId: 1 })) } },
      (host: { files: { watch(r: unknown, cb: () => void): unknown } }) =>
        void host.files.watch({ root: 'r', rel: '' }, () => {}),
    ],
  ])(
    'a host that uses %s is pinned and never sleeps',
    async (_name, caps, surfaces, use) => {
      const mod = {
        async activate(host: never) {
          (use as (h: never) => void)(host);
          return { sources: [], tools: [] };
        },
      };
      const h = makeDormantHost(mod, {
        caps,
        makeSurfaces: () => ({ surfaces, close: jest.fn() }),
      });
      await h.host.start();
      await sleepMs(IDLE * 4);
      expect(h.dormant).toEqual([]);
      expect(h.logs.some((m) => /pinned/.test(m))).toBe(true);
      await h.host.stop();
    },
  );
});

async function dormantHost(
  mod: unknown,
  overrides: Record<string, unknown> = {},
) {
  const h = makeDormantHost(mod, overrides);
  await h.host.start();
  await sleepMs(IDLE * 4);
  expect(h.dormant).toEqual([true]);
  return h;
}

const senderModule = {
  async activate() {
    return {
      sources: [],
      tools: [],
      senders: {
        fixsrc: { send: async () => ({ externalMessageId: 'sent' }) },
      },
    };
  },
};
const sourceModule = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'src',
            name: 'Src',
            documentTypes: ['x'],
            auth: 'none',
          },
          async connect() {
            return { identifier: 'me' };
          },
          async *pull() {},
          toDocument: (i: unknown) => i,
        },
      ],
      tools: [],
    };
  },
};

describe('host wake (#137)', () => {
  it('a tool call wakes a dormant host and returns the right result', async () => {
    const h = await dormantHost(toolModule);
    await expect(h.host.callTool('t', { x: 1 })).resolves.toEqual({
      echoed: { x: 1 },
    });
    expect(h.spawns()).toBe(2);
    expect(h.dormant).toEqual([true, false]);
    expect(h.statuses).toEqual(['activating', 'activated']); // no 'activating' on wake
    await h.host.stop();
  });

  it('a sender call wakes it', async () => {
    const h = await dormantHost(senderModule);
    await expect(
      h.host.callSender(
        'fixsrc',
        {
          accountId: 'a',
          kind: 'reply',
          outboundRef: {},
          bodyMarkdown: 'x',
        } as never,
        { credentials: null },
      ),
    ).resolves.toEqual({ externalMessageId: 'sent' });
    await h.host.stop();
  });

  it('a source verb wakes it', async () => {
    const h = await dormantHost(sourceModule);
    const src = h.source()(h.registered[0].sources[0]);
    await expect(src.connect({} as never)).resolves.toEqual({
      identifier: 'me',
    });
    expect(h.spawns()).toBe(2);
    await h.host.stop();
  });

  it('concurrent wakes share one spawn', async () => {
    const h = await dormantHost(toolModule);
    await Promise.all([
      h.host.callTool('t', { n: 1 }),
      h.host.callTool('t', { n: 2 }),
    ]);
    expect(h.spawns()).toBe(2);
    await h.host.stop();
  });

  it('equal contributions skip registration on wake', async () => {
    const h = await dormantHost(toolModule);
    await h.host.callTool('t', { n: 1 });
    expect(h.registered).toHaveLength(1);
    expect(h.unregistered).toEqual([]);
    await h.host.stop();
  });

  it('different contributions re-register on wake (old disposer first)', async () => {
    let n = 0;
    const mod = {
      async activate() {
        n += 1;
        return {
          sources: [],
          tools: [
            {
              name: n === 1 ? 't' : 't2',
              description: '',
              inputSchema: {},
              call: async () => n,
            },
          ],
        };
      },
    };
    const h = await dormantHost(mod);
    await h.host.ensureLive();
    expect(h.unregistered).toEqual([1]);
    expect(h.registered.map((c) => c.tools[0].name)).toEqual(['t', 't2']);
    await h.host.stop();
  });

  it('ensureLive waits for activated across a handshake retry', async () => {
    let spawn = 0;
    const h = await dormantHost(toolModule, {
      readyTimeoutMs: 50,
      handshakeRetryDelayMs: () => 20,
      transportFactory: () => {
        spawn += 1;
        if (spawn === 2) return createHungTransport(); // the wake's first try
        const pair = createInMemoryHostPair();
        runExtensionHost(pair.child, {
          requireModule: () => toolModule,
          exit: (c) => pair.simulateExit(c),
        });
        return pair.main;
      },
    });
    await expect(h.host.callTool('t', { n: 7 })).resolves.toEqual({
      echoed: { n: 7 },
    });
    expect(spawn).toBe(3);
    expect(h.statuses).not.toContain('errored');
    await h.host.stop();
  });

  it('the wake is bounded', async () => {
    let spawn = 0;
    const h = await dormantHost(toolModule, {
      dormancy: { idleMs: IDLE, wakeTimeoutMs: 100 },
      readyTimeoutMs: 5_000,
      transportFactory: () => {
        spawn += 1;
        if (spawn > 1) return createHungTransport();
        const pair = createInMemoryHostPair();
        runExtensionHost(pair.child, {
          requireModule: () => toolModule,
          exit: (c) => pair.simulateExit(c),
        });
        return pair.main;
      },
    });
    const t0 = Date.now();
    await expect(h.host.callTool('t', { n: 1 })).rejects.toThrow(
      'extension is not running',
    );
    expect(Date.now() - t0).toBeLessThan(1_000);
    await h.host.stop();
  });

  it('disable cancels a wake in flight', async () => {
    let spawn = 0;
    const h = await dormantHost(toolModule, {
      readyTimeoutMs: 5_000,
      transportFactory: () => {
        spawn += 1;
        if (spawn > 1) return createHungTransport();
        const pair = createInMemoryHostPair();
        runExtensionHost(pair.child, {
          requireModule: () => toolModule,
          exit: (c) => pair.simulateExit(c),
        });
        return pair.main;
      },
    });
    const call = h.host.callTool('t', { n: 1 });
    await sleepMs(10);
    await h.host.stop();
    await expect(call).rejects.toThrow('extension is not running');
    expect(h.unregistered).toEqual([1]); // kept registration disposed exactly once
    expect(h.statuses[h.statuses.length - 1]).toBe('disabled');
  });

  it('hard stop of a dormant host disposes the kept registration and reports disabled', async () => {
    const h = await dormantHost(toolModule);
    await h.host.stop();
    expect(h.unregistered).toEqual([1]);
    expect(h.dormant).toEqual([true, false]);
    expect(h.statuses[h.statuses.length - 1]).toBe('disabled');
    await expect(h.host.callTool('t', { n: 1 })).rejects.toThrow(
      'extension is not running',
    );
  });

  it('a call during the soft stop waits and then wakes', async () => {
    let deactivating!: () => void;
    const started = new Promise<void>((r) => {
      deactivating = r;
    });
    const mod = {
      ...toolModule,
      async deactivate() {
        deactivating();
        await sleepMs(30);
      },
    };
    const h = makeDormantHost(mod);
    await h.host.start();
    await started; // the idle soft stop is mid-teardown
    await expect(h.host.callTool('t', { n: 'late' })).resolves.toEqual({
      echoed: { n: 'late' },
    });
    expect(h.spawns()).toBe(2);
    await h.host.stop();
  });
});
