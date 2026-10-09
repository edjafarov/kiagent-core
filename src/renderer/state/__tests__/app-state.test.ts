import { deserialize, serialize } from 'node:v8';
import type { AppState } from '@shared/contracts';
import type { RendererApi } from '@shared/ipc';

/**
 * Covers the `app:get-state` rejection-retry path (attach()'s initial invoke
 * has no rejection handler otherwise, which both throws an unhandled
 * rejection and leaves `state` null forever if the app is idle and no
 * `push:app-state` broadcast happens to arrive).
 *
 * Each test re-imports app-state.ts fresh via `jest.isolateModules` so the
 * module-level `state`/`attached`/`attachGen` singleton never leaks between
 * tests — there is no public reset hook, and none should be added just for
 * tests (mirrors how the module is actually consumed: one store per app
 * lifetime, `detach()` only fires when the last subscriber unsubscribes).
 */

function makeAppState(): AppState {
  return {
    accounts: [],
    processing: {
      pending: 0,
      done: 0,
      skipped: 0,
      failed: 0,
      lane: 'open',
      waiting: null,
      active: [],
      download: null,
    },
    mcp: { port: null, clients: 0 },
    identity: null,
    prefs: {
      theme: 'system',
      logLevel: 'info',
      launchAtLogin: false,
      showInMenuBar: false,
      processing: { enabled: false, window: 'always' },
      models: { override: 'auto', autoInstall: false },
      outbound: { defaultMode: 'review' },
      features: {},
      onboarding: {
        sourceBackfilledAt: null,
        mcpConnectedAt: null,
        firstQueryAt: null,
        dismissedAt: null,
      },
    },
    extensions: [],
    ready: true,
  };
}

type Bridge = RendererApi & {
  on: jest.Mock;
  invoke: jest.Mock;
};

function makeBridge(): Bridge {
  return {
    invoke: jest.fn(),
    on: jest.fn(() => () => {}),
  } as unknown as Bridge;
}

describe('app-state: app:get-state rejection retry', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
    delete (window as { kiagent?: unknown }).kiagent;
  });

  test('rejects once, then resolves on retry: getAppState() reflects it, no unhandled rejection', async () => {
    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on('unhandledRejection', onUnhandled);

    await jest.isolateModulesAsync(async () => {
      const bridge = makeBridge();
      const finalState = makeAppState();
      bridge.invoke
        .mockRejectedValueOnce(new Error('boot race'))
        .mockResolvedValueOnce({ state: finalState, seq: 0, rev: 1 });
      (window as unknown as { kiagent: Bridge }).kiagent = bridge;

      // eslint-disable-next-line global-require
      const { subscribeAppState, getAppState } = require('../app-state');
      const unsubscribe = subscribeAppState(() => {});

      // Let the rejected initial invoke's `.then` rejection handler run.
      await Promise.resolve();
      await Promise.resolve();
      expect(getAppState()).toBeNull();

      // Fire the 1s backoff timer; let the retry's resolved invoke apply.
      await jest.advanceTimersByTimeAsync(1000);

      expect(getAppState()).toEqual(finalState);
      expect(bridge.invoke).toHaveBeenCalledTimes(2);

      unsubscribe();
    });

    // Flush any leftover microtasks before asserting no unhandled rejection.
    await Promise.resolve();
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toBeUndefined();
  });

  test('a push arriving before the retry fires wins; the retry loop stops', async () => {
    await jest.isolateModulesAsync(async () => {
      const bridge = makeBridge();
      let pushListener: ((payload: unknown) => void) | undefined;
      bridge.on.mockImplementation(
        (_channel: string, cb: (p: unknown) => void) => {
          pushListener = cb;
          return () => {};
        },
      );
      bridge.invoke.mockRejectedValueOnce(new Error('boot race'));
      (window as unknown as { kiagent: Bridge }).kiagent = bridge;

      // eslint-disable-next-line global-require
      const { subscribeAppState, getAppState } = require('../app-state');
      const unsubscribe = subscribeAppState(() => {});

      await Promise.resolve();
      await Promise.resolve();
      expect(getAppState()).toBeNull();

      const pushedState = makeAppState();
      pushListener?.({ state: pushedState, seq: 0, rev: 1 });
      expect(getAppState()).toEqual(pushedState);

      // Advance past the 1s retry: it must see gotPush and skip invoking.
      await jest.advanceTimersByTimeAsync(1000);
      expect(bridge.invoke).toHaveBeenCalledTimes(1); // only the initial call

      // Advance well past any further backoff too — still nothing.
      await jest.advanceTimersByTimeAsync(20000);
      expect(bridge.invoke).toHaveBeenCalledTimes(1);
      expect(getAppState()).toEqual(pushedState);

      unsubscribe();
    });
  });

  test('detach after rejection stops the retry loop; state stays null', async () => {
    await jest.isolateModulesAsync(async () => {
      const bridge = makeBridge();
      bridge.invoke.mockRejectedValueOnce(new Error('boot race'));
      (window as unknown as { kiagent: Bridge }).kiagent = bridge;

      // eslint-disable-next-line global-require
      const { subscribeAppState, getAppState } = require('../app-state');
      const unsubscribe = subscribeAppState(() => {});

      await Promise.resolve();
      await Promise.resolve();
      expect(getAppState()).toBeNull();

      // Last (only) subscriber unsubscribes -> detach() fires, bumping the
      // generation the in-flight retry closed over.
      unsubscribe();

      await jest.advanceTimersByTimeAsync(20000);

      expect(bridge.invoke).toHaveBeenCalledTimes(1); // no retry invoke fired
      expect(getAppState()).toBeNull();
    });
  });
});

