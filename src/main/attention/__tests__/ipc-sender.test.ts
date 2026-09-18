import {
  createTrustedRendererPredicate,
  expectedRendererUrl,
  guardIpcHandler,
  SENDER_VALIDATED_CHANNELS,
} from '../../ipc-sender';

describe('trusted attention renderer sender', () => {
  const app = { isPackaged: false, getAppPath: () => '/app' };

  it('requires the live app window, its main frame, and the app URL', () => {
    const mainFrame = {};
    const sender = { getURL: () => expectedRendererUrl(app), mainFrame };
    const win = { isDestroyed: () => false, webContents: sender };
    const predicate = createTrustedRendererPredicate({
      app,
      BrowserWindow: { getAllWindows: () => [win] },
    });

    expect(predicate({ sender, senderFrame: mainFrame })).toBe(true);
    expect(predicate({ sender, senderFrame: {} })).toBe(false);
    expect(
      predicate({
        sender: { ...sender, getURL: () => 'https://evil.test' },
        senderFrame: mainFrame,
      }),
    ).toBe(false);
    expect(SENDER_VALIDATED_CHANNELS).toEqual(
      new Set(['attention:list', 'attention:act']),
    );
  });

  it('S10 rejects untrusted attention senders without calling the handler', () => {
    const handler = jest.fn(() => 'handled');
    const guarded = guardIpcHandler('attention:list', handler, () => false);

    expect(() => guarded({}, undefined)).toThrow('untrusted renderer');
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['attention:list', 'attention:act'])(
    'S10a rejects an untrusted sender on every validated channel: %s',
    (channel) => {
      const handler = jest.fn(() => 'handled');
      const guarded = guardIpcHandler(channel, handler, () => false);

      expect(() => guarded({}, undefined)).toThrow('untrusted renderer');
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('S10 leaves unrelated channels unaffected by the sender guard', () => {
    const handler = jest.fn(() => 'handled');
    const guarded = guardIpcHandler('prefs:get', handler, () => false);

    expect(guarded({}, undefined)).toBe('handled');
    expect(handler).toHaveBeenCalledWith(undefined);
  });
});
