/** @jest-environment node */
/** Phase 6c Task 2: settings changed with no leader apply at once, wait in the
 *  queue, and show over the table until the leader's feed supersedes them. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPrefs, type CorePrefs, type OfflineQueue, type UserPrefsStore } from '../prefs';
import { SyncNoMaster } from '../sync/forward-core';
import type { ForwardRequest } from '../sync/service';
import type { QueuedSetting } from '../sync/settings-queue';

function fakeStore(initial: Record<string, unknown> = {}, writable = true) {
  const rows: Record<string, unknown> = { ...initial };
  const s: UserPrefsStore & { rows: Record<string, unknown>; writable: boolean } = {
    rows,
    writable,
    all: async () => JSON.parse(JSON.stringify(rows)),
    set: async (k, v) => {
      rows[k] = v;
    },
    canWrite: () => s.writable,
  };
  return s;
}

interface Row {
  rowId: number;
  key: string;
  req: ForwardRequest;
}
function fakeQueue() {
  const rows: Row[] = [];
  const clock = { now: 1000 };
  let id = 0;
  const q: OfflineQueue & { rows: Row[]; clock: { now: number } } = {
    rows,
    clock,
    nowMs: () => clock.now,
    enqueue: async (req, opts) => {
      const i = rows.findIndex((r) => r.key === opts.coalesceKey);
      if (i >= 0) rows.splice(i, 1);
      id += 1;
      rows.push({ rowId: id, key: opts.coalesceKey, req });
      return id;
    },
    discard: async (rowId) => {
      const i = rows.findIndex((r) => r.rowId === rowId);
      if (i >= 0) rows.splice(i, 1);
    },
  };
  return q;
}

const noMaster = async (): Promise<void> => {
  throw new SyncNoMaster();
};

describe('the offline queue overlay', () => {
  let dir: string;
  const made: string[] = [];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-overlay-'));
    made.push(dir);
  });
  afterAll(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  async function follower(initial: Record<string, unknown> = {}, withQueue = true) {
    const store = fakeStore(initial, false);
    const p = createPrefs(dir, store);
    await p.ready;
    const queue = fakeQueue();
    p.setForwardUser(noMaster);
    p.setForwardExt(noMaster);
    if (withQueue) p.setOfflineQueue(queue);
    return { p, store, queue };
  }

  it('with no leader a user-key patch applies, queues one row with the full merged value, and resolves', async () => {
    const { p, queue } = await follower({
      'core.outbound': { defaultMode: 'link', extra: 1 },
    });
    await p.patch({ outbound: { defaultMode: 'chat' } });
    expect(p.get().outbound.defaultMode).toBe('chat');
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0].key).toBe('core.outbound');
    expect(queue.rows[0].req).toEqual({
      kind: 'core',
      name: 'prefs:patch',
      payload: { outbound: p.get().outbound },
    });
    expect((queue.rows[0].req.payload as { outbound: unknown }).outbound).toEqual({ defaultMode: 'chat' });
  });

  it('a nested merge builds on the queued value, not the table', async () => {
    const { p, queue } = await follower();
    await p.patch({ features: { a: true } });
    await p.patch({ features: { b: true } });
    expect(p.get().features).toEqual({ a: true, b: true });
    expect(queue.rows).toHaveLength(1);
    expect((queue.rows[0].req.payload as { features: unknown }).features).toEqual({ a: true, b: true });
  });

  it('a patch of theme and outbound queues two rows keyed core.theme and core.outbound', async () => {
    const { p, queue } = await follower();
    await p.patch({ theme: 'dark', outbound: { defaultMode: 'chat' } });
    expect(queue.rows.map((r) => r.key).sort()).toEqual(['core.outbound', 'core.theme']);
    expect(p.get().theme).toBe('dark');
  });

  it('a user part and a device part of one patch: device applied, user queued, nothing half-written', async () => {
    const { p, store, queue } = await follower();
    await p.patch({ launchAtLogin: false, theme: 'dark' });
    expect(p.get().launchAtLogin).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8')).launchAtLogin).toBe(false);
    expect(queue.rows.map((r) => r.key)).toEqual(['core.theme']);
    expect(store.rows).toEqual({});
  });

  it('a patch emits onChange once for the queued value', async () => {
    const { p } = await follower();
    const seen: string[] = [];
    p.onChange((v) => seen.push(v.theme));
    await p.patch({ theme: 'dark' });
    expect(seen).toEqual(['dark']);
  });

  it('setExt with no leader queues kiagent.meetings.summaryInstructions with the whole value', async () => {
    const { p, queue } = await follower();
    await p.setExt('kiagent.meetings.summaryInstructions', { text: 'be brief', n: 2 });
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0].key).toBe('kiagent.meetings.summaryInstructions');
    expect(queue.rows[0].req).toEqual({
      kind: 'core',
      name: 'prefs:set-ext',
      payload: { key: 'kiagent.meetings.summaryInstructions', value: { text: 'be brief', n: 2 } },
    });
    expect(p.getExt('kiagent.meetings.summaryInstructions')).toEqual({ text: 'be brief', n: 2 });
  });

  it('queueExtensionEnabled keys core.extensions.<id> and getCore("core.extensions") shows the merged object including a missing table', async () => {
    const { p, queue } = await follower();
    expect(p.getCore('core.extensions')).toBeUndefined();
    await p.queueExtensionEnabled('a.b', true);
    expect(queue.rows[0].key).toBe('core.extensions.a.b');
    expect(queue.rows[0].req).toEqual({
      kind: 'core',
      name: 'extension:set-enabled',
      payload: { id: 'a.b', enabled: true },
    });
    expect(p.getCore('core.extensions')).toEqual({ 'a.b': { enabled: true } });
  });

  it('queueExtensionEnabled merges over a table entry and keeps its ref', async () => {
    const { p } = await follower({ 'core.extensions': { x: { enabled: true, ref: 'r1' }, y: { enabled: true } } });
    await p.queueExtensionEnabled('x', false);
    expect(p.getCore('core.extensions')).toEqual({ x: { enabled: false, ref: 'r1' }, y: { enabled: true } });
  });

  it('a handler refusal (not no-master) rethrows and queues nothing', async () => {
    const { p, queue } = await follower();
    p.setForwardUser(async () => {
      throw new Error('bad value');
    });
    p.setForwardExt(async () => {
      throw new Error('bad value');
    });
    await expect(p.patch({ theme: 'dark' })).rejects.toThrow('bad value');
    await expect(p.setExt('x.y', 1)).rejects.toThrow('bad value');
    expect(queue.rows).toEqual([]);
    expect(p.get().theme).toBe('system');
  });

  it('with no queue set the old rejection is unchanged', async () => {
    const { p } = await follower({}, false);
    await expect(p.patch({ theme: 'dark' })).rejects.toBeInstanceOf(SyncNoMaster);
    await expect(p.setExt('x.y', 1)).rejects.toBeInstanceOf(SyncNoMaster);
    expect(p.get().theme).toBe('system');
    expect(p.getExt('x.y')).toBeUndefined();
  });

  it('refreshUser does not flip a queued key back', async () => {
    const { p, store } = await follower({ 'core.theme': 'light' });
    await p.patch({ theme: 'dark' });
    store.rows['core.other'] = 1;
    await p.refreshUser();
    expect(p.get().theme).toBe('dark');
    await p.refreshUser({ prefKeys: ['core.theme'], pullStartedAt: 5000 });
    expect(p.get().theme).toBe('dark'); // the overlay is only dropped by an ack
  });

  it('restoreQueued rebuilds the overlay from rows', async () => {
    const { p } = await follower();
    const rows: QueuedSetting[] = [
      { rowId: 4, key: 'core.theme', value: 'dark', stuck: false },
      { rowId: 5, key: 'a.b', value: 7, stuck: false },
      { rowId: 6, key: 'core.extensions.z', value: true, stuck: false },
    ];
    p.restoreQueued(rows);
    expect(p.get().theme).toBe('dark');
    expect(p.getExt('a.b')).toBe(7);
    expect(p.getCore('core.extensions')).toEqual({ z: { enabled: true } });
  });

  it('ack of the row that owns the entry: entry dropped, value held as optimistic', async () => {
    const { p, queue } = await follower();
    await p.patch({ theme: 'dark' });
    const { rowId } = queue.rows[0];
    queue.rows.length = 0;
    p.onQueueChange({ kind: 'delivered', rowId, coalesceKey: 'core.theme' });
    expect(p.get().theme).toBe('dark');
  });

  it('ack of an older in-flight row does not clear a newer queued edit', async () => {
    const { p, queue } = await follower();
    await p.patch({ theme: 'dark' });
    const n = queue.rows[0].rowId;
    await p.patch({ theme: 'light' });
    const m = queue.rows[0].rowId;
    expect(m).toBeGreaterThan(n);
    p.onQueueChange({ kind: 'delivered', rowId: n, coalesceKey: 'core.theme' });
    expect(p.get().theme).toBe('light');
    // and it is still an overlay: an ack of M then holds M's value
    p.onQueueChange({ kind: 'delivered', rowId: m, coalesceKey: 'core.theme' });
    expect(p.get().theme).toBe('light');
  });

  it('ack of a row whose entry is gone is a no-op', async () => {
    const { p } = await follower();
    const seen = jest.fn();
    p.onChange(seen);
    p.onQueueChange({ kind: 'delivered', rowId: 99, coalesceKey: 'core.theme' });
    p.onQueueChange({ kind: 'discarded', rowId: 99, coalesceKey: 'core.theme' });
    expect(seen).not.toHaveBeenCalled();
    expect(p.get().theme).toBe('system');
  });

  it('a delta from a pull started before the ack leaves the optimistic value; from a pull started after the ack releases it', async () => {
    const { p, queue, store } = await follower({ 'core.theme': 'light' });
    await p.patch({ theme: 'dark' });
    queue.clock.now = 2000;
    p.onQueueChange({ kind: 'delivered', rowId: queue.rows[0].rowId, coalesceKey: 'core.theme' });
    // the leader's feed has not caught up: the table still says light
    await p.refreshUser({ prefKeys: ['core.theme'], pullStartedAt: 1500 });
    expect(p.get().theme).toBe('dark');
    store.rows['core.theme'] = 'dark';
    await p.refreshUser({ prefKeys: ['core.theme'], pullStartedAt: 2500 });
    expect(p.get().theme).toBe('dark');
    store.rows['core.theme'] = 'light'; // someone else changed it later
    await p.refreshUser({ prefKeys: ['core.theme'], pullStartedAt: 3000 });
    expect(p.get().theme).toBe('light');
  });

  it('a core.extensions delta releases the core.extensions.<id> optimistic entries', async () => {
    const { p, queue, store } = await follower({ 'core.extensions': { a: { enabled: false } } });
    await p.queueExtensionEnabled('a', true);
    queue.clock.now = 2000;
    p.onQueueChange({ kind: 'delivered', rowId: queue.rows[0].rowId, coalesceKey: 'core.extensions.a' });
    expect(p.getCore('core.extensions')).toEqual({ a: { enabled: true } });
    await p.refreshUser({ prefKeys: ['core.theme'], pullStartedAt: 3000 });
    expect(p.getCore('core.extensions')).toEqual({ a: { enabled: true } });
    store.rows['core.extensions'] = { a: { enabled: false } };
    await p.refreshUser({ prefKeys: ['core.extensions'], pullStartedAt: 3000 });
    expect(p.getCore('core.extensions')).toEqual({ a: { enabled: false } });
  });

  it('meta without pullStartedAt releases nothing', async () => {
    const { p, queue, store } = await follower({ 'core.theme': 'light' });
    await p.patch({ theme: 'dark' });
    queue.clock.now = 2000;
    p.onQueueChange({ kind: 'delivered', rowId: queue.rows[0].rowId, coalesceKey: 'core.theme' });
    await p.refreshUser({ prefKeys: ['core.theme'] });
    await p.refreshUser();
    expect(p.get().theme).toBe('dark');
    expect(store.rows['core.theme']).toBe('light');
  });

  it('on a leader (canWrite) an ack drops the overlay and keeps no optimistic value', async () => {
    const { p, queue, store } = await follower({ 'core.theme': 'light' });
    await p.patch({ theme: 'dark' });
    store.writable = true; // promotion
    p.onQueueChange({ kind: 'delivered', rowId: queue.rows[0].rowId, coalesceKey: 'core.theme' });
    expect(p.get().theme).toBe('light');
    store.rows['core.theme'] = 'dark'; // the drain ran the row as the leader
    await p.refreshUser();
    expect(p.get().theme).toBe('dark');
  });

  it('discard drops the entry and the control shows the table value; an extension key fires onExtChange', async () => {
    const { p, queue } = await follower({ 'core.theme': 'light', 'a.b': 1 });
    await p.patch({ theme: 'dark' });
    await p.setExt('a.b', 2);
    const cb = jest.fn();
    p.onExtChange(cb);
    for (const r of [...queue.rows]) p.onQueueChange({ kind: 'discarded', rowId: r.rowId, coalesceKey: r.key });
    expect(p.get().theme).toBe('light');
    expect(p.getExt('a.b')).toBe(1);
    expect(cb).toHaveBeenCalledWith('a.b', 1);
  });

  it('reconcile input: getCore overlays a queued enable so extension-set reconcile does not revert it', async () => {
    const { p } = await follower({ 'core.extensions': { a: { enabled: false } } });
    await p.queueExtensionEnabled('a', true);
    await p.refreshUser({ prefKeys: [], pullStartedAt: 9999 });
    expect((p.getCore('core.extensions') as Record<string, { enabled: boolean }>).a.enabled).toBe(true);
  });

  it('an online edit of a key with an optimistic entry shows the new value at once', async () => {
    const { p, queue } = await follower({ 'core.theme': 'light' });
    await p.patch({ theme: 'dark' });
    p.onQueueChange({ kind: 'delivered', rowId: queue.rows[0].rowId, coalesceKey: 'core.theme' });
    p.setForwardUser(async () => undefined);
    p.setForwardExt(async () => undefined);
    await p.setExt('a.b', 1);
    p.onQueueChange({ kind: 'delivered', rowId: 99, coalesceKey: 'a.b' });
    await p.patch({ theme: 'system' });
    expect(p.get().theme).toBe('system');
  });

  it('an online edit of an extension key with an optimistic entry shows the new value at once', async () => {
    const { p, queue } = await follower();
    await p.setExt('a.b', 1);
    p.onQueueChange({ kind: 'delivered', rowId: queue.rows[0].rowId, coalesceKey: 'a.b' });
    expect(p.getExt('a.b')).toBe(1);
    p.setForwardExt(async () => undefined);
    await p.setExt('a.b', 2);
    expect(p.getExt('a.b')).toBe(2);
  });

  it('an online edit of a key with a queued row replaces the row instead of forwarding', async () => {
    const { p, queue } = await follower();
    await p.patch({ theme: 'dark' });
    const first = queue.rows[0].rowId;
    const fwd = jest.fn(async () => undefined);
    p.setForwardUser(fwd);
    p.setForwardExt(fwd);
    await p.patch({ theme: 'light' });
    expect(fwd).not.toHaveBeenCalled();
    expect(queue.rows).toHaveLength(1);
    expect(queue.rows[0].rowId).toBeGreaterThan(first);
    expect((queue.rows[0].req.payload as { theme: string }).theme).toBe('light');
    expect(p.get().theme).toBe('light');
    p.setForwardExt(noMaster);
    await p.setExt('a.b', 1);
    p.setForwardExt(fwd);
    await p.setExt('a.b', 2);
    expect(fwd).not.toHaveBeenCalled();
    expect(queue.rows.filter((r) => r.key === 'a.b')).toHaveLength(1);
    expect(p.getExt('a.b')).toBe(2);
    expect(p.hasQueued('a.b')).toBe(true);
    expect(p.hasQueued('zzz')).toBe(false);
  });

  it('an acknowledged optimistic value does not survive promotion', async () => {
    const { p, queue, store } = await follower({ 'core.theme': 'system' });
    await p.patch({ theme: 'dark' });
    p.onQueueChange({ kind: 'delivered', rowId: queue.rows[0].rowId, coalesceKey: 'core.theme' });
    expect(p.get().theme).toBe('dark');
    store.writable = true; // promoted before any delta arrived
    await p.seedUser();
    expect(p.get().theme).toBe('system'); // the local table is authoritative now
    await p.patch({ theme: 'light' });
    expect(p.get().theme).toBe('light');
    expect(store.rows['core.theme']).toBe('light');
  });

  it('a promoted leader\'s own theme write shows, survives, and the stale queued row is gone', async () => {
    const { p, queue, store } = await follower({ 'core.theme': 'system' });
    await p.patch({ theme: 'dark' });
    expect(queue.rows).toHaveLength(1);
    store.writable = true; // promoted; the drain has not run yet
    await p.seedUser();
    await p.patch({ theme: 'light' });
    expect(p.get().theme).toBe('light');
    expect(store.rows['core.theme']).toBe('light');
    // Nothing stale is left for the drain to deliver over it.
    expect(queue.rows).toEqual([]);
    p.onQueueChange({ kind: 'delivered', rowId: 1, coalesceKey: 'core.theme' });
    expect(p.get().theme).toBe('light');
  });

  it('a promoted leader\'s own extension setting write drops the queued one', async () => {
    const { p, queue, store } = await follower();
    await p.setExt('a.b', 1);
    store.writable = true;
    await p.seedUser();
    await p.setExt('a.b', 2);
    expect(p.getExt('a.b')).toBe(2);
    expect(queue.rows).toEqual([]);
  });

  it('a promoted leader\'s own extension switch is not shadowed by the queued one', async () => {
    const { p, queue, store } = await follower({ 'core.extensions': { z: { enabled: false, ref: 'r' } } });
    await p.queueExtensionEnabled('z', true);
    store.writable = true;
    await p.seedUser();
    await p.updateCore('core.extensions', (cur) => ({
      ...(cur as Record<string, object>),
      z: { enabled: false, ref: 'r' },
      y: { enabled: true },
    }));
    expect((p.getCore('core.extensions') as Record<string, { enabled: boolean }>).z.enabled).toBe(false);
    expect(queue.rows).toEqual([]);
  });

  it('a queued switch the leader did not touch keeps waiting for its delivery', async () => {
    const { p, queue, store } = await follower({ 'core.extensions': {} });
    await p.queueExtensionEnabled('z', true);
    store.writable = true;
    await p.seedUser();
    await p.updateCore('core.extensions', (cur) => ({ ...(cur as object), y: { enabled: true } }));
    expect(queue.rows.map((r) => r.key)).toEqual(['core.extensions.z']);
    expect((p.getCore('core.extensions') as Record<string, { enabled: boolean }>).z.enabled).toBe(true);
  });

  it('a stuck row does not shadow the table on a leader', async () => {
    const { p, store } = await follower({ 'core.theme': 'system', 'a.b': 1 });
    p.restoreQueued([
      { rowId: 4, key: 'core.theme', value: 'dark', stuck: true },
      { rowId: 5, key: 'a.b', value: 7, stuck: true },
    ]);
    expect(p.get().theme).toBe('dark'); // a follower keeps showing what it asked for
    store.writable = true;
    await p.seedUser();
    expect(p.get().theme).toBe('system');
    expect(p.getExt('a.b')).toBe(1);
  });

  it('restoreQueued keeps a newer entry and takes a newer row', async () => {
    const { p } = await follower();
    p.restoreQueued([{ rowId: 8, key: 'core.theme', value: 'dark', stuck: false }]);
    p.restoreQueued([{ rowId: 3, key: 'core.theme', value: 'light', stuck: false }]);
    expect(p.get().theme).toBe('dark');
    p.restoreQueued([{ rowId: 9, key: 'core.theme', value: 'light', stuck: false }]);
    expect(p.get().theme).toBe('light');
  });

  it('two copies offline, A then B reach the leader: B wins, also over a value the leader changed meanwhile', async () => {
    const leaderStore = fakeStore({}, true);
    const leaderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-leader-'));
    made.push(leaderDir);
    const leader = createPrefs(leaderDir, leaderStore);
    await leader.ready;
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-a-'));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-b-'));
    made.push(dirA, dirB);
    const mk = async (d: string) => {
      const p = createPrefs(d, fakeStore({}, false));
      await p.ready;
      const queue = fakeQueue();
      p.setForwardUser(noMaster);
      p.setOfflineQueue(queue);
      return { p, queue };
    };
    const A = await mk(dirA);
    const B = await mk(dirB);
    await A.p.patch({ theme: 'dark', outbound: { defaultMode: 'chat' } });
    await B.p.patch({ theme: 'light' });
    const deliver = async (q: ReturnType<typeof fakeQueue>): Promise<void> => {
      for (const r of q.rows.splice(0)) await leader.patch(r.req.payload as never);
    };
    await deliver(A.queue);
    await leader.patch({ theme: 'dark' }); // changed meanwhile
    await deliver(B.queue);
    expect(leader.get().theme).toBe('light');
    expect(leader.get().outbound.defaultMode).toBe('chat');
  });

  it('a pull that started before the forward and applies after it does not flip the control back', async () => {
    const { p, store, queue } = await follower({ 'core.theme': 'light' });
    p.setForwardUser(async () => undefined);
    queue.clock.now = 100;
    await p.patch({ theme: 'dark' });
    expect(p.get().theme).toBe('dark');
    await p.refreshUser({ prefKeys: ['core.theme'], pullStartedAt: 50 });
    expect(p.get().theme).toBe('dark');
    store.rows['core.theme'] = 'light';
    await p.refreshUser({ prefKeys: ['core.theme'], pullStartedAt: 150 });
    expect(p.get().theme).toBe('light');
  });

  it('a stored null is shown (presence)', async () => {
    const { p } = await follower();
    p.setForwardExt(async () => undefined);
    await p.setExt('a.b', null);
    expect(p.getExt('a.b')).toBeNull();
  });

  it('M3: a restart between an ack and its pull drops the ack', async () => {
    const { p, store } = await follower({ 'core.theme': 'light' });
    p.setForwardUser(async () => undefined);
    await p.patch({ theme: 'dark' });
    expect(p.get().theme).toBe('dark');
    const p2 = createPrefs(dir, store);
    await p2.ready;
    expect(p2.get().theme).toBe('light');
  });
});
