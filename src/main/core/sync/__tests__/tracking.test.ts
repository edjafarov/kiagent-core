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
  copiedSetDigest,
  copiedTables,
} from '../tables';
import { disableTracking, enableTracking, ensureSyncTriggers } from '../tracking';
import { readSyncStatus } from '../status';
import {
  addOutbox,
  descriptor,
  physical,
  registerPlugin,
} from './synced-plugin';

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
const account = () =>
  store.createAccount({ source: 'test', identifier: 'a@b' });
const commit = (
  id: Awaited<ReturnType<typeof account>>['id'],
  documents: DocumentInput[],
) => store.commit({ account: id, documents, cursor: null });

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
  expect([...COPIED_CORE_TABLES]).toEqual([
    'accounts',
    'documents',
    'outbox',
    'event_drafts',
    'sync_epochs',
    'attention_items',
    'attention_revisions',
  ]);
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
    .prepare(
      `SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_%'`,
    )
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
  const row = conn().prepare(`SELECT id, seq FROM documents`).get() as {
    id: string;
    seq: number;
  };
  enableTracking(conn());
  conn()
    .prepare(`UPDATE documents SET scope_root_id='r2' WHERE id=?`)
    .run(row.id);
  expect(entries().filter((e) => e.tbl === 'documents')).toEqual([
    { tbl: 'documents', pk: JSON.stringify([row.id]) },
  ]);
});

it('a documents delete writes one entry', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  const { id } = conn().prepare(`SELECT id FROM documents`).get() as {
    id: string;
  };
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
  const first = conn().prepare(`SELECT cursor FROM sync_rows`).get() as {
    cursor: number;
  };
  conn().prepare(`UPDATE accounts SET cursor='2' WHERE id=?`).run(a.id);
  const rows = conn().prepare(`SELECT cursor FROM sync_rows`).all() as {
    cursor: number;
  }[];
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
    (
      conn().prepare(`SELECT history_id h FROM sync_state`).get() as {
        h: string;
      }
    ).h;
  const first = h();
  expect(first).toBeTruthy();
  enableTracking(conn());
  expect(h()).toBe(first);
});

it('enableTracking marks the device joined', () => {
  expect(conn().prepare(`SELECT joined FROM sync_state`).get()).toEqual({
    joined: 0,
  });
  enableTracking(conn());
  expect(conn().prepare(`SELECT joined FROM sync_state`).get()).toEqual({
    joined: 1,
  });
});

