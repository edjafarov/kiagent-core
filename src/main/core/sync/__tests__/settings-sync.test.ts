/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { createDbUserPrefsStore, createPrefs, type OfflineQueue, type UserPrefsStore } from '../../prefs';
import { SyncNoMaster } from '../forward-core';
import { migrate } from '../../store/schema';
import { openStore } from '../../store/store';
import { leadProc } from './lead-proc';
import { readGateSync } from '../role';
import { createSyncService } from '../service';
import { forwardOrQueue, installSettingsSync, type ForwardOrQueueOp } from '../settings-sync';

let db: AppDb | undefined;
let dir = '';
afterEach(async () => {
  jest.useRealTimers();
  await db?.close();
  db = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

it('installSettingsSync wires the same things main did', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-sync-'));
  db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  db._conn!.prepare(`UPDATE sync_state SET role = 'follower'`).run();
  (db as unknown as { proc: unknown }).proc = leadProc(() => db!._conn!);
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  });
  const svc = createSyncService({
    bootGate: readGateSync(db._conn!),
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    log: () => undefined,
  });
  const prefs = createPrefs(path.join(dir, 'prefs'), createDbUserPrefsStore(db, () => !svc.readOnly()));
  await prefs.ready;
  const extensions = {
    reconcileExtensions: jest.fn(async () => undefined),
    failedExtensions: jest.fn(() => [{ id: 'x' }]),
    hasPendingExtensionRecords: jest.fn(() => false),
    offerExtensions: jest.fn(() => ({})),
    unionExtensions: jest.fn(async () => []),
  };
  const syncExtensions = jest.fn(async () => undefined);
  let captured: ((t: string[], m: object) => void) | undefined;
  const sync = {
    ...svc,
    onApplied: (cb: never) => {
      captured = cb;
      return svc.onApplied(cb);
    },
  };
  const settings = installSettingsSync({
    prefs,
    sync: sync as never,
    extensions: extensions as never,
    handlers: { 'prefs:patch': (r) => prefs.patch(r as never) },
    afterPromote: () => undefined,
    syncExtensions,
    onNoMaster: () => undefined,
    log: () => undefined,
    retryEveryMs: 1000,
    nowMs: Date.now,
    setInterval: setInterval,
  });

  // A prefs:patch on a follower with no leader lands in sync_outbound.
  await settings.forwardedLocal.get('prefs:patch')!({ theme: 'dark' });
  expect(db._conn!.prepare(`SELECT kind FROM sync_outbound`).all()).toEqual([{ kind: 'prefs:patch' }]);

  // onApplied(['user_prefs']) refreshes prefs, then reconciles once.
  const refresh = jest.spyOn(prefs, 'refreshUser');
  captured!(['user_prefs'], {});
  await jest.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(extensions.reconcileExtensions).toHaveBeenCalledTimes(1);

  // The retry timer calls syncExtensions when a connector failed.
  syncExtensions.mockClear();
  jest.advanceTimersByTime(1000);
  expect(syncExtensions).toHaveBeenCalledTimes(1);

  // The core runner applies prefs:set-ext with notify.
  const setExt = jest.spyOn(prefs, 'setExt');
  await settings.coreRunner('prefs:set-ext', { key: 'kiagent.x.y', value: 1 });
  expect(setExt).toHaveBeenCalledWith('kiagent.x.y', 1, { notify: true });
});

describe('forwardOrQueue', () => {
  function op(over: Partial<ForwardOrQueueOp> = {}) {
    const rows = new Map<string, { id: number; n: number }>();
    let id = 0;
    const calls = { forward: 0, enqueue: [] as string[], forwarded: 0, queued: [] as string[] };
    const o: ForwardOrQueueOp = {
      keys: ['a'],
      isHeld: () => false,
      forward: async () => {
        calls.forward += 1;
        const e = new Error('no master') as Error & { code: string };
        e.code = 'EXT_SYNC_NO_MASTER';
        throw e;
      },
      enqueue: async (k) => {
        calls.enqueue.push(k);
        id += 1;
        rows.set(k, { id, n: (rows.get(k)?.n ?? 0) + 1 });
        return id;
      },
      apply: { forwarded: () => void (calls.forwarded += 1), queued: (k) => void calls.queued.push(k) },
      ...over,
    };
    return { o, calls, rows };
  }

  it('a multi-key patch with one held key queues every touched key with its complete merged value and forwards nothing', async () => {
    const { o, calls } = op({ keys: ['core.theme', 'core.outbound'], isHeld: (k) => k === 'core.outbound' });
    expect(await forwardOrQueue(o)).toBe('queued');
    expect(calls.forward).toBe(0);
    expect(calls.enqueue).toEqual(['core.theme', 'core.outbound']);
    expect(calls.queued).toEqual(['core.theme', 'core.outbound']);
  });

  it('a switch whose local op fails is not queued', async () => {
    const { o, calls } = op({ runLocal: async () => ({ ok: false }) });
    expect(await forwardOrQueue(o)).toBe('local-failed');
    expect(calls.enqueue).toEqual([]);
    expect(calls.queued).toEqual([]);
  });

  it('a held ext key replaces its row', async () => {
    const { o, calls, rows } = op({ keys: ['kiagent.x'], isHeld: (k) => rows.has(k) });
    expect(await forwardOrQueue(o)).toBe('queued');
    expect(await forwardOrQueue(o)).toBe('queued');
    expect(calls.forward).toBe(1);
    expect(rows.get('kiagent.x')).toEqual({ id: 2, n: 2 });
  });

  it('a successful forward applies forwarded; any other error rethrows', async () => {
    const ok = op({ forward: async () => undefined });
    expect(await forwardOrQueue(ok.o)).toBe('forwarded');
    expect(ok.calls.forwarded).toBe(1);
    const bad = op({ forward: async () => { throw new Error('refused'); } });
    await expect(forwardOrQueue(bad.o)).rejects.toThrow('refused');
    expect(bad.calls.enqueue).toEqual([]);
  });
});

