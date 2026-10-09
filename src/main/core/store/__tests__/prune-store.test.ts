/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});
const T = Date.parse('2026-10-09T12:00:00.000Z');

describe('prune primitives (#59 §3b)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let clock = T;

  beforeEach(async () => {
    clock = T - 72 * 3_600_000;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prunestore-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
      now: () => new Date(clock).toISOString(),
    });
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me' })
    ).id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const firstAt = async (iso: string) =>
    (
      (await db.all(`SELECT MIN(seq) AS s FROM changes WHERE at >= ?`, [
        iso,
      ])) as Array<{
        s: number | null;
      }>
    )[0].s;

  it('firstChangeSeqAt bisects to the first change at/after an instant, also after a prefix is gone', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('old')],
      cursor: 1,
    });
    clock = T - 3_600_000;
    await store.commit({
      account: accountId,
      documents: [doc('new')],
      cursor: 2,
    });
    const since = new Date(T - 48 * 3_600_000).toISOString();
    const expected = await firstAt(since);
    expect(await store.firstChangeSeqAt(since)).toBe(expected);
    expect(await store.firstChangeSeqAt(new Date(T).toISOString())).toBe(
      (await store.headSeq()) + 1,
    );
    expect(await store.deleteChangesRange(1, expected!)).toBeGreaterThan(0);
    expect(await store.firstChangeSeqAt(since)).toBe(expected);
    expect(await store.minChangeSeq()).toBe(expected);
    // Every retained row qualifies: the answer is the retained MIN(seq), an
    // existing row, never a deleted number below it.
    expect(await store.firstChangeSeqAt('2000-01-01T00:00:00.000Z')).toBe(
      expected,
    );
    expect(
      await db.all(`SELECT 1 FROM changes WHERE seq = ?`, [
        await store.firstChangeSeqAt('2000-01-01T00:00:00.000Z'),
      ]),
    ).toEqual([{ 1: 1 }]);
  });

  it("the bisection's queries never SCAN changes (endpoint and primary-key seeks only)", async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: 1,
    });
    const spy = jest.spyOn(db, 'all');
    await store.firstChangeSeqAt(new Date(T).toISOString());
    const sqls = [...new Set(spy.mock.calls.map(([sql]) => sql as string))];
    spy.mockRestore();
    // MIN, MAX, the bisection probe and the final resolve.
    expect(sqls.length).toBeGreaterThanOrEqual(3);
    for (const sql of sqls) {
      const params = Array((sql.match(/\?/g) ?? []).length).fill(1);
      // eslint-disable-next-line no-await-in-loop
      const plan = (await db.all(
        `EXPLAIN QUERY PLAN ${sql}`,
        params,
      )) as Array<{
        detail: string;
      }>;
      expect(
        plan.map((p) => p.detail).filter((x) => /\bSCAN changes\b/.test(x)),
      ).toEqual([]);
    }
  });

  it('firstChangeSeqAt is 1 on an empty log', async () => {
    await db.run(`DELETE FROM changes`);
    expect(await store.firstChangeSeqAt('2000-01-01T00:00:00.000Z')).toBe(1);
  });

  it('deleteChangesRange is a half-open primary-key range', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: 1,
    });
    const head = await store.headSeq();
    expect(await store.deleteChangesRange(1, head)).toBe(head - 1);
    expect(await db.all(`SELECT seq FROM changes`)).toEqual([{ seq: head }]);
    expect(await store.deleteChangesRange(5, 5)).toBe(0);
  });

  it('publishChangesFloor never lowers the floor', async () => {
    await store.publishChangesFloor(10);
    await store.publishChangesFloor(4);
    expect(await store.changesFloor()).toBe(10);
    await store.publishChangesFloor(12);
    expect(await store.changesFloor()).toBe(12);
  });

  it('consumerFloor is MIN(cursor) over the given rows, null when none', async () => {
    await db.run(
      `INSERT INTO consumers(name, cursor) VALUES('w:a', 7), ('w:b', 3), ('seed:w:a', 0)`,
    );
    expect(await store.consumerFloor(['w:a', 'w:b'])).toBe(3);
    expect(await store.consumerFloor(['w:a'])).toBe(7);
    expect(await store.consumerFloor(['w:none'])).toBeNull();
    expect(await store.consumerFloor([])).toBeNull();
  });

  it('walCheckpoint runs', async () => {
    await expect(store.walCheckpoint()).resolves.toBeUndefined();
  });
});
