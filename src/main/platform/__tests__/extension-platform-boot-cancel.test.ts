/** @jest-environment node */
import path from 'path';

import type { ExtensionPlatform } from '../extension-platform';
import { runExtensionHost } from '../extension-host-entry';
import { createInMemoryHostPair, type HostTransport } from '../transport';
import {
  createHarness,
  FIXTURES,
  waitFor,
  type PlatformHarness,
} from './helpers/platform-harness';

/** #140 A2: a boot abort (quit / Reset all) that lands while an extension's
 *  handshake is in flight must cut that handshake short — prompt teardown,
 *  no late 'activated', no contributions registered after cancellation. */
describe('extension platform boot cancellation mid-handshake (#140)', () => {
  let h: PlatformHarness;
  let platform: ExtensionPlatform | null = null;

  beforeEach(async () => {
    h = await createHarness();
    const first = h.make();
    await first.start();
    await h.install(first, path.join(FIXTURES, 'ext-basic'));
    await first.stop();
    h.registry.clear();
    h.tools.clear();
    h.counts.registerTool = 0;
    h.snapshots.length = 0;
  });
  afterEach(async () => {
    await platform?.stop();
    platform = null;
    await h.close();
  });

  /** A transport whose child→main messages of `held` kinds are buffered
   *  until `release()` — a slow host stuck in its handshake. */
  function holdingTransport(held: string) {
    const buffered: Array<() => void> = [];
    let released = false;
    const factory = (): HostTransport => {
      const pair = createInMemoryHostPair();
      runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
      return {
        ...pair.main,
        onMessage: (cb) =>
          pair.main.onMessage((m) => {
            const kind = (m as { kind?: string } | null)?.kind;
            if (!released && kind === held) buffered.push(() => cb(m));
            else cb(m);
          }),
      };
    };
    return {
      factory,
      held: () => buffered.length,
      release: () => {
        released = true;
        for (const deliver of buffered.splice(0)) deliver();
      },
    };
  }

  const everActivated = () =>
    h.snapshots.some((s) =>
      s.some((e) => e.id === 'test.basic' && e.status === 'activated'),
    );

  for (const [phase, held] of [
    ['after bootstrap (waiting for ready)', 'ready'],
    ['during activation (waiting for activated)', 'activated'],
  ] as const) {
    it(`an abort ${phase} tears the host down promptly and registers nothing`, async () => {
      const t = holdingTransport(held);
      platform = h.make({
        transportFactory: t.factory,
        hostTimeouts: { readyTimeoutMs: 2_000, activateTimeoutMs: 2_000 },
      });
      await platform.load();
      const ac = new AbortController();
      const started = platform.startUtility(ac.signal);
      await waitFor(() => t.held() > 0);

      const t0 = Date.now();
      ac.abort(); // quit / Reset all: abort, then the queued teardown
      const teardown = Promise.all([started, platform.stop()]);
      await new Promise((r) => setTimeout(r, 50));
      t.release(); // the slow host answers while teardown is in progress
      await teardown;
      expect(Date.now() - t0).toBeLessThan(1_000);
      platform = null;
      expect(
        h.snapshots.at(-1)?.find((e) => e.id === 'test.basic')?.status,
      ).toBe('disabled');
      await new Promise((r) => setTimeout(r, 50));
      expect(everActivated()).toBe(false);
      expect(h.registry.has('basicsrc')).toBe(false);
      expect(h.counts.registerTool).toBe(0);
    }, 10_000);
  }
});
