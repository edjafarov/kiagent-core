/** A follower whose search index is damaged: the apply names it, the repair cures it. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import {
  migrate,
  repairSearchIndex,
  SEARCH_INDEX_REPAIR_WINDOW_MS,
} from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { createWriteTx, type WriteTx } from '../../store/write-tx';
import { buildDelta, type SyncCursor } from '../delta';
import { enableTracking } from '../tracking';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string, markdown: string): DocumentInput => ({
  externalId,
  type: 'file',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: null,
});

let dir: string;
let source: AppDb;
let sourceStore: CoreStore;
let dest: AppDb;
let destTx: WriteTx;
let reader: Database.Database;
let stage: string;
let after: SyncCursor;
let accountId: string;

const dst = () => dest._conn!;
const build = () => {
  const r = buildDelta(reader, after, 0, stage, 250 * 1024 * 1024);
  if (r.status !== 'ok') throw new Error(r.status);
};
const apply = () => {
  const res = destTx.applyDelta(stage);
  after = res.target;
  return res;
};
const ftsOk = (c: Database.Database, t: string): boolean => {
  try {
    c.prepare(`INSERT INTO ${t}(${t}) VALUES('integrity-check')`).run();
    return true;
  } catch {
    return false;
  }
};
/** Rows in `_data` for segment ids the structure record does not list: the
 *  damage found on a real follower. The next segment FTS5 writes collides. */
const orphanSegments = (c: Database.Database) => {
  c.unsafeMode(true); // shadow tables are read-only in defensive mode
  try {
    const put = c.prepare(
      `INSERT OR IGNORE INTO documents_fts_data(id, block) VALUES(?, x'00')`,
    );
    // `_data` is written with REPLACE; `_idx` (segid, term, pgno) with a plain
    // INSERT, so a stale idx row is what makes the next new segment collide.
    const idx = c.prepare(
      `INSERT OR IGNORE INTO documents_fts_idx(segid, term, pgno) VALUES(?, x'', 2)`,
    );
    for (let seg = 1n; seg <= 200n; seg++) {
      put.run((seg << 37n) + 1n);
      idx.run(seg);
    }
  } finally {
    c.unsafeMode(false);
  }
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-repair-'));
  const file = path.join(dir, 'src.db');
  source = await openDb(file);
  migrate(source._conn!);
  sourceStore = openStore(source, deps);
  enableTracking(source._conn!);
  dest = await openDb(path.join(dir, 'dst.db'));
  migrate(dst());
  dst().prepare(`UPDATE sync_state SET role = 'follower'`).run();
  destTx = createWriteTx(dst(), {
    detectLanguages: () => ['eng'],
    now: () => new Date().toISOString(),
  });
  reader = new Database(file, { readonly: true });
  stage = path.join(dir, 'stage');
  after = { seq: 0, cursor: 0 };
  accountId = (
    await sourceStore.createAccount({ source: 'test', identifier: 'a@b' })
  ).id;
  await sourceStore.commit({
    account: accountId as never,
    documents: [doc('d1', 'alpha'), doc('d2', 'bravo')],
    cursor: null,
  });
  build();
  apply();
});
afterEach(async () => {
  reader.close();
  await source.close();
  await dest.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const damageAndPull = async () => {
  orphanSegments(dst());
  await sourceStore.commit({
    account: accountId as never,
    documents: [doc('d1', 'charlie'), doc('d3', 'delta')],
    cursor: null,
  });
  build();
};

it('an apply that fails on a damaged search index says so with code search-index', async () => {
  await damageAndPull();
  let err: unknown;
  try {
    apply();
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string }).code).toBe('search-index');
  // The whole apply rolled back: d3 is not there.
  expect(
    dst().prepare(`SELECT 1 FROM documents WHERE title = 'd3'`).get(),
  ).toBeUndefined();
});

it('the repair rebuilds the index and the same stage then applies', async () => {
  await damageAndPull();
  expect(() => apply()).toThrow();
  expect(repairSearchIndex(dst(), Date.now())).toBe('repaired');
  expect(ftsOk(dst(), 'documents_fts')).toBe(true);
  expect(ftsOk(dst(), 'documents_tri')).toBe(true);
  apply();
  const hits = dst()
    .prepare(
      `SELECT doc_id FROM documents_fts WHERE documents_fts MATCH 'charlie'`,
    )
    .all();
  expect(hits).toHaveLength(1);
});

it('a second repair inside the window is skipped', async () => {
  await damageAndPull();
  const t = Date.now();
  expect(repairSearchIndex(dst(), t)).toBe('repaired');
  orphanSegments(dst());
  expect(repairSearchIndex(dst(), t + SEARCH_INDEX_REPAIR_WINDOW_MS - 1)).toBe(
    'skipped',
  );
  expect(repairSearchIndex(dst(), t + SEARCH_INDEX_REPAIR_WINDOW_MS + 1)).toBe(
    'repaired',
  );
});

it('stale index rows that integrity-check misses are cleared by the repair', async () => {
  await damageAndPull();
  expect(ftsOk(dst(), 'documents_fts')).toBe(true); // the check alone cannot see it
  expect(() => apply()).toThrow();
  expect(repairSearchIndex(dst(), Date.now())).toBe('repaired');
  expect(
    dst()
      .prepare(`SELECT count(*) n FROM documents_fts_idx WHERE segid > 100`)
      .get(),
  ).toEqual({ n: 0 });
});

it('an apply error that is not about the search index keeps its own error', () => {
  fs.writeFileSync(stage, 'not a stage');
  let err: unknown;
  try {
    apply();
  } catch (e) {
    err = e;
  }
  expect((err as { code?: string }).code).not.toBe('search-index');
});
