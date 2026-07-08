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
    processing: { pending: 0, done: 0, skipped: 0, failed: 0 },
    mcp: { port: null, clients: 0 },
    identity: null,
    prefs: {
      theme: 'system',
      logLevel: 'info',
      launchAtLogin: false,
      showInMenuBar: false,
      processing: { enabled: false, window: 'always' },
      privacy: { browserHistory: false, sendDiagnostics: false },
      models: { override: 'auto', autoInstall: false },
      onboarding: {
        sourceBackfilledAt: null,
        mcpConnectedAt: null,
        firstQueryAt: null,
        dismissedAt: null,
      },
    },
    extensions: [],
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
