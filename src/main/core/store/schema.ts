import type BetterSqlite3 from 'better-sqlite3';

import { VISUAL_EXTS } from '@main/workers/vision/classify';
import {
  decideFileIndexing,
  type FileIndexCandidate,
} from '@shared/file-indexability';

import { buildStemView } from '../stemming';

/** WHERE text shared VERBATIM by the stats queries in store.ts and the partial
 *  indexes below — SQLite only uses a partial index when the query's WHERE
 *  implies the index's WHERE, which identical text guarantees. Never edit one
 *  side without the other (they can't drift: both read these constants). */
export const EXTRACTED_DOCS_WHERE = `json_extract(metadata,'$.extraction') IS NOT NULL AND archived_at IS NULL`;

export const PENDING_VISUAL_WHERE = `json_extract(metadata,'$.extraction') IS NULL
   AND type IN ('attachment','file')
   AND (markdown IS NULL OR length(trim(markdown)) < 16)
   AND (json_extract(metadata,'$.mime') LIKE 'image/%'
        OR json_extract(metadata,'$.mime') = 'application/pdf'
        OR lower(json_extract(metadata,'$.ext')) IN (${VISUAL_EXTS.map((e) => `'${e}'`).join(',')}))
   AND archived_at IS NULL`;

const QUERY_INDEXES: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: 'docs_extracted',
    sql: `CREATE INDEX docs_extracted ON documents(updated_at DESC, seq DESC) WHERE ${EXTRACTED_DOCS_WHERE}`,
  },
  {
    name: 'docs_pending_visual',
    sql: `CREATE INDEX docs_pending_visual ON documents(id) WHERE ${PENDING_VISUAL_WHERE}`,
  },
  // Backs the per-account startup projection (app-projection.ts's init()):
  // read.count({account}) becomes an index range scan, and read.search({
  // account, limit}) (textless branch, store.ts search()) gets its ORDER BY
  // COALESCE(created_at, ingested_at) DESC for free from the index — no temp
  // B-tree sort over the account's whole row set. The query's own WHERE
  // (archived_at IS NULL AND account_id=?) implies this index's partial WHERE,
  // so no store.ts change is needed for the planner to match it.
  {
    name: 'docs_account_recency',
    sql: `CREATE INDEX docs_account_recency ON documents(account_id, COALESCE(created_at, ingested_at) DESC) WHERE archived_at IS NULL`,
  },
];

/**
 * Idempotent, self-healing query-performance indexes. Runs on every open
 * (end of migrate()): compares each desired CREATE INDEX text against
 * sqlite_master and drops+recreates on mismatch — so a future definition
 * change (e.g. VISUAL_EXTS) rebuilds the affected index automatically
 * instead of silently regressing to a full scan or a temp B-tree sort.
 * First build on a large corpus is a one-time table scan at boot.
 *
 * Degrade, don't fail: this runs synchronously inside migrate(), which
 * openDb() awaits before the corpus is usable at all. A failed build (e.g.
 * SQLITE_BUSY, or disk pressure mid-scan while indexing a 324k-row table) is
 * caught per-index, logged, and skipped — it must NEVER throw out of here and
 * block opening the corpus. Worst case on failure: sqlite_master keeps
 * whatever it had (stale/missing index, rolled back by the failed
 * transaction), the affected query silently falls back to a full scan/sort,
 * and the next migrate() (next app start) retries the build.
 */
export function ensureQueryIndexes(db: BetterSqlite3.Database): void {
  for (const { name, sql } of QUERY_INDEXES) {
    try {
      const row = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
        .get(name) as { sql: string } | undefined;
      if (row?.sql === sql) continue;
      db.transaction(() => {
        db.exec(`DROP INDEX IF EXISTS ${name}`);
        db.exec(sql);
      })();
    } catch (err) {
      // A main-process console.warn is the idiomatic fallback for a
      // non-fatal, no-logSink-available case (see outbound/pages.ts's css()
      // for the same pattern) — this is purely a query-performance index,
      // never a reason to fail opening the corpus.
      console.warn(
        `ensureQueryIndexes: failed to build index ${name} — the query it backs falls back to a full scan until this succeeds`,
        err,
      );
    }
  }
}

/**
 * Forward-only, versioned migrations. Each entry runs in one transaction;
 * `meta.schemaVersion` tracks the last applied index + 1.
 */
type Migration = string | ((db: BetterSqlite3.Database) => void);

/** Row shape the v2 cleanup migration's paging query reads. */
interface CandidateRow {
  rid: number;
  id: string;
  title: string | null;
  metadata: string;
  source: string;
}

