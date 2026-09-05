import type BetterSqlite3 from 'better-sqlite3';

import { VISUAL_EXTS } from '@main/workers/vision/classify';
import {
  decideFileIndexing,
  type FileIndexCandidate,
} from '@shared/file-indexability';
import {
  coveringRoots,
  isUnder,
  normalizePathSeparators,
} from '@shared/folder-paths';

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

/** The catch-all root id for BOTH cloud connectors. Google Drive's alias for
 *  My Drive is the literal 'root' (google-docs source.ts:362-365 defaults to
 *  `{rootFolderId:'root', rootName:'My Drive'}`); OneDrive's drive root is the
 *  literal 'root' too — source.ts:211 defaults to
 *  `{rootFolderId:'root', rootName:'OneDrive'}`, its picker seeds
 *  `{id:'root', name:'OneDrive'}` (:829) and its delta URL is
 *  `/me/drive/items/root/delta` (:618, :658). Neither is a GUID. */
const CLOUD_CATCH_ALL_ROOT_ID = 'root';

/** Re-implementation of engine.ts's reconcile breaker thresholds
 *  (engine.ts:133-134, MASS_ARCHIVE_MIN_DOCS / MASS_ARCHIVE_RATIO; the
 *  comparison itself is at engine.ts:307-310). The
 *  breaker is an engine concept and does not run during migration, so without
 *  these constants the protection simply is not present on the one pass that
 *  can archive on upgrade. Keep the values in sync with engine.ts:133-134.
 *  Under C-27 the only pass that can archive is the LOCAL-FOLDER one, so this
 *  breaker now guards local-folder alone. It is deliberately kept even though
 *  the cloud path it was originally written for no longer exists: DECISIONS
 *  C-27 notes that the breaker would not have saved that path anyway (a
 *  50-row account is below MIN_DOCS), which is exactly why the cloud rule had
 *  to change instead of leaning on the breaker. */
const V3_MASS_ARCHIVE_MIN_DOCS = 100;
const V3_MASS_ARCHIVE_RATIO = 0.5;

/** Hoisted so the SQL text is not a Literal descendant of the `.exec()`
 *  CallExpression — that is what keeps .eslintrc.js:112-146's vestigial
 *  owned-table selector at zero warnings, the same reason write-tx.ts and v2
 *  hoist every `prepare`. */
const V3_ADD_SCOPE_ROOT_SQL = `ALTER TABLE documents ADD COLUMN scope_root_id TEXT`;
const V3_SCOPE_ROOT_INDEX_SQL = `CREATE INDEX idx_documents_account_scope_root ON documents(account_id, scope_root_id) WHERE archived_at IS NULL`;

/** `FolderRootSelection` as the v3 migration writes it into
 *  `config.folderRoots`. Declared locally rather than imported from
 *  @shared/contracts so the migration stays a self-contained storage
 *  concern (A-5 keeps Task 1 to `src/shared/*`); the shape is pinned by the
 *  tests. */
interface V3FolderRoot {
  id: string;
  name: string;
}

/** Everything v3 needs about one account, resolved once up front. */
interface V3AccountScope {
  source: string;
  /** Selected root ids in config order, deduped and (local-folder) collapsed. */
  rootIds: string[];
  /** The catch-all root id when the set contains one, else null (R6). Under
   *  C-27 this decides only what a non-matching CLOUD row is STAMPED with
   *  ('root' when present, NULL when not) — never whether it is archived,
   *  because no cloud row is ever archived here. It is always null for
   *  local-folder. */
  catchAll: string | null;
}

/** Why a row got the scope it got. THREE of the four verdicts land NULL and
 *  NONE of those three is ever archived (A-3, C-27); `out-of-scope` is the
 *  one and only archive verdict.
 *
 *  - `root`         — attributed. Stamp it.
 *  - `unknown`      — no usable attribution key at all (no `absPath`, no
 *                     `root_folder_id`). NULL, live.
 *  - `unmatched`    — **CLOUD ONLY (C-27).** The key is present but names no
 *                     configured root and the account has no catch-all. This
 *                     is stale data frozen by `hashSkip`, NOT proof the
 *                     document left scope: the named folder may well be a
 *                     child of a configured root. A migration cannot resolve
 *                     provider folder parentage; the connector can. NULL,
 *                     live, and COUNTED so the population is visible.
 *  - `out-of-scope` — **LOCAL-FOLDER ONLY.** The absolute path is provably
 *                     outside every configured root (`isUnder`, evaluated
 *                     locally with no network and no tree walk). This is the
 *                     only verdict that is a proof rather than a guess, and
 *                     therefore the only one that may archive.
 *
 *  The type is the first of two independent layers enforcing C-27: the cloud
 *  branch of `v3Attribute` cannot return `out-of-scope`. The second layer is
 *  pass 2, which only iterates local-folder accounts. */
