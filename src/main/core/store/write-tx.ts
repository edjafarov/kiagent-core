import { createHash } from 'crypto';

import type BetterSqlite3 from 'better-sqlite3';

import type {
  AccountId,
  Change,
  CommitBatch,
  DocumentInput,
  ExternalRef,
  Seq,
} from '@shared/contracts';

import { newId } from '../ids';
import { buildStemView } from '../stemming';
import type { AccountRow, DocRow } from './store';

/** Injected so the write path stays testable and Electron-free. Mirrors the
 *  slice of StoreDeps the transaction actually touches. */
export interface WriteTxDeps {
  /** Cheap language detection for search stemming (ISO-639-3). */
  detectLanguages(text: string): string[];
  now(): string;
}

function contentHash(d: DocumentInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: d.title,
        markdown: d.markdown,
        url: d.url ?? null,
        metadata: d.metadata,
        createdAt: d.createdAt,
      }),
    )
    .digest('hex');
}

/** DECISIONS R5: is this account folder-scoped? Read off the CANONICAL marker
 *  every folder-scoped source writes — `config.folderRoots` (contracts'
 *  `FolderScopedConfig`) — rather than a hard-coded source list, so a fourth
 *  folder-scoped source is covered the day it ships. What it is FOR is the
 *  account branch of commitTx, where imap / gmail / whatsapp / browser-history
 *  land: none of them ever sets `scopeRootId`, so an ungated warn would fire on
 *  every document they commit. (Worker emissions need no gate at all — they go
 *  through the `consumer` branch, which returns long before this one and
 *  carries no R5 warn.) Unreadable config is never a reason to fail a commit. */
function isFolderScopedAccount(acc: AccountRow): boolean {
  try {
    return Array.isArray(
      (JSON.parse(acc.config) as { folderRoots?: unknown }).folderRoots,
    );
  } catch {
    return false;
  }
}

/** What one reconcile pass learned about an account, in scalars only. */
export interface ReconcileCounts {
  /** Rows the connector's listing staged this pass. */
  listedCount: number;
  /** Live documents eligible for archiving (committed at or before startSeq). */
  liveCount: number;
  /** Of those, the ones the listing did not mention. */
  deletionCount: number;
}

/** Input for one folder-scope edit (DECISIONS R8 / amendment A-1). */
export interface FolderScopeInput {
  accountId: AccountId;
  /** Canonical config, already validated. `folderRoots` only — core derives
   *  the legacy mirror here, the source never sends one (A-2). */
  config: Record<string, unknown>;
  /** The source's own opaque cursor, already transformed for the new roots. */
  cursor: unknown;
  /** The `scope_root_id` values whose live documents LEAVE scope, computed BY
   *  THE SOURCE, which alone knows folder containment. An EMPTY ARRAY IS
   *  LEGAL — a pure widening save archives nothing. Core must NEVER derive
   *  this by set-difference over `folderRoots` — on the real production Drive
   *  account that archives 314 of 316 live rows, whose stamps `hashSkip` froze
   *  at whatever folder they were last emitted under.
   *
   *  **C-46/D2 — this doc block used to specify the empty array as "what
   *  Drive returns whenever the catch-all is retained", and that
   *  specification is the defect.** A retained My Drive is not an ancestor of
   *  a shared-with-me or shared-drive root, so "catch-all retained" does not
   *  imply "nothing left scope". A removed root that a retained one genuinely
   *  covers goes in `reattributeScopeRoots`; staying silent about it freezes
   *  a stale stamp that no later save can match (C-46/D3). */
  archiveScopeRootIds: string[];
  /** C-46/D5. Removed roots whose live documents stay in scope under a
   *  RETAINED root: `scope_root_id` is re-stamped `from` -> `to` inside this
   *  same transaction, BEFORE the archive step, and no `changes` row is
   *  written (scope attribution is not user-visible content and must not
   *  churn the feed).
   *
   *  REQUIRED, may be empty — the same reasoning as `archiveScopeRootIds`
   *  being required: a source that has nothing to re-attribute says `[]` out
   *  loud, and a caller cannot drop the field by accident.
   *
   *  `to` is NOT validated against the new `folderRoots`: core does not
   *  derive containment (R8/A-1), so it has no standing to second-guess the
   *  source's claim. The one check is the contradiction guard.
   *
   *  `applyFolderScope` THROWS when any `from` also appears in
   *  `archiveScopeRootIds`. That is a contradictory instruction — the source
   *  has decided the same root both leaves scope and does not — and picking
   *  an order would silently apply one of two opposite outcomes. It is a
   *  source bug and must be loud. */
  reattributeScopeRoots: Array<{ from: string; to: string }>;
  /* DELIBERATELY NO `archiveNullScoped` (DECISIONS C-34). A source may still
   * ASK for the NULL-attribution repair — the flag is in the frozen
   * `FolderScopeUpdate` and both cloud connectors send it — but core does not
   * act on it in this train, and the refusal lives HERE, in the type, rather
   * than in a `false` somewhere in the engine: with no parameter to forward,
   * re-arming it is a TS2353 at the call site instead of a one-word edit that
   * silently re-opens multi-document loss on Google Drive and OneDrive at
   * once. What must exist before it returns is spelled out above
   * `FOLDER_SCOPE_OUT`. */
  /** `JSON.stringify(account.config)` as the flow read it. Compared INSIDE
   *  the transaction; if the stored config has moved, nothing is written. */
  expectedConfigJson: string;
}