describe('app-state: structural sharing across cloned pushes', () => {
  const clone = <T>(v: T): T => deserialize(serialize(v)) as T;

  function richState(): AppState {
    const s = makeAppState();
    return {
      ...s,
      identity: { name: 'Alice', emails: ['a@example.com'], phones: [] },
      extensions: [
        { id: 'ext.a', name: 'A', status: 'activated', enabled: true },
      ] as unknown as AppState['extensions'],
      accounts: [
        {
          account: { id: 'a', source: 'gmail', status: 'live' },
          docCount: 1,
          recent: [{ id: 'x', title: null, ts: '2026-10-01T00:00:00Z' }],
        },
        {
          account: { id: 'b', source: 'slack', status: 'backfilling' },
          docCount: 2,
          recent: [],
        },
      ] as unknown as AppState['accounts'],
    };
  }

  test('fresh clones keep unchanged sub-trees; an equal push notifies no one; rev still advances', async () => {
    await jest.isolateModulesAsync(async () => {
      const bridge = makeBridge();
      let onPush: ((p: unknown) => void) | undefined;
      bridge.on.mockImplementation(
        (channel: string, fn: (p: unknown) => void) => {
          if (channel === 'push:app-state') onPush = fn;
          return () => {};
        },
      );
      const base = richState();
      bridge.invoke.mockResolvedValueOnce({
        state: clone(base),
        seq: 0,
        rev: 1,
      });
      (window as unknown as { kiagent: Bridge }).kiagent = bridge;

      // eslint-disable-next-line global-require
      const { subscribeAppState, getAppState } = require('../app-state');
      const listener = jest.fn();
      const unsubscribe = subscribeAppState(listener);
      await Promise.resolve();
      await Promise.resolve();
      const first = getAppState() as AppState;
      expect(first).toEqual(base);
      listener.mockClear();

      const next = clone(base);
      next.accounts[1].docCount = 3;
      onPush!({ state: clone(next), seq: 1, rev: 2 });
      const second = getAppState() as AppState;
      expect(listener).toHaveBeenCalledTimes(1);
      expect(second.accounts).not.toBe(first.accounts);
      expect(second.accounts[0]).toBe(first.accounts[0]);
      expect(second.accounts[1]).not.toBe(first.accounts[1]);
      expect(second.accounts[1].account).toBe(first.accounts[1].account);
      expect(second.identity).toBe(first.identity);
      expect(second.extensions).toBe(first.extensions);
      expect(second.prefs).toBe(first.prefs);
      expect(second.processing).toBe(first.processing);

      // Structurally equal push: no notify, same snapshot.
      onPush!({ state: clone(next), seq: 1, rev: 3 });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getAppState()).toBe(second);

      // The equal push advanced the rev: a replay of rev 3 is stale.
      const replay = clone(next);
      replay.accounts[0].docCount = 999;
      onPush!({ state: replay, seq: 1, rev: 3 });
      expect(getAppState()).toBe(second);
      // A late, lower rev carrying a real change is dropped too.
      onPush!({ state: clone(replay), seq: 1, rev: 2 });
      expect(getAppState()).toBe(second);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
    });
  });
});