type V3Attribution =
  | { kind: 'root'; rootId: string }
  | { kind: 'unknown' }
  | { kind: 'unmatched' }
  | { kind: 'out-of-scope' };

/** JSON that parses to a genuine, non-array object — or null. `JSON.parse`
 *  succeeds on `'null'` and on `'[1,2]'` (`typeof [] === 'object'`), so the
 *  guard has to check the parsed VALUE's shape, not just that parsing did not
 *  throw. Used for BOTH `documents.metadata` and `accounts.config`. */
function readJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Display-only leaf name for a local-folder root. Handles both separators
 *  because `config.paths` entries are OS-native (`path.resolve` at connect),
 *  and never returns '' (a bare '/' or 'C:\' keeps its own text). */
function v3LocalRootName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return (i >= 0 ? trimmed.slice(i + 1) : trimmed) || p;
}

/** local-folder roots, or null when `config.paths` is unusable.
 *
 *  C-31 — THE VALIDITY RULE MIRRORS THE RUNTIME EXACTLY, INCLUDING `.every`.
 *  `getRootPaths` (local-folder-source.ts:52-64) accepts a config only when
 *  `Array.isArray(paths) && paths.length > 0 && paths.every((p) => typeof p
 *  === 'string' && p.length > 0)` — the `.every` is at :57 — and otherwise
 *  throws `SourcePermanentError`, i.e. the account does not sync AT ALL
 *  today. A migration that instead FILTERED the malformed entries would
 *  silently redefine that account's scope to the surviving subset, rewrite
 *  its config to match, and then archive every document outside the subset —
 *  choosing on the user's behalf which of their folders was the real one, and
 *  destroying the evidence of what the other one was. So: one bad entry and
 *  the whole account is skipped, untouched, with a warn. `null` here is the
 *  "leave it exactly as it is" answer, which is always safe.
 *
 *  `coveringRoots` runs BEFORE attribution so an overlapping pair like
 *  ['/A','/A/B'] collapses to ['/A'] and no document can match two roots —
 *  spec-reality-diff D7. */
function v3LocalRoots(config: Record<string, unknown>): V3FolderRoot[] | null {
  const raw = config.paths;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  // `.every`, NOT `.filter` — byte-for-byte the runtime validator's rule.
  if (!raw.every((p) => typeof p === 'string' && p.length > 0)) return null;
  return coveringRoots([...new Set(raw as string[])]).map((p) => ({
    id: p,
    name: v3LocalRootName(p),
  }));
}

/** Drive/OneDrive roots, mirroring each connector's own `rootsConfig`
 *  verbatim (gdocs source.ts:343-368, onedrive source.ts:193-218): dedupe by
 *  rootFolderId (first wins); name falls back to the stored `rootName`, then
 *  — google-docs only — 'My Drive' for the 'root' alias, then the id itself;
 *  an absent/empty/unusable `roots` array becomes the legacy default
 *  (google-docs `root`/'My Drive', onedrive `root`/'OneDrive'). Never null: a
 *  cloud account always has a root set. */
