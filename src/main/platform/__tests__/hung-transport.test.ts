/** @jest-environment node */
import { createExtensionHost } from '../host-process';
import { createHungTransport } from '../transport';

describe('createHungTransport', () => {
  it('fires exit once on kill, never answers', () => {
    const t = createHungTransport();
    const exits: Array<number | null> = [];
    const onMsg = jest.fn();
    t.onMessage(onMsg);
    t.onExit((c) => exits.push(c));
    t.send({ kind: 'bootstrap' });
    t.kill();
    t.kill();
    t.close();
    expect(exits).toEqual([null]);
    expect(onMsg).not.toHaveBeenCalled();
  });

  it('a host on it times out its handshake and stays activating (retrying), never errored', async () => {
    const statuses: string[] = [];
    const host = createExtensionHost({
      extensionId: 'kia.hung',
      entryAbsPath: '/virtual/e.js',
      dataDir: '/virtual/d',
      caps: [],
      transportFactory: createHungTransport,
      makeSurfaces: () => ({ surfaces: {} as never, close: () => {} }),
      logSink: { log: jest.fn() },
      onStatus: (s) => statuses.push(s),
      registerContributions: () => () => {},
      readyTimeoutMs: 30,
      handshakeRetryDelayMs: () => 60_000,
    });
    await host.start(); // settles once the retry is scheduled
    expect(statuses).toEqual(['activating', 'activating']);
    await host.stop();
  });
});
