/** @jest-environment node */
import path from 'path';

import type { ExtensionPlatform } from '../extension-platform';
import {
  createHarness,
  FIXTURES,
  waitFor,
  type PlatformHarness,
} from './helpers/platform-harness';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASIC = path.join(FIXTURES, 'ext-basic');

describe('dormant utility hosts (#137)', () => {
  let h: PlatformHarness;
  let platform: ExtensionPlatform;
  const snap = (id: string) => platform.snapshot().find((e) => e.id === id);

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await platform.stop();
    await h.close();
    delete process.env.KIA_DORMANT_HOSTS;
  });

  async function startWith(overrides = {}) {
    platform = h.make({
      dormantExtensions: ['test.basic'],
      dormantAfterMs: 40,
      ...overrides,
    });
    await platform.start();
    await h.install(platform, BASIC);
  }

  it('e2e: activate → dormant → a tool call wakes the host and returns the right result', async () => {
    await startWith();
    await waitFor(() => snap('test.basic')?.dormant === true);
    expect(snap('test.basic')?.status).toBe('activated');
    // soft stop keeps tools/list and the source identical
    expect([...h.tools.keys()]).toEqual(['basic_echo']);
    expect(h.registry.has('basicsrc')).toBe(true);
    const before = h.counts.registerTool;

    await expect(h.tools.get('basic_echo')!.call({ x: 1 })).resolves.toEqual({
      echoed: { x: 1 },
    });
    expect(h.spawns.get('test.basic')).toBe(2);
    expect(snap('test.basic')?.dormant).toBeUndefined();
    expect(h.counts.registerTool).toBe(before); // equal contributions: no re-registration
  });

  it('a source verb wakes it too', async () => {
    await startWith();
    await waitFor(() => snap('test.basic')?.dormant === true);
    await expect(
      h.registry.get('basicsrc')!.connect({} as never),
    ).resolves.toEqual({
      identifier: 'basic-account',
      config: {},
    });
  });

  it('an extension not on the allowlist never goes dormant', async () => {
    await startWith({ dormantExtensions: [] });
    await sleepMs(200);
    expect(snap('test.basic')?.dormant).toBeUndefined();
    expect(h.spawns.get('test.basic')).toBe(1);
  });

  it('KIA_DORMANT_HOSTS=0 disables dormancy', async () => {
    process.env.KIA_DORMANT_HOSTS = '0';
    await startWith();
    await sleepMs(200);
    expect(snap('test.basic')?.dormant).toBeUndefined();
  });

  it('an allowlisted in-process (unsafe.mainProcess) extension is never dormant', async () => {
    platform = h.make({
      bundledDir: h.copyBundled('ext-bundled'),
      dormantExtensions: ['test.bundled'],
      dormantAfterMs: 40,
    });
    await platform.start();
    await sleepMs(200);
    expect(snap('test.bundled')?.status).toBe('activated');
    expect(snap('test.bundled')?.dormant).toBeUndefined();
  });

  it('hard stop of a dormant host: registrations and cadence go, status disabled', async () => {
    await startWith();
    const account = await h.store.createAccount({
      source: 'basicsrc',
      identifier: 'basic-account',
      config: {},
      status: 'live',
    });
    await waitFor(() => snap('test.basic')?.dormant === true);
    expect(await platform.setEnabled('test.basic', false)).toEqual({
      ok: true,
    });
    expect(h.tools.has('basic_echo')).toBe(false);
    expect(h.registry.has('basicsrc')).toBe(false);
    expect(snap('test.basic')?.status).toBe('disabled');
    expect(snap('test.basic')?.dormant).toBeUndefined();
    expect(h.scheduler.unregister).toHaveBeenCalledWith(
      `source:basicsrc:${account.id}`,
    );
  });
});