function v3CloudRoots(
  config: Record<string, unknown>,
  source: string,
): V3FolderRoot[] {
  const out: V3FolderRoot[] = [];
  const seen = new Set<string>();
  const raw = config.roots;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const r = entry as { rootFolderId?: unknown; rootName?: unknown } | null;
      if (!r || typeof r.rootFolderId !== 'string' || !r.rootFolderId) continue;
      if (seen.has(r.rootFolderId)) continue;
      seen.add(r.rootFolderId);
      const named =
        typeof r.rootName === 'string' && r.rootName ? r.rootName : null;
      out.push({
        id: r.rootFolderId,
        name:
          named ??
          (source === 'google-docs' &&
          r.rootFolderId === CLOUD_CATCH_ALL_ROOT_ID
            ? 'My Drive'
            : r.rootFolderId),
      });
    }
  }
  if (out.length === 0) {
    out.push({
      id: CLOUD_CATCH_ALL_ROOT_ID,
      name: source === 'onedrive' ? 'OneDrive' : 'My Drive',
    });
  }
  return out;
}

/**
 * Which selected root's subtree contains this document.
 *
 * local-folder matches `metadata.absPath` — camelCase, capital P
 * (to-document.ts:65). NOT `externalId`: scanner.ts's `toAbsPosix`
 * (scanner.ts:166-168) rewrote that one to '/'-separated for EVERY row on
 * every platform, so it can never line up with a backslashed Windows root.
 *
 * **`metadata.absPath` DOES NOT HAVE OS-NATIVE SEPARATORS. It has THREE
 * provenances and two spellings** (C-46/D1 — this doc block used to claim
 * "OS-native", and that false premise is what caused the defect):
 *   - SCAN rows come from fast-glob with `absolute: true`
 *     (scanner.ts:112-115). Its entry transformer runs `makeAbsolute` then
 *     `unixify` (`fast-glob/out/providers/transformers/entry.js:12-16`), and
 *     `unixify` is `filepath.replace(/\\/g, '/')`
 *     (`fast-glob/out/utils/path.js:29-31`) — UNCONDITIONAL, not
 *     platform-gated. On Windows these are FORWARD-slashed.
 *   - WATCH rows come from chokidar, which emits OS-native paths
 *     (watch.ts:180-192). On Windows these are BACKslashed.
 *   - `config.paths` / `folderRoots[].id` are `path.resolve`d
 *     (`folder-roots.ts` `validateFolderRoots`), so on Windows they are
 *     BACKslashed too.
 * A real Windows corpus therefore holds BOTH forms at once, and comparing
 * either one raw against the root is a `startsWith` that silently fails.
 * `normalizePathSeparators` is applied to BOTH sides below for exactly that
 * reason — `isUnder` itself is deliberately left alone, because its other
 * callers (`watch.ts:93`'s `rootOf`, `coveringRoots`, `removedRootIds`) all
 * compare SAME-provenance pairs and widening it there buys nothing.
 * `path.resolve` is NOT the answer: it is cwd- and platform-dependent, and a
 * corpus can carry paths written on another OS.
 *
 * The stamp is the CONFIG spelling, verbatim (B-7). Normalization decides the
 * comparison and never the value written — `scope_root_id` must stay
 * byte-equal to `folderRoots[].id` or `removedRootIds` and the archive
 * IN-list can never match it again.
 *
 * Drive/OneDrive match `metadata.root_folder_id` (gdocs source.ts:1040,
 * onedrive source.ts:869). When it names no selected root, R6 attributes the
 * row to the catch-all if the account has one: My Drive / the OneDrive root is
 * a genuine ancestor of its whole subtree, so this is the correct containment
 * answer, not a fudge. Measured 2026-09-04 on the production corpus, it is the
 * difference between 316/316 retained and 314 of 316 archived (314 rows spread
 * over 24 distinct stale ids) on an account that is `needsReauth` and cannot
 * re-walk.
 *
 * C-27 — THE CLOUD BRANCH NEVER RETURNS `out-of-scope`. When there is no
 * exact match AND no catch-all, the verdict is `unmatched`: NULL, live, never
 * archived. The reason is the same frozen-metadata fact R6 rests on, carried
 * to its conclusion. `root_folder_id` records the root the document was under
 * the last time its CONTENT changed, and both connectors `hashSkip` an
 * unchanged live row (gdocs source.ts:476, onedrive source.ts:296), so it is
 * never refreshed. A user who had child folder `B` selected and later selects
 * its parent `A` has documents stamped `B` that are still perfectly in scope.
 * Deciding they are not requires knowing that `B ⊄ A` — provider folder
 * parentage, which is stored nowhere in the corpus and which a boot-critical
 * migration may not go to the network to fetch. The connector's own walk is
 * the only actor that has that answer, so the archive decision is deferred to
 * it, unconditionally and with no threshold.
 *
 * `local-folder` keeps `out-of-scope` precisely BECAUSE its ids are absolute
 * paths: `isUnder('/AA/z.txt', '/A')` is a complete, local, offline proof of
 * non-containment. That asymmetry — a checkable id versus an opaque one — is
 * the whole reason the two branches differ.
 */
