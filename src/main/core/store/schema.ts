import type BetterSqlite3 from 'better-sqlite3';

/**
 * Forward-only, versioned migrations. Each entry runs in one transaction;
 * `meta.schemaVersion` tracks the last applied index + 1.
 */
const MIGRATIONS: string[] = [
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
];

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
      db.exec(MIGRATIONS[i]);
      db.prepare(
        `INSERT INTO meta(key, value) VALUES('schemaVersion', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(i + 1));
    })();
  }
}
