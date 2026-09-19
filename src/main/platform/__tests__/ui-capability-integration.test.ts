/** @jest-environment node */
import type { Cap, ExtensionStatus, Query } from '@shared/contracts';

import { runExtensionHost } from '../extension-host-entry';
import { createExtensionHost } from '../host-process';
import { buildSurfaces, createEventBus } from '../host-surfaces';
import { createInMemoryHostPair } from '../transport';
import { createUiRegistry, type UiRegistry } from '../ui-registry';

const noopLog = { log: jest.fn() };
const EXT_ID = 'test.ui';

/** Mirrors host-process.test.ts's own makeDeps, but wires a REAL
 *  buildSurfaces() bound to a caller-supplied, possibly-shared UiRegistry —
 *  exactly what extension-platform.ts's own makeSurfaces wrapper does —
 *  instead of the stub `{surfaces: {...}}` that file's makeDeps uses. This
 *  is the layer that owns the incarnation lifecycle (spawn/respawn/stop),
 *  so it is the right level for the incarnation-binding gates: the pure
 *  registry semantics are covered in ui-registry.test.ts. */
function makeDeps(
  mod: unknown,
  uiRegistry: UiRegistry,
  overrides: Record<string, unknown> = {},
) {
  const statuses: Array<{ status: ExtensionStatus; error?: string }> = [];
  const pairs: Array<ReturnType<typeof createInMemoryHostPair>> = [];
  const deps = {
    extensionId: EXT_ID,
    entryAbsPath: '/virtual/e.js',
    dataDir: '/virtual/d',
    caps: ['ui'] as Cap[],
    transportFactory: () => {
      const pair = createInMemoryHostPair();
      pairs.push(pair);
      runExtensionHost(pair.child, {
        requireModule: () => mod,
        exit: (c) => pair.simulateExit(c),
      });
      return pair.main;
    },
    makeSurfaces: (
      deliverEvent: (name: string, payload: unknown, meta: unknown) => void,
      context?: { owner?: { handle?: string }; signal?: AbortSignal },
    ) =>
      buildSurfaces({
        extensionId: EXT_ID,
        dataDir: '/virtual',
        query: {} as Query,
        inference: {
          complete: async () => '',
          see: async () => '',
          read: async () => '',
          hear: async () => '',
          lane: async () => 'open' as const,
          describe: async () => null,
        },
        notify: () => {},
        attention: {
          publish: async () => ({ rejected: [] }),
          resolve: async () => ({ rejected: [] }),
        } as never,
        bus: createEventBus(),
        deliverEvent: deliverEvent as never,
        uiRegistry,
        tier: 'bundled',
        owner: context?.owner as never,
        signal: context?.signal,
      }),
    logSink: noopLog,
    onStatus: (status: ExtensionStatus, error?: string) =>
      statuses.push({ status, error }),
    registerContributions: () => () => {},
    killAfterMs: 50,
    readyTimeoutMs: 1000,
    activateTimeoutMs: 1000,
    ...overrides,
  };
  return { deps, statuses, pairs };
}

/** Polls `statuses` for a transition strictly after `base` landing on
 *  'activated' or 'errored' — same technique host-process.test.ts's own
 *  crash-loop test uses. */
function waitForSettled(
  statuses: Array<{ status: ExtensionStatus; error?: string }>,
  base: number,
): Promise<void> {
  return new Promise((resolve) => {
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
}

const okUiModule = {
  async activate(host: {
    ui: { handle(n: string, fn: (p: unknown) => unknown): Promise<unknown> };
  }) {
    await host.ui.handle('echo', async (p: unknown) => p);
    return {};
  },
};

const failingActivateModule = {
  async activate(host: {
    ui: { handle(n: string, fn: (p: unknown) => unknown): Promise<unknown> };
  }) {
    await host.ui.handle('echo', async (p: unknown) => p);
    throw new Error('activation blew up on purpose');
  },
};

const hangingAfterHandleModule = {
  async activate(host: {
    ui: { handle(n: string, fn: (p: unknown) => unknown): Promise<unknown> };
  }) {
    await host.ui.handle('echo', async (p: unknown) => p);
    await new Promise(() => {}); // never resolves — pins activation mid-flight
  },
  deactivate: () => new Promise(() => {}),
};

describe('B1 ui-registry <-> host-process incarnation binding (real spawn/respawn/stop)', () => {
  it('zero ui-registry entries survive a FAILED activation', async () => {
    const uiRegistry = createUiRegistry();
    const { deps } = makeDeps(failingActivateModule, uiRegistry);
    const host = createExtensionHost(deps as never);
    await expect(host.start()).rejects.toThrow(/activation blew up/);
    // The handler DID register while activating…
    // …but the failed incarnation's teardown must have cleared it.
    expect(uiRegistry.namesFor(EXT_ID)).toEqual([]);
  });

  it('zero ui-registry entries survive stop() firing DURING activation', async () => {
    const uiRegistry = createUiRegistry();
    const { deps, statuses } = makeDeps(hangingAfterHandleModule, uiRegistry, {
      readyTimeoutMs: 30,
      activateTimeoutMs: 30,
      killAfterMs: 20,
    });
    const host = createExtensionHost(deps as never);
    const startPromise = host.start();
    // Give the child a beat to register 'echo' and then hang forever in
    // activate() — proving the entry existed WHILE activating, so the
    // zero-after-stop assertion below is a real teardown, not a vacuous
    // "it was never there" pass.
    await new Promise((r) => setTimeout(r, 20));
    expect(uiRegistry.namesFor(EXT_ID)).toEqual(['echo']);
    await host.stop();
    await expect(startPromise).rejects.toThrow();
    expect(statuses.at(-1)?.status).toBe('disabled');
    expect(uiRegistry.namesFor(EXT_ID)).toEqual([]);
  });

  it('a crash respawn clears the dead incarnation before the live successor registers — no stale leak, no duplicate reject', async () => {
    const uiRegistry = createUiRegistry();
    const { deps, statuses, pairs } = makeDeps(okUiModule, uiRegistry);
    const host = createExtensionHost(deps as never);
    await host.start();
    expect(uiRegistry.namesFor(EXT_ID)).toEqual(['echo']);
    const firstIncarnation = uiRegistry.resolve(EXT_ID, 'echo')?.incarnation;
    expect(firstIncarnation).toBeDefined();

    const base = statuses.length;
    const settled = waitForSettled(statuses, base);
    pairs[pairs.length - 1].simulateExit(1); // crash
    await settled;

    expect(statuses.at(-1)?.status).toBe('activated'); // respawned cleanly
    // Exactly ONE entry — if the dead incarnation's registration had leaked,
    // the respawn's fresh host.ui.handle('echo', …) would have hit
    // ui-registry's duplicate-reject and activation would have FAILED
    // instead of landing on 'activated'.
    expect(uiRegistry.namesFor(EXT_ID)).toEqual(['echo']);
    const secondIncarnation = uiRegistry.resolve(EXT_ID, 'echo')?.incarnation;
    // A genuinely FRESH registration, not the leaked original — proves the
    // dead incarnation's entry was actually replaced, not merely tolerated.
    expect(secondIncarnation).toBeDefined();
    expect(secondIncarnation).not.toBe(firstIncarnation);

    await host.stop();
    expect(uiRegistry.namesFor(EXT_ID)).toEqual([]);
  });
});
