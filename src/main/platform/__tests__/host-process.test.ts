/** @jest-environment node */
import type { Cap, ExtensionStatus } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createExtensionHost } from '../host-process';
import { createInMemoryHostPair } from '../transport';

const noopLog = { log: jest.fn() };

function makeDeps(mod: unknown, overrides: Record<string, unknown> = {}) {
  const statuses: Array<{ status: ExtensionStatus; error?: string }> = [];
  const pairs: Array<ReturnType<typeof createInMemoryHostPair>> = [];
  const registered: Contributions[] = [];
  const unregistered: number[] = [];
  const deps = {
    extensionId: 'test.basic',
    entryAbsPath: '/virtual/e.js',
    dataDir: '/virtual/d',
    caps: ['net'] as Cap[],
    transportFactory: () => {
      const pair = createInMemoryHostPair();
      pairs.push(pair);
      runExtensionHost(pair.child, {
        requireModule: () => mod,
        exit: (c) => pair.simulateExit(c),
      });
      return pair.main;
    },
    makeSurfaces: () => ({
      surfaces: { net: { fetch: async () => ({ status: 200 }) } } as never,
      close: jest.fn(),
    }),
    logSink: noopLog,
    onStatus: (status: ExtensionStatus, error?: string) =>
      statuses.push({ status, error }),
    registerContributions: (c: Contributions) => {
      registered.push(c);
      return () => unregistered.push(1);
    },
    killAfterMs: 50,
    readyTimeoutMs: 1000,
    activateTimeoutMs: 1000,
    ...overrides,
  };
  return { deps, statuses, pairs, registered, unregistered };
}

const okModule = {
  async activate() {
    return {
      sources: [],
      tools: [
        { name: 't', description: '', inputSchema: {}, call: async () => 1 },
      ],
    };
  },
  deactivate: jest.fn(),
};

// Never settles either hook — used to pin the incarnation mid-handshake so
// a crash/stop can be simulated deterministically while a wait is pending,
// without racing an activate() or deactivate() that resolves on its own.
const hangingModule = {
  activate: () => new Promise(() => {}),
  deactivate: () => new Promise(() => {}),
};

