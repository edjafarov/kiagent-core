/** @jest-environment node */
import {
  subscribeUpdaterState,
  updaterInvokeHandlers,
} from '@main/updater/ipc';
import type { UpdateState, UpdaterManager } from '@main/updater/types';

function fakeManager() {
  let cb: ((s: UpdateState) => void) | null = null;
  const idle: UpdateState = {
    status: 'idle',
    currentVersion: '0.38.0',
    version: null,
  };
  return {
    getState: jest.fn((): UpdateState => idle),
    check: jest.fn(
      async (): Promise<UpdateState> => ({ ...idle, status: 'checking' }),
    ),
    quitAndInstall: jest.fn(),
    onStateChange: jest.fn((fn: (s: UpdateState) => void) => {
      cb = fn;
      return () => {
        cb = null;
      };
    }),
    start: jest.fn(),
    stop: jest.fn(),
    emit: (s: UpdateState) => cb?.(s),
  };
}

const handlersFor = (m: ReturnType<typeof fakeManager>) =>
  updaterInvokeHandlers(m as unknown as UpdaterManager);

describe('updaterInvokeHandlers', () => {
  it('update:get-state returns the manager state', async () => {
    const m = fakeManager();
    expect(await handlersFor(m)['update:get-state'](undefined)).toMatchObject({
      status: 'idle',
    });
  });

  it('update:check delegates to manager.check', async () => {
    const m = fakeManager();
    expect(await handlersFor(m)['update:check'](undefined)).toMatchObject({
      status: 'checking',
    });
    expect(m.check).toHaveBeenCalled();
  });

  it('update:quit-and-install delegates to the manager', async () => {
    const m = fakeManager();
    await handlersFor(m)['update:quit-and-install'](undefined);
    expect(m.quitAndInstall).toHaveBeenCalled();
  });

  /* The slice returns handlers rather than registering them, so that main can
   * hold ONE map it can be checked against — see shared/ipc.ts InvokeHandlers.
   * Registering nothing is the property under test here. */
  it('registers nothing itself — the three channels are only returned', () => {
    const m = fakeManager();
    expect(Object.keys(handlersFor(m)).sort()).toEqual([
      'update:check',
      'update:get-state',
      'update:quit-and-install',
    ]);
    expect(m.onStateChange).not.toHaveBeenCalled();
  });
});

describe('subscribeUpdaterState', () => {
  it('forwards state changes to the broadcaster, and unsubscribes', () => {
    const m = fakeManager();
    const seen: UpdateState[] = [];
    const off = subscribeUpdaterState(m as unknown as UpdaterManager, (s) => {
      seen.push(s);
    });
    const next: UpdateState = {
      status: 'downloaded',
      currentVersion: '0.38.0',
      version: '0.39.0',
    };
    m.emit(next);
    expect(seen).toEqual([next]);

    off();
    m.emit({ ...next, status: 'idle' });
    expect(seen).toHaveLength(1);
  });
});
