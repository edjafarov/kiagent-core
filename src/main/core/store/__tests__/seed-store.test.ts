/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { QUERY_METHODS } from '../corpus-query';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});
const W = 'worker:s:v1';

describe('seeding primitives (#59 §3a)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-seedstore-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me' })
    ).id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seqOf = async (externalId: string) =>
    (
      (await db.all(`SELECT seq FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ seq: number }>
    )[0].seq;

  it('seedPage: live documents in (afterSeq, throughSeq], oldest first, bounded', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'b', type: 'note' }],
      cursor: 2,
    });
    const h0 = await store.headSeq();
    await store.commit({
      account: accountId,
      documents: [doc('late')],
      cursor: 3,
    });

    const all = await store.read.seedPage!({
      afterSeq: 0,
      throughSeq: h0,
      limit: 10,
    });
    expect(all.map((d) => d.externalId)).toEqual(['a', 'c']);
    const rest = await store.read.seedPage!({
      afterSeq: await seqOf('a'),
      throughSeq: h0,
      limit: 10,
    });
    expect(rest.map((d) => d.externalId)).toEqual(['c']);
    expect(
      await store.read.seedPage!({ afterSeq: 0, throughSeq: h0, limit: 1 }),
    ).toHaveLength(1);
  });

  it('the read worker serves seedPage', () => {
    expect(QUERY_METHODS).toContain('seedPage');
  });

  it('beginSeed writes the real row at h0 and seed:<c> at 0 together; endSeed drops only the seed row', async () => {
    expect(await store.consumerRow(W)).toBeNull();
    const g = store.ledgerGen();
    await store.beginSeed(W, 42);
    expect(store.ledgerGen()).toBeGreaterThan(g);
    expect(await store.consumerRow(W)).toBe(42);
    expect(await store.consumerRow(`seed:${W}`)).toBe(0);
    await store.endSeed(W);
    expect(await store.consumerRow(`seed:${W}`)).toBeNull();
    expect(await store.consumerRow(W)).toBe(42);
  });

  it('a seed commit moves seed:<c> only; after endSeed a late seedCursor revives nothing', async () => {
    await store.beginSeed(W, 7);
    await store.commit({ consumer: W, cursor: 7, seedCursor: 5 });
    expect(await store.consumerRow(`seed:${W}`)).toBe(5);
    expect(await store.consumerRow(W)).toBe(7);
    await store.endSeed(W);
    await store.commit({ consumer: W, cursor: 7, seedCursor: 6 });
    expect(await store.consumerRow(`seed:${W}`)).toBeNull();
  });

  it('a seed commit writes its ledger outcomes in the same transaction as seedCursor', async () => {
    await store.beginSeed(W, 7);
    await store.commit({
      consumer: W,
      cursor: 7,
      seedCursor: 5,
      ledger: [
        { seq: 4, attempts: 0, outcome: 'deferred' },
        { seq: 5, attempts: 1, outcome: 'done' },
      ],
    });
    expect(await store.consumerRow(`seed:${W}`)).toBe(5);
    expect(
      await db.all(
        `SELECT seq, attempts, outcome FROM work_ledger WHERE consumer = ? ORDER BY seq`,
        [W],
      ),
    ).toEqual([
      { seq: 4, attempts: 0, outcome: 'deferred' },
      { seq: 5, attempts: 1, outcome: 'done' },
    ]);
    expect(await store.ledgerHasDeferred(W)).toBe(true);
  });

  it('ledgerCountsAll without a list ignores seed: rows (pending = head − h0)', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 1,
    });
    const head = await store.headSeq();
    await store.beginSeed(W, head);
    expect((await store.ledgerCountsAll()).pending).toBe(0);
    expect((await store.ledgerCountsAll([W])).pending).toBe(0);
  });

  it('changesFloor is null until a prune publishes one', async () => {
    expect(await store.changesFloor()).toBeNull();
    await db.run(`INSERT INTO meta(key, value) VALUES('changesFloor', '17')`);
    expect(await store.changesFloor()).toBe(17);
  });
});
