/** @jest-environment node */
/** Step 5 Task 4: the user's extension set (`core.extensions`) and the
 *  per-device reconcile (spec 7.9 rules 7-9). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as tar from 'tar';

import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';

import { createExtensionPlatform, type ExtensionPlatform } from '../extension-platform';
import { runExtensionHost } from '../extension-host-entry';
import { createInMemoryHostPair } from '../transport';

import {
  createExtensionSync,
  needsInstall,
  type ExtensionOps,
  type ExtensionSetStore,
  type ExtensionsSet,
  type LocalExtension,
} from '../extension-set';

function fakeStore(initial?: ExtensionsSet, writable = true) {
  let value: ExtensionsSet | undefined = initial;
  const store: ExtensionSetStore & { writes: number; writable: boolean; failNext: boolean; set(v: ExtensionsSet | undefined): void } = {
    writable,
    failNext: false,
    set(v) {
      value = v;
    },
    writes: 0,
    get: () => value,
    canWrite() {
      return this.writable;
    },
    async update(fn) {
      if (!this.writable) throw new Error('read only');
      if (this.failNext) {
        this.failNext = false;
        throw new Error('disk full');
      }
      const next = fn(value);
      if (next !== undefined && JSON.stringify(next) !== JSON.stringify(value)) {
        value = next;
        this.writes += 1;
      }
    },
  };
  return store;
}

function fakeOps(initial: LocalExtension[]) {
  const local = new Map(initial.map((e) => [e.id, { ...e }]));
  const calls: string[] = [];
  const failInstall = new Set<string>();
  const ops: ExtensionOps & { calls: string[]; failInstall: Set<string>; local: typeof local } = {
    calls,
    failInstall,
    local,
    list: () => [...local.values()].map((e) => ({ ...e })),
    async setEnabled(id, enabled) {
      calls.push(`enable:${id}:${enabled}`);
      const e = local.get(id);
      if (!e) return { ok: false, error: 'none' };
      e.enabled = enabled;
      return { ok: true };
    },
    async installFromRef(ref, opts) {
      calls.push(`install:${ref}:${opts.grantConsent}`);
      const id = ref.replace(/^github:kia-plugins\//, 'kia.').replace(/@.*$/, '');
      if (failInstall.has(id)) return { ok: false, error: 'offline' };
      local.set(id, { id, origin: 'marketplace', enabled: true, ref });
      return { ok: true, id };
    },
    async uninstall(id) {
      calls.push(`uninstall:${id}`);
      local.delete(id);
      return { ok: true };
    },
  };
  return ops;
}

const mk = (store: ExtensionSetStore, ops: ExtensionOps) =>
  createExtensionSync({ store, ops, log: () => {} });

describe('needsInstall', () => {
  const ref = 'github:kia-plugins/x@2';
  it('installs what is missing only when the set carries a ref', () => {
    expect(needsInstall(undefined, { ref })).toBe(true);
    expect(needsInstall(undefined, {})).toBe(false);
  });
  it('reinstalls a marketplace extension only when the pinned ref differs', () => {
    const mp = (r?: string): LocalExtension => ({ id: 'x', origin: 'marketplace', enabled: true, ref: r });
    expect(needsInstall(mp('github:kia-plugins/x@1'), { ref })).toBe(true);
    expect(needsInstall(mp(ref), { ref })).toBe(false);
    expect(needsInstall(mp('github:kia-plugins/x@1'), {})).toBe(false);
  });
  it('never reinstalls a bundled or dev extension', () => {
    for (const origin of ['bundled', 'dev'] as const)
      expect(needsInstall({ id: 'x', origin, enabled: true, ref: 'a' }, { ref })).toBe(false);
  });
});

describe('reconcile', () => {
  it('installs a connector from its ref with consent granted, no prompt', async () => {
    const ops = fakeOps([]);
    const sync = mk(fakeStore(), ops);
    const r = await sync.reconcile({ 'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' } });
    expect(ops.calls).toEqual(['install:github:kia-plugins/slack@v2:true']);
    expect(r).toEqual({ installed: ['kia.slack'], failed: [] });
  });

  it('applies enabled state through setEnabled', async () => {
    const ops = fakeOps([{ id: 'kiagent.people', origin: 'bundled', enabled: true }]);
    const sync = mk(fakeStore(), ops);
    await sync.reconcile({ 'kiagent.people': { enabled: false } });
    expect(ops.calls).toEqual(['enable:kiagent.people:false']);
  });

  it('installs a connector the set disables, then disables it', async () => {
    const ops = fakeOps([]);
    const sync = mk(fakeStore(), ops);
    await sync.reconcile({ 'kia.slack': { enabled: false, ref: 'github:kia-plugins/slack@v2' } });
    expect(ops.calls).toEqual(['install:github:kia-plugins/slack@v2:true', 'enable:kia.slack:false']);
  });

  it('never uninstalls a marketplace connector for being absent from the set', async () => {
    const ops = fakeOps([{ id: 'kia.old', origin: 'marketplace', enabled: true, ref: 'github:x/old@1' }]);
    await mk(fakeStore(), ops).reconcile({});
    expect(ops.calls).toEqual([]);
  });

  it('reinstalls a marketplace connector whose local ref differs from the pinned one, then applies enabled', async () => {
    const ops = fakeOps([{ id: 'kia.slack', origin: 'marketplace', enabled: true, ref: 'github:kia-plugins/slack@v1' }]);
    const r = await mk(fakeStore(), ops).reconcile({
      'kia.slack': { enabled: false, ref: 'github:kia-plugins/slack@v2' },
    });
    expect(ops.calls).toEqual(['install:github:kia-plugins/slack@v2:true', 'enable:kia.slack:false']);
    expect(r.installed).toEqual(['kia.slack']);
    expect(ops.local.get('kia.slack')?.ref).toBe('github:kia-plugins/slack@v2');
  });

  it('does not reinstall when the refs match', async () => {
    const ops = fakeOps([{ id: 'kia.slack', origin: 'marketplace', enabled: true, ref: 'github:kia-plugins/slack@v2' }]);
    await mk(fakeStore(), ops).reconcile({ 'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' } });
    expect(ops.calls).toEqual([]);
  });

  it('leaves a bundled extension and a dev install alone when missing from the set', async () => {
    const ops = fakeOps([
      { id: 'kiagent.people', origin: 'bundled', enabled: false },
      { id: 'dev.x', origin: 'dev', enabled: true },
    ]);
    await mk(fakeStore(), ops).reconcile({});
    expect(ops.calls).toEqual([]);
  });

  it('does not install an entry without a ref', async () => {
    const ops = fakeOps([]);
    const r = await mk(fakeStore(), ops).reconcile({ 'kiagent.gone': { enabled: true } });
    expect(ops.calls).toEqual([]);
    expect(r).toEqual({ installed: [], failed: [] });
  });

  it('lists an install failure and retries on the next call', async () => {
    const ops = fakeOps([]);
    ops.failInstall.add('kia.slack');
    const sync = mk(fakeStore(), ops);
    const set = { 'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' } };
    const r1 = await sync.reconcile(set);
    expect(r1.failed).toEqual([{ id: 'kia.slack', error: 'offline' }]);
    expect(sync.failed()).toEqual([{ id: 'kia.slack', error: 'offline' }]);
    ops.failInstall.clear();
    const r2 = await sync.reconcile(set);
    expect(r2).toEqual({ installed: ['kia.slack'], failed: [] });
    expect(sync.failed()).toEqual([]);
  });

  it('does nothing the second time', async () => {
    const ops = fakeOps([{ id: 'kiagent.people', origin: 'bundled', enabled: true }]);
    const sync = mk(fakeStore(), ops);
    const set = {
      'kiagent.people': { enabled: false },
      'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' },
    };
    await sync.reconcile(set);
    ops.calls.length = 0;
    const r = await sync.reconcile(set);
    expect(ops.calls).toEqual([]);
    expect(r).toEqual({ installed: [], failed: [] });
  });

  it('does not touch the set while reconciling', async () => {
    const store = fakeStore({ 'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' } });
    await mk(store, fakeOps([])).reconcile(store.get()!);
    expect(store.writes).toBe(0);
  });

  it('runFromStore does nothing before a set exists', async () => {
    const ops = fakeOps([{ id: 'kia.old', origin: 'marketplace', enabled: true, ref: 'r' }]);
    const r = await mk(fakeStore(), ops).runFromStore();
    expect(ops.calls).toEqual([]);
    expect(r).toEqual({ installed: [], failed: [] });
  });

  it('runs one reconcile at a time', async () => {
    const ops = fakeOps([]);
    const sync = mk(fakeStore(), ops);
    const set = { 'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' } };
    await Promise.all([sync.reconcile(set), sync.reconcile(set)]);
    expect(ops.calls.filter((c) => c.startsWith('install'))).toHaveLength(1);
  });
});

describe('one queue and recorded actions', () => {
  it('a reconcile started during a user action reads the set after the action recorded it', async () => {
    const store = fakeStore({ 'kiagent.people': { enabled: true } });
    const ops = fakeOps([{ id: 'kiagent.people', origin: 'bundled', enabled: true }]);
    const sync = mk(store, ops);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const act = sync.act(
      async () => {
        await gate;
        ops.local.get('kiagent.people')!.enabled = false;
        return { ok: true };
      },
      () => ({ kind: 'enabled', id: 'kiagent.people', enabled: false }),
    );
    const rec = sync.runFromStore();
    release();
    await act;
    await rec;
    expect(store.get()).toEqual({ 'kiagent.people': { enabled: false } });
    expect(ops.calls).toEqual([]); // reconcile did not flip it back
  });

  it('a failed set write rejects the action, keeps a pending record, and the next reconcile retries it', async () => {
    const store = fakeStore({ 'kiagent.people': { enabled: true } });
    const ops = fakeOps([{ id: 'kiagent.people', origin: 'bundled', enabled: true }]);
    const sync = mk(store, ops);
    store.failNext = true;
    await expect(
      sync.act(
        async () => {
          ops.local.get('kiagent.people')!.enabled = false;
          return { ok: true };
        },
        () => ({ kind: 'enabled', id: 'kiagent.people', enabled: false }),
      ),
    ).rejects.toThrow(/could not be recorded in the extension set/);
    expect(sync.hasPending()).toBe(true);
    expect(store.get()).toEqual({ 'kiagent.people': { enabled: true } });
    await sync.runFromStore();
    expect(sync.hasPending()).toBe(false);
    expect(store.get()).toEqual({ 'kiagent.people': { enabled: false } });
    expect(ops.calls).toEqual([]); // never reverted the user's change
  });

  it('does not record when the local op failed', async () => {
    const store = fakeStore({});
    const sync = mk(store, fakeOps([]));
    const r = await sync.act(async () => ({ ok: false }), () => ({ kind: 'uninstalled', id: 'x' }));
    expect(r.ok).toBe(false);
    expect(store.writes).toBe(0);
  });
});

describe('leader writes the set', () => {
  it('enable and disable rewrite the entry', async () => {
    const store = fakeStore({ 'kiagent.people': { enabled: true } });
    const ops = fakeOps([{ id: 'kiagent.people', origin: 'bundled', enabled: false }]);
    await mk(store, ops).recordEnabled('kiagent.people', false);
    expect(store.get()).toEqual({ 'kiagent.people': { enabled: false } });
  });

  it('install adds the pinned ref; uninstall removes the entry', async () => {
    const store = fakeStore({});
    const sync = mk(store, fakeOps([]));
    await sync.recordInstalled('kia.slack', 'github:kia-plugins/slack@v2');
    expect(store.get()).toEqual({ 'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' } });
    await sync.recordUninstalled('kia.slack');
    expect(store.get()).toEqual({});
  });

  it('first write on a device that never seeded builds the set from local state', async () => {
    const store = fakeStore();
    const ops = fakeOps([
      { id: 'kia.slack', origin: 'marketplace', enabled: true, ref: 'github:kia-plugins/slack@v2' },
      { id: 'kiagent.people', origin: 'bundled', enabled: false, explicit: true },
    ]);
    await mk(store, ops).recordEnabled('kia.slack', false);
    ops.local.get('kia.slack')!.enabled = false;
    expect(store.get()!['kiagent.people']).toEqual({ enabled: false });
    expect(store.get()!['kia.slack'].ref).toBe('github:kia-plugins/slack@v2');
  });

  it('a follower records nothing', async () => {
    const store = fakeStore({}, false);
    await mk(store, fakeOps([])).recordInstalled('kia.slack', 'r');
    expect(store.get()).toEqual({});
  });

  it('a dev install (no marketplace ref) is never recorded', async () => {
    const store = fakeStore({});
    await mk(store, fakeOps([])).recordInstalled('dev.x', undefined);
    expect(store.get()).toEqual({});
  });
});

describe('seeding', () => {
  const local: LocalExtension[] = [
    { id: 'kia.slack', origin: 'marketplace', enabled: true, ref: 'github:kia-plugins/slack@v2' },
    { id: 'kia.notion', origin: 'marketplace', enabled: false, ref: 'github:kia-plugins/notion@v3' },
    { id: 'kiagent.people', origin: 'bundled', enabled: false, explicit: true },
    { id: 'kiagent.mail', origin: 'bundled', enabled: true },
    { id: 'dev.x', origin: 'dev', enabled: true },
  ];

  it('seeds once from local state on a writable device: marketplace with refs, explicit bundled, no dev', async () => {
    const store = fakeStore();
    const sync = mk(store, fakeOps(local));
    await sync.seed();
    expect(store.get()).toEqual({
      'kia.slack': { enabled: true, ref: 'github:kia-plugins/slack@v2' },
      'kia.notion': { enabled: false, ref: 'github:kia-plugins/notion@v3' },
      'kiagent.people': { enabled: false },
    });
  });

  it('never clobbers an existing set', async () => {
    const store = fakeStore({ 'kia.other': { enabled: true, ref: 'r' } });
    await mk(store, fakeOps(local)).seed();
    expect(store.get()).toEqual({ 'kia.other': { enabled: true, ref: 'r' } });
    expect(store.writes).toBe(0);
  });

  it('a follower never seeds', async () => {
    const store = fakeStore(undefined, false);
    await mk(store, fakeOps(local)).seed();
    expect(store.get()).toBeUndefined();
  });

  it('seeds again after a promotion makes it writable', async () => {
    const store = fakeStore(undefined, false);
    const sync = mk(store, fakeOps(local));
    await sync.seed();
    store.writable = true;
    await sync.seed();
    expect(Object.keys(store.get()!)).toContain('kia.slack');
  });
});

/* ---- the platform: leader writes, follower forwards, reconcile through it ---- */
jest.setTimeout(120_000);

describe('platform wiring', () => {
  const FWD = path.join(__dirname, 'fixtures', 'ext-fwd');
  const BASIC = path.join(__dirname, 'fixtures', 'ext-basic');
  const REF = 'github:kia-plugins/basic@v1';
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  let setStore: ReturnType<typeof fakeStore>;
  const sync = { readOnly: jest.fn(), forward: jest.fn(), enqueue: jest.fn(), onApplied: jest.fn() };

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
      sync: sync as never,
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
  beforeEach(() => {
    sync.readOnly.mockReset().mockReturnValue(false);
    sync.forward.mockReset();
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
    expect(setStore.get()).toEqual({});
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