describe('synced plugin tables', () => {
  const file = () => path.join(dir, 'a.db');

  it('a synced plugin table gets triggers from its composite key', async () => {
    const registry = await registerPlugin(file(), conn());
    void registry;
    enableTracking(conn());
    const t = physical('notes');
    conn()
      .prepare(`INSERT INTO "${t}"(account_id, key, body) VALUES('a','k','x')`)
      .run();
    conn().prepare(`UPDATE "${t}" SET body='y' WHERE account_id='a'`).run();
    conn().prepare(`UPDATE "${t}" SET key='k2' WHERE account_id='a'`).run();
    conn().prepare(`DELETE FROM "${t}"`).run();
    const got = entries().filter((e) => e.tbl === t);
    expect(got.map((e) => e.pk).sort()).toEqual([
      JSON.stringify(['a', 'k']),
      JSON.stringify(['a', 'k2']),
    ]);
    // An unlisted table of the same plugin is not tracked.
    conn()
      .prepare(`INSERT INTO "${physical('local_x')}"(id, v) VALUES('1','v')`)
      .run();
    expect(entries().some((e) => e.tbl === physical('local_x'))).toBe(false);
  });

  it('an upsert or an OR-clause write of a tracked row succeeds and moves its cursor', async () => {
    // SQLite applies the OUTER statement's conflict policy to a trigger body,
    // so `INSERT OR REPLACE` inside the trigger aborted every plugin upsert.
    await registerPlugin(file(), conn());
    enableTracking(conn());
    const t = physical('notes');
    const upsert = `INSERT INTO "${t}"(account_id, key, body) VALUES('a','k',?)
      ON CONFLICT(account_id, key) DO UPDATE SET body = excluded.body`;
    conn().prepare(upsert).run('x');
    const first = conn()
      .prepare(`SELECT cursor FROM sync_rows WHERE tbl = ?`)
      .get(t) as { cursor: number };
    expect(() => conn().prepare(upsert).run('y')).not.toThrow();
    expect(() =>
      conn().prepare(`UPDATE OR ABORT "${t}" SET body = 'z'`).run(),
    ).not.toThrow();
    expect(() =>
      conn()
        .prepare(
          `INSERT OR IGNORE INTO "${t}"(account_id, key, body) VALUES('a','k','w')`,
        )
        .run(),
    ).not.toThrow();
    const rows = conn()
      .prepare(`SELECT cursor FROM sync_rows WHERE tbl = ?`)
      .all(t) as { cursor: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].cursor).toBeGreaterThan(first.cursor);
  });

  it('re-creating triggers replaces an older body under the same name', async () => {
    await registerPlugin(file(), conn());
    enableTracking(conn());
    const t = physical('notes');
    conn().exec(`DROP TRIGGER "sync_i_${t}";
      CREATE TRIGGER "sync_i_${t}" AFTER INSERT ON "${t}" BEGIN SELECT 1; END;`);
    ensureSyncTriggers(conn());
    const { sql } = conn()
      .prepare(`SELECT sql FROM sqlite_master WHERE name = ?`)
      .get(`sync_i_${t}`) as { sql: string };
    expect(sql).toContain('sync_rows');
  });

  it('every copied core table gets triggers when tracking starts', () => {
    enableTracking(conn());
    const names = (
      conn()
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_%'`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const t of [
      'outbox',
      'event_drafts',
      'sync_epochs',
      'attention_items',
      'attention_revisions',
    ]) {
      expect(names).toEqual(
        expect.arrayContaining([`sync_i_${t}`, `sync_u_${t}`, `sync_d_${t}`]),
      );
    }
  });

  it('a plugin migration adding a synced table while tracking generates its triggers', async () => {
    enableTracking(conn());
    await registerPlugin(file(), conn());
    const names = (
      conn()
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_%'`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        `sync_i_${physical('notes')}`,
        `sync_d_${physical('blobs')}`,
      ]),
    );
    expect(names.some((n) => n.includes(physical('local_x')))).toBe(false);
    conn()
      .prepare(
        `INSERT INTO "${physical('blobs')}"(id, data) VALUES('b', x'01')`,
      )
      .run();
    expect(entries()).toContainEqual({ tbl: physical('blobs'), pk: '["b"]' });
  });

  it('copiedTables lists the core tables then the physical synced names', async () => {
    expect(copiedTables(conn())).toEqual([...COPIED_CORE_TABLES]);
    await registerPlugin(file(), conn());
    expect(copiedTables(conn())).toEqual([
      ...COPIED_CORE_TABLES,
      physical('notes'),
      physical('blobs'),
    ]);
  });

  it('status reports the copied-set digest', () => {
    expect(readSyncStatus(conn()).copiedSet).toBe(copiedSetDigest(conn()));
  });

  it('copiedSetDigest changes with the version, the table list and a descriptor digest, and not with row data', async () => {
    const d0 = copiedSetDigest(conn());
    expect(copiedSetDigest(conn())).toBe(d0);
    const a = await account();
    await commit(a.id, [doc('d1')]);
    addOutbox(conn(), a.id, 'o');
    expect(copiedSetDigest(conn())).toBe(d0);
    conn()
      .prepare(`UPDATE meta SET value = value + 1 WHERE key='schemaVersion'`)
      .run();
    const d1 = copiedSetDigest(conn());
    expect(d1).not.toBe(d0);
    conn()
      .prepare(`UPDATE meta SET value = value - 1 WHERE key='schemaVersion'`)
      .run();
    const registry = await registerPlugin(file(), conn());
    const d2 = copiedSetDigest(conn());
    expect(d2).not.toBe(d0);
    // A later descriptor with another synced table: table list and digest move.
    await registry.register({
      pluginId: 'test.syncplug',
      descriptor: descriptor({ synced: ['notes'] }),
      legacyPath: file(),
    });
    expect(copiedSetDigest(conn())).not.toBe(d2);
  });
});