const readString = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;
const readFiniteNumber = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Builds the `@shared/file-indexability` candidate shape for a v2-migration
 * row, per the metadata alias precedence confirmed against a real 11 GB dev
 * corpus (both spellings genuinely coexist — a Drive `file` row carries
 * `mime` AND `mime_type`, `size_bytes` AND `sizeBytes`; a local-folder row
 * carries `mime`, `filename`, `ext`, `absPath`, `size` and `sizeBytes`):
 *   mime:     metadata.mime, then metadata.mime_type
 *   filename: metadata.filename, then the document's title, then ''
 *   size:     metadata.sizeBytes, metadata.size_bytes, then metadata.size
 *   path:     metadata.absPath, then filename
 * `local-folder` maps to profile 'local-folder'; the caller only ever passes
 * rows already filtered to the three known `a.source` values, so anything
 * else (i.e. `google-docs` / `onedrive`) maps to 'cloud-drive'.
 */
function candidateFromRow(
  row: Pick<CandidateRow, 'title' | 'source'>,
  metadata: Record<string, unknown>,
): FileIndexCandidate {
  const filename = readString(metadata.filename) ?? row.title ?? '';
  return {
    profile: row.source === 'local-folder' ? 'local-folder' : 'cloud-drive',
    filename,
    mime: readString(metadata.mime) ?? readString(metadata.mime_type),
    sizeBytes:
      readFiniteNumber(metadata.sizeBytes) ??
      readFiniteNumber(metadata.size_bytes) ??
      readFiniteNumber(metadata.size),
    path: readString(metadata.absPath) ?? filename,
  };
}