function v3Attribute(
  scope: V3AccountScope,
  metadata: Record<string, unknown>,
): V3Attribution {
  if (scope.source === 'local-folder') {
    const abs = metadata.absPath;
    if (typeof abs !== 'string' || !abs) return { kind: 'unknown' };
    // C-46/D1: mixed provenance, so BOTH sides are normalized before the
    // containment test — and `rootId` is returned UNnormalized (B-7).
    const absNorm = normalizePathSeparators(abs);
    for (const rootId of scope.rootIds) {
      if (isUnder(absNorm, normalizePathSeparators(rootId)))
        return { kind: 'root', rootId };
    }
    // The ONLY `out-of-scope` in the file. Provable from the path alone.
    return { kind: 'out-of-scope' };
  }
  const rootFolderId = metadata.root_folder_id;
  if (typeof rootFolderId !== 'string' || !rootFolderId) {
    return { kind: 'unknown' };
  }
  if (scope.rootIds.includes(rootFolderId)) {
    return { kind: 'root', rootId: rootFolderId };
  }
  if (scope.catchAll !== null) {
    return { kind: 'root', rootId: scope.catchAll };
  }
  // C-27: stale, not out of scope. NEVER `out-of-scope` on this branch.
  return { kind: 'unmatched' };
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
  // v3 — folder scope. Adds `documents.scope_root_id` (which FolderRootSelection
  // covers this document), rewrites every folder-scoped account's config to the
  // canonical `folderRoots` shape, and stamps every LIVE row on the three sources
  // the migration knows how to attribute (`local-folder`, `google-docs`,
  // `onedrive` — bare, unprefixed `accounts.source` literals, same as v2).
  //
  // Deliberately NO `d.type` filter, unlike v2: google-docs emits
  // `metadata.root_folder_id` on every doc type it produces, and a native
  // Google Doc is `type = 'gdocs.doc'`, never `'file'` (17 of the production
  // account's 316 live rows). Filtering to 'file' here would leave every
  // native doc unattributed and therefore NULL forever (see the contentHash
  // note below).
  //
  // C-27 — FOR A CLOUD DOCUMENT THIS MIGRATION IS ATTRIBUTION-ONLY AND
  // ARCHIVES NOTHING. `metadata.root_folder_id` is not "the root this document
  // is under" — it is "the root it was under the last time its content
  // changed". Both cloud connectors `hashSkip` an unchanged, still-live
  // document (gdocs source.ts:476, onedrive source.ts:296), so the field is
  // frozen at last emission and nothing rewrites it. A mismatch is therefore
  // STALE DATA, not evidence the document left scope — and that is true of
  // EVERY mismatch, not only when the literal 'root' happens to be
  // configured. A user who had child folder B selected and later selects its
  // parent A has documents stamped B that are still perfectly in scope; a
  // migration cannot learn that B ⊂ A (no folder parentage is stored, and
  // boot must not make network calls), but the connector's walk can. So:
  //   - exact match with a configured root  → stamp that root;
  //   - no match but the set has the catch-all ('root' for BOTH Drive and
  //     OneDrive) → stamp the catch-all (R6, unchanged): My Drive / the
  //     OneDrive root is a genuine ancestor of its whole subtree;
  //   - anything else, including an unknown/absent/unreadable value →
  //     LEAVE THE ROW LIVE with scope_root_id NULL. Never archive.
  // There is NO cloud archive pass. Not a bounded one, not a
  // breaker-protected one. Leaning on the breaker was considered and rejected
  // in DECISIONS C-27 for a measurable reason: MASS_ARCHIVE_MIN_DOCS is 100,
  // so an account with 50 stale-but-in-scope rows loses all 50 with no
  // warning a user ever sees.
  //
  // Measured on the real production corpus 2026-09-04: google-docs account
  // 019fd782 was reconnected through a blank picker, which replaced its
  // explicit roots with the 'root' catch-all; 314 of its 316 live rows still
  // carry OLD root ids, spread over 24 distinct stale ids. Treating that
  // mismatch as evidence of scope archives 99.4% of the account — and the
  // account is `needsReauth`, so the compensating re-walk cannot run until the
  // user completes OAuth (boot.ts:198-206 never resumes a needsReauth
  // account on its own).
  //
  // LOCAL-FOLDER IS DIFFERENT ON PURPOSE, and keeps its archive pass. Its
  // roots are absolute paths, so `isUnder` decides containment exactly,
  // locally, offline: '/AA/z.txt' is provably not under '/A'. That is a proof,
  // not a guess, which is exactly why cloud ids do not get one. The engine's
  // own mass-archive thresholds are still re-implemented for that pass because
  // the engine's breaker does not run during migration.
  //
  // A NULL `scope_root_id` is NEVER archived here (A-3, C-27). NULL means
  // "not attributed", which is a different population from "provably out of
  // scope": only `v3Attribute`'s `out-of-scope` verdict — reachable from the
  // local-folder branch alone — is an archive candidate. There is NO repair
  // path for a NULL scope in this train: DECISIONS C-34 removed
  // `archiveNullScoped` from `applyFolderScope`'s store input type outright,
  // so a NULL-scoped row is unreachable by the archive predicate BY
  // CONSTRUCTION rather than by a flag's default value.
  //
  // ⚠️ READ THE HAND-OFF AT THE TOP OF TASK 2 BEFORE RE-ARMING THAT FLAG.
  // A re-walk CANNOT re-stamp a live row: both connectors' `hashSkip` and
  // core's `upsertDocument` (write-tx.ts:170-176) skip an unchanged live row
  // outright, so only an ARCHIVED row is ever re-emitted and re-stamped. That
  // makes `archiveNullScoped` archive-before-proof, and it would destroy
  // precisely the rows this migration just refused to touch. Before the branch
  // may return it needs an archive-AFTER-proof predicate shaped like
  // `reconcile`'s (write-tx.ts:512-538) AND a listing pass for OneDrive, which
  // has no `reconcile()` at all. The constraint is "no path in this train may
  // archive a document the migration could not attribute".
  //
  // WHY GETTING THIS RIGHT HERE IS THE ONLY CHEAP CHANCE. `scope_root_id` is
  // not part of `contentHash` (write-tx.ts's contentHash hashes title/markdown/
  // url/metadata/createdAt only) and `upsertDocument` returns null — writing
  // NOTHING — for an unchanged live row. So a live row's attribution can never
  // be repaired by a re-walk; the only repairs are this migration, or archive-
  // then-re-emit (which for the cloud sources means re-exporting/re-downloading
  // the bytes `hashSkip` existed to avoid).
  //
  // `accounts.cursor` is left UNTOUCHED on purpose. It is opaque to core, so
  // core cannot synthesize a DriveCursor/OneDriveCursor; the updated
  // connectors read a missing `scope_roots` as "mismatch, backfill once" and
  // keep their preserved page token (spec-reality-diff A3 option (i)).
  //
  // THE LEGACY MIRROR IS CORE'S, AND ONLY CORE'S (DECISIONS R1 as amended by
  // A-2). The installed connectors (gdocs 2.1.6, onedrive 2.0.5) ship through
  // the in-app Marketplace and do NOT auto-update. gdocs 2.1.6 reading a config
  // with no `roots` falls through source.ts:362-365 to its default — all of My
  // Drive — and its reconcile() then archives every document not reachable from
  // it. So canonical `folderRoots` is written ALONGSIDE the legacy shape,
  // DERIVED from it, for exactly one release train: `paths` for local-folder,
  // `roots` for the two cloud sources. Task 3's `applyFolderScope` performs the
  // identical derivation so a Save and an upgrade produce the same bytes; the
  // connectors are silent about the legacy keys and neither write nor strip
  // them.
  //
  // Paged by rowid in v2's style rather than one `.all()`: a past reconcile
  // bug once produced 3.7M phantom rows. The whole pass is still ONE
  // transaction because migrate() wraps every version that way. Measured
  // 2026-09-04: v2+v3 together take ~100 ms on the 4.9 GB / 594-live-doc
  // production corpus and ~1.15 s on the 11 GB dev corpus, including the
  // CREATE INDEX.
  //
  // ORDER IS LOAD-BEARING: `db.prepare()` resolves column names at prepare
  // time, so the ALTER and the CREATE INDEX must run BEFORE any prepare that
  // mentions `scope_root_id`, or the migration throws `no such column` and
  // bricks boot. `ALTER TABLE … ADD COLUMN` is legal — and rolled back — inside
  // this transaction, so it needs no separate version step.
  //
  // The index is structural (here, not in QUERY_INDEXES) because its
  // definition is fixed and Task 3's applyFolderScope predicate — R8/A-1's
  // explicit IN-list, `account_id = ? AND archived_at IS NULL AND
  // scope_root_id IN (…archiveScopeRootIds)`, NEVER a NOT IN — must plan onto
  // it the moment the ladder finishes. Partial on `archived_at IS NULL` to
  // match the house style of docs_account_recency; the same index also serves
  // this migration's own second pass. Verified on SQLite 3.53.2: the IN-list
  // form seeks BOTH columns, `SEARCH documents USING INDEX
  // idx_documents_account_scope_root (account_id=? AND scope_root_id=?)`; a
  // NULL-scope disjunct, were one ever added, narrows it to `(account_id=?)`;
  // neither ever degrades to a table scan.
  (db) => {
    db.exec(V3_ADD_SCOPE_ROOT_SQL);
    db.exec(V3_SCOPE_ROOT_INDEX_SQL);

    const accountPage = db.prepare(
      `SELECT id, source, config FROM accounts
        WHERE source IN ('local-folder','google-docs','onedrive')`,
    );
    const setConfig = db.prepare(`UPDATE accounts SET config = ? WHERE id = ?`);
    const addChange = db.prepare(
      `INSERT INTO changes(kind, ref_id, at) VALUES(?, ?, ?)`,
    );
    const page = db.prepare(`
      SELECT d.rowid AS rid, d.id, d.account_id, d.metadata
        FROM documents d JOIN accounts a ON a.id = d.account_id
       WHERE d.rowid > ? AND d.archived_at IS NULL
         AND a.source IN ('local-folder','google-docs','onedrive')
       ORDER BY d.rowid LIMIT 1000
    `);
    const stamp = db.prepare(
      `UPDATE documents SET scope_root_id = ? WHERE id = ?`,
    );
    const orphanPage = db.prepare(`
      SELECT d.rowid AS rid, d.id, d.metadata FROM documents d
       WHERE d.account_id = ? AND d.rowid > ? AND d.archived_at IS NULL
         AND d.scope_root_id IS NULL
       ORDER BY d.rowid LIMIT 1000
    `);
    const archive = db.prepare(
      `UPDATE documents SET archived_at=?, updated_at=?, seq=? WHERE id=?`,
    );
    const at = new Date().toISOString();

    // ── pass 1a: resolve each account's scope and rewrite its config ───────
    const scopes = new Map<string, V3AccountScope>();
    for (const row of accountPage.all() as Array<{
      id: string;
      source: string;
      config: string;
    }>) {
      const config = readJsonObject(row.config);
      if (config === null) {
        console.warn(
          `schema v3 migration: unreadable config on account ${row.id} (${row.source}) — account left untouched, its documents keep scope_root_id NULL`,
        );
        continue;
      }
      const roots =
        row.source === 'local-folder'
          ? v3LocalRoots(config)
          : v3CloudRoots(config, row.source);
      if (roots === null) {
        console.warn(
          `schema v3 migration: account ${row.id} (${row.source}) has no usable folder roots in its config — account left untouched, its documents keep scope_root_id NULL`,
        );
        continue;
      }
      scopes.set(row.id, {
        source: row.source,
        rootIds: roots.map((r) => r.id),
        catchAll:
          row.source !== 'local-folder' &&
          roots.some((r) => r.id === CLOUD_CATCH_ALL_ROOT_ID)
            ? CLOUD_CATCH_ALL_ROOT_ID
            : null,
      });
      const next: Record<string, unknown> = {
        ...config,
        folderRoots: roots,
        // TODO(folder-scope-train-2): drop the legacy mirror
        // Core is its only writer (DECISIONS R1 as amended by A-2); Task 3's
        // applyFolderScope repeats this exact derivation on every Save.
        ...(row.source === 'local-folder'
          ? { paths: roots.map((r) => r.id) }
          : {
              roots: roots.map((r) => ({
                rootFolderId: r.id,
                rootName: r.name,
              })),
            }),
      };
      // IDEMPOTENCE. Write ONLY when the config actually changes. The ladder
      // body can be replayed over a corpus whose config this migration has
      // already rewritten (that is exactly what the v2 no-op test does: rewind
      // the marker, `migrate()` again), and an unconditional write appended a
      // duplicate `kind='account'` row to `changes` on EVERY replay —
      // measured, 2 accounts → +2 rows per replay, unbounded. `changes` is the
      // feed every consumer cursors over, so those duplicates are re-delivered
      // work, not just noise. `next` is built by spreading `config` first, so a
      // config this migration wrote re-serializes byte-identically and the
      // comparison is exact; a config that merely differs in key order costs at
      // most ONE rewrite and is stable thereafter.
      const nextJson = JSON.stringify(next);
      if (nextJson !== row.config) {
        setConfig.run(nextJson, row.id);
        // Feed-visible, exactly as store.setAccountConfig does — otherwise a
        // consumer keeps materializing the pre-migration config from its own
        // cursor. This row is also the seq boundary the corpus dry-run uses to
        // tell v2's archives apart from v3's; v2 only ever writes
        // kind='document' (schema.ts:328-330), so the first kind='account' row
        // above the pre-migrate high-water mark is unambiguously v3's.
        addChange.run('account', row.id, at);
      }
    }

    // ── pass 1b: stamp every live row, counting per account ────────────────
    // Counters only — never an array of ids. A 3.7M-document account has
    // already OOM'd this process once by materializing per-account row sets.
    const liveByAccount = new Map<string, number>();
    /** `out-of-scope` verdicts — LOCAL-FOLDER ONLY, the archive candidates. */
    const orphansByAccount = new Map<string, number>();
    /** C-27's population: cloud rows this migration deliberately could not
     *  attribute and deliberately did not archive. Counted so the size of the
     *  hazard is visible on a real user's machine before Task 3's
     *  `archiveNullScoped` is ever pointed at it. */
    const unmatchedByAccount = new Map<string, number>();
    let last = 0;
    for (;;) {
      const rows = page.all(last) as Array<{
        rid: number;
        id: string;
        account_id: string;
        metadata: string;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        const scope = scopes.get(row.account_id);
        if (!scope) continue; // account skipped above — leave every row alone
        // Counted BEFORE the metadata guard on purpose: an unreadable row is
        // still a live row, and including it only enlarges the breaker's
        // denominator, i.e. makes the archival decision more conservative.
        liveByAccount.set(
          row.account_id,
          (liveByAccount.get(row.account_id) ?? 0) + 1,
        );
        const metadata = readJsonObject(row.metadata);
        if (metadata === null) {
          console.warn(
            `schema v3 migration: unreadable metadata on document ${row.id} — scope_root_id left NULL, row left live`,
          );
          continue;
        }
        const attribution = v3Attribute(scope, metadata);
        if (attribution.kind === 'root') {
          stamp.run(attribution.rootId, row.id);
        } else if (attribution.kind === 'out-of-scope') {
          orphansByAccount.set(
            row.account_id,
            (orphansByAccount.get(row.account_id) ?? 0) + 1,
          );
        } else if (attribution.kind === 'unmatched') {
          unmatchedByAccount.set(
            row.account_id,
            (unmatchedByAccount.get(row.account_id) ?? 0) + 1,
          );
        }
      }
      last = rows[rows.length - 1].rid;
    }

    // ── C-27 observability: one warn per account, never per row ────────────
    // These rows are LIVE and searchable — nothing is lost here. The warn
    // exists so that the population Tasks 3 and 7 must not archive can be
    // sized on a real machine. Never log a document id, a path or a provider
    // folder name; counts and the account id only.
    for (const [accountId, n] of unmatchedByAccount) {
      const scope = scopes.get(accountId);
      console.warn(
        `schema v3 migration: left ${n} of ${liveByAccount.get(accountId) ?? 0}` +
          ` live rows unattributed on account ${accountId} (${scope?.source ?? 'unknown'})` +
          ` — their frozen root_folder_id names no configured root and the account has no` +
          ` catch-all, so C-27 leaves them live with scope_root_id NULL rather than archiving` +
          ` a document that may still be in scope. Only a connector re-walk can attribute them;` +
          ` they must NOT be archived by applyFolderScope's archiveNullScoped path.`,
      );
    }

    // ── pass 2: archive — LOCAL-FOLDER ONLY, and only if the breaker allows ─
    // The `source !== 'local-folder'` gate is C-27's SECOND, independent
    // layer. The first is `v3Attribute`, whose cloud branch cannot return
    // `out-of-scope` at all, so `orphansByAccount` can never hold a cloud
    // account; this gate makes that structural instead of emergent, so a
    // future edit to `v3Attribute` alone cannot re-arm a cloud archive. Both
    // layers are load-bearing and the mutation matrix in Task 2 Step 8 proves
    // it takes BOTH mutations to reach the regression.
    for (const [accountId, scope] of scopes) {
      if (scope.source !== 'local-folder') continue; // C-27: cloud never archives
      const orphanCount = orphansByAccount.get(accountId) ?? 0;
      if (orphanCount === 0) continue;
      const liveCount = liveByAccount.get(accountId) ?? 0;
      if (
        orphanCount > V3_MASS_ARCHIVE_MIN_DOCS &&
        orphanCount > liveCount * V3_MASS_ARCHIVE_RATIO
      ) {
        // Same shape as engine.ts:307-310's reconcile breaker, which is
        // `deletionCount > MIN_DOCS && deletionCount > liveCount * RATIO` —
        // strictly greater on BOTH comparisons, as here. Refusing leaves
        // the rows LIVE with scope_root_id NULL — never with a fabricated root
        // id. NULL is the honest "not attributed" marker; a fabricated root id
        // would be a WRONG answer nothing can ever correct: contentHash
        // excludes scope and `upsertDocument` writes nothing at all for an
        // unchanged live row (write-tx.ts:170-176), so the wrong stamp would
        // survive every future walk.
        console.warn(
          `schema v3 migration: refusing to archive ${orphanCount} of ${liveCount} live rows on account ${accountId} — above the mass-archive thresholds; rows left live with scope_root_id NULL`,
        );
        continue;
      }
      let cursor = 0;
      for (;;) {
        const rows = orphanPage.all(accountId, cursor) as Array<{
          rid: number;
          id: string;
          metadata: string;
        }>;
        if (rows.length === 0) break;
        for (const row of rows) {
          const metadata = readJsonObject(row.metadata);
          if (metadata === null) continue; // unreadable — already warned, stays live
          // The `out-of-scope` re-check is what implements A-3 and C-27:
          // `orphanPage` selects every NULL-scoped live row, which includes
          // the `unknown` ones (and, on a mixed corpus, would include
          // `unmatched` ones if this loop ever ran for a cloud account). Only
          // `out-of-scope` — reachable from the local-folder branch alone —
          // may be archived.
          if (v3Attribute(scope, metadata).kind !== 'out-of-scope') continue;
          // Feed-visible, never a raw delete: one `changes` row per archived
          // document with `documents.seq` set to that same change's seq.
          // `changes.seq` is `INTEGER PRIMARY KEY AUTOINCREMENT`
          // (schema.ts:199), i.e. a rowid alias, so `lastInsertRowid` IS the
          // seq. This is write-tx.ts:519-539's archiveBatchTx idiom (the
          // appendChange → UPDATE documents SET archived_at, seq, updated_at
          // pairing is :530-536, and appendChange itself returns
          // `Number(r.lastInsertRowid)` at :81-86) — and v2 already uses this
          // exact line pair inside a migration at schema.ts:389-390.
          const seq = Number(
            addChange.run('document', row.id, at).lastInsertRowid,
          );
          archive.run(at, at, seq, row.id);
        }
        cursor = rows[rows.length - 1].rid;
      }
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
