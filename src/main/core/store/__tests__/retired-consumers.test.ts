/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const LIVE = 'worker:vision:v1';
const OLD = 'worker:audio:v1';

describe('retired consumer sweep (#139)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-retired-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    await db.run(
      `INSERT INTO consumers(name, cursor) VALUES(?, 10), (?, 5), ('seed:worker:x:v1', 3)`,
      [LIVE, OLD],
    );
    // Seqs far apart: three 50k windows for the retired consumer.
    await store.ledgerRecordMany(OLD, [
      { seq: 1, attempts: 0, outcome: 'skip' },
      { seq: 60_000, attempts: 0, outcome: 'deferred' },
      { seq: 120_001, attempts: 1, outcome: 'done' },
    ]);
    await store.ledgerRecordMany(LIVE, [
      { seq: 1, attempts: 0, outcome: 'skip' },
      { seq: 2, attempts: 0, outcome: 'deferred' },
    ]);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes only inactive names (ledger rows, then the row); keeps seed rows and live skip rows', async () => {
    expect(await store.sweepRetiredConsumers([LIVE])).toEqual({
      consumers: 1,
      rows: 3,
    });
    expect(await db.all(`SELECT name FROM consumers ORDER BY name`)).toEqual([
      { name: 'seed:worker:x:v1' },
      { name: LIVE },
    ]);
    expect(
      await db.all(
        `SELECT consumer, seq FROM work_ledger ORDER BY consumer, seq`,
      ),
    ).toEqual([
      { consumer: LIVE, seq: 1 },
      { consumer: LIVE, seq: 2 },
    ]);
  });

  it('with no retired names it issues no work_ledger statement', async () => {
    await store.sweepRetiredConsumers([LIVE, OLD]);
    const seen: string[] = [];
    for (const m of ['all', 'run', 'batch'] as const) {
      const orig = (db[m] as (...a: unknown[]) => Promise<unknown>).bind(db);
      jest.spyOn(db, m).mockImplementation(((...a: unknown[]) => {
        const first = a[0];
        if (typeof first === 'string') seen.push(first);
        else for (const s of first as Array<{ sql: string }>) seen.push(s.sql);
        return orig(...a);
      }) as never);
    }
    expect(await store.sweepRetiredConsumers([LIVE, OLD])).toEqual({
      consumers: 0,
      rows: 0,
    });
    expect(seen.filter((s) => /work_ledger/.test(s))).toEqual([]);
  });

  it('is a no-op with no active consumers (boot before workers attach)', async () => {
    expect(await store.sweepRetiredConsumers([])).toEqual({
      consumers: 0,
      rows: 0,
    });
    expect(await db.all(`SELECT COUNT(*) AS c FROM consumers`)).toEqual([
      { c: 3 },
    ]);
  });

  it('moves ledgerGen when it deletes', async () => {
    const g = store.ledgerGen();
    await store.sweepRetiredConsumers([LIVE]);
    expect(store.ledgerGen()).toBeGreaterThan(g);
  });
});
