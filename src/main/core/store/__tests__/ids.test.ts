/** Step 2 Task 2: ids that two devices derive alike for the same natural key. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { DocumentInput } from '@shared/contracts';

import { hashedId } from '../../ids';
import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../schema';
import { openStore, type CoreStore } from '../store';
import { createWriteTx, type WriteTx } from '../write-tx';
import { buildDelta } from '../../sync/delta';
import { enableTracking } from '../../sync/tracking';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const doc = (externalId: string, markdown = 'body'): DocumentInput => ({
  externalId,
  type: 'file',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: null,
});

describe('hashedId', () => {
  it('is stable, shaped like a UUID, and depends on every part', () => {
    expect(hashedId('document', ['a', 'b', 'c'])).toBe(hashedId('document', ['a', 'b', 'c']));
    expect(hashedId('document', ['a', 'b', 'c'])).toMatch(UUID);
    expect(hashedId('document', ['a', 'b', 'c'])).not.toBe(hashedId('document', ['a', 'b', 'd']));
    expect(hashedId('document', ['a', 'b', 'c'])).not.toBe(hashedId('account', ['a', 'b', 'c']));
  });

  it('keeps part boundaries: ("a","bc") is not ("ab","c")', () => {
    expect(hashedId('account', ['a', 'bc'])).not.toBe(hashedId('account', ['ab', 'c']));
  });
});

describe('on two stores', () => {
  let dir: string;
  let a: AppDb;
  let b: AppDb;
  let storeA: CoreStore;
  let storeB: CoreStore;
  let bTx: WriteTx;
  let readerA: Database.Database;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ids-'));
    a = await openDb(path.join(dir, 'a.db'));
    b = await openDb(path.join(dir, 'b.db'));
    migrate(a._conn!);
    migrate(b._conn!);
    storeA = openStore(a, deps);
    storeB = openStore(b, deps);
    bTx = createWriteTx(b._conn!, { detectLanguages: () => ['eng'], now: () => new Date().toISOString() });
    readerA = new Database(path.join(dir, 'a.db'), { readonly: true });
  });
  afterEach(async () => {
    readerA.close();
    await a.close();
    await b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const ids = (c: Database.Database) => ({
    accounts: c.prepare(`SELECT id FROM accounts ORDER BY id`).all(),
    documents: c.prepare(`SELECT id FROM documents ORDER BY id`).all(),
  });

  it('the same natural key gives the same ids', async () => {
    const x = await storeA.createAccount({ source: 'gmail', identifier: 'me@x.com' });
    const y = await storeB.createAccount({ source: 'gmail', identifier: 'me@x.com' });
    expect(x.id).toBe(y.id);
    await storeA.commit({ account: x.id, documents: [doc('m1')], cursor: null });
    await storeB.commit({ account: y.id, documents: [doc('m1')], cursor: null });
    expect(ids(a._conn!)).toEqual(ids(b._conn!));
  });

  it('a different natural key gives a different id', async () => {
    const x = await storeA.createAccount({ source: 'gmail', identifier: 'me@x.com' });
    const y = await storeA.createAccount({ source: 'gmail', identifier: 'you@x.com' });
    expect(x.id).not.toBe(y.id);
  });

  it('existing rows keep their ids', async () => {
    const x = await storeA.createAccount({ source: 'gmail', identifier: 'me@x.com' });
    a._conn!.prepare(`UPDATE accounts SET id = 'old-random-id'`).run();
    a._conn!.prepare(`UPDATE documents SET account_id = 'old-random-id'`).run();
    await storeA.commit({ account: 'old-random-id' as never, documents: [doc('m1')], cursor: null });
    const before = ids(a._conn!);
    await storeA.commit({ account: 'old-random-id' as never, documents: [doc('m1', 'changed')], cursor: null });
    expect(ids(a._conn!)).toEqual(before);
    expect(x.id).not.toBe('old-random-id');
  });

  it('a document re-read after takeover upserts, not duplicates', async () => {
    // B copied A's rows, then leads and reads the same message again.
    b._conn!.prepare(`UPDATE sync_state SET role = 'follower'`).run();
    enableTracking(a._conn!);
    const x = await storeA.createAccount({ source: 'gmail', identifier: 'me@x.com' });
    await storeA.commit({ account: x.id, documents: [doc('m1')], cursor: null });
    const out = path.join(dir, 'stage');
    const r = buildDelta(readerA, { seq: 0, cursor: 0 }, 0, out, 1e9);
    if (r.status !== 'ok') throw new Error(r.status);
    bTx.applyDelta(out);
    b._conn!.prepare(`UPDATE sync_state SET role = 'normal'`).run();
    await storeB.commit({ account: x.id, documents: [doc('m1', 'read again')], cursor: null });
    const rows = b._conn!.prepare(`SELECT id, markdown FROM documents`).all() as { id: string; markdown: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].markdown).toBe('read again');
    expect(rows[0].id).toBe((a._conn!.prepare(`SELECT id FROM documents`).get() as { id: string }).id);
  });

  it('an independent re-read on a device that never copied the row still lands on one id', async () => {
    const x = await storeA.createAccount({ source: 'gmail', identifier: 'me@x.com' });
    await storeA.commit({ account: x.id, documents: [doc('m1')], cursor: null });
    enableTracking(a._conn!);
    await storeB.createAccount({ source: 'gmail', identifier: 'me@x.com' });
    await storeB.commit({ account: x.id, documents: [doc('m1', 'second reader')], cursor: null });
    expect(ids(b._conn!).documents).toEqual(ids(a._conn!).documents);
  });
});
