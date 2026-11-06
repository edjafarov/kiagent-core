/** @jest-environment node */
/** Step 3 Task 1: the forwarding point and the durable delivery queue
 *  (alpha-cent spec 7.8, r16 rulings 3 and 8). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { leadProc } from './lead-proc';
import { LOCAL_CORE_TABLES } from '../tables';
import { userPrefRequest } from '../settings-queue';
import { readSyncStatus } from '../status';
import {
  createSyncService,
  type ForwardRequest,
  type SyncService,
} from '../service';
import { readGateSync } from '../role';

interface Device {
  dir: string;
  db: AppDb;
  store: CoreStore;
  svc: SyncService;
  conn: () => import('better-sqlite3').Database;
}
const devices: Device[] = [];

async function device(
  follower = false,
  extra: {
    nowMs?: () => number;
    fencedAtBoot?: boolean;
    log?: (l: 'info' | 'warn' | 'error', m: string) => void;
  } = {},
): Promise<Device> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-outbound-'));
  const db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  });
  const conn = () => db._conn!;
  // The worker thread is the only thing missing in-process.
  (db as unknown as { proc: unknown }).proc = leadProc(conn);
  if (follower) conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();
  // An old master wakes with tracking on.
  if (extra.fencedAtBoot)
    conn().prepare(`UPDATE sync_state SET tracking = 1, joined = 1`).run();
  const svc = createSyncService({
    bootGate: readGateSync(conn()),
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    log: extra.log ?? (() => undefined),
    nowMs: extra.nowMs,
  });
  const d = { dir, db, store, svc, conn };
  devices.push(d);
  return d;
}
const ui = (name: string, payload: unknown = {}): ForwardRequest => ({
  kind: 'ui',
  extensionId: 'test.ext',
  name,
  payload,
});
const rows = (d: Device) =>
  d
    .conn()
    .prepare(
      `SELECT kind, extension_id, attempts FROM sync_outbound ORDER BY id`,
    )
    .all();

afterEach(async () => {
  for (const d of devices.splice(0)) {
    await d.db.close();
    fs.rmSync(d.dir, { recursive: true, force: true });
  }
});

describe('forwarding', () => {
  it('with no forwarder a follower gets no-master', async () => {
    const d = await device();
    await expect(d.svc.forward(ui('save'))).resolves.toMatchObject({
      ok: false,
      code: 'no-master',
    });
  });

  it('forward hands the request to the forwarder and returns its answer', async () => {
    const d = await device();
    const seen: ForwardRequest[] = [];
    d.svc.setForwarder(async (r) => {
      seen.push(r);
      return { ok: true, value: 7 };
    });
    await expect(d.svc.forward(ui('save', { id: 1 }))).resolves.toEqual({
      ok: true,
      value: 7,
    });
    expect(seen).toEqual([ui('save', { id: 1 })]);
  });

  it('a throwing forwarder is no-master, never an exception', async () => {
    const d = await device();
    d.svc.setForwarder(async () => {
      throw new Error('socket hang up');
    });
    await expect(d.svc.forward(ui('save'))).resolves.toMatchObject({
      ok: false,
      code: 'no-master',
    });
  });

  it('runForwarded on a follower answers no-master and runs nothing', async () => {
    const d = await device(true);
    const runUi = jest.fn();
    d.svc.setRunners({ ui: runUi, core: jest.fn(), commit: jest.fn() });
    await expect(d.svc.runForwarded(ui('save'))).resolves.toMatchObject({
      ok: false,
      code: 'no-master',
    });
    expect(runUi).not.toHaveBeenCalled();
  });

  it('runForwarded twice with the same payload leaves one row (an upsert handler, no ledger)', async () => {
    const d = await device();
    const table = new Map<string, unknown>();
    d.svc.setRunners({
      ui: async (_ext, _name, p) => {
        table.set((p as { id: string }).id, p);
        return { saved: true };
      },
      core: jest.fn(),
      commit: jest.fn(),
    });
    const r = ui('save', { id: 'claim-1', label: 'x' });
    await expect(d.svc.runForwarded(r)).resolves.toEqual({
      ok: true,
      value: { saved: true },
    });
    await expect(d.svc.runForwarded(r)).resolves.toEqual({
      ok: true,
      value: { saved: true },
    });
    expect(table.size).toBe(1);
  });

  it('runForwarded dispatches core and commit kinds, and a handler failure is code handler', async () => {
    const d = await device();
    const core = jest.fn(async () => 'acted');
    const commit = jest.fn(async () => undefined);
    d.svc.setRunners({
      ui: async () => {
        throw new Error('boom');
      },
      core,
      commit,
    });
    await expect(
      d.svc.runForwarded({
        kind: 'core',
        name: 'attention.act',
        payload: { id: 'a' },
      }),
    ).resolves.toEqual({ ok: true, value: 'acted' });
    expect(core).toHaveBeenCalledWith('attention.act', { id: 'a' });
    await expect(
      d.svc.runForwarded({
        kind: 'commit',
        name: 'core.commitBatch',
        payload: { n: 1 },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(commit).toHaveBeenCalledWith({ n: 1 });
    await expect(d.svc.runForwarded(ui('save'))).resolves.toEqual({
      ok: false,
      code: 'handler',
      message: 'boom',
    });
  });
});

describe('the delivery queue', () => {
  /** A forwarder that holds its first call until `release()` is called. */
  function gatedForwarder(sent: number[]) {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    const forward = async (r: ForwardRequest) => {
      if (first) {
        first = false;
        await gate;
      }
      sent.push((r.payload as { n: number }).n);
      return { ok: true as const, value: null };
    };
    return { forward, release };
  }
  const settle = () => new Promise((r) => setImmediate(r));

  it('the fence lifting while a drain is in flight sends each row once', async () => {
    const d = await device(false, { fencedAtBoot: true });
    await d.svc.enqueue(ui('import', { n: 1 }));
    await d.svc.enqueue(ui('import', { n: 2 }));
    const sent: number[] = [];
    const g = gatedForwarder(sent);
    d.svc.setForwarder(g.forward);
    d.svc.setRunners({
      ui: async (_e, _n, p) => {
        await g.forward({
          kind: 'ui',
          name: 'x',
          payload: p,
        } as ForwardRequest);
        return null;
      },
      core: jest.fn(),
      commit: jest.fn(),
    });
    const inFlight = d.svc.drainOutbound();
    void d.svc.open('lease'); // boot fence set: runs onOpen, then a drain
    await settle();
    g.release();
    await inFlight;
    await settle();
    await settle();
    expect(sent).toEqual([1, 2]);
    expect(rows(d)).toEqual([]);
  });

  it('a promotion while a drain is in flight sends each row once', async () => {
    const d = await device(true);
    await d.svc.enqueue(ui('import', { n: 1 }));
    await d.svc.enqueue(ui('import', { n: 2 }));
    const sent: number[] = [];
    const g = gatedForwarder(sent);
    d.svc.setForwarder(g.forward);
    d.svc.setRunners({
      ui: async (_e, _n, p) => {
        await g.forward({
          kind: 'ui',
          name: 'x',
          payload: p,
        } as ForwardRequest);
        return null;
      },
      core: jest.fn(),
      commit: jest.fn(),
    });
    const inFlight = d.svc.drainOutbound();
    const promoted = d.svc.lead({ epoch: 2 }).then(() => d.svc.open('head-acked'));
    await settle();
    g.release();
    await Promise.all([inFlight, promoted]);
    expect(sent).toEqual([1, 2]);
    expect(rows(d)).toEqual([]);
  });

  it('enqueue writes a local row; status counts it', async () => {
    const d = await device();
    await d.svc.enqueue(ui('import', { meeting: 'm1' }));
    expect(rows(d)).toEqual([
      { kind: 'import', extension_id: 'test.ext', attempts: 0 },
    ]);
    expect(readSyncStatus(d.conn()).outbound).toEqual({ waiting: 1 });
  });

  it('drainOutbound sends in order and deletes only on success', async () => {
    const d = await device(true);
    await d.svc.enqueue(ui('import', { n: 1 }));
    await d.svc.enqueue(ui('import', { n: 2 }));
    await d.svc.enqueue(ui('import', { n: 3 }));
    const sent: unknown[] = [];
    let fail = true;
    d.svc.setForwarder(async (r) => {
      if (fail && (r.payload as { n: number }).n === 2)
        return { ok: false, code: 'no-master', message: 'x' };
      sent.push((r.payload as { n: number }).n);
      return { ok: true, value: null };
    });
    await expect(d.svc.drainOutbound()).resolves.toEqual({
      sent: 1,
      waiting: 2,
    });
    expect(sent).toEqual([1]);
    expect(rows(d).map((r) => (r as { attempts: number }).attempts)).toEqual([
      0, 0,
    ]);
    fail = false;
    await expect(d.svc.drainOutbound()).resolves.toEqual({
      sent: 2,
      waiting: 0,
    });
    expect(sent).toEqual([1, 2, 3]);
  });

  it('a handler failure keeps the row, counts the attempt and waits out a backoff', async () => {
    const t = { now: 1_000_000 };
    const d = await device(true, { nowMs: () => t.now });
    await d.svc.enqueue(ui('import'));
    const calls = jest.fn(
      async () =>
        ({ ok: false, code: 'handler', message: 'bad bundle' }) as const,
    );
    d.svc.setForwarder(calls);
    await expect(d.svc.drainOutbound()).resolves.toEqual({
      sent: 0,
      waiting: 1,
    });
    expect(rows(d)).toEqual([
      { kind: 'import', extension_id: 'test.ext', attempts: 1 },
    ]);
    // Inside the backoff the master is not asked again.
    await d.svc.drainOutbound();
    expect(calls).toHaveBeenCalledTimes(1);
    t.now += 10 * 60_000;
    await d.svc.drainOutbound();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(rows(d)).toEqual([
      { kind: 'import', extension_id: 'test.ext', attempts: 2 },
    ]);
  });

  it('a no-master answer is not a failed attempt', async () => {
    const d = await device(true);
    await d.svc.enqueue(ui('import'));
    d.svc.setForwarder(async () => ({
      ok: false,
      code: 'no-master',
      message: 'x',
    }));
    for (let i = 0; i < 10; i += 1) await d.svc.drainOutbound();
    expect(rows(d)).toEqual([
      { kind: 'import', extension_id: 'test.ext', attempts: 0 },
    ]);
  });

  it('a permanently failing item is kept, logged by source and no longer blocks the rest', async () => {
    const t = { now: 1_000_000 };
    const logs: string[] = [];
    const d = await device(true, {
      nowMs: () => t.now,
      log: (_l, m) => logs.push(m),
    });
    await d.svc.enqueue({
      kind: 'ui',
      extensionId: 'bad.ext',
      name: 'import',
      payload: { n: 0 },
    });
    await d.svc.enqueue(ui('import', { n: 1 }));
    const sent: number[] = [];
    d.svc.setForwarder(async (r) => {
      const { n } = r.payload as { n: number };
      if (n === 0) return { ok: false, code: 'handler', message: 'bad bundle' };
      sent.push(n);
      return { ok: true, value: null };
    });
    for (let i = 0; i < 12; i += 1) {
      await d.svc.drainOutbound();
      t.now += 24 * 60 * 60_000;
    }
    expect(sent).toEqual([1]);
    // Kept, never deleted, and not asked again once the retries are spent.
    expect(rows(d)).toEqual([
      { kind: 'import', extension_id: 'bad.ext', attempts: 5 },
    ]);
    expect(
      logs.filter((m) => m.includes('bad.ext') && m.includes('bad bundle'))
        .length,
    ).toBeGreaterThan(0);
    expect(
      logs.filter((m) => m.includes('giving up') && m.includes('bad.ext')),
    ).toHaveLength(1);
  });

  it('after promote the rows run locally, in order', async () => {
    const d = await device(true);
    const order: number[] = [];
    d.svc.setRunners({
      ui: async (_e, _n, p) => {
        order.push((p as { n: number }).n);
        return null;
      },
      core: jest.fn(),
      commit: async (p) => void order.push((p as { n: number }).n),
    });
    await d.svc.enqueue(ui('import', { n: 1 }));
    await d.svc.enqueue({
      kind: 'commit',
      name: 'core.commitBatch',
      payload: { n: 2 },
    });
    await d.svc.lead({ epoch: 2 });
    await d.svc.open('head-acked');
    expect(order).toEqual([1, 2]);
    expect(rows(d)).toEqual([]);
  });

  it('drain with no forwarder and a follower role keeps the rows', async () => {
    const d = await device(true);
    await d.svc.enqueue(ui('import'));
    await expect(d.svc.drainOutbound()).resolves.toEqual({
      sent: 0,
      waiting: 1,
    });
  });

  it('retained lists the keys recorded for a table', async () => {
    const d = await device();
    d.conn()
      .prepare(
        `INSERT INTO sync_retained(tbl, pk) VALUES('t', '["m1"]'), ('t', '["m2"]'), ('u', '["x"]')`,
      )
      .run();
    await expect(d.svc.retained('t')).resolves.toEqual(['["m1"]', '["m2"]']);
  });
});

