/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { ensureQueryIndexes } from '../schema';
import { openStore, type CoreStore } from '../store';

const C = 'worker:vision:v1';

describe('deferred lookups seek work_ledger_active (#139)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-defplan-'));
    db = await openDb(path.join(dir, 'test.db'));
    ensureQueryIndexes(db._conn!);
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const planOfCall = async (call: () => Promise<unknown>) => {
    const spy = jest.spyOn(db, 'all');
    await call();
    const [sql, params] = spy.mock.calls.find(([s]) =>
      /FROM work_ledger/.test(s as string),
    )!;
    spy.mockRestore();
    return (
      (await db.all(`EXPLAIN QUERY PLAN ${sql as string}`, params)) as Array<{
        detail: string;
      }>
    ).map((r) => r.detail);
  };

  it('ledgerDeferred range-seeks the partial index', async () => {
    const plan = await planOfCall(() => store.ledgerDeferred(C, 0, 500));
    expect(plan.some((d) => /work_ledger_active/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN /.test(d))).toBe(false);
  });

  it('ledgerHasDeferred range-seeks the partial index', async () => {
    const plan = await planOfCall(() => store.ledgerHasDeferred(C));
    expect(plan.some((d) => /work_ledger_active/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN /.test(d))).toBe(false);
  });

  it('both still ignore skip rows and find deferred ones', async () => {
    await store.ledgerRecordMany(C, [
      { seq: 1, attempts: 0, outcome: 'skip' },
      { seq: 2, attempts: 0, outcome: 'deferred' },
    ]);
    expect(await store.ledgerDeferred(C, 0, 10)).toEqual([2]);
    expect(await store.ledgerHasDeferred(C)).toBe(true);
  });
});
