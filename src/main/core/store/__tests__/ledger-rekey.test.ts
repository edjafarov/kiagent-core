/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (
  externalId: string,
  markdown = `body ${externalId}`,
): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});
const V = 'worker:vision:v1';
const A = 'worker:audio:v2';

describe('paged re-key repair (#59 §0)', () => {
  let dir: string;
  let file: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  const open = async () => {
    db = await openDb(file);
    store = openStore(db, deps);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-rekey-'));
    file = path.join(dir, 'test.db');
    await open();
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`); // pre-upgrade
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me' })
    ).id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Commit `externalId` twice; returns [old seq, current seq]. */
  const twice = async (externalId: string): Promise<[number, number]> => {
    await store.commit({
      account: accountId,
      documents: [doc(externalId)],
      cursor: 1,
    });
    const old = await seqOf(externalId);
    await store.commit({
      account: accountId,
      documents: [doc(externalId, 'edited')],
      cursor: 2,
    });
    return [old, await seqOf(externalId)];
  };
  const seqOf = async (externalId: string) =>
    (
      (await db.all(`SELECT seq FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ seq: number }>
    )[0].seq;
  const ledger = (consumer: string) =>
    db.all(
      `SELECT seq, attempts, outcome FROM work_ledger WHERE consumer = ? ORDER BY seq`,
      [consumer],
    );
  const repairAll = async (limit?: number) => {
    let pages = 0;
    for (;;) {
      pages += 1;
      // eslint-disable-next-line no-await-in-loop
      if ((await store.ledgerRekeyPage(limit)).done) return pages;
    }
  };

  it('none at the current seq: the deferral moves there, attempts kept', async () => {
    const [old, cur] = await twice('a');
    await store.ledgerRecord(V, old, 2, 'deferred');
    await repairAll();
    expect(await ledger(V)).toEqual([
      { seq: cur, attempts: 2, outcome: 'deferred' },
    ]);
    expect(await store.ledgerRekeyed()).toBe(true);
  });

  it('done at the current seq: the stale deferral is dropped', async () => {
    const [old, cur] = await twice('a');
    await store.ledgerRecordMany(V, [
      { seq: old, attempts: 1, outcome: 'deferred' },
      { seq: cur, attempts: 1, outcome: 'done' },
    ]);
    await repairAll();
    expect(await ledger(V)).toEqual([
      { seq: cur, attempts: 1, outcome: 'done' },
    ]);
  });

  it('(old, deferred), (current, skip) becomes (current, deferred) with attempts reset', async () => {
    const [old, cur] = await twice('a');
    await store.ledgerRecordMany(V, [
      { seq: old, attempts: 3, outcome: 'deferred' },
      { seq: cur, attempts: 0, outcome: 'skip' },
    ]);
    await repairAll();
    expect(await ledger(V)).toEqual([
      { seq: cur, attempts: 0, outcome: 'deferred' },
    ]);
  });

  it('failed at the current seq also gets one more retry', async () => {
    const [old, cur] = await twice('a');
    await store.ledgerRecordMany(V, [
      { seq: old, attempts: 1, outcome: 'deferred' },
      { seq: cur, attempts: 4, outcome: 'failed' },
    ]);
    await repairAll();
    expect(await ledger(V)).toEqual([
      { seq: cur, attempts: 0, outcome: 'deferred' },
    ]);
  });

  it('a purged document: the stale row is dropped', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('p')],
      cursor: 1,
    });
    const s = await seqOf('p');
    await store.ledgerRecord(V, s, 0, 'deferred');
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'p', type: 'note' }],
      cursor: 2,
    });
    await store.commit({ purgeArchived: { before: '9999-01-01T00:00:00Z' } });
    await repairAll();
    expect(await ledger(V)).toEqual([]);
  });

  it('a current deferral (audio, model missing) is untouched', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('m')],
      cursor: 1,
    });
    const s = await seqOf('m');
    await store.ledgerRecord(A, s, 0, 'deferred');
    await repairAll();
    expect(await ledger(A)).toEqual([
      { seq: s, attempts: 0, outcome: 'deferred' },
    ]);
  });

  it('pages by (consumer, seq), persists its cursor, and resumes after a reopen', async () => {
    const stale: Array<[string, number, number]> = [];
    for (const id of ['a', 'b', 'c']) {
      // eslint-disable-next-line no-await-in-loop
      const [old, cur] = await twice(id);
      stale.push([id, old, cur]);
    }
    await store.ledgerRecordMany(
      V,
      stale.map(([, old]) => ({
        seq: old,
        attempts: 0,
        outcome: 'deferred' as const,
      })),
    );
    await store.ledgerRecord(A, stale[0][1], 0, 'deferred');

    // One page of 2 rows, then "quit".
    expect((await store.ledgerRekeyPage(2)).done).toBe(false);
    const cursor = (await db.all(
      `SELECT value FROM meta WHERE key = 'ledgerRekeyCursor'`,
    )) as Array<{ value: string }>;
    expect(cursor).toHaveLength(1);
    await store.close();

    await open(); // next start
    expect(await store.ledgerRekeyed()).toBe(false);
    await repairAll(2);
    expect(await ledger(V)).toEqual(
      stale.map(([, , cur]) => ({
        seq: cur,
        attempts: 0,
        outcome: 'deferred',
      })),
    );
    expect(await ledger(A)).toEqual([
      { seq: stale[0][2], attempts: 0, outcome: 'deferred' },
    ]);
    expect(
      await db.all(
        `SELECT key FROM meta WHERE key LIKE 'ledgerRekey%' ORDER BY key`,
      ),
    ).toEqual([{ key: 'ledgerRekeyed' }]);
  });
});