it('sync_outbound and sync_retained are local tables', () => {
  expect(LOCAL_CORE_TABLES).toEqual(
    expect.arrayContaining(['sync_outbound', 'sync_retained']),
  );
});

it('applyDelta tells onApplied which copied tables the delta touched, and nothing for an empty one', async () => {
  const d = await device();
  let tables: string[] = [];
  const fake = createSyncService({
    db: d.db,
    store: {
      ...d.store,
      applySyncDelta: async () => ({
        applied: 2,
        target: { seq: 1, cursor: 1 },
        tables,
      }),
    } as never,
    dbPath: path.join(d.dir, 'a.db'),
    workerFile: '',
  });
  const seen: string[][] = [];
  fake.onApplied((t) => seen.push(t));
  tables = ['accounts', 'documents'];
  await fake.applyDelta('stage');
  tables = [];
  await fake.applyDelta('stage');
  expect(seen).toEqual([['accounts', 'documents']]);
});

describe('the settings queue (phase 6c)', () => {
  const setting = (k: 'theme' | 'outbound', v: unknown): ForwardRequest =>
    userPrefRequest(k, v);
  const keyed = (d: Device) =>
    d
      .conn()
      .prepare(
        `SELECT id, coalesce_key AS k, attempts FROM sync_outbound ORDER BY id`,
      )
      .all() as { id: number; k: string | null; attempts: number }[];

  it('a second enqueue with the same key leaves one row, the newer, with a greater id', async () => {
    const d = await device(true);
    const a = await d.svc.enqueue(setting('theme', 'dark'), {
      coalesceKey: 'core.theme',
    });
    const b = await d.svc.enqueue(setting('theme', 'light'), {
      coalesceKey: 'core.theme',
    });
    expect(b).toBeGreaterThan(a);
    expect(keyed(d)).toEqual([{ id: b, k: 'core.theme', attempts: 0 }]);
    const payload = d
      .conn()
      .prepare(`SELECT payload FROM sync_outbound`)
      .get() as { payload: Buffer };
    expect(JSON.parse(payload.payload.toString('utf8')).payload).toEqual({
      theme: 'light',
    });
  });

  it('rows without a key are never coalesced', async () => {
    const d = await device(true);
    await d.svc.enqueue(ui('import', { n: 1 }));
    await d.svc.enqueue(ui('import', { n: 1 }));
    expect(keyed(d)).toHaveLength(2);
  });

  it('the keyed replace is one batch: a failing insert leaves the older row', async () => {
    const d = await device(true);
    const a = await d.svc.enqueue(setting('theme', 'dark'), {
      coalesceKey: 'core.theme',
    });
    d.conn().exec(
      `CREATE TRIGGER refuse_new BEFORE INSERT ON sync_outbound WHEN (SELECT count(*) FROM sync_outbound) = 0 BEGIN SELECT RAISE(ABORT, 'full'); END`,
    );
    await expect(
      d.svc.enqueue(setting('theme', 'light'), { coalesceKey: 'core.theme' }),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/full/),
    });
    expect(keyed(d)).toEqual([{ id: a, k: 'core.theme', attempts: 0 }]);
  });

  it('enqueue returns the new row id', async () => {
    const d = await device(true);
    const id = await d.svc.enqueue(ui('import'));
    expect(keyed(d)[0].id).toBe(id);
  });

  it('a refused unkeyed row ahead of two keyed rows does not hold them back: both delivered, row 1 attempts+1', async () => {
    const d = await device(true);
    await d.svc.enqueue(ui('import', { n: 0 }));
    await d.svc.enqueue(setting('theme', 'dark'), {
      coalesceKey: 'core.theme',
    });
    await d.svc.enqueue(setting('outbound', { defaultMode: 'chat' }), {
      coalesceKey: 'core.outbound',
    });
    const sent: string[] = [];
    d.svc.setForwarder(async (r) => {
      if (r.kind === 'ui')
        return { ok: false, code: 'handler', message: 'bad' };
      sent.push(r.name);
      return { ok: true, value: null };
    });
    await d.svc.drainOutbound();
    expect(sent).toEqual(['prefs:patch', 'prefs:patch']);
    expect(keyed(d)).toEqual([
      expect.objectContaining({ k: null, attempts: 1 }),
    ]);
  });

  it('after an unkeyed refusal a later unkeyed row is skipped, not sent', async () => {
    const d = await device(true);
    await d.svc.enqueue(ui('import', { n: 0 }));
    await d.svc.enqueue(ui('import', { n: 1 }));
    const sent: number[] = [];
    d.svc.setForwarder(async (r) => {
      sent.push((r.payload as { n: number }).n);
      return { ok: false, code: 'handler', message: 'bad' };
    });
    await d.svc.drainOutbound();
    expect(sent).toEqual([0]);
  });

  it('a backing-off keyed row is skipped and later keyed rows go; a backing-off unkeyed row skips later unkeyed rows only', async () => {
    const t = { now: 1_000_000 };
    const d = await device(true, { nowMs: () => t.now });
    await d.svc.enqueue(setting('theme', 'dark'), {
      coalesceKey: 'core.theme',
    });
    await d.svc.enqueue(setting('outbound', { defaultMode: 'chat' }), {
      coalesceKey: 'core.outbound',
    });
    const calls: string[] = [];
    let refuseTheme = true;
    d.svc.setForwarder(async (r) => {
      const p = r.payload as Record<string, unknown>;
      calls.push(Object.keys(p)[0]);
      if (refuseTheme && 'theme' in p)
        return { ok: false, code: 'handler', message: 'bad' };
      return { ok: true, value: null };
    });
    await d.svc.drainOutbound();
    expect(calls).toEqual(['theme', 'outbound']);
    // inside backoff: theme is not asked again
    refuseTheme = false;
    calls.length = 0;
    await d.svc.drainOutbound();
    expect(calls).toEqual([]);
    // unkeyed: backing off skips later unkeyed but a keyed row goes
    t.now += 10 * 60_000;
    await d.svc.drainOutbound(); // theme delivered
    await d.svc.enqueue(ui('import', { n: 0 }));
    refuseTheme = true;
    d.svc.setForwarder(async (r) => {
      calls.push(
        r.kind === 'ui' ? `ui${(r.payload as { n: number }).n}` : 'keyed',
      );
      return r.kind === 'ui'
        ? { ok: false, code: 'handler', message: 'bad' }
        : { ok: true, value: null };
    });
    calls.length = 0;
    await d.svc.drainOutbound(); // ui0 refused, backing off
    await d.svc.enqueue(ui('import', { n: 1 }));
    await d.svc.enqueue(setting('theme', 'light'), {
      coalesceKey: 'core.theme',
    });
    calls.length = 0;
    await d.svc.drainOutbound();
    expect(calls).toEqual(['keyed']);
  });

  it('no leader reachable ends the pass for every kind', async () => {
    const d = await device(true);
    await d.svc.enqueue(setting('theme', 'dark'), {
      coalesceKey: 'core.theme',
    });
    await d.svc.enqueue(ui('import'));
    const f = jest.fn(
      async () => ({ ok: false, code: 'no-master', message: 'x' }) as const,
    );
    d.svc.setForwarder(f);
    await d.svc.drainOutbound();
    expect(f).toHaveBeenCalledTimes(1);
    expect(keyed(d)).toHaveLength(2);
  });

  it('a delivered keyed row fires onQueueChange delivered with its key', async () => {
    const d = await device(true);
    const id = await d.svc.enqueue(setting('theme', 'dark'), {
      coalesceKey: 'core.theme',
    });
    const seen: unknown[] = [];
    d.svc.onQueueChange((e) => seen.push(e));
    d.svc.setForwarder(async () => ({ ok: true, value: null }));
    await d.svc.drainOutbound();
    expect(seen).toEqual([
      { kind: 'delivered', rowId: id, coalesceKey: 'core.theme' },
    ]);
  });

  it('discardQueued deletes a keyed row and fires discarded; it refuses a row without a key', async () => {
    const d = await device(true);
    const k = await d.svc.enqueue(setting('theme', 'dark'), {
      coalesceKey: 'core.theme',
    });
    const u = await d.svc.enqueue(ui('import'));
    const seen: unknown[] = [];
    d.svc.onQueueChange((e) => seen.push(e));
    await d.svc.discardQueued(k);
    expect(seen).toEqual([
      { kind: 'discarded', rowId: k, coalesceKey: 'core.theme' },
    ]);
    await d.svc.discardQueued(u);
    expect(keyed(d).map((r) => r.id)).toEqual([u]);
    expect(seen).toHaveLength(1);
  });

  it('a spent row is listed as stuck', async () => {
    const d = await device(true);
    const id = await d.svc.enqueue(setting('theme', 'dark'), {
      coalesceKey: 'core.theme',
    });
    expect((await d.svc.queuedSettings())[0].stuck).toBe(false);
    d.conn()
      .prepare(`UPDATE sync_outbound SET attempts = 5 WHERE id = ?`)
      .run(id);
    expect(await d.svc.queuedSettings()).toEqual([
      { rowId: id, key: 'core.theme', value: 'dark', stuck: true },
    ]);
    expect(readSyncStatus(d.conn()).queuedSettings[0].stuck).toBe(true);
  });

  it('queuedSettings lists one entry per key with the value', async () => {
    const d = await device(true);
    await d.svc.enqueue(setting('theme', 'dark'), {
      coalesceKey: 'core.theme',
    });
    const id = await d.svc.enqueue(setting('theme', 'light'), {
      coalesceKey: 'core.theme',
    });
    await d.svc.enqueue(ui('import'));
    expect(await d.svc.queuedSettings()).toEqual([
      { rowId: id, key: 'core.theme', value: 'light', stuck: false },
    ]);
    expect(readSyncStatus(d.conn()).queuedSettings).toEqual([
      { rowId: id, key: 'core.theme', value: 'light', stuck: false },
    ]);
  });
});

it('applyDelta passes pullStartedAt and the touched user_prefs keys to onApplied listeners', async () => {
  const d = await device();
  const fake = createSyncService({
    db: d.db,
    store: {
      ...d.store,
      applySyncDelta: async () => ({
        applied: 1,
        target: { seq: 1, cursor: 1 },
        tables: ['user_prefs'],
        prefKeys: ['core.theme'],
      }),
    } as never,
    dbPath: path.join(d.dir, 'a.db'),
    workerFile: '',
  });
  const seen: unknown[] = [];
  fake.onApplied((t, meta) => seen.push([t, meta]));
  await fake.applyDelta('stage', { pullStartedAt: 123 });
  await fake.applyDelta('stage');
  expect(seen).toEqual([
    [['user_prefs'], { prefKeys: ['core.theme'], pullStartedAt: 123 }],
    [['user_prefs'], { prefKeys: ['core.theme'], pullStartedAt: undefined }],
  ]);
});
