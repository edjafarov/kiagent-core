/** @jest-environment node */
/** Step 5 Task 4: the extension set through the real `createExtensionPlatform`
 *  (the slow tier): the leader writes, a follower forwards, reconcile runs
 *  through the platform. The rules over fake ops are in extension-set.test.ts. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as tar from 'tar';

import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';
import type { SyncService } from '@main/core/sync/service';

import { createExtensionPlatform, type ExtensionPlatform } from '../extension-platform';
import { runExtensionHost } from '../extension-host-entry';
import { createInMemoryHostPair } from '../transport';

import { fakeStore } from './helpers/extension-fakes';

jest.setTimeout(120_000);

describe('platform wiring', () => {
  const FWD = path.join(__dirname, 'fixtures', 'ext-fwd');
  const BASIC = path.join(__dirname, 'fixtures', 'ext-basic');
  const REF = 'github:kia-plugins/basic@v1';
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  let setStore: ReturnType<typeof fakeStore>;
  // The members the platform reads, typed against the real service.
  type PlatformSync = Pick<SyncService, 'readOnly' | 'forward' | 'enqueue' | 'onApplied'>;
  const sync: { [K in keyof PlatformSync]: jest.Mock<ReturnType<PlatformSync[K]>, Parameters<PlatformSync[K]>> } = {
    readOnly: jest.fn(),
    forward: jest.fn(),
    enqueue: jest.fn(),
    onApplied: jest.fn(),
  };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-extset-'));
    fs.cpSync(FWD, path.join(tmp, 'bundled', 'test.fwd'), { recursive: true });
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    setStore = fakeStore();
    fs.cpSync(BASIC, path.join(tmp, 'pkg', 'basic'), { recursive: true });
    const bytes = Buffer.from(
      (await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        tar
          .c({ gzip: true, cwd: path.join(tmp, 'pkg') }, ['basic'])
          .on('data', (c: Buffer) => chunks.push(c))
          .on('end', () => resolve(Buffer.concat(chunks)))
          .on('error', reject);
      })),
    );
    platform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      bundledDir: path.join(tmp, 'bundled'),
      store,
      attention: {} as never,
      // The platform's dep is the whole service; the fake carries what it reads.
      sync: sync as unknown as SyncService,
      extensionSet: setStore,
      download: async () => ({ bytes, pinnedRef: REF }),
      sources: { register: () => {}, get: () => undefined, list: () => [], unregister: () => {} },
      senders: { register: () => {}, get: () => undefined, ids: () => [], unregister: () => {} },
      scheduler: { register: jest.fn(), unregister: jest.fn(), jobs: jest.fn(async () => []), trigger: jest.fn(), env: {} } as never,
      registerTool: () => () => {},
      inference: { complete: async () => '', see: async () => '', read: async () => '', hear: async () => '' },
      laneState: () => 'open',
      logSink: { log: () => {} },
      notify: () => {},
      transportFactory: () => {
        const pair = createInMemoryHostPair();
        runExtensionHost(pair.child, {
          // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require, import/no-dynamic-require
          requireModule: (p: string) => require(p),
          exit: (code) => pair.simulateExit(code),
        });
        return pair.main;
      },
      onChange: () => {},
      hostTimeouts: { readyTimeoutMs: 60_000, activateTimeoutMs: 60_000 },
    } as never);
    await platform.start();
  });
  afterAll(async () => {
    await platform.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  // Each test seeds its own set and starts as a writable leader with
  // test.fwd enabled; the platform itself is shared because it is slow to boot.
  beforeEach(async () => {
    sync.readOnly.mockReset().mockReturnValue(false);
    sync.forward.mockReset();
    setStore.set(undefined);
    setStore.writable = true;
    setStore.failNext = false;
    await platform.reconcileExtensions({ 'test.fwd': { enabled: true } });
    setStore.set(undefined);
  });
  const enabled = (id: string) => platform.snapshot().find((e) => e.id === id)?.enabled;

  it('on the leader setEnabled rewrites the key; reconcile brings the device back without rewriting it', async () => {
    expect((await platform.setEnabled('test.fwd', false)).ok).toBe(true);
    expect(setStore.get()).toEqual({ 'test.fwd': { enabled: false } });
    const writes = setStore.writes;
    const r = await platform.reconcileExtensions({ 'test.fwd': { enabled: true } });
    expect(r).toEqual({ installed: [], failed: [] });
    expect(enabled('test.fwd')).toBe(true);
    expect(setStore.writes).toBe(writes);
  });

  it('reconcileExtensions with no set argument reads the store, and does nothing without one', async () => {
    setStore.set(undefined);
    await expect(platform.reconcileExtensions()).resolves.toEqual({ installed: [], failed: [] });
    setStore.set({ 'test.fwd': { enabled: false } });
    await platform.reconcileExtensions();
    expect(enabled('test.fwd')).toBe(false);
    await platform.reconcileExtensions({ 'test.fwd': { enabled: true } });
    expect(enabled('test.fwd')).toBe(true);
  });

  it('seedExtensionSet seeds once from local state and keeps an existing row', async () => {
    setStore.set(undefined);
    await platform.seedExtensionSet();
    expect(setStore.get()).toEqual({ 'test.fwd': { enabled: true } });
    setStore.set({ 'x.y': { enabled: true, ref: 'r' } });
    await platform.seedExtensionSet();
    expect(setStore.get()).toEqual({ 'x.y': { enabled: true, ref: 'r' } });
  });

  it('a follower commit of a marketplace connector forwards the pinned ref and installs nothing locally', async () => {
    const p = await platform.installPreview(REF);
    if (!('token' in p)) throw new Error('preview failed');
    sync.readOnly.mockReturnValue(true);
    sync.forward.mockResolvedValue({ ok: true, value: { ok: true, id: 'test.basic' } });
    const r = await platform.installCommit(p.token);
    expect(r).toEqual({ ok: true, id: 'test.basic' });
    expect(sync.forward).toHaveBeenCalledWith({
      kind: 'core',
      name: 'extension:install',
      payload: { ref: REF },
    });
    expect(platform.snapshot().some((e) => e.id === 'test.basic')).toBe(false);
    // the staged token is gone
    sync.readOnly.mockReturnValue(false);
    expect((await platform.installCommit(p.token)).ok).toBe(false);
  });

  it('a follower commit with no leader says so and installs nothing', async () => {
    const p = await platform.installPreview(REF);
    if (!('token' in p)) throw new Error('preview failed');
    sync.readOnly.mockReturnValue(true);
    sync.forward.mockResolvedValue({ ok: false, code: 'no-master', message: 'x' });
    const r = await platform.installCommit(p.token);
    expect(r.ok).toBe(false);
    expect(platform.snapshot().some((e) => e.id === 'test.basic')).toBe(false);
  });

  it('a follower commit of a local (dev) install is this machine\'s own and is not forwarded', async () => {
    const p = await platform.installPreview(BASIC);
    if (!('token' in p)) throw new Error('preview failed');
    sync.readOnly.mockReturnValue(true);
    expect((await platform.installCommit(p.token)).ok).toBe(true);
    expect(sync.forward).not.toHaveBeenCalled();
    sync.readOnly.mockReturnValue(false);
    expect((await platform.uninstall('test.basic')).ok).toBe(true);
  });

  it('on the leader install records the pinned ref and consent; uninstall removes it', async () => {
    setStore.set({});
    const r = await platform.installFromRef(REF, { grantConsent: true });
    expect(r).toEqual({ ok: true, id: 'test.basic' });
    expect(platform.snapshot().find((e) => e.id === 'test.basic')?.status).toBe('activated');
    expect(await store.consents.latest('test.basic' as never)).toBeTruthy();
    expect(setStore.get()).toEqual({ 'test.basic': { enabled: true, ref: REF } });
    expect((await platform.uninstall('test.basic')).ok).toBe(true);
    expect(setStore.get()).toEqual({ 'test.basic': { enabled: false, removed: true } });
  });

  it('uninstalling an id the platform does not know fails and writes no tombstone', async () => {
    setStore.set({});
    const writes = setStore.writes;
    expect((await platform.uninstall('no.such.id')).ok).toBe(false);
    expect(setStore.get()).toEqual({});
    expect(setStore.writes).toBe(writes);
  });

  it('enable on a tombstone is refused before the raw op', async () => {
    setStore.set({ 'test.fwd': { enabled: false, removed: true } });
    const writes = setStore.writes;
    const before = enabled('test.fwd');
    const r = await platform.setEnabled('test.fwd', true);
    expect(r).toEqual({ ok: false, error: 'This connector was removed on another device. Reinstall it first.' });
    expect(enabled('test.fwd')).toBe(before);
    expect(setStore.writes).toBe(writes);
    setStore.set({});
  });

  it('reconcile installs a missing connector from the set with consent, then leaves it alone when it leaves the set', async () => {
    sync.readOnly.mockReturnValue(true); // a follower: nothing is recorded
    setStore.writable = false;
    const r = await platform.reconcileExtensions({ 'test.basic': { enabled: true, ref: REF } });
    expect(r).toEqual({ installed: ['test.basic'], failed: [] });
    expect(enabled('test.basic')).toBe(true);
    expect(await store.consents.latest('test.basic' as never)).toBeTruthy();
    await platform.reconcileExtensions({ 'test.basic': { enabled: false, ref: REF } });
    expect(enabled('test.basic')).toBe(false);
    await platform.reconcileExtensions({});
    expect(platform.snapshot().some((e) => e.id === 'test.basic')).toBe(true); // absence never uninstalls
    expect((await platform.uninstall('test.basic')).ok).toBe(true);
    setStore.writable = true;
  });

  it('setEnabled whose set write fails rejects with a clear message, and the next reconcile records it', async () => {
    setStore.set({ 'test.fwd': { enabled: true } });
    await platform.setEnabled('test.fwd', true);
    setStore.failNext = true;
    await expect(platform.setEnabled('test.fwd', false)).rejects.toThrow(/could not be recorded in the extension set/);
    expect(enabled('test.fwd')).toBe(false);
    expect(platform.hasPendingExtensionRecords()).toBe(true);
    await platform.reconcileExtensions();
    expect(platform.hasPendingExtensionRecords()).toBe(false);
    expect(setStore.get()).toEqual({ 'test.fwd': { enabled: false } });
    expect(enabled('test.fwd')).toBe(false);
    await platform.setEnabled('test.fwd', true);
  });
});
