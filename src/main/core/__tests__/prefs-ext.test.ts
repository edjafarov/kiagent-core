import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPrefs, type UserPrefsStore } from '../prefs';
import { forwardCore, NO_MASTER_MESSAGE, SyncNoMaster } from '../sync/forward-core';

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

describe('extension prefs on CorePrefs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-ext-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  async function make(store: ReturnType<typeof fakeStore>) {
    const p = createPrefs(dir, store);
    await p.ready;
    return p;
  }

  it('setExt on the leader stores the key as given and getExt reads it back', async () => {
    const store = fakeStore();
    const p = await make(store);
    await p.setExt('ext.id.a', { n: 1 });
    expect(store.rows['ext.id.a']).toEqual({ n: 1 });
    expect(p.getExt('ext.id.a')).toEqual({ n: 1 });
    expect(p.getExt('ext.id.missing')).toBeUndefined();
  });

  it('a value that is not JSON is refused before anything is written', async () => {
    const store = fakeStore();
    const p = await make(store);
    await expect(p.setExt('ext.id.a', () => 1)).rejects.toThrow(/JSON/);
    await expect(p.setExt('ext.id.a', undefined)).rejects.toThrow(/JSON/);
    await expect(p.setExt('ext.id.a', { f: () => 1 })).rejects.toThrow(/JSON/);
    expect(store.rows).toEqual({});
  });

  it('refreshUser fires onExtChange once per changed or removed key, with the new value', async () => {
    const store = fakeStore({ 'ext.id.a': 1, 'ext.id.b': 2 });
    const p = await make(store);
    const seen: Array<[string, unknown]> = [];
    p.onExtChange((k, v) => seen.push([k, v]));
    store.rows['ext.id.a'] = 5;
    delete store.rows['ext.id.b'];
    store.rows['ext.id.c'] = 'x';
    await p.refreshUser();
    expect(seen.sort()).toEqual([
      ['ext.id.a', 5],
      ['ext.id.b', undefined],
      ['ext.id.c', 'x'],
    ]);
    await p.refreshUser();
    expect(seen).toHaveLength(3);
  });

  it('core keys changing do not reach onExtChange', async () => {
    const store = fakeStore();
    const p = await make(store);
    const cb = jest.fn();
    p.onExtChange(cb);
    store.rows['core.theme'] = 'dark';
    await p.refreshUser();
    expect(cb).not.toHaveBeenCalled();
  });

  it('a local setExt does not echo to onExtChange; the leader running a forwarded one does', async () => {
    const store = fakeStore();
    const p = await make(store);
    const cb = jest.fn();
    p.onExtChange(cb);
    await p.setExt('ext.id.a', 1);
    expect(cb).not.toHaveBeenCalled();
    await p.setExt('ext.id.a', 2, { notify: true });
    expect(cb).toHaveBeenCalledWith('ext.id.a', 2);
  });

  it('on a follower setExt forwards, resolves once the leader took it, and shows the value at once', async () => {
    const store = fakeStore({}, false);
    const p = await make(store);
    const forwarded: unknown[] = [];
    p.setForwardExt(async (key, value) => {
      forwarded.push({ key, value });
    });
    await p.setExt('ext.id.a', { v: 1 });
    expect(forwarded).toEqual([{ key: 'ext.id.a', value: { v: 1 } }]);
    expect(store.rows).toEqual({});
    expect(p.getExt('ext.id.a')).toEqual({ v: 1 });
  });

  it('on a follower with no leader setExt rejects with the no-master message and keeps nothing', async () => {
    const store = fakeStore({}, false);
    const p = await make(store);
    const sync = { forward: async () => ({ ok: false as const, code: 'no-master', message: 'x' }) };
    p.setForwardExt(async (key, value) => {
      await forwardCore(sync as never, 'prefs:set-ext', { key, value });
    });
    const err = await p.setExt('ext.id.a', 1).catch((e) => e);
    expect(err).toBeInstanceOf(SyncNoMaster);
    expect(err.message).toBe(NO_MASTER_MESSAGE);
    expect(p.getExt('ext.id.a')).toBeUndefined();
  });

  it('on a follower with no leader and a queue set, setExt applies and queues instead of rejecting', async () => {
    const store = fakeStore({}, false);
    const p = await make(store);
    const queued: unknown[] = [];
    p.setOfflineQueue({
      nowMs: () => 0,
      enqueue: async (req, opts) => {
        queued.push({ req, key: opts.coalesceKey });
        return 1;
      },
    });
    const sync = { forward: async () => ({ ok: false as const, code: 'no-master', message: 'x' }) };
    p.setForwardExt(async (key, value) => {
      await forwardCore(sync as never, 'prefs:set-ext', { key, value });
    });
    await p.setExt('ext.id.a', 1);
    expect(queued).toHaveLength(1);
    expect(p.getExt('ext.id.a')).toBe(1);
    expect(store.rows).toEqual({});
  });

  it('a follower the forward feed later overwrites: refresh replaces the optimistic value', async () => {
    const store = fakeStore({}, false);
    const p = await make(store);
    p.setForwardExt(async () => undefined);
    await p.setExt('ext.id.a', 1);
    store.rows['ext.id.a'] = 1;
    const cb = jest.fn();
    p.onExtChange(cb);
    await p.refreshUser();
    expect(p.getExt('ext.id.a')).toBe(1);
    expect(cb).not.toHaveBeenCalled();
  });
});