describe('createExtensionHost', () => {
  it('start() activates, registers contributions, reports status transitions', async () => {
    const { deps, statuses, registered } = makeDeps(okModule);
    const host = createExtensionHost(deps as never);
    await host.start();
    expect(statuses.map((s) => s.status)).toEqual(['activating', 'activated']);
    expect(registered).toHaveLength(1);
    expect(registered[0].tools[0].name).toBe('t');
    await host.stop();
  });

  it('an activate() error lands in errored without registering anything', async () => {
    const { deps, statuses, registered } = makeDeps({
      activate: async () => {
        throw new Error('nope');
      },
    });
    const host = createExtensionHost(deps as never);
    await expect(host.start()).rejects.toThrow(/nope/);
    expect(statuses.at(-1)).toEqual({
      status: 'errored',
      error: expect.stringMatching(/nope/),
    });
    expect(registered).toHaveLength(0);
  });

  it('callTool proxies to the current incarnation, and rejects once stopped', async () => {
    const { deps } = makeDeps(okModule);
    const host = createExtensionHost(deps as never);
    await host.start();
    await expect(host.callTool('t', {})).resolves.toBe(1);
    await host.stop();
    await expect(host.callTool('t', {})).rejects.toThrow(/not running/);
  });

  it('stop() deactivates cleanly and unregisters', async () => {
    const { deps, statuses, unregistered } = makeDeps(okModule);
    const host = createExtensionHost(deps as never);
    await host.start();
    await host.stop();
    expect(unregistered).toHaveLength(1);
    expect(statuses.at(-1)?.status).toBe('disabled');
  });

  it('a crash restarts the host; 3 crashes in 60s trip the breaker', async () => {
    let t = 0;
    const { deps, statuses, pairs, unregistered } = makeDeps(okModule, {
      now: () => t,
    });
    const host = createExtensionHost(deps as never);
    await host.start();
    // three crashes at t=1s, 2s, 3s — breaker trips on the third
    for (let i = 0; i < 3; i += 1) {
      t += 1000;
      const base = statuses.length; // wait for NEW transitions, not the stale 'activated'
      const settled = new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          const last = statuses.at(-1);
          if (
            statuses.length > base &&
            (last?.status === 'activated' || last?.status === 'errored')
          ) {
            clearInterval(iv);
            resolve();
          }
        }, 5);
      });
      pairs[pairs.length - 1].simulateExit(1);
      // eslint-disable-next-line no-await-in-loop
      await settled;
    }
    expect(statuses.at(-1)).toEqual({
      status: 'errored',
      error: expect.stringMatching(/crash loop/),
    });
    expect(unregistered.length).toBeGreaterThanOrEqual(3);
    expect(pairs).toHaveLength(3); // 1 initial + 2 restarts; third crash stays down
  });

  it('a crash during the handshake is recovered by a respawn: start() resolves and no stale errored follows', async () => {
    const { deps, statuses, pairs } = makeDeps(okModule, {
      readyTimeoutMs: 30,
      activateTimeoutMs: 30,
    });
    const host = createExtensionHost(deps as never);
    const startPromise = host.start();
    // Crash the very first incarnation before it has processed anything at
    // all (before 'ready') — synchronously, before any microtask runs. The
    // pre-fix bug left this incarnation's handshake wait dangling until its
    // own timeout, long after the respawn below had already activated —
    // which then nulled the live `current`, forced `stopped = true`, and
    // fired a stale 'errored' after the legitimate 'activated'.
    pairs[0].simulateExit(1);
    await expect(startPromise).resolves.toBeUndefined();
    expect(statuses.at(-1)?.status).toBe('activated');
    // Flush well past where the old dangling handshake timeout (30ms) would
    // have fired, to prove no stale 'errored' ever lands after 'activated'.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(statuses.at(-1)?.status).toBe('activated');
    expect(statuses.some((s) => s.status === 'errored')).toBe(false);
    await host.stop();
    expect(statuses.at(-1)?.status).toBe('disabled');
  });

  it('stop() mid-handshake tears down the child and settles with a single disabled, no stale errored', async () => {
    const { deps, statuses, pairs } = makeDeps(hangingModule, {
      readyTimeoutMs: 30,
      activateTimeoutMs: 30,
      killAfterMs: 20,
    });
    const host = createExtensionHost(deps as never);
    const startPromise = host.start();
    let childExited = false;
    pairs[0].main.onExit(() => {
      childExited = true;
    });
    // Both activate() and deactivate() hang forever, so the only thing that
    // can ever end this incarnation is stop()'s own killAfterMs escalation
    // — pinning the activate-phase handshake wait as genuinely pending when
    // the kill lands.
    const stopPromise = host.stop();
    await expect(startPromise).rejects.toThrow();
    await stopPromise;
    expect(childExited).toBe(true); // the transport exit path actually ran
    expect(statuses.at(-1)?.status).toBe('disabled');
    // Flush well past where the old dangling activate-phase timeout (30ms)
    // would have fired, to prove no stale 'errored' ever lands after
    // 'disabled'.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(statuses.at(-1)?.status).toBe('disabled');
    expect(statuses.some((s) => s.status === 'errored')).toBe(false);
  });

  it('a synchronous setup throw (e.g. transportFactory) rejects start() promptly with a single errored, no hang', async () => {
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const { deps, statuses } = makeDeps(okModule, {
        transportFactory: () => {
          throw new Error('boom: transportFactory failed synchronously');
        },
      });
      const host = createExtensionHost(deps as never);
      // Pre-fix, the setup block ran outside spawn()'s try/catch, so this
      // synchronous throw became an unhandled rejection and start() hung
      // forever (startReject was never called). Jest's default test
      // timeout is the backstop that turns a regression into a failure
      // instead of hanging the suite.
      await expect(host.start()).rejects.toThrow(/boom/);
      // Give any stray unhandled rejection a turn to surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(statuses.map((s) => s.status)).toEqual(['activating', 'errored']);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('stop() racing an activated notify that beats the exit: no activated status, no contributions registered, terminal disabled', async () => {
    const { deps, statuses, pairs, registered } = makeDeps(okModule);
    const host = createExtensionHost(deps as never);
    const startPromise = host.start();

    let stopPromise: Promise<void> | null = null;
    let sawActivated = false;
    // Hook the raw transport message stream. spawn()'s own endpoint (and
    // therefore its internal onMessage subscription) is created
    // synchronously inside host.start() above, before this line runs, so
    // our subscription is added *after* it in transport.ts's `toMain` Set —
    // meaning for any given message delivery, the endpoint's own dispatch
    // (which settles the pending waitNotify's promise) always runs before
    // this callback, synchronously, in the same microtask. Calling
    // host.stop() here therefore flips `stopping` to true before spawn()'s
    // post-handshake continuation (a separately-queued microtask reacting
    // to that settled promise) ever gets to inspect it — deterministically
    // reproducing "the child's activated notify beats the transport exit"
    // without any sleep or timing guess.
    pairs[0].main.onMessage((raw) => {
      const msg = raw as { kind?: string };
      if (msg?.kind === 'activated' && !sawActivated) {
        sawActivated = true;
        stopPromise = host.stop();
      }
    });

    await expect(startPromise).rejects.toThrow(/stopped before activation/);
    expect(sawActivated).toBe(true); // the child DID activate — this is the race, not a hang
    expect(stopPromise).not.toBeNull();
    await stopPromise;

    expect(statuses.map((s) => s.status)).toEqual(['activating', 'disabled']);
    expect(statuses.some((s) => s.status === 'activated')).toBe(false);
    expect(registered).toHaveLength(0); // contributions were never registered
  });
});
