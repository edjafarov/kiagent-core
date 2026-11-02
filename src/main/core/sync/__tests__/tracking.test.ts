/** Multi-device sync, spec section 7.6: tracker and table classification. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import {
  COPIED_CORE_TABLES,
  isDerivedTable,
  LOCAL_CORE_TABLES,
} from '../tables';
import { disableTracking, enableTracking } from '../tracking';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string, markdown = 'body'): DocumentInput => ({
  externalId,
  type: 'file',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: null,
});

let db: AppDb;
let store: CoreStore;
let dir: string;
const conn = () => db._conn!;
const entries = () =>
  conn().prepare(`SELECT tbl, pk FROM sync_rows ORDER BY cursor`).all() as {
    tbl: string;
    pk: string;
  }[];
const account = () => store.createAccount({ source: 'test', identifier: 'a@b' });
const commit = (id: Awaited<ReturnType<typeof account>>['id'], documents: DocumentInput[]) =>
  store.commit({ account: id, documents, cursor: null });

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-track-'));
  db = await openDb(path.join(dir, 'a.db'));
  migrate(conn());
  store = openStore(db, deps);
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('every core table is classified as copied, local or derived', () => {
  const names = (
    conn()
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const unknown = names.filter(
    (n) =>
      !COPIED_CORE_TABLES.includes(n) &&
      !LOCAL_CORE_TABLES.includes(n) &&
      !isDerivedTable(n),
  );
  expect(unknown).toEqual([]);
  expect([...COPIED_CORE_TABLES]).toEqual(['accounts', 'documents']);
});

it('no copied table lacks a primary key', () => {
  for (const t of COPIED_CORE_TABLES) {
    const pk = conn()
      .prepare(`SELECT name FROM pragma_table_info(?) WHERE pk>0`)
      .all(t);
    expect(pk.length).toBeGreaterThan(0);
  }
});

it('creates nothing until enabled: no sync trigger exists after migrations', () => {
  const n = conn()
    .prepare(`SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_%'`)
    .get() as { n: number };
  expect(n.n).toBe(0);
});

it('a normal documents insert and seq-advancing update write no documents entries', async () => {
  const a = await account();
  enableTracking(conn());
  await commit(a.id, [doc('d1')]);
  await commit(a.id, [doc('d1', 'changed')]);
  expect(entries().filter((e) => e.tbl === 'documents')).toEqual([]);
});

it('a documents update that keeps seq writes one entry', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  const row = conn().prepare(`SELECT id, seq FROM documents`).get() as { id: string; seq: number };
  enableTracking(conn());
  conn().prepare(`UPDATE documents SET scope_root_id='r2' WHERE id=?`).run(row.id);
  expect(entries().filter((e) => e.tbl === 'documents')).toEqual([
    { tbl: 'documents', pk: JSON.stringify([row.id]) },
  ]);
});

it('a documents delete writes one entry', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  const { id } = conn().prepare(`SELECT id FROM documents`).get() as { id: string };
  enableTracking(conn());
  conn().prepare(`DELETE FROM documents WHERE id=?`).run(id);
  expect(entries()).toEqual([{ tbl: 'documents', pk: JSON.stringify([id]) }]);
});

it('removing an account tracks the account and each of its documents', async () => {
  const a = await account();
  await commit(a.id, [doc('d1'), doc('d2')]);
  enableTracking(conn());
  conn().prepare(`DELETE FROM accounts WHERE id=?`).run(a.id);
  const got = entries();
  expect(got.filter((e) => e.tbl === 'documents')).toHaveLength(2);
  expect(got.filter((e) => e.tbl === 'accounts')).toHaveLength(1);
});

it('an account update replaces its one entry and moves its cursor', async () => {
  const a = await account();
  enableTracking(conn());
  conn().prepare(`UPDATE accounts SET cursor='1' WHERE id=?`).run(a.id);
  const first = conn().prepare(`SELECT cursor FROM sync_rows`).get() as { cursor: number };
  conn().prepare(`UPDATE accounts SET cursor='2' WHERE id=?`).run(a.id);
  const rows = conn().prepare(`SELECT cursor FROM sync_rows`).all() as { cursor: number }[];
  expect(rows).toHaveLength(1);
  expect(rows[0].cursor).toBeGreaterThan(first.cursor);
});

it('tracking=0 records nothing', async () => {
  const a = await account();
  enableTracking(conn());
  disableTracking(conn());
  conn().prepare(`UPDATE accounts SET cursor='1' WHERE id=?`).run(a.id);
  expect(entries()).toEqual([]);
});

it('enabling twice keeps one history id', () => {
  enableTracking(conn());
  const h = () =>
    (conn().prepare(`SELECT history_id h FROM sync_state`).get() as { h: string }).h;
  const first = h();
  expect(first).toBeTruthy();
  enableTracking(conn());
  expect(h()).toBe(first);
});

it('enableTracking marks the device joined', () => {
  expect(conn().prepare(`SELECT joined FROM sync_state`).get()).toEqual({ joined: 0 });
  enableTracking(conn());
  expect(conn().prepare(`SELECT joined FROM sync_state`).get()).toEqual({ joined: 1 });
});