describe('settings on a copy through the real prefs', () => {
  function copy() {
    const rows: Record<string, unknown> = {};
    const store: UserPrefsStore = {
      all: async () => JSON.parse(JSON.stringify(rows)),
      set: async (k, v) => void (rows[k] = v),
      canWrite: () => false,
    };
    const queued: { key: string; payload: unknown }[] = [];
    const clock = { now: 100 };
    const queue: OfflineQueue = {
      nowMs: () => clock.now,
      enqueue: async (req, o) => {
        queued.push({ key: o.coalesceKey, payload: req.payload });
        return queued.length;
      },
    };
    return { rows, store, queued, clock, queue };
  }
  let tmp = '';
  afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

  it('a multi-key patch with one held key queues each key with its complete merged value (real prefs)', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-sync-multi-'));
    const c = copy();
    c.rows['core.outbound'] = { defaultMode: 'link', extra: 1 };
    const prefs = createPrefs(tmp, c.store);
    await prefs.ready;
    const fwd = jest.fn(async () => undefined);
    prefs.setOfflineQueue(c.queue);
    prefs.setForwardUser(async () => {
      throw new SyncNoMaster();
    });
    await prefs.patch({ outbound: { defaultMode: 'chat' } });
    prefs.setForwardUser(fwd);
    await prefs.patch({ theme: 'dark', outbound: { defaultMode: 'link' } });
    expect(fwd).not.toHaveBeenCalled();
    const last = c.queued.slice(-2);
    expect(last.map((q) => q.key)).toEqual(['core.theme', 'core.outbound']);
    expect(last[0].payload).toEqual({ theme: 'dark' });
    expect(last[1].payload).toEqual({ outbound: prefs.get().outbound });
    expect((last[1].payload as { outbound: Record<string, unknown> }).outbound).toMatchObject({ defaultMode: 'link' });
  });

  it('a forwarded switch shows until a pull that started after it lands', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-sync-switch-'));
    const c = copy();
    c.rows['core.extensions'] = { a: { enabled: false } };
    const prefs = createPrefs(tmp, c.store);
    await prefs.ready;
    prefs.setOfflineQueue(c.queue);
    const handlers: Record<string, (r: unknown) => unknown> = { 'extension:set-enabled': async () => ({ ok: true }) };
    installSettingsSync({
      prefs,
      sync: {
        forward: async () => ({ ok: true, value: { ok: true } }),
        readOnly: () => true,
        enqueue: c.queue.enqueue,
        onQueueChange: () => undefined,
        discardQueued: async () => undefined,
        onApplied: () => () => undefined,
        setSettingsOffer: () => undefined,
        queuedSettings: async () => [],
      } as never,
      extensions: {
        reconcileExtensions: async () => undefined,
        failedExtensions: () => [],
        hasPendingExtensionRecords: () => false,
        offerExtensions: () => ({}),
        unionExtensions: async () => [],
      } as never,
      handlers,
      afterPromote: () => undefined,
      syncExtensions: async () => undefined,
      onNoMaster: () => undefined,
      log: () => undefined,
      retryEveryMs: 1000,
      nowMs: () => c.clock.now,
      setInterval: (() => ({ unref: () => undefined })) as never,
    });
    const view = () => (prefs.getCore('core.extensions') as Record<string, { enabled: boolean }>).a.enabled;
    await handlers['extension:set-enabled']({ id: 'a', enabled: true });
    expect(view()).toBe(true);
    await prefs.refreshUser({ prefKeys: ['core.extensions'], pullStartedAt: 50 });
    expect(view()).toBe(true);
    await prefs.refreshUser({ prefKeys: ['core.extensions'], pullStartedAt: 150 });
    expect(view()).toBe(false);
  });
});
