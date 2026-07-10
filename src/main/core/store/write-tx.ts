import { createHash } from 'crypto';

import type BetterSqlite3 from 'better-sqlite3';

import type {
  Change,
  CommitBatch,
  DocumentInput,
  ExternalRef,
  Seq,
} from '@shared/contracts';

import { newId } from '../ids';
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
): { commit(batch: CommitBatch): Seq } {
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

  // FTS rows are rowid-pinned to their document's rowid (schema v2): deletes
  // and replacements are rowid-equality lookups instead of full virtual-table
  // scans on the UNINDEXED doc_id. Both callers write the documents row
  // before touching FTS, so the subselect always resolves.
  const ftsDelete = (docId: string): void => {
    conn
      .prepare(
        `DELETE FROM documents_fts
        WHERE rowid = (SELECT rowid FROM documents WHERE id = ?)`,
      )
      .run(docId);
  };

  /** Insert-only FTS write for a brand-new document — its id was minted in
   *  this transaction, so there is nothing to delete first (the old
   *  unconditional delete-then-insert made every fresh ingest pay a full
   *  FTS scan: O(N²) across a backfill). */
  const ftsInsert = (
    docId: string,
    title: string | null,
    markdown: string | null,
  ): void => {
    conn
      .prepare(
        `INSERT INTO documents_fts(rowid, doc_id, title, markdown)
        VALUES((SELECT rowid FROM documents WHERE id = ?), ?, ?, ?)`,
      )
      .run(docId, docId, title ?? '', markdown ?? '');
  };

  const ftsUpsert = (
    docId: string,
    title: string | null,
    markdown: string | null,
  ): void => {
    ftsDelete(docId);
    ftsInsert(docId, title, markdown);
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
           parent_id=?, content_hash=?, seq=?, archived_at=NULL, languages=?, updated_at=?
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
          existing.id,
        );
      ftsUpsert(existing.id, input.title, input.markdown);
      return seq;
    }
    const id = newId<'document'>();
    const seq = appendChange('document', id);
    conn
      .prepare(
        `INSERT INTO documents(id, account_id, external_id, type, title, markdown, url,
         metadata, created_at, parent_id, content_hash, seq, archived_at, languages,
         ingested_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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
      );
    ftsInsert(id, input.title, input.markdown);
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
          ftsUpsert(row.id, row.title, e.markdown);
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
      for (const { id } of rows) {
        conn.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
        last = appendChange('purge', id);
      }
      return last;
    }

    const acc = getAccountRow(batch.account);
    if (!acc) throw new Error(`commit: unknown account ${batch.account}`);
    for (const doc of batch.documents) {
      const seq = upsertDocument(acc.id, doc);
      if (seq !== null) last = seq;
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

  return { commit: (batch: CommitBatch): Seq => commitTx(batch) };
}
