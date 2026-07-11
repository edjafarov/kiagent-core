import type BetterSqlite3 from 'better-sqlite3';

import { buildStemView } from '../stemming';

/**
 * Forward-only, versioned migrations. Each entry runs in one transaction;
 * `meta.schemaVersion` tracks the last applied index + 1.
 */
type Migration = string | ((db: BetterSqlite3.Database) => void);

const MIGRATIONS: Migration[] = [
  // v1 — the greenfield schema. Column names are storage detail (snake_case
  // SQL convention); row mappers in store.ts produce the camelCase domain
  // shapes from @shared/contracts.
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    identifier TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL,
    cursor TEXT,
    progress TEXT,
    last_sync_at TEXT,
    last_error TEXT,
    cadence TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(source, identifier)
  );

  CREATE TABLE documents (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT,
    markdown TEXT,
    url TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT,
    parent_id TEXT,
    content_hash TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    languages TEXT NOT NULL DEFAULT '[]',
    ingested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(account_id, external_id, type)
  );
  CREATE INDEX idx_documents_parent ON documents(parent_id);
  CREATE INDEX idx_documents_account_type ON documents(account_id, type);

  -- The feed: one ordered log of everything that changed. 'document' and
  -- 'account' rows materialize CURRENT state on read (log-compaction
  -- semantics); 'purge' / 'accountRemoved' are tombstones.
  CREATE TABLE changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('document','purge','account','accountRemoved')),
    ref_id TEXT NOT NULL,
    at TEXT NOT NULL
  );

  -- Durable cursors for feed consumers (workers, projections).
  CREATE TABLE consumers (
    name TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL DEFAULT 0
  );

  -- Per-consumer work ledger: change -> attempts/outcome. Engine-owned.
  CREATE TABLE work_ledger (
    consumer TEXT NOT NULL,
    seq INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    outcome TEXT CHECK (outcome IN ('done','skip','failed','deferred')),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (consumer, seq)
  );

  -- Encrypted credential blobs. ONE scheme.
  CREATE TABLE vault (
    account_id TEXT PRIMARY KEY,
    blob BLOB NOT NULL
  );

  -- Append-only consent history; latest row wins at host construction.
  CREATE TABLE consents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    extension_id TEXT NOT NULL,
    caps TEXT NOT NULL,
    manifest_version TEXT NOT NULL,
    granted_at TEXT NOT NULL
  );

  -- Durable scheduler state: last/next run per job id.
  CREATE TABLE schedule (
    job_id TEXT PRIMARY KEY,
    cadence TEXT NOT NULL,
    last_run TEXT,
    next_run TEXT
  );

  -- Full-text index, maintained INSIDE the commit transaction.
  CREATE VIRTUAL TABLE documents_fts USING fts5(
    doc_id UNINDEXED,
    title,
    markdown,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,

  // v2 — pin each documents_fts row's rowid to its document's rowid.
  // doc_id is UNINDEXED, so "DELETE FROM documents_fts WHERE doc_id = ?" was
  // a full virtual-table scan per call — O(N²) across a mail backfill. With
  // the rowid pinned, delete/replace become rowid-equality lookups while the
  // search SQL (which joins on doc_id) stays byte-for-byte unchanged.
  // Archived rows are included: archiving leaves FTS intact today.
  // NOTE: documents has a TEXT primary key, so its implicit rowids can be
  // renumbered by VACUUM — every VACUUM of a non-empty corpus must re-run
  // this same delete-all + repopulate (see maintenance.compact in store.ts).
  `
  DELETE FROM documents_fts;
  INSERT INTO documents_fts(rowid, doc_id, title, markdown)
    SELECT rowid, id, coalesce(title, ''), coalesce(markdown, '')
    FROM documents;
  `,

  // v3 — search parity (docs/superpowers/specs/2026-07-11-search-parity-design.md):
  // stem columns on documents_fts (snowball, per-document language) and a
  // trigram table for substring-recall fuzzy fallback. A FUNCTION migration:
  // the backfill stems text in JS, which a SQL string cannot express. DROPs
  // are IF EXISTS so a re-run against an already-v3-shaped file (version
  // regression in tests) is idempotent. Raw columns keep positions 1/2, so
  // snippet(documents_fts, 2, …) and the search JOIN are unchanged.
  (db: BetterSqlite3.Database): void => {
    db.exec(`
      DROP TABLE IF EXISTS documents_fts;
      DROP TABLE IF EXISTS documents_tri;
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        doc_id UNINDEXED,
        title,
        markdown,
        title_stem,
        markdown_stem,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE documents_tri USING fts5(
        doc_id UNINDEXED,
        body,
        tokenize = 'trigram remove_diacritics 1'
      );
    `);
    repopulateSearchIndex(db);
  },
];

