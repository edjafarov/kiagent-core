/** @jest-environment node */
/** Step 2: outbox and event drafts write through the generic database handle,
 *  outside the writer guard, so on a follower they must refuse on their own
 *  (one write authority per copied table, spec 7.8 ruling 7). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { SyncReadOnly } from '../role';
import { readGuardedDb } from '../read-guard';

let dir: string;
let db: AppDb;
let ro = false;
let store: CoreStore;

beforeEach(async () => {
  ro = false;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-read-guard-'));
  db = await openDb(path.join(dir, 'k.db'));
  store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => [],
    readOnly: () => ro,
  } as never);
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const draft = async () => {
  const a = await store.createAccount({ source: 'gmail', identifier: 'a@x' });
  return store.outbox.create({
    accountId: a.id,
    kind: 'new',
    recipientDisplay: 'r',
    to: ['r@x'],
    cc: [],
    subject: 's',
    bodyMarkdown: 'b',
    confirmMode: 'review',
    createdVia: 'panel',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  } as never);
};

it('the outbox refuses a write on a follower and works after the role flips, without a restart', async () => {
  const a = await draft();
  ro = true;
  await expect(draft()).rejects.toBeInstanceOf(SyncReadOnly);
  await expect(store.outbox.transition(a.id, ['draft'], 'cancelled' as never)).rejects.toBeInstanceOf(SyncReadOnly);
  expect((await store.outbox.get(a.id))?.id).toBe(a.id); // reads work
  ro = false;
  await expect(draft()).resolves.toBeDefined();
});

it('the maintenance sweeps are quiet on a follower: the leader owns expiry', async () => {
  ro = true;
  await expect(store.outbox.expireOverdue()).resolves.toBeUndefined();
  await expect(store.eventDrafts.expireOverdue()).resolves.toBe(0);
  await expect(store.eventDrafts.recoverOrphanedCreating()).resolves.toBe(0);
  await expect(store.outbox.recoverOrphanedSending()).resolves.toBeUndefined();
});

it('event drafts refuse a write on a follower', async () => {
  ro = true;
  await expect(
    store.eventDrafts.discard('nope'),
  ).rejects.toBeInstanceOf(SyncReadOnly);
});

it('readGuardedDb lets reads and WITH-selects through, refuses every other statement', async () => {
  const g = readGuardedDb(db, () => true);
  await expect(g.all('SELECT 1 AS x')).resolves.toEqual([{ x: 1 }]);
  await expect(g.all('WITH t AS (SELECT 1 AS x) SELECT x FROM t')).resolves.toEqual([{ x: 1 }]);
  await expect(g.run(`INSERT INTO meta(key,value) VALUES('k','v')`)).rejects.toBeInstanceOf(SyncReadOnly);
  await expect(g.exec(`DELETE FROM meta`)).rejects.toBeInstanceOf(SyncReadOnly);
  await expect(
    g.batch([{ sql: 'SELECT 1' }, { sql: ` update meta SET value='x'` }]),
  ).rejects.toBeInstanceOf(SyncReadOnly);
  await expect(g.batch([{ sql: 'SELECT 1 AS x' }])).resolves.toHaveLength(1);
});
