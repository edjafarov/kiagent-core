/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';
import { createWriteTx } from '../write-tx';

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
const settle = () =>
  new Promise((r) => {
    setTimeout(r, 30);
  });

describe('commit reports whether it logged (#135)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-logged-'));
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

  it('WriteTx.commit returns {seq, logged} per batch kind', () => {
    const tx = createWriteTx(db._conn!, {
      detectLanguages: () => ['eng'],
      now: () => new Date().toISOString(),
    });
    const r = tx.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 1,
    });
    expect(r.logged).toBe(true);
    expect(r.seq).toBeGreaterThan(0);
    expect(tx.commit({ consumer: 'worker:t:v1', cursor: r.seq }).logged).toBe(
      false,
    );
    expect(
      tx.commit({ purgeArchived: { before: '2000-01-01T00:00:00Z' } }).logged,
    ).toBe(false);
  });

  it('a parked feed is not woken by a cursor-only consumer commit, and is by a document commit', async () => {
    const it = store.feed(await store.headSeq())[Symbol.asyncIterator]();
    const next = it.next();
    await settle(); // the feed read once and parked on the nudge
    const spy = jest.spyOn(db, 'all');
    const feedReads = () =>
      spy.mock.calls.filter(([sql]) =>
        /FROM changes WHERE seq > \?/.test(sql as string),
      ).length;

    await store.commit({ consumer: 'worker:t:v1', cursor: 1 });
    await settle();
    expect(feedReads()).toBe(0);

    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 1,
    });
    const r = await next;
    expect(r.done).toBe(false);
    expect(feedReads()).toBeGreaterThan(0);
    await it.return?.();
  });
});
