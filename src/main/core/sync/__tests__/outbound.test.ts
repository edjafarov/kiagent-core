/** @jest-environment node */
/** Step 3 Task 1: the forwarding point and the durable delivery queue
 *  (alpha-cent spec 7.8, r16 rulings 3 and 8). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { promote } from '../promote';
import { LOCAL_CORE_TABLES } from '../tables';
import { readSyncStatus } from '../status';
import { createSyncService, type ForwardRequest, type SyncService } from '../service';

interface Device {
  dir: string;
  db: AppDb;
  store: CoreStore;
  svc: SyncService;
  conn: () => import('better-sqlite3').Database;
}
const devices: Device[] = [];

async function device(follower = false): Promise<Device> {
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
  (db as unknown as { proc: (n: string, a: { epoch: number }) => Promise<null> }).proc = async (
    name,
    a,
  ) => {
    if (name === 'syncPromote') promote(conn(), a.epoch);
    return null;
  };
  if (follower) conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();
  const svc = createSyncService({
    initialReadOnly: follower,
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    log: () => undefined,
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
  d.conn().prepare(`SELECT kind, extension_id, attempts FROM sync_outbound ORDER BY id`).all();

afterEach(async () => {
  for (const d of devices.splice(0)) {
    await d.db.close();
    fs.rmSync(d.dir, { recursive: true, force: true });
  }
});

describe('forwarding', () => {
  it('with no forwarder a follower gets no-master', async () => {
    const d = await device();
    await expect(d.svc.forward(ui('save'))).resolves.toMatchObject({ ok: false, code: 'no-master' });
  });

  it('forward hands the request to the forwarder and returns its answer', async () => {
    const d = await device();
    const seen: ForwardRequest[] = [];
    d.svc.setForwarder(async (r) => {
      seen.push(r);
      return { ok: true, value: 7 };
    });
    await expect(d.svc.forward(ui('save', { id: 1 }))).resolves.toEqual({ ok: true, value: 7 });
    expect(seen).toEqual([ui('save', { id: 1 })]);
  });

  it('a throwing forwarder is no-master, never an exception', async () => {
    const d = await device();
    d.svc.setForwarder(async () => {
      throw new Error('socket hang up');
    });
    await expect(d.svc.forward(ui('save'))).resolves.toMatchObject({ ok: false, code: 'no-master' });
  });

  it('runForwarded on a follower refuses and runs nothing', async () => {
    const d = await device(true);
    const runUi = jest.fn();
    d.svc.setRunners({ ui: runUi, core: jest.fn(), commit: jest.fn() });
    await expect(d.svc.runForwarded(ui('save'))).resolves.toMatchObject({ ok: false, code: 'handler' });
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
    await expect(d.svc.runForwarded(r)).resolves.toEqual({ ok: true, value: { saved: true } });
    await expect(d.svc.runForwarded(r)).resolves.toEqual({ ok: true, value: { saved: true } });
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
      d.svc.runForwarded({ kind: 'core', name: 'attention.act', payload: { id: 'a' } }),
    ).resolves.toEqual({ ok: true, value: 'acted' });
    expect(core).toHaveBeenCalledWith('attention.act', { id: 'a' });
    await expect(
      d.svc.runForwarded({ kind: 'commit', name: 'core.commitBatch', payload: { n: 1 } }),
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
  it('enqueue writes a local row; status counts it', async () => {
    const d = await device();
    await d.svc.enqueue(ui('import', { meeting: 'm1' }));
    expect(rows(d)).toEqual([{ kind: 'import', extension_id: 'test.ext', attempts: 0 }]);
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
      if (fail && (r.payload as { n: number }).n === 2) return { ok: false, code: 'no-master', message: 'x' };
      sent.push((r.payload as { n: number }).n);
      return { ok: true, value: null };
    });
    await expect(d.svc.drainOutbound()).resolves.toEqual({ sent: 1, waiting: 2 });
    expect(sent).toEqual([1]);
    expect(rows(d).map((r) => (r as { attempts: number }).attempts)).toEqual([1, 0]);
    fail = false;
    await expect(d.svc.drainOutbound()).resolves.toEqual({ sent: 2, waiting: 0 });
    expect(sent).toEqual([1, 2, 3]);
  });

  it('a handler failure on the master is dropped after it is reported, not retried for ever', async () => {
    const d = await device(true);
    await d.svc.enqueue(ui('import'));
    d.svc.setForwarder(async () => ({ ok: false, code: 'handler', message: 'bad bundle' }));
    await expect(d.svc.drainOutbound()).resolves.toEqual({ sent: 0, waiting: 0 });
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
    await d.svc.enqueue({ kind: 'commit', name: 'core.commitBatch', payload: { n: 2 } });
    await d.svc.promote(2);
    expect(order).toEqual([1, 2]);
    expect(rows(d)).toEqual([]);
  });

  it('drain with no forwarder and a follower role keeps the rows', async () => {
    const d = await device(true);
    await d.svc.enqueue(ui('import'));
    await expect(d.svc.drainOutbound()).resolves.toEqual({ sent: 0, waiting: 1 });
  });

  it('retained lists the keys recorded for a table', async () => {
    const d = await device();
    d.conn().prepare(`INSERT INTO sync_retained(tbl, pk) VALUES('t', '["m1"]'), ('t', '["m2"]'), ('u', '["x"]')`).run();
    await expect(d.svc.retained('t')).resolves.toEqual(['["m1"]', '["m2"]']);
  });
});

it('sync_outbound and sync_retained are local tables', () => {
  expect(LOCAL_CORE_TABLES).toEqual(expect.arrayContaining(['sync_outbound', 'sync_retained']));
});

it('applyDelta tells onApplied which copied tables the delta touched, and nothing for an empty one', async () => {
  const d = await device();
  let tables: string[] = [];
  const fake = createSyncService({
    db: d.db,
    store: { ...d.store, applySyncDelta: async () => ({ applied: 2, target: { seq: 1, cursor: 1 }, tables }) } as never,
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
