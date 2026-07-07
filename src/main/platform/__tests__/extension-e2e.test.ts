/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AuthChannel, ExtensionSnapshot, Source } from '@shared/contracts';

import { createEngine } from '@main/core/engine/engine';
import { openStore, type CoreStore } from '@main/core/store/store';

import { createExtensionPlatform, type ExtensionPlatform } from '../extension-platform';
import { nodeForkTransport } from '../transport';

jest.setTimeout(240_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHILD_ENTRY = path.resolve(__dirname, '../extension-host-entry.ts');
const FIXTURE = path.join(__dirname, 'fixtures', 'ext-basic');

describe('extension runtime e2e (real forked child)', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  const registry = new Map<string, Source>();
  const snapshots: ExtensionSnapshot[][] = [];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-e2e-'));
    store = openStore(path.join(tmp, 'kiagent.db'), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    platform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s) => void registry.set(s.descriptor.id, s),
        get: (id) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id) => void registry.delete(id),
      },
      scheduler: { register: jest.fn(), unregister: jest.fn(), jobs: jest.fn(async () => []), trigger: jest.fn(), env: {} } as never,
      registerTool: () => () => {},
      inference: { complete: async () => '', see: async () => '', read: async () => '' },
      logSink: { log: (...a) => process.stderr.write(`${JSON.stringify(a)}\n`) },
      notify: () => {},
      transportFactory: () =>
        nodeForkTransport(CHILD_ENTRY, {
          cwd: REPO_ROOT,
          execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'],
          env: {
            ...process.env,
            KIA_EXT_HOST_CHILD: '1',
            TS_NODE_TRANSPILE_ONLY: '1',
            TS_NODE_PROJECT: path.join(REPO_ROOT, 'tsconfig.json'),
          },
        }),
      onChange: (s) => snapshots.push(s),
      hostTimeouts: { readyTimeoutMs: 180_000, activateTimeoutMs: 180_000 },
    });
  });

  afterAll(async () => {
    await platform.stop();
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('installs, activates in a real child, and the engine syncs its documents', async () => {
    await platform.start();
    const preview = await platform.installPreview(FIXTURE);
    expect(preview).toMatchObject({ ok: true, id: 'test.basic' });
    const commit = await platform.installCommit((preview as { token: string }).token);
    expect(commit).toEqual({ ok: true, id: 'test.basic' });
    expect(registry.has('basicsrc')).toBe(true);

    const engine = createEngine({
      store,
      sources: { get: (id: string) => registry.get(id), list: () => [], register: () => {} } as never,
      inference: { complete: async () => '', see: async () => '', read: async () => '' } as never,
      convert: async (d) => d,
      logs: { log: () => {} },
      refreshers: new Map(),
    });
    const auth = { prompt: async () => ({}), oauth: async () => ({}), showQr: () => {}, status: () => {} } as never as AuthChannel;
    const account = await engine.connect(registry.get('basicsrc')!, auth);
    expect(account.identifier).toBe('basic-account');

    const handle = engine.run(account);
    const deadline = Date.now() + 60_000;
    // eslint-disable-next-line no-await-in-loop
    while ((await store.read.count({ account: account.id })) < 2 && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 200); });
    }
    await handle.stop();
    const docs = await store.read.search({ account: account.id });
    expect(docs.map((d) => d.externalId).sort()).toEqual(['basic-0', 'basic-1']);

    // Reconcile over RPC: a second engine cycle diffs the child's listing
    // (only basic-0 lives upstream) against the store and archives basic-1.
    // Cycle 1 above archived nothing — both docs committed after reconcile's
    // startSeq snapshot (the engine's TOCTOU guard) — which this implicitly
    // proves too: count was 2 at the end of cycle 1.
    const handle2 = engine.run(account);
    const deadline2 = Date.now() + 60_000;
    // eslint-disable-next-line no-await-in-loop
    while ((await store.read.count({ account: account.id })) > 1 && Date.now() < deadline2) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 200); });
    }
    await handle2.stop();
    expect(await store.read.count({ account: account.id })).toBe(1);
    const live = await store.read.search({ account: account.id });
    expect(live.map((d) => d.externalId)).toEqual(['basic-0']);

    // uninstall is refused while the account lives, then succeeds after removal
    await expect(platform.uninstall('test.basic')).resolves.toMatchObject({ ok: false });
    await engine.remove(account.id);
    await expect(platform.uninstall('test.basic')).resolves.toEqual({ ok: true });
    expect(registry.has('basicsrc')).toBe(false);
  });
});
