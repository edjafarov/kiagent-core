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
const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});

describe('ledgerGen (#139)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-gen-'));
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

  const moves = async (f: () => unknown) => {
    const g = store.ledgerGen();
    await f();
    return store.ledgerGen() > g;
  };

  it('every mutation source moves it; readers do not', async () => {
    expect(
      await moves(() =>
        store.commit({ account: accountId, documents: [doc('a')], cursor: 1 }),
      ),
    ).toBe(true);
    // A cursor-only consumer commit wakes no feed but moves `pending`.
    expect(
      await moves(() => store.commit({ consumer: 'worker:t:v1', cursor: 1 })),
    ).toBe(true);
    expect(
      await moves(() => store.ledgerRecord('worker:t:v1', 1, 0, 'done')),
    ).toBe(true);
    expect(
      await moves(() =>
        store.ledgerRecordMany('worker:t:v1', [
          { seq: 2, attempts: 0, outcome: 'skip' },
        ]),
      ),
    ).toBe(true);
    expect(await moves(() => store.markLedgerChanged())).toBe(true);
    expect(
      await moves(() =>
        store.setAccountStatus(accountId, { status: 'paused' }),
      ),
    ).toBe(true);
    expect(
      await moves(() =>
        store.setAccountStatus(accountId, { status: 'paused' }),
      ),
    ).toBe(false);
    expect(
      await moves(() => store.createAccount({ source: 'x', identifier: 'y' })),
    ).toBe(true);
    expect(await moves(() => store.ledgerRekeyPage())).toBe(true);
    expect(await moves(() => store.ledgerCountsAll(['worker:t:v1']))).toBe(
      false,
    );
    expect(await moves(() => store.visualWaitingCount('worker:t:v1'))).toBe(
      false,
    );
  });
});
