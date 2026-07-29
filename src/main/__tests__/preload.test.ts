/**
 * @jest-environment node
 *
 * The contextBridge surface is the renderer's ONLY door into main, and its
 * allowlist is the door's lock. Nothing else exercised preload.ts: every
 * renderer test talks to a mocked bridge, so a channel dropped from
 * INVOKE_CHANNELS — or the allowlist check itself going missing — would sail
 * through the whole suite and only surface in a packaged build.
 */
import { INVOKE_CHANNELS, PUSH_CHANNELS } from '@shared/ipc';
import type { RendererApi } from '@shared/ipc';

const mockInvoke = jest.fn();
const mockOn = jest.fn();
const mockRemoveListener = jest.fn();
const mockExpose = jest.fn();

jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (...a: unknown[]) => mockExpose(...a),
  },
  ipcRenderer: {
    invoke: (...a: unknown[]) => mockInvoke(...a),
    on: (...a: unknown[]) => mockOn(...a),
    removeListener: (...a: unknown[]) => mockRemoveListener(...a),
  },
}));

/** preload.ts exposes its api as an import SIDE EFFECT, so the only way to
 *  get hold of it is to (re-)import the module and catch what it hands the
 *  bridge. */
function loadPreload(): { key: string; api: RendererApi } {
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../preload');
  });
  const [key, api] = mockExpose.mock.calls.at(-1) as [string, RendererApi];
  return { key, api };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInvoke.mockResolvedValue('ok');
});

describe('preload contextBridge surface', () => {
  it('exposes the api on window.kiagent', () => {
    const { key, api } = loadPreload();
    expect(key).toBe('kiagent');
    expect(typeof api.invoke).toBe('function');
    expect(typeof api.on).toBe('function');
  });

  it('invoke forwards an allowlisted channel to ipcRenderer with its payload', async () => {
    const { api } = loadPreload();
    await expect(api.invoke('app:get-state', undefined)).resolves.toBe('ok');
    expect(mockInvoke).toHaveBeenCalledWith('app:get-state', undefined);

    mockInvoke.mockClear();
    await api.invoke('docs:get', { id: 'd1' } as never);
    expect(mockInvoke).toHaveBeenCalledWith('docs:get', { id: 'd1' });
  });

  it('invoke REJECTS an unknown channel and never reaches ipcRenderer', async () => {
    const { api } = loadPreload();
    await expect(
      api.invoke('app:definitely-not-a-channel' as never, undefined as never),
    ).rejects.toThrow('unknown invoke channel: app:definitely-not-a-channel');
    // The load-bearing half: a rejection that still called through would
    // have already run the main-side handler.
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('on subscribes an allowlisted push channel, strips the event arg, and unsubscribes', () => {
    const { api } = loadPreload();
    const cb = jest.fn();
    const off = api.on('push:logs', cb);
    expect(mockOn).toHaveBeenCalledTimes(1);
    const [channel, listener] = mockOn.mock.calls[0] as [
      string,
      (e: unknown, p: unknown) => void,
    ];
    expect(channel).toBe('push:logs');

    // The renderer callback must see the PAYLOAD only — never the
    // IpcRendererEvent, which carries a live `sender` handle.
    listener({ sender: 'nope' }, [{ msg: 'hi' }]);
    expect(cb).toHaveBeenCalledWith([{ msg: 'hi' }]);

    off();
    expect(mockRemoveListener).toHaveBeenCalledWith('push:logs', listener);
  });

  it('on THROWS for an unknown push channel and never reaches ipcRenderer', () => {
    const { api } = loadPreload();
    // Synchronous by design (preload.ts) — not a rejected promise.
    expect(() => api.on('push:nonsense' as never, jest.fn())).toThrow(
      'unknown push channel: push:nonsense',
    );
    expect(mockOn).not.toHaveBeenCalled();
  });

  it('accepts every declared channel and nothing else', async () => {
    const { api } = loadPreload();
    // Cheap full sweep: the allowlists ARE the contract, so walk them.
    for (const c of INVOKE_CHANNELS) {
      await expect(api.invoke(c, undefined as never)).resolves.toBe('ok');
    }
    expect(mockInvoke).toHaveBeenCalledTimes(INVOKE_CHANNELS.length);
    for (const c of PUSH_CHANNELS) {
      expect(() => api.on(c, jest.fn())).not.toThrow();
    }
    expect(mockOn).toHaveBeenCalledTimes(PUSH_CHANNELS.length);
  });
});
