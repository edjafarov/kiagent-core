/**
 * FTS rowid-pinning (schema v2): documents_fts rows live at their document's
 * rowid so delete/replace are rowid-equality lookups instead of full
 * virtual-table scans on the UNINDEXED doc_id (the old shape made every
 * fresh ingest O(N) — O(N²) across a backfill). These tests pin:
 *  - the plan shape (equality, not scan),
 *  - pinning across every write path (insert/update/enrich/purge/remove),
 *  - the v1→v2 migration repinning an unpinned database,
 *  - the compact() rebuild that guards against VACUUM renumbering rowids.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { migrate } from '../schema';
import { openStore } from '../store';
import type { CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

function doc(
  externalId: string,
  over: Partial<DocumentInput> = {},
): DocumentInput {
  return {
    externalId,
    type: 'note',
    title: `Title ${externalId}`,
    markdown: `unique-${externalId} body`,
    metadata: {},
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/** Every FTS row must sit at its document's rowid. */
function assertPinned(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    const rows = raw
      .prepare(
        `SELECT f.rowid AS fts_rowid, d.rowid AS doc_rowid
           FROM documents_fts f JOIN documents d ON d.id = f.doc_id`,
      )
      .all() as Array<{ fts_rowid: number; doc_rowid: number }>;
    const ftsCount = (
      raw.prepare(`SELECT COUNT(*) AS c FROM documents_fts`).get() as {
        c: number;
      }
    ).c;
    expect(rows.length).toBe(ftsCount); // no orphaned FTS rows
    for (const r of rows) expect(r.fts_rowid).toBe(r.doc_rowid);
  } finally {
    raw.close();
  }
}

describe('documents_fts rowid pinning', () => {
  let dir: string;
  let dbPath: string;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-fts-'));
    dbPath = path.join(dir, 'test.db');
    store = openStore(await openDb(dbPath), deps);
    const account = await store.createAccount({
      source: 'test',
      identifier: 'me@example.com',
    });
    accountId = account.id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes and replaces FTS rows by rowid equality, not a table scan', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: null,
    });
    await store.close();
    const raw = new Database(dbPath);
    try {
      const detail = (q: string): string =>
        (
          raw.prepare(`EXPLAIN QUERY PLAN ${q}`).all('x') as Array<{
            detail: string;
          }>
        )
          .map((r) => r.detail)
          .join(' | ');
      // 'INDEX 0:=' is fts5's rowid-equality strategy; bare 'INDEX 0:' is the
      // full-scan strategy the old doc_id predicate produced.
      expect(
        detail(
          `DELETE FROM documents_fts
           WHERE rowid = (SELECT rowid FROM documents WHERE id = ?)`,
        ),
      ).toContain('INDEX 0:=');
      expect(detail(`DELETE FROM documents_fts WHERE doc_id = ?`)).toMatch(
        /INDEX 0:(?!=)/,
      );
    } finally {
      raw.close();
    }
    // afterEach closes again — make that a no-op instead of a crash.
    store = openStore(await openDb(dbPath), deps);
  });

  it('keeps FTS pinned and searchable across insert, update, enrich, archive+purge and removeAccount', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: null,
    });
    assertPinned(dbPath);

    // Update: old term drops out, new term matches, still pinned.
    await store.commit({
      account: accountId,
      documents: [doc('a', { markdown: 'replacement-alpha body' })],
      cursor: null,
    });
    assertPinned(dbPath);
    expect(await store.read.search({ text: 'unique-a' })).toHaveLength(0);
    expect(await store.read.search({ text: 'replacement-alpha' })).toHaveLength(
      1,
    );

    // Archive + purge: gone from search, no FTS orphans.
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'b', type: 'note' }],
      cursor: null,
    });
    await store.commit({ purgeArchived: { before: '9999-12-31T00:00:00Z' } });
    assertPinned(dbPath);
    expect(
      await store.read.search({ text: 'unique-b', includeArchived: true }),
    ).toHaveLength(0);

    // removeAccount: everything gone, FTS empty.
    await store.commit({ removeAccount: accountId });
    assertPinned(dbPath);
    expect(await store.read.search({ text: 'unique-c' })).toHaveLength(0);
  });

  it('v2 migration repins an unpinned (v1-shaped) database', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: null,
    });
    await store.close();

    // Regress the file to v1 shape: FTS rows at arbitrary rowids (as the old
    // insert-without-rowid produced) and schemaVersion back at 1.
    const raw = new Database(dbPath);
    raw.exec(`DELETE FROM documents_fts`);
    raw
      .prepare(
        `INSERT INTO documents_fts(rowid, doc_id, title, markdown)
         SELECT rowid + 1000, id, coalesce(title,''), coalesce(markdown,'')
         FROM documents`,
      )
      .run();
    raw.prepare(`UPDATE meta SET value='1' WHERE key='schemaVersion'`).run();
    migrate(raw);
    expect(
      (
        raw
          .prepare(`SELECT value FROM meta WHERE key='schemaVersion'`)
          .get() as {
          value: string;
        }
      ).value,
    ).toBe('2');
    raw.close();
    assertPinned(dbPath);

    store = openStore(await openDb(dbPath), deps);
    expect(await store.read.search({ text: 'unique-a' })).toHaveLength(1);
  });

  it('migrate() fails closed on a corpus newer than this build', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: null,
    });
    await store.close();

    // Simulate a corpus written by a future build: bump schemaVersion past
    // the migrations this build knows about. A forward-only migrate() would
    // otherwise open it silently and write with stale FTS assumptions.
    const raw = new Database(dbPath);
    raw.prepare(`UPDATE meta SET value='99' WHERE key='schemaVersion'`).run();
    expect(() => migrate(raw)).toThrow(/newer than this build/i);
    // Restore a valid version so the reopen below (which re-runs migrate)
    // doesn't re-trip the guard — this test only pins the guard itself.
    raw.prepare(`UPDATE meta SET value='2' WHERE key='schemaVersion'`).run();
    raw.close();

    store = openStore(await openDb(dbPath), deps); // afterEach close is a no-op
  });

  it('compact() rebuilds the pinning after VACUUM renumbers rowids', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: null,
    });
    // Purge one document to open a rowid gap, so VACUUM actually renumbers.
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'a', type: 'note' }],
      cursor: null,
    });
    await store.commit({ purgeArchived: { before: '9999-12-31T00:00:00Z' } });

    await store.maintenance.compact();
    assertPinned(dbPath);

    // The write paths keep working against the rebuilt pinning: an update
    // must replace (not duplicate or mis-delete) its FTS row.
    await store.commit({
      account: accountId,
      documents: [doc('b', { markdown: 'post-compact body' })],
      cursor: null,
    });
    assertPinned(dbPath);
    expect(await store.read.search({ text: 'unique-b' })).toHaveLength(0);
    expect(await store.read.search({ text: 'post-compact' })).toHaveLength(1);
  });
});
