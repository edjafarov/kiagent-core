/** @jest-environment node */
import fs from 'fs';
import path from 'path';

import type { ExtensionPlatform } from '../extension-platform';
import { writeEnabledState } from '../extensions';
import {
  createHarness,
  FIXTURES,
  waitFor,
  type PlatformHarness,
} from './helpers/platform-harness';

describe('extension platform boot split (#140)', () => {
  let h: PlatformHarness;
  let platform: ExtensionPlatform | null = null;
  const status = (id: string) =>
    platform!.snapshot().find((e) => e.id === id)?.status;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await platform?.stop();
    platform = null;
    await h.close();
  });

  /** test.basic installed (consented) through a first platform, then stopped. */
  async function installBasic(): Promise<void> {
    const first = h.make();
    await first.start();
    await h.install(first, path.join(FIXTURES, 'ext-basic'));
    await first.stop();
    h.registry.clear();
    h.tools.clear();
    h.counts.registerTool = 0;
    h.spawns.clear(); // the install spawned test.basic once; count from here
  }

  it('load() shows enabled entries as activating, disabled ones as disabled, and activates none', async () => {
    const bundledDir = h.copyBundled('ext-bundled');
    h.copyBundled('ext-bundled-slow');
    fs.mkdirSync(path.join(h.tmp, 'extensions'), { recursive: true });
    writeEnabledState(path.join(h.tmp, 'extensions'), {
      'test.bundled-slow': { enabled: false },
    });
    platform = h.make({ bundledDir });
    await platform.load();
    expect(status('test.bundled')).toBe('activating');
    expect(status('test.bundled-slow')).toBe('disabled');
    expect(h.counts.registerTool).toBe(0);
  });

  it('startInProcess() activates only unsafe.mainProcess entries; startUtility() starts the rest', async () => {
    await installBasic();
    platform = h.make({ bundledDir: h.copyBundled('ext-bundled') });
    await platform.load();
    const report = await platform.startInProcess();
    expect(report.pending).toEqual([]);
    expect(Object.keys(report.activatedMs)).toEqual(['test.bundled']);
    expect(status('test.bundled')).toBe('activated');
    expect(status('test.basic')).toBe('activating');
    expect(h.registry.has('basicsrc')).toBe(false);
    expect(h.spawns.get('test.basic')).toBeUndefined();

    await platform.startUtility();
    expect(status('test.basic')).toBe('activated');
    expect(h.registry.has('basicsrc')).toBe(true);
  });

  it('startInProcess() returns at the bound when a first handshake times out; the retry activates later', async () => {
    platform = h.make({
      bundledDir: h.copyBundled('ext-bundled-slow'),
      // extras.mainProcess for unsafe.mainProcess entries (extension-platform
      // passes deps.mainApi to the in-process runtime).
      mainApi: { slowFirstActivate: { ms: 400 } },
      hostTimeouts: {
        activateTimeoutMs: 100,
        handshakeRetryDelayMs: () => 300,
      },
    });
    await platform.load();
    const t0 = Date.now();
    const report = await platform.startInProcess({ boundMs: 150 });
    expect(Date.now() - t0).toBeLessThan(380);
    expect(report.pending).toEqual(['test.bundled-slow']);
    expect(status('test.bundled-slow')).toBe('activating');
    expect(
      h.logs.some((l) => /still activating.*test\.bundled-slow/.test(l.msg)),
    ).toBe(true);
    await waitFor(() => status('test.bundled-slow') === 'activated', 3000);
    expect(h.tools.has('slow.probe')).toBe(true);
  });

  it('logs how long each activation took', async () => {
    platform = h.make({ bundledDir: h.copyBundled('ext-bundled') });
    await platform.load();
    await platform.startInProcess();
    expect(
      h.logs.some(
        (l) =>
          l.scope === 'extension:test.bundled' &&
          /^activated in \d+ ms$/.test(l.msg),
      ),
    ).toBe(true);
  });

  it('startUtility(signal): an abort during an unresolved consent read starts no transport', async () => {
    await installBasic();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let consentReads = 0;
    // The store with consents.latest held until `release` (Proxy keeps every
    // other store method bound to the real store).
    const gatedStore = new Proxy(h.store, {
      get(target, key, receiver) {
        if (key !== 'consents') return Reflect.get(target, key, receiver);
        const { consents } = target;
        return new Proxy(consents, {
          get(c, k, r) {
            if (k !== 'latest') return Reflect.get(c, k, r);
            return async (id: string) => {
              consentReads += 1;
              await gate;
              return c.latest(id);
            };
          },
        });
      },
    });
    platform = h.make({ store: gatedStore });
    await platform.load();
    const ac = new AbortController();
    const started = platform.startUtility(ac.signal);
    await waitFor(() => consentReads > 0); // test.basic is mid-consent-read
    ac.abort(); // quit / Reset all
    release();
    await started;
    expect(h.spawns.get('test.basic')).toBeUndefined();
    expect(h.registry.has('basicsrc')).toBe(false);
  });

  it('startUtility(signal) already aborted spawns nothing (queued activations are skipped)', async () => {
    await installBasic();
    platform = h.make();
    await platform.load();
    const ac = new AbortController();
    ac.abort();
    await platform.startUtility(ac.signal);
    expect(h.spawns.get('test.basic')).toBeUndefined();
    expect(status('test.basic')).toBe('activating'); // never touched
  });

  it('a DB-worker respawn after load() but before any start activates nothing', async () => {
    let respawn: (() => void) | undefined;
    platform = h.make({
      bundledDir: h.copyBundled('ext-bundled'),
      db: {
        onWorkerRespawn: (cb: () => void) => {
          respawn = cb;
          return () => {};
        },
      } as never,
    });
    await platform.load();
    respawn!();
    await new Promise((r) => setTimeout(r, 50));
    expect(status('test.bundled')).toBe('activating');
    expect(h.counts.registerTool).toBe(0);
  });
});