/** Counts only. See applyFolderScope. */
export interface FolderScopeResult {
  archived: number;
  /** Live rows whose `scope_root_id` this save re-stamped (C-46/D5). */
  reattributed: number;
  remaining: number;
  stale: boolean;
}

/** DECISIONS R1 + amendment A-2: CORE owns the legacy config mirror, in
 *  exactly two places — the v3 migration and `applyFolderScope`. Connectors
 *  return canonical-only config and are simply silent about `roots`/`paths`;
 *  core adds them back, and REPLACES whatever stale mirror came through.
 *
 *  It has to exist because the installed Marketplace connectors (gdocs 2.1.6,
 *  onedrive 2.0.5) ship through the in-app Marketplace and do NOT auto-update.
 *  gdocs reading a config with no `roots` falls through `rootsConfig` to its
 *  default — all of My Drive — and its `reconcile()` then archives every
 *  document not reachable from there. The mass-archive breaker only fires
 *  above BOTH 100 docs and a 0.5 ratio, so a smaller shared-root corpus is
 *  gutted silently.
 *
 *  Shape is byte-identical to the v3 migration's (schema.ts, pass 1a). The
 *  two writers are pinned in sync by the cross-pin test in
 *  __tests__/write-tx.test.ts (DECISIONS R1 / C-15), which runs the REAL v3
 *  migration and feeds its own `folderRoots` back through this function.
 *  Change one derivation and that test fails.
 *
 *  TODO(folder-scope-train-2): drop the legacy roots/paths mirror once gdocs
 *  and onedrive read `folderRoots`.
 */
export function withLegacyMirror(
  source: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const raw = config.folderRoots;
  if (!Array.isArray(raw)) return config; // not a folder-scoped config
  const roots = raw as Array<{ id: string; name: string }>;
  if (source === 'local-folder') {
    return { ...config, paths: roots.map((r) => r.id) };
  }
  if (source === 'google-docs' || source === 'onedrive') {
    return {
      ...config,
      roots: roots.map((r) => ({ rootFolderId: r.id, rootName: r.name })),
    };
  }
  return config; // no legacy reader on this source — nothing to mirror
}

export interface WriteTx {
  commit(batch: CommitBatch): Seq;
  /** Start a pass: drop whatever the previous one staged for this account. */
  reconcileBegin(accountId: string): void;
  /** Stage one bounded slice of the connector's listing. */
  reconcileStage(accountId: string, refs: ExternalRef[]): void;
  /** Count the anti-join. Returns scalars — never the refs themselves. */
  reconcileDiff(accountId: string, startSeq: Seq): ReconcileCounts;
  /** Archive every staged-as-missing document, in worker-side batches.
   *  Returns how many were archived, and ends the pass. */
  reconcileArchive(accountId: string, startSeq: Seq): number;
  /** End a pass without archiving (refused, aborted, or nothing to do). */
  reconcileEnd(accountId: string): void;
  /** ONE transaction: config + cursor + archival of the roots the SOURCE
   *  reported as leaving scope + one `changes` row per archived document.
   *  Returns COUNTS ONLY — never row sets. */
  applyFolderScope(input: FolderScopeInput): FolderScopeResult;
}

/**
 * The corpus write primitive, hosted on the RAW better-sqlite3 connection.
 * In-process (tests, stdio) this runs directly on the main store's handle;
 * worker-backed this is registered as the `commit` procedure and runs inside
 * the DB worker thread (see db/worker-entry.ts) — either way its statements are
 * synchronous and wrapped in ONE `conn.transaction()`.
 *
 * It CANNOT be a static `AppDb.batch()`: `reconcileParents` re-reads documents
 * written earlier in the SAME transaction (read-your-own-writes), so the whole
 * procedure is relocated verbatim rather than flattened.
 */
