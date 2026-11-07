/** @jest-environment node */
/** Step 5 Task 4: the user's extension set (`core.extensions`) and the
 *  per-device reconcile (spec 7.9 rules 7-9), over fake ops: the fast tier.
 *  The same rules on the real platform are in extension-set-platform.test.ts. */
import {
  createExtensionSync,
  needsInstall,
  type ExtensionOps,
  type ExtensionSetStore,
  type LocalExtension,
} from '../extension-set';

import { fakeOps, fakeStore } from './helpers/extension-fakes';

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
    const r = await sync.act(async () => ({ ok: false }), () => ({ kind: 'uninstalled', id: 'x', origin: 'marketplace' }));
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
    await sync.recordUninstalled('kia.slack', 'marketplace');
    expect(store.get()).toEqual({ 'kia.slack': { enabled: false, removed: true } });
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

describe('uninstall follows the user as a tombstone', () => {
  const REF = 'github:kia-plugins/slack@v2';
  const slack = (over: Partial<LocalExtension> = {}): LocalExtension => ({
    id: 'kia.slack', origin: 'marketplace', enabled: true, ref: REF, ...over,
  });

  it('M7: an uninstall on the leader writes a tombstone and every other device uninstalls', async () => {
    const leaderStore = fakeStore({ 'kia.slack': { enabled: true, ref: REF } });
    const leaderOps = fakeOps([slack()]);
    const leader = mk(leaderStore, leaderOps);
    await leader.act(() => leaderOps.uninstall('kia.slack'), () => ({ kind: 'uninstalled', id: 'kia.slack', origin: 'marketplace' }));
    expect(leaderStore.get()).toEqual({ 'kia.slack': { enabled: false, removed: true } });
    const followerOps = fakeOps([slack()]);
    const follower = mk(fakeStore(leaderStore.get(), false), followerOps);
    expect(await follower.runFromStore()).toEqual({ installed: [], failed: [] });
    expect(followerOps.calls).toEqual(['uninstall:kia.slack']);
    expect(followerOps.local.has('kia.slack')).toBe(false);
  });

  it('the guard keeps and disables: a refused raw uninstall becomes setEnabled(false) and a kept report', async () => {
    const ops = fakeOps([slack()]);
    ops.uninstall = async (id) => {
      ops.calls.push(`uninstall:${id}`);
      return { ok: false, error: 'accounts' };
    };
    const r = await mk(fakeStore(), ops).reconcile({ 'kia.slack': { enabled: false, removed: true } });
    expect(ops.calls).toEqual(['uninstall:kia.slack', 'enable:kia.slack:false']);
    expect(r.failed).toEqual([{ id: 'kia.slack', error: 'kept: this device has its accounts' }]);
    expect(ops.local.get('kia.slack')!.enabled).toBe(false);
  });

  it('a kept connector is disabled and reported once: later reconciles with the tombstone standing neither call setEnabled nor log', async () => {
    const logs: string[] = [];
    const ops = fakeOps([slack()]);
    ops.uninstall = async (id) => {
      ops.calls.push(`uninstall:${id}`);
      return { ok: false, error: 'accounts' };
    };
    const sync = createExtensionSync({ store: fakeStore(), ops, log: (m) => logs.push(m) });
    const set = { 'kia.slack': { enabled: false, removed: true as const } };
    await sync.reconcile(set);
    await sync.reconcile(set);
    expect(ops.calls.filter((c) => c.startsWith('enable:'))).toEqual(['enable:kia.slack:false']);
    expect(logs.filter((m) => m.includes('kept'))).toHaveLength(1);
  });

  it('reinstall replaces the tombstone with {enabled:true, ref}', async () => {
    const store = fakeStore({ 'kia.slack': { enabled: false, removed: true } });
    await mk(store, fakeOps([])).recordInstalled('kia.slack', REF);
    expect(store.get()).toEqual({ 'kia.slack': { enabled: true, ref: REF } });
  });

  it('the kept device does not offer it, and union refuses it while the tombstone stands', async () => {
    const store = fakeStore({ 'kia.slack': { enabled: false, removed: true } });
    const sync = mk(store, fakeOps([slack({ enabled: false })]));
    expect(sync.offer()).toEqual({});
    expect(await sync.union({ 'kia.slack': { enabled: true, ref: REF } })).toEqual([]);
    expect(store.get()).toEqual({ 'kia.slack': { enabled: false, removed: true } });
  });

  it('a pending enable meeting a tombstone is discarded and the removal applies', async () => {
    const logs: string[] = [];
    const store = fakeStore({});
    store.update = async () => {
      throw new Error('disk full');
    };
    const ops = fakeOps([slack()]);
    const sync = createExtensionSync({ store, ops, log: (m) => logs.push(m) });
    await sync
      .act(() => ops.setEnabled('kia.slack', true), () => ({ kind: 'enabled', id: 'kia.slack', enabled: true }))
      .catch(() => undefined);
    expect(sync.hasPending()).toBe(true);
    ops.calls.length = 0;
    await sync.reconcile({ 'kia.slack': { enabled: false, removed: true } });
    expect(sync.hasPending()).toBe(false);
    expect(ops.calls).toEqual(['uninstall:kia.slack']);
    expect(logs.some((m) => m.includes('kia.slack'))).toBe(true);
  });

  it('a pending install record wins until recorded', async () => {
    const store = fakeStore({});
    store.update = async () => {
      throw new Error('disk full');
    };
    const ops = fakeOps([slack()]);
    const sync = mk(store, ops);
    await sync
      .act(() => Promise.resolve({ ok: true }), () => ({ kind: 'installed', id: 'kia.slack', ref: REF }))
      .catch(() => undefined);
    expect(sync.hasPending()).toBe(true);
    await sync.reconcile({ 'kia.slack': { enabled: false, removed: true } });
    expect(ops.calls).toEqual([]);
    expect(sync.hasPending()).toBe(true);
  });

  it('a refused raw uninstall on the leader writes no tombstone', async () => {
    const store = fakeStore({ 'kia.slack': { enabled: true, ref: REF } });
    const sync = mk(store, fakeOps([slack()]));
    await sync.act(
      async () => ({ ok: false }),
      () => ({ kind: 'uninstalled', id: 'kia.slack', origin: 'marketplace' }),
    );
    expect(store.get()).toEqual({ 'kia.slack': { enabled: true, ref: REF } });
    expect(store.writes).toBe(0);
  });

  it('a dev-origin uninstall writes nothing', async () => {
    const store = fakeStore({});
    const sync = mk(store, fakeOps([]));
    await sync.act(
      async () => ({ ok: true }),
      () => ({ kind: 'uninstalled', id: 'dev.x', origin: 'dev' }),
    );
    expect(store.get()).toEqual({});
    expect(store.writes).toBe(0);
  });

  it('a tombstone for an id this device never installed calls nothing and offers nothing', async () => {
    const store = fakeStore({ 'kia.slack': { enabled: false, removed: true } });
    const ops = fakeOps([]);
    const sync = mk(store, ops);
    const r = await sync.reconcile(store.get()!);
    expect(r).toEqual({ installed: [], failed: [] });
    expect(ops.calls).toEqual([]);
    expect(sync.offer()).toEqual({});
  });

  it('a tombstone that carries a ref still installs nothing on a device without it', async () => {
    const ops = fakeOps([]);
    const r = await mk(fakeStore(), ops).reconcile({ 'kia.slack': { enabled: false, ref: REF, removed: true } });
    expect(ops.calls).toEqual([]);
    expect(r).toEqual({ installed: [], failed: [] });
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
