/** Step 2 Task 1: what `promote` and `demote` write to the database. Called
 *  directly on the connection, no worker: the role guard is not under test
 *  here (promote.test.ts runs it through the real writer). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { demote, EPOCH_GAP as GAP, lead, promote } from '../promote';
import { readSyncStatus } from '../status';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

let db: AppDb;
let store: CoreStore;
let dir: string;
const conn = () => db._conn!;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-promote-book-'));
  db = await openDb(path.join(dir, 'a.db'));
  migrate(conn());
  store = openStore(db, deps);
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const write = () => store.createAccount({ source: 's', identifier: `i${(n += 1)}` });
const state = () =>
  conn().prepare(`SELECT * FROM sync_state`).get() as Record<string, number | string | null>;
const follow = () =>
  conn()
    .prepare(
      `UPDATE sync_state SET role='follower', master_device_id='m1', tracking=0,
                             history_id='h1', after_seq=7, after_cursor=5, joined=1`,
    )
    .run();
const seqOf = (name: string) =>
  ((conn().prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(name) as { seq: number } | undefined)
    ?.seq ?? 0);
const head = () =>
  (conn().prepare(`SELECT max(seq) AS m FROM changes`).get() as { m: number }).m;

describe('promote', () => {
  it('raises both counters to the epoch range, and the next rows land above it', async () => {
    follow();
    promote(conn(), 3);
    expect(seqOf('changes')).toBeGreaterThanOrEqual(3 * GAP);
    expect(seqOf('sync_rows')).toBeGreaterThanOrEqual(3 * GAP);
    await write();
    expect(head()).toBeGreaterThan(3 * GAP);
  });

  it('raises counters that already have rows, with one sequence row each, and the next rows land above', async () => {
    await write();
    await write();
    follow();
    promote(conn(), 3);
    for (const name of ['changes', 'sync_rows']) {
      const rows = conn().prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).all(name) as {
        seq: number;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].seq).toBeGreaterThanOrEqual(3 * GAP);
    }
    await write();
    expect(head()).toBeGreaterThan(3 * GAP);
  });

  it('never lowers a counter that is already higher', () => {
    follow();
    conn().prepare(`INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES ('changes', ?)`).run(9 * GAP);
    promote(conn(), 2);
    expect(seqOf('changes')).toBe(9 * GAP);
  });

  it('writes sync_epochs with the old position and records the epoch', () => {
    follow();
    promote(conn(), 3);
    expect(conn().prepare(`SELECT * FROM sync_epochs`).all()).toEqual([
      { epoch: 3, grant_seq: 7, grant_cursor: 5 },
    ]);
    expect(state().epoch).toBe(3);
  });

  it('the sync_epochs row is the first tracked row, so it travels', () => {
    follow();
    promote(conn(), 3);
    const first = conn()
      .prepare(`SELECT tbl, pk, cursor FROM sync_rows ORDER BY cursor LIMIT 1`)
      .all();
    expect(first).toMatchObject([{ tbl: 'sync_epochs', pk: '[3]' }]);
    expect(Number((first[0] as { cursor: number }).cursor)).toBeGreaterThan(3 * GAP);
  });

  it('keeps history_id, turns tracking on and clears the master', () => {
    follow();
    promote(conn(), 2);
    expect(state()).toMatchObject({ role: 'normal', tracking: 1, history_id: 'h1', master_device_id: null });
  });

  it("status reports the epoch and the grant of the device's own epoch", () => {
    follow();
    expect(readSyncStatus(conn())).toMatchObject({ epoch: 0, grant: null });
    promote(conn(), 3);
    expect(readSyncStatus(conn())).toMatchObject({ epoch: 3, grant: { seq: 7, cursor: 5 } });
  });

  it('promoting twice with the same epoch changes nothing the second time', () => {
    follow();
    promote(conn(), 2);
    promote(conn(), 2);
    expect(conn().prepare(`SELECT * FROM sync_epochs`).all()).toHaveLength(1);
  });

  it('deletes every consumer and their ledger rows so workers re-seed', () => {
    follow();
    conn().prepare(`INSERT INTO consumers(name, cursor) VALUES ('worker:ocr:v1', 99)`).run();
    conn()
      .prepare(
        `INSERT INTO work_ledger(consumer, seq, attempts, outcome, updated_at) VALUES ('worker:ocr:v1', 4, 1, 'done', 'n')`,
      )
      .run();
    promote(conn(), 2);
    expect(conn().prepare(`SELECT * FROM consumers`).all()).toEqual([]);
    expect(conn().prepare(`SELECT * FROM work_ledger`).all()).toEqual([]);
  });

  it('demote sets after to the head and stops tracking', async () => {
    lead(conn(), 1);
    await write();
    const h = conn()
      .prepare(
        `SELECT (SELECT coalesce(max(seq), 0) FROM documents) AS s, (SELECT coalesce(max(cursor), 0) FROM sync_rows) AS c`,
      )
      .get() as { s: number; c: number };
    demote(conn(), 'm2');
    expect(state()).toMatchObject({
      role: 'follower',
      tracking: 0,
      master_device_id: 'm2',
      after_seq: h.s,
      after_cursor: h.c,
    });
  });
});