export function createWriteTx(
  conn: BetterSqlite3.Database,
  deps: WriteTxDeps,
): WriteTx {
  // ── low-level helpers (all run inside the caller's transaction) ──────────

  const appendChange = (kind: Change['kind'], refId: string): Seq => {
    const r = conn
      .prepare(`INSERT INTO changes(kind, ref_id, at) VALUES(?, ?, ?)`)
      .run(kind, refId, deps.now());
    return Number(r.lastInsertRowid);
  };

  const getAccountRow = (id: string): AccountRow | undefined =>
    conn.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as
      | AccountRow
      | undefined;

  const findDocRow = (
    accountId: string,
    externalId: string,
    type: string,
  ): DocRow | undefined =>
    conn
      .prepare(
        `SELECT * FROM documents WHERE account_id = ? AND external_id = ? AND type = ?`,
      )
      .get(accountId, externalId, type) as DocRow | undefined;

  // Search-index rows (documents_fts AND documents_tri) are rowid-pinned to
  // their document's rowid (schema v2/v3): deletes and replacements are
  // rowid-equality lookups instead of full virtual-table scans on the
  // UNINDEXED doc_id. Both callers write the documents row before touching
  // the index, so the subselect always resolves.
  const ftsDelete = (docId: string): void => {
    for (const table of ['documents_fts', 'documents_tri']) {
      conn
        .prepare(
          `DELETE FROM ${table}
          WHERE rowid = (SELECT rowid FROM documents WHERE id = ?)`,
        )
        .run(docId);
    }
  };

  /** Insert-only index write for a brand-new document — its id was minted in
   *  this transaction, so there is nothing to delete first. Stem columns are
   *  built with the document's just-detected languages; the trigram body is
   *  the raw title + markdown. */
  const ftsInsert = (
    docId: string,
    title: string | null,
    markdown: string | null,
    languages: string[],
  ): void => {
    const t = title ?? '';
    const m = markdown ?? '';
    conn
      .prepare(
        `INSERT INTO documents_fts(rowid, doc_id, title, markdown, title_stem, markdown_stem)
        VALUES((SELECT rowid FROM documents WHERE id = ?), ?, ?, ?, ?, ?)`,
      )
      .run(
        docId,
        docId,
        t,
        m,
        buildStemView(t, languages),
        buildStemView(m, languages),
      );
    conn
      .prepare(
        `INSERT INTO documents_tri(rowid, doc_id, body)
        VALUES((SELECT rowid FROM documents WHERE id = ?), ?, ?)`,
      )
      .run(docId, docId, `${t}\n${m}`.trim());
  };

  const ftsUpsert = (
    docId: string,
    title: string | null,
    markdown: string | null,
    languages: string[],
  ): void => {
    ftsDelete(docId);
    ftsInsert(docId, title, markdown, languages);
  };

  /** Upsert one document; returns its seq, or null when nothing changed. */
  const upsertDocument = (
    accountId: string,
    input: DocumentInput,
  ): Seq | null => {
    const hash = contentHash(input);
    const existing = findDocRow(accountId, input.externalId, input.type);
    if (
      existing &&
      existing.content_hash === hash &&
      existing.archived_at === null
    ) {
      return null; // unchanged — no feed churn
    }
    let parentId: string | null = null;
    if (input.parent) {
      const parent = findDocRow(
        accountId,
        input.parent.externalId,
        input.parent.type,
      );
      parentId = parent?.id ?? null;
    }
    const text = `${input.title ?? ''}\n${input.markdown ?? ''}`.trim();
    const languages = text ? deps.detectLanguages(text) : [];
    const ts = deps.now();
    if (existing) {
      const seq = appendChange('document', existing.id);
      conn
        .prepare(
          `UPDATE documents SET title=?, markdown=?, url=?, metadata=?, created_at=?,
           parent_id=?, content_hash=?, seq=?, archived_at=NULL, languages=?, updated_at=?,
           scope_root_id=COALESCE(?, scope_root_id)
         WHERE id=?`,
        )
        .run(
          input.title,
          input.markdown,
          input.url ?? null,
          JSON.stringify(input.metadata),
          input.createdAt,
          parentId,
          hash,
          seq,
          JSON.stringify(languages),
          ts,
          input.scopeRootId ?? null,
          existing.id,
        );
      ftsUpsert(existing.id, input.title, input.markdown, languages);
      return seq;
    }
    const id = newId<'document'>();
    const seq = appendChange('document', id);
    conn
      .prepare(
        `INSERT INTO documents(id, account_id, external_id, type, title, markdown, url,
         metadata, created_at, parent_id, content_hash, seq, archived_at, languages,
         ingested_at, updated_at, scope_root_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        accountId,
        input.externalId,
        input.type,
        input.title,
        input.markdown,
        input.url ?? null,
        JSON.stringify(input.metadata),
        input.createdAt,
        parentId,
        hash,
        seq,
        JSON.stringify(languages),
        ts,
        ts,
        input.scopeRootId ?? null,
      );
    ftsInsert(id, input.title, input.markdown, languages);
    return seq;
  };

  /** Second pass over a batch, run AFTER every document in it has been
   *  upserted: `upsertDocument`'s parent resolution only sees rows already
   *  written earlier IN THIS TRANSACTION, so a child that arrives before its
   *  parent within the same batch resolves to parentId=null. And a doc whose
   *  content didn't change is skipped by upsertDocument entirely — its
   *  content_hash deliberately excludes parent (see contentHash), so a
   *  reparent with no other edits would otherwise never be seen. Re-resolving
   *  here against the batch's own DocumentInput.parent refs fixes both,
   *  without touching content_hash. */
  const reconcileParents = (
    accountId: string,
    documents: DocumentInput[],
  ): Seq | null => {
    let last: Seq | null = null;
    for (const input of documents) {
      if (!input.parent) continue;
      const child = findDocRow(accountId, input.externalId, input.type);
      if (!child) continue; // upserted above; absence means a prior step rejected it
      const parent = findDocRow(
        accountId,
        input.parent.externalId,
        input.parent.type,
      );
      const parentId = parent?.id ?? null;
      if (child.parent_id !== parentId) {
        const seq = appendChange('document', child.id);
        conn
          .prepare(
            `UPDATE documents SET parent_id=?, seq=?, updated_at=? WHERE id=?`,
          )
          .run(parentId, seq, deps.now(), child.id);
        last = seq;
      }
    }
    return last;
  };

  const archiveByRef = (accountId: string, ref: ExternalRef): Seq | null => {
    const row = findDocRow(accountId, ref.externalId, ref.type);
    if (!row || row.archived_at !== null) return null;
    const seq = appendChange('document', row.id);
    conn
      .prepare(
        `UPDATE documents SET archived_at = ?, seq = ?, updated_at = ? WHERE id = ?`,
      )
      .run(deps.now(), seq, deps.now(), row.id);
    return seq;
  };

  // ── the write primitive ───────────────────────────────────────────────────

  const commitTx = conn.transaction((batch: CommitBatch): Seq => {
    let last: Seq = Number(
      (
        conn.prepare(`SELECT MAX(seq) AS s FROM changes`).get() as {
          s: number | null;
        }
      ).s ?? 0,
    );

    if ('consumer' in batch) {
      conn
        .prepare(
          `INSERT INTO consumers(name, cursor) VALUES(?, ?)
         ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor`,
        )
        .run(batch.consumer, batch.cursor);
      if (batch.documents?.length) {
        // Worker emissions land under the worker's synthetic account,
        // atomically with its cursor.
        const synthetic = getOrCreateAccountTx('worker', batch.consumer);
        for (const doc of batch.documents) {
          const seq = upsertDocument(synthetic.id, doc);
          if (seq !== null) last = seq;
        }
        const reconciled = reconcileParents(synthetic.id, batch.documents);
        if (reconciled !== null) last = reconciled;
      }
      if (batch.enrich?.length) {
        for (const e of batch.enrich) {
          const row = conn
            .prepare(`SELECT * FROM documents WHERE id = ?`)
            .get(e.documentId) as DocRow | undefined;
          if (!row) continue; // purged since the worker read it — enrich is best-effort
          const seq = appendChange('document', row.id);
          const metadata = e.metadata
            ? JSON.stringify({
                ...(JSON.parse(row.metadata) as Record<string, unknown>),
                ...e.metadata,
              })
            : row.metadata;
          const text = `${row.title ?? ''}\n${e.markdown}`.trim();
          const languages = text ? deps.detectLanguages(text) : [];
          conn
            .prepare(
              `UPDATE documents SET markdown=?, metadata=?, seq=?, languages=?, updated_at=? WHERE id=?`,
            )
            .run(
              e.markdown,
              metadata,
              seq,
              JSON.stringify(languages),
              deps.now(),
              row.id,
            );
          ftsUpsert(row.id, row.title, e.markdown, languages);
          last = seq;
        }
      }
      return last;
    }

    if ('removeAccount' in batch) {
      const acc = getAccountRow(batch.removeAccount);
      if (!acc) return last;
      // One statement, one pass, by pinned rowid (schema v2) — doc_id is
      // UNINDEXED, so even a single set-based DELETE on it would still scan
      // the whole FTS table (the whole cascade runs synchronously in the DB
      // worker, stalling every queued read until it finishes).
      conn
        .prepare(
          `DELETE FROM documents_fts
          WHERE rowid IN (SELECT rowid FROM documents WHERE account_id = ?)`,
        )
        .run(acc.id);
      conn
        .prepare(
          `DELETE FROM documents_tri
          WHERE rowid IN (SELECT rowid FROM documents WHERE account_id = ?)`,
        )
        .run(acc.id);
      conn.prepare(`DELETE FROM documents WHERE account_id = ?`).run(acc.id);
      conn.prepare(`DELETE FROM vault WHERE account_id = ?`).run(acc.id);
      conn.prepare(`DELETE FROM accounts WHERE id = ?`).run(acc.id);
      last = appendChange('accountRemoved', acc.id);
      return last;
    }

    if ('purgeArchived' in batch) {
      const rows = conn
        .prepare(
          `SELECT id FROM documents WHERE archived_at IS NOT NULL AND archived_at < ?`,
        )
        .all(batch.purgeArchived.before) as Array<{ id: string }>;
      // One set-based FTS delete (same shape as removeAccount) BEFORE the
      // document rows go away — the rowid subselect resolves nothing after.
      conn
        .prepare(
          `DELETE FROM documents_fts
          WHERE rowid IN (SELECT rowid FROM documents
                          WHERE archived_at IS NOT NULL AND archived_at < ?)`,
        )
        .run(batch.purgeArchived.before);
      conn
        .prepare(
          `DELETE FROM documents_tri
          WHERE rowid IN (SELECT rowid FROM documents
                          WHERE archived_at IS NOT NULL AND archived_at < ?)`,
        )
        .run(batch.purgeArchived.before);
      for (const { id } of rows) {
        conn.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
        last = appendChange('purge', id);
      }
      return last;
    }

    const acc = getAccountRow(batch.account);
    if (!acc) throw new Error(`commit: unknown account ${batch.account}`);
    // R5's warn-never-throw. Gated TWICE on purpose:
    //  · on the ACCOUNT being folder-scoped, so non-folder-scoped sources —
    //    which never set scopeRootId — do not warn on every document;
    //  · on a row having actually been WRITTEN (`seq !== null`), because
    //    upsertDocument short-circuits an unchanged live row. Without this
    //    second gate a local-folder re-walk, or a train-1 gdocs/onedrive
    //    account re-emitting its whole corpus with no scopeRootId, would warn
    //    once per file per walk. There is deliberately no `throw` on this
    //    path at all: see DECISIONS R5.
    // The message says "not stamped by this commit", NOT "storing NULL":
    // under C-13's COALESCE the UPDATE branch PRESERVES an existing stamp, so
    // "storing NULL" would be false on every train-1 re-pull of a migrated
    // row. It is true on both branches as worded.
    // console.warn is the in-store idiom for a non-fatal, no-logSink case
    // (schema.ts:80, :366), and it reaches the main process's stderr from
    // inside the DB worker — worker-client.ts:62-65 spawns the Worker without
    // `stderr: true`, so node's default piping to the parent is in force.
    const scoped = isFolderScopedAccount(acc);
    for (const doc of batch.documents) {
      const seq = upsertDocument(acc.id, doc);
      if (seq === null) continue; // unchanged live row — nothing was written
      last = seq;
      if (scoped && doc.scopeRootId === undefined) {
        console.warn(
          'commit: no resolvable folder root — scope_root_id not stamped by this commit',
          {
            accountId: acc.id,
            source: acc.source,
            externalId: doc.externalId,
          },
        );
      }
    }
    const reconciled = reconcileParents(acc.id, batch.documents);
    if (reconciled !== null) last = reconciled;
    for (const ref of batch.deletions ?? []) {
      const seq = archiveByRef(acc.id, ref);
      if (seq !== null) last = seq;
    }
    last = appendChange('account', acc.id);
    conn
      .prepare(
        `UPDATE accounts SET cursor = ?, status = COALESCE(?, status),
         progress = COALESCE(?, progress),
         last_error = CASE WHEN ? THEN ? ELSE last_error END,
         last_sync_at = ?
       WHERE id = ?`,
      )
      .run(
        JSON.stringify(batch.cursor ?? null),
        batch.status ?? null,
        batch.progress ? JSON.stringify(batch.progress) : null,
        batch.error !== undefined ? 1 : 0,
        batch.error ?? null,
        deps.now(),
        acc.id,
      );
    return last;
  });

  const getOrCreateAccountTx = (
    source: string,
    identifier: string,
  ): AccountRow => {
    const found = conn
      .prepare(`SELECT * FROM accounts WHERE source = ? AND identifier = ?`)
      .get(source, identifier) as AccountRow | undefined;
    if (found) return found;
    const id = newId<'account'>();
    conn
      .prepare(
        `INSERT INTO accounts(id, source, identifier, config, status, created_at)
       VALUES(?, ?, ?, '{}', 'live', ?)`,
      )
      .run(id, source, identifier, deps.now());
    appendChange('account', id);
    return getAccountRow(id)!;
  };

  // ── reconcile: the diff never leaves this thread ─────────────────────────
  //
  // The connector's listing and the resulting deletion set are both
  // proportional to the ACCOUNT, and both used to live on the main heap: a
  // 3.7M-document local-folder root (a symlink cycle walked by the watcher)
  // put ~3.2 GiB of `listed[]`/`deletions[]` against V8's 4 GiB cap and
  // killed the main process with an OOM SIGTRAP. Paging the live-ref read
  // only moved the death from the DB worker to the main heap.
  //
  // So the listing is staged here a bounded batch at a time, the diff is an
  // anti-join, and the caller only ever sees counts. `reconcile_listing` is a
  // TEMP table: it lives on this connection alone (which is where every one
  // of these procedures runs), never touches the WAL, and cannot outlive the
  // process. It is keyed by account because per-account sync loops reconcile
  // CONCURRENTLY — an unkeyed staging table would let one account's listing
  // archive another's corpus.
  const RECONCILE_ARCHIVE_BATCH = 5_000;

  const ensureListingTable = (): void => {
    conn.exec(
      `CREATE TEMP TABLE IF NOT EXISTS reconcile_listing (
         account_id TEXT NOT NULL,
         external_id TEXT NOT NULL,
         type TEXT NOT NULL,
         PRIMARY KEY (account_id, external_id, type)
       ) WITHOUT ROWID`,
    );
  };

  const clearListing = (accountId: string): void => {
    ensureListingTable();
    conn
      .prepare(`DELETE FROM reconcile_listing WHERE account_id = ?`)
      .run(accountId);
  };

  const stageTx = conn.transaction(
    (accountId: string, refs: ExternalRef[]): void => {
      const ins = conn.prepare(
        `INSERT OR IGNORE INTO reconcile_listing(account_id, external_id, type)
         VALUES(?, ?, ?)`,
      );
      for (const r of refs) ins.run(accountId, r.externalId, r.type);
    },
  );

  // Live and eligible: committed at or before the caller's snapshot. Anything
  // pull() landed mid-pass is newer than the listing could possibly know
  // about, so it is excluded rather than treated as a deletion (the TOCTOU
  // guard that used to live in reconcilePass).
  const ELIGIBLE = `account_id = ? AND archived_at IS NULL AND seq <= ?`;
  const UNLISTED = `NOT EXISTS (
      SELECT 1 FROM reconcile_listing l
       WHERE l.account_id = documents.account_id
         AND l.external_id = documents.external_id
         AND l.type = documents.type)`;

  const archiveBatchTx = conn.transaction(
    (accountId: string, startSeq: Seq): number => {
      const rows = conn
        .prepare(
          `SELECT id FROM documents
            WHERE ${ELIGIBLE} AND ${UNLISTED}
            LIMIT ?`,
        )
        .all(accountId, startSeq, RECONCILE_ARCHIVE_BATCH) as Array<{
        id: string;
      }>;
      const upd = conn.prepare(
        `UPDATE documents SET archived_at = ?, seq = ?, updated_at = ? WHERE id = ?`,
      );
      for (const { id } of rows) {
        const seq = appendChange('document', id);
        upd.run(deps.now(), seq, deps.now(), id);
      }
      return rows.length;
    },
  );

  // ── folder scope: config + cursor + archival, or none of it ──────────────
  //
  // ONE transaction on purpose, unlike reconcileArchive above. Reconcile is a
  // background repair that may safely be interrupted and resumed; this is a
  // user-visible scope edit. A crash between "config says root R is gone" and
  // "R's documents are archived" leaves the account claiming a scope its
  // corpus does not have, and nothing re-derives it: contentHash excludes
  // scope, so a re-pull never re-stamps an existing row.
  //
  // The SELECT is still PAGED — archived rows drop out of the predicate, so
  // the same "read a page, archive it, repeat" loop reconcileArchive uses
  // works here, which bounds the worker heap to one page of ids even on a
  // multi-million-row account. What it does NOT bound is lock duration: the
  // whole edit is one write transaction by design. Deliberate trade.
  const FOLDER_SCOPE_ARCHIVE_PAGE = 5_000;

  // DECISIONS R8: an explicit IN-list of the stamps the SOURCE says are
  // leaving scope. NEVER a NOT-IN over the surviving roots — core does not
  // know folder containment, and a NOT-IN archives every historical stamp
  // hashSkip froze. An empty list therefore archives nothing, which is the
  // safe default and the common case.
  //
  // json_each over ONE bound JSON array rather than an expanded IN (?,?,…):
  // the list is small today, but a bound-parameter list is capped by
  // SQLITE_MAX_VARIABLE_NUMBER and would start failing at some future size.
  //
  // THERE IS NO NULL-ATTRIBUTION BRANCH IN THIS TRAIN, and its absence is
  // structural, not a switched-off flag (DECISIONS C-34): `FolderScopeInput`
  // carries no `archiveNullScoped`, this predicate has no `IS NULL` disjunct
  // and no flag bind, so restoring the behaviour cannot be a one-word edit:
  // it stops compiling at the engine call site (TS2353 on that call's object
  // literal — which is why the engine passes a literal there, not a widened
  // variable). TWO things must exist first, and both of them:
  //  1. an ARCHIVE-AFTER-PROOF predicate, shaped like reconcile's above —
  //       const ELIGIBLE = `account_id = ? AND archived_at IS NULL AND seq <= ?`;
  //       const UNLISTED = `NOT EXISTS (
  //           SELECT 1 FROM reconcile_listing l
  //            WHERE l.account_id = documents.account_id
  //              AND l.external_id = documents.external_id
  //              AND l.type = documents.type)`;
  //     i.e. archive only rows a COMPLETED, durable listing proved absent, and
  //     only up to the caller's seq snapshot so a concurrent pull is never
  //     read as a deletion;
  //  2. a listing pass for OneDrive, which has no reconcile() at all
  //     (onedrive-kia-connector/src/source.ts:62) and so cannot stage one.
  // Archiving FIRST and repairing with a compensating re-walk is not a
  // substitute: a LIVE row whose content and extraction status are unchanged
  // is never re-stamped by any walk (both cloud connectors' hashSkip is
  // `if (!existing || existing.archivedAt) return false;`, and this file's own
  // upsertDocument early-returns on
  // `content_hash === hash && existing.archived_at === null`), and whether
  // that single re-walk ran, completed and reached the row is not observable
  // from inside the transaction that archived it.
  //
  // Measured on this worktree's better-sqlite3 (SQLite 3.53.2) on 2026-09-05,
  // against a stand-in `documents` table carrying the v1 DDL plus Task 2's
  // column and partial index:
  //   SEARCH documents USING INDEX idx_documents_account_scope_root
  //     (account_id=? AND scope_root_id=?)
  //   LIST SUBQUERY 1 / SCAN json_each VIRTUAL TABLE INDEX 1:
  // Both index columns are usable now; the earlier two-disjunct form could
  // only seek on account_id and added a bloom filter. SQLite's empty-set rule
  // still holds either way: `x IN (empty)` is FALSE even for a NULL x, so an
  // empty archiveScopeRootIds archives nothing.
  const FOLDER_SCOPE_OUT = `account_id = ? AND archived_at IS NULL
       AND scope_root_id IN (SELECT value FROM json_each(?))`;

  // C-46/D5. Re-attribution, the third verb — "this removed root's documents
  // are STILL in scope, under a retained root". Same predicate shape as the
  // archive above and it seeks on the same
  // `idx_documents_account_scope_root` (account_id, scope_root_id).
  //
  // `archived_at IS NULL` for the same reason the archive has it: an archived
  // row is out of the working set, and silently re-stamping one would destroy
  // the record of which root it was archived under — the only thing that could
  // ever explain the archive. It also makes the operation idempotent by
  // construction, since a row that has already moved no longer matches `from`.
  //
  // No `appendChange`, and `seq`/`updated_at` are deliberately NOT touched:
  // `scope_root_id` is core's own attribution bookkeeping, not user-visible
  // content, and churning the feed would resurface every re-attributed
  // document in the user's recent list for a change they cannot see.
  const FOLDER_SCOPE_REATTRIBUTE = `UPDATE documents SET scope_root_id = ?
      WHERE account_id = ? AND scope_root_id = ? AND archived_at IS NULL`;

  const applyFolderScopeTx = conn.transaction(
    (input: FolderScopeInput): FolderScopeResult => {
      const acc = getAccountRow(input.accountId);
      if (!acc)
        throw new Error(`applyFolderScope: unknown account ${input.accountId}`);

      // C-46/D5's guard, ABOVE the stale-config return: a source that names
      // one root in BOTH arrays has said it both leaves scope and does not.
      // There is no order that is "the" right answer, so core refuses rather
      // than silently applying one of two opposite outcomes — and it refuses
      // even when the save turns out to be stale, because the contradiction is
      // a bug in the connector's containment logic that would otherwise
      // surface only on the retry that wins.
      const contradiction = input.reattributeScopeRoots.find(({ from }) =>
        input.archiveScopeRootIds.includes(from),
      );
      if (contradiction)
        throw new Error(
          `applyFolderScope: scope root '${contradiction.from}' is both archived and re-attributed — a source must say exactly one of the two`,
        );

      // Stale-write guard, INSIDE the transaction: two Save clicks on one
      // account must not interleave. Both sides are JSON.stringify output of
      // a parsed object that descends from this same stored text, so key
      // order already matches; re-stringifying normalizes formatting the
      // caller cannot control (and lets a caller pass the raw config column
      // straight through).
      const storedJson = JSON.stringify(
        JSON.parse(acc.config) as Record<string, unknown>,
      );
      const expectedJson = JSON.stringify(
        JSON.parse(input.expectedConfigJson) as Record<string, unknown>,
      );
      if (storedJson !== expectedJson)
        return { archived: 0, reattributed: 0, remaining: 0, stale: true };

      conn
        .prepare(`UPDATE accounts SET config = ?, cursor = ? WHERE id = ?`)
        .run(
          JSON.stringify(withLegacyMirror(acc.source, input.config)),
          JSON.stringify(input.cursor ?? null),
          acc.id,
        );
      appendChange('account', acc.id);

      // Same idiom as archiveBatchTx above — appendChange, then UPDATE
      // documents SET archived_at, seq, updated_at. Archiving is feed-visible,
      // never a raw delete.
      const page = conn.prepare(
        `SELECT id FROM documents WHERE ${FOLDER_SCOPE_OUT} LIMIT ?`,
      );
      const upd = conn.prepare(
        `UPDATE documents SET archived_at = ?, seq = ?, updated_at = ? WHERE id = ?`,
      );
      // BEFORE the archive, so a root re-attributed onto a `to` that this
      // same save then archives really does end up archived — one save, one
      // coherent outcome, and the ordering is pinned by a test.
      const restamp = conn.prepare(FOLDER_SCOPE_REATTRIBUTE);
      let reattributed = 0;
      for (const { from, to } of input.reattributeScopeRoots) {
        reattributed += Number(restamp.run(to, acc.id, from).changes);
      }

      const archiveJson = JSON.stringify(input.archiveScopeRootIds);
      let archived = 0;
      for (;;) {
        const rows = page.all(
          acc.id,
          archiveJson,
          FOLDER_SCOPE_ARCHIVE_PAGE,
        ) as Array<{ id: string }>;
        for (const { id } of rows) {
          const seq = appendChange('document', id);
          upd.run(deps.now(), seq, deps.now(), id);
        }
        archived += rows.length;
        if (rows.length < FOLDER_SCOPE_ARCHIVE_PAGE) break;
      }

      const remaining = Number(
        (
          conn
            .prepare(
              `SELECT COUNT(*) AS n FROM documents
                WHERE account_id = ? AND archived_at IS NULL`,
            )
            .get(acc.id) as { n: number }
        ).n,
      );
      return { archived, reattributed, remaining, stale: false };
    },
  );

  return {
    commit: (batch: CommitBatch): Seq => commitTx(batch),

    reconcileBegin: (accountId) => clearListing(accountId),

    reconcileStage: (accountId, refs) => {
      if (refs.length === 0) return;
      ensureListingTable();
      stageTx(accountId, refs);
    },

    reconcileDiff: (accountId, startSeq) => {
      ensureListingTable();
      const listedCount = Number(
        (
          conn
            .prepare(
              `SELECT COUNT(*) AS n FROM reconcile_listing WHERE account_id = ?`,
            )
            .get(accountId) as { n: number }
        ).n,
      );
      const counts = conn
        .prepare(
          `SELECT COUNT(*) AS live,
                  SUM(CASE WHEN ${UNLISTED} THEN 1 ELSE 0 END) AS gone
             FROM documents WHERE ${ELIGIBLE}`,
        )
        .get(accountId, startSeq) as { live: number; gone: number | null };
      return {
        listedCount,
        liveCount: Number(counts.live),
        deletionCount: Number(counts.gone ?? 0),
      };
    },

    reconcileArchive: (accountId, startSeq) => {
      ensureListingTable();
      // Batched so one cleanup of a poisoned multi-million-document account
      // is a series of bounded transactions rather than a single one holding
      // a write lock (and its rollback journal) over the whole corpus.
      let archived = 0;
      for (;;) {
        const n = archiveBatchTx(accountId, startSeq);
        archived += n;
        if (n < RECONCILE_ARCHIVE_BATCH) break;
      }
      clearListing(accountId);
      return archived;
    },

    reconcileEnd: (accountId) => clearListing(accountId),

    applyFolderScope: (input) => applyFolderScopeTx(input),
  };
}
