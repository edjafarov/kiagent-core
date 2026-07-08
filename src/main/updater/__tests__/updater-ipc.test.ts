/** @jest-environment node */
import { registerUpdaterIpc } from '@main/updater/ipc';
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

function fakeBus() {
  const handlers = new Map<string, (e: unknown, p: unknown) => unknown>();
  const broadcasts: Array<{ channel: string; payload: unknown }> = [];
  return {
    handle: (channel: string, fn: (e: unknown, p: unknown) => unknown) =>
      handlers.set(channel, fn),
    broadcast: (channel: string, payload: unknown) =>
      broadcasts.push({ channel, payload }),
    invoke: (channel: string, payload?: unknown) =>
      handlers.get(channel)!({}, payload),
    broadcasts,
  };
}

describe('registerUpdaterIpc', () => {
  it('update:get-state returns the manager state', async () => {
    const m = fakeManager();
    const bus = fakeBus();
    registerUpdaterIpc(m as unknown as UpdaterManager, bus as never);
    expect(await bus.invoke('update:get-state')).toMatchObject({
      status: 'idle',
    });
  });

  it('update:check delegates to manager.check', async () => {
    const m = fakeManager();
    const bus = fakeBus();
    registerUpdaterIpc(m as unknown as UpdaterManager, bus as never);
    expect(await bus.invoke('update:check')).toMatchObject({
      status: 'checking',
    });
    expect(m.check).toHaveBeenCalled();
  });

  it('update:quit-and-install delegates to the manager', async () => {
    const m = fakeManager();
    const bus = fakeBus();
    registerUpdaterIpc(m as unknown as UpdaterManager, bus as never);
    await bus.invoke('update:quit-and-install');
    expect(m.quitAndInstall).toHaveBeenCalled();
  });

  it('broadcasts state changes on push:update-state', () => {
    const m = fakeManager();
    const bus = fakeBus();
    registerUpdaterIpc(m as unknown as UpdaterManager, bus as never);
    const next: UpdateState = {
      status: 'downloaded',
      currentVersion: '0.38.0',
      version: '0.39.0',
    };
    m.emit(next);
    expect(bus.broadcasts).toContainEqual({
      channel: 'push:update-state',
      payload: next,
    });
  });
});