const MIGRATIONS: Migration[] = [
  // v1 — the full schema (2026-07-28 collapse of the original v1..v5 chain;
  // corpora predating the collapse must be rebuilt — the corpus is a
  // rebuildable cache). Column names are storage detail (snake_case SQL
  // convention); row mappers in store.ts produce the camelCase domain shapes
  // from @shared/contracts.
  //
  // documents_fts rows are rowid-PINNED to their document's rowid, so
  // delete/replace are rowid-equality lookups (not full virtual-table scans)
  // while the search SQL joins on doc_id unchanged. documents has a TEXT
  // primary key, so its implicit rowids can be renumbered by VACUUM — every
  // VACUUM of a non-empty corpus must re-run repopulateSearchIndex (see
  // maintenance.compact in store.ts).
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

  -- Full-text index, maintained INSIDE the commit transaction. Raw columns
  -- keep positions 1/2 so snippet(documents_fts, 2, …) and the search JOIN
  -- stay stable; *_stem carry the snowball stem view (search parity design,
  -- docs/superpowers/specs/2026-07-11-search-parity-design.md).
  CREATE VIRTUAL TABLE documents_fts USING fts5(
    doc_id UNINDEXED,
    title,
    markdown,
    title_stem,
    markdown_stem,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  -- Trigram table for substring-recall fuzzy fallback.
  CREATE VIRTUAL TABLE documents_tri USING fts5(
    doc_id UNINDEXED,
    body,
    tokenize = 'trigram remove_diacritics 1'
  );

  -- The outbox: frozen outbound drafts + their audit trail
  -- (docs/superpowers/specs/2026-07-23-unified-outbound-design.md). Dedicated
  -- table, NOT a document type: drafts are mutable workflow state, and the
  -- sent copy re-enters the corpus through normal ingestion. Sent/failed/
  -- discarded rows are retained — the table IS the audit log. ON DELETE
  -- CASCADE: removing an account removes its outbox history, matching the
  -- removeAccount cascade for every other per-account table.
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('reply','new')),
    reply_to_document_id TEXT,
    outbound_ref TEXT,
    recipient_display TEXT NOT NULL,
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT,
    body_markdown TEXT NOT NULL,
    threading_json TEXT,
    confirm_mode TEXT NOT NULL CHECK (confirm_mode IN ('review','link','chat')),
    status TEXT NOT NULL CHECK (status IN
      ('draft','sending','sent','failed','discarded','expired','delivery_unknown')),
    error TEXT,
    external_message_id TEXT,
    created_via TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_outbox_account_status ON outbox(account_id, status);
  `,

  // v2 — archive `documents` rows @shared/file-indexability's
  // decideFileIndexing would now reject, left over from before that policy
  // existed. Scoped to `type = 'file'` rows on the three sources it knows
  // how to classify (`local-folder`, `google-docs`, `onedrive`); every other
  // source (gmail, notion, ...) and every other type — Google's own native
  // docs export as `type = 'gdocs.doc'`, never `'file'` — is left untouched.
  // `d.type = 'file'` is load-bearing: in the dev corpus this ran against,
  // 298 `gdocs.doc` rows outnumbered the 40 `file` rows 7-to-1, so dropping
  // the filter would mostly archive the wrong table.
  //
  // Archiving is feed-visible, never a raw delete (write-tx.ts's
  // archiveByRef): one `changes` row per archived document, with
  // `documents.seq` set to that same change's seq. Consumers of the feed
  // depend on that row existing. This does NOT reclaim disk — archived rows
  // keep their `documents_fts` / `documents_tri` entries.
  //
  // Paged by rowid rather than one `.all()` — the biggest corpus this ran
  // against is 11 GB with ~2,100 candidate rows, nothing to a single page,
  // but a past reconcile bug once produced 3.7M phantom rows, so this stays
  // a paged scan rather than assuming any corpus is small. The whole scan is
  // still ONE transaction, because migrate() wraps every version that way
  // and a half-applied cleanup is worse than a slow one — if this ever needs
  // to be incremental, that's a separate resumable-cursor design, not a
  // `db.transaction` quietly dropped from here.
  (db) => {
    const page = db.prepare(`
      SELECT d.rowid AS rid, d.id, d.title, d.metadata, a.source
        FROM documents d JOIN accounts a ON a.id = d.account_id
       WHERE d.rowid > ? AND d.archived_at IS NULL
         AND d.type = 'file'
         AND a.source IN ('local-folder','google-docs','onedrive')
       ORDER BY d.rowid LIMIT 1000
    `);
    const addChange = db.prepare(
      `INSERT INTO changes(kind, ref_id, at) VALUES('document', ?, ?)`,
    );
    const archive = db.prepare(
      `UPDATE documents SET archived_at=?, updated_at=?, seq=? WHERE id=?`,
    );
    const at = new Date().toISOString();
    let last = 0;
    for (;;) {
      const rows = page.all(last) as CandidateRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        // A row whose metadata cannot be read as a (non-array) object is
        // precisely a row this migration must NOT touch — fail open, never
        // throw: a thrown error here rolls back the whole version-step
        // transaction, which leaves `schemaVersion` at 1 forever (this loop
        // is the only thing that can ever advance it past 1), so every
        // subsequent boot repeats the same throw. `JSON.parse('null')`
        // SUCCEEDS and yields `null` — a bare try/catch around parse alone
        // does not catch that; the guard has to check the parsed VALUE's
        // shape, not just that parsing didn't throw. An array also passes
        // `typeof x === 'object' && x !== null` (`typeof [] === 'object'`),
        // so it needs its own exclusion: every field would resolve to
        // undefined and decideFileIndexing would archive it as
        // 'no-extension'/'unsupported' — exactly the unreadable-metadata
        // case this guard exists to skip, not archive.
        let metadata: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(row.metadata);
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            throw new Error('metadata did not parse to an object');
          }
          metadata = parsed as Record<string, unknown>;
        } catch (err) {
          console.warn(
            `schema v2 migration: unreadable metadata on document ${row.id} — left live`,
            err,
          );
          continue;
        }
        const candidate = candidateFromRow(row, metadata);
        // Real native Google Docs are always `type = 'gdocs.doc'` and
        // excluded by the WHERE clause above — but decideFileIndexing has no
        // concept of "native document" at all, so a `type = 'file'` row that
        // still carries the native-doc export MIME would otherwise fall
        // through its default branch to 'unsupported' and get archived.
        // Guard against that explicitly: only the document MIME is
        // preserved this way. Every OTHER application/vnd.google-apps.*
        // MIME (Sheets, Slides, ...) needs no such guard — it already ends
        // up 'unsupported' via decideFileIndexing's own fallthrough, which
        // is real corpus noise this migration is meant to clean
        // (`vnd.google-apps.presentation` among it).
        if (candidate.mime === 'application/vnd.google-apps.document') {
          continue;
        }
        const decision = decideFileIndexing(candidate);
        if (decision.kind === 'ignore') {
          const seq = Number(addChange.run(row.id, at).lastInsertRowid);
          archive.run(at, at, seq, row.id);
        }
      }
      last = rows[rows.length - 1].rid;
    }
  },
];

/**
 * Clear and refill BOTH search tables from `documents`, rowid-pinned,
 * stemming each row with its stored languages. Used by maintenance.compact
 * (VACUUM can renumber documents rowids — see the rowid-pinning note in the
 * schema above).
 *
 * Runs as ONE transaction (better-sqlite3 nests as a SAVEPOINT): a rebuild
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
  // Fail closed on a corpus at a version this build doesn't know: a corpus
  // written by a newer build (or by the pre-collapse v1..v5 chain) carries
  // storage invariants — FTS rowid pinning above all — that writing with the
  // wrong assumptions would corrupt. Refuse to open instead. (The corpus is
  // a rebuildable cache: update the app, or erase and re-sync.)
  if (version > MIGRATIONS.length) {
    throw new Error(
      `corpus schema v${version} is newer than this build supports ` +
        `(v${MIGRATIONS.length}). Update the app to the latest version to open ` +
        `this database, or erase and re-sync it.`,
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
  ensureQueryIndexes(db);
}