/**
 * Clear and refill BOTH search tables from `documents`, rowid-pinned,
 * stemming each row with its stored languages. Used by the v3 migration and
 * by maintenance.compact (VACUUM can renumber documents rowids — see the v2
 * note above).
 *
 * Runs as ONE transaction (better-sqlite3 nests as a SAVEPOINT, so calling
 * this from inside the v3 migration's own transaction is safe): a rebuild
 * that dies partway must never leave the search tables half-repopulated. The
 * corpus is read in rowid-ordered pages rather than one `.all()` over every
 * document — better-sqlite3 forbids `.iterate()` while writing on the same
 * connection, so a chunked `.all()` loop is the shape that avoids
 * materializing the whole corpus in memory at once.
 */
export function repopulateSearchIndex(db: BetterSqlite3.Database): void {
  db.transaction(() => {
    db.exec(`DELETE FROM documents_fts; DELETE FROM documents_tri;`);
    const page = db.prepare(
      `SELECT rowid AS rid, id, title, markdown, languages FROM documents
       WHERE rowid > ? ORDER BY rowid LIMIT 1000`,
    );
    const fts = db.prepare(
      `INSERT INTO documents_fts(rowid, doc_id, title, markdown, title_stem, markdown_stem)
       VALUES(?, ?, ?, ?, ?, ?)`,
    );
    const tri = db.prepare(
      `INSERT INTO documents_tri(rowid, doc_id, body) VALUES(?, ?, ?)`,
    );
    let last = 0;
    for (;;) {
      const rows = page.all(last) as Array<{
        rid: number;
        id: string;
        title: string | null;
        markdown: string | null;
        languages: string;
      }>;
      if (rows.length === 0) break;
      for (const r of rows) {
        let langs: string[];
        try {
          langs = JSON.parse(r.languages) as string[];
        } catch {
          throw new Error(
            `repopulateSearchIndex: corrupt languages JSON on document ${r.id}`,
          );
        }
        const title = r.title ?? '';
        const markdown = r.markdown ?? '';
        fts.run(
          r.rid,
          r.id,
          title,
          markdown,
          buildStemView(title, langs),
          buildStemView(markdown, langs),
        );
        tri.run(r.rid, r.id, `${title}\n${markdown}`.trim());
      }
      last = rows[rows.length - 1].rid;
    }
  })();
}

export function migrate(db: BetterSqlite3.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const hasMeta = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='meta'`,
    )
    .get();
  let version = 0;
  if (hasMeta) {
    const row = db
      .prepare(`SELECT value FROM meta WHERE key='schemaVersion'`)
      .get() as { value: string } | undefined;
    version = row ? Number(row.value) : 0;
  }
  // Fail closed on a corpus written by a NEWER build. Migrations are
  // forward-only, so an older build silently skips the loop and then writes
  // with its outdated assumptions — since v2 (FTS rowid pinning) the corpus
  // now carries a cross-version storage invariant, so a downgrade that writes
  // can corrupt the FTS index. Refuse to open instead. (The corpus is a
  // rebuildable cache; the user can reinstall the matching build.)
  if (version > MIGRATIONS.length) {
    throw new Error(
      `corpus schema v${version} is newer than this build supports ` +
        `(v${MIGRATIONS.length}). Update the app to the latest version to open ` +
        `this database.`,
    );
  }
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    db.transaction(() => {
      const m = MIGRATIONS[i];
      if (typeof m === 'string') db.exec(m);
      else m(db);
      db.prepare(
        `INSERT INTO meta(key, value) VALUES('schemaVersion', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(i + 1));
    })();
  }
}
