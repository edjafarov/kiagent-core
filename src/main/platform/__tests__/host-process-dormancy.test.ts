/** @jest-environment node */
import type { Cap, ExtensionStatus, Session, Source } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createExtensionHost } from '../host-process';
import { createInMemoryHostPair } from '../transport';

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
