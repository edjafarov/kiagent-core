import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import type {
  Account,
  AccountId,
  Cadence,
  Change,
  CommitBatch,
  ConsentRecord,
  Credentials,
  Document,
  DocumentId,
  DocumentInput,
  ExtensionId,
  ExternalRef,
  Identity,
  Query,
  Seq,
  Store,
  SyncStatus,
} from '@shared/contracts';

import { newId } from '../ids';
import { migrate } from './schema';

/** Injected so the store stays testable and Electron-free. */
export interface StoreDeps {
  /** Credential blob encryption (Electron safeStorage in production). */
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
  /** Cheap language detection for search stemming (ISO-639-3). */
  detectLanguages(text: string): string[];
  now?(): string;
}

export interface LedgerCounts {
  done: number;
  skip: number;
  failed: number;
  deferred: number;
}

export interface ScheduleRow {
  jobId: string;
  cadence: Cadence;
  lastRun: string | null;
  nextRun: string | null;
}

/**
 * The Store contract plus the in-process surface the ENGINE needs (consumer
 * cursors, work ledger, schedule, account creation). Extensions never see
 * this type — they get the plain `Store` slices their caps allow.
 */
export interface CoreStore extends Store {
  createAccount(a: {
    source: string;
    identifier: string;
    config?: Record<string, unknown>;
    status?: SyncStatus;
    cadence?: Cadence;
  }): Promise<Account>;
  getOrCreateAccount(source: string, identifier: string): Promise<Account>;
  account(id: AccountId): Promise<Account | null>;
  setAccountCadence(id: AccountId, cadence: Cadence | null): Promise<void>;
  setAccountConfig(
    id: AccountId,
    config: Record<string, unknown>,
  ): Promise<void>;
  /** (externalId, type, seq) for every non-archived document under an
   *  account — the diff surface `reconcile()` archiving needs, without
   *  paying for full Document rows (title/markdown/metadata) just to compare
   *  keys. `seq` lets a caller exclude documents committed after some point
   *  in time (see reconcilePass's TOCTOU guard in engine.ts). */
  liveRefs(accountId: AccountId): Array<ExternalRef & { seq: Seq }>;
  consumerCursor(name: string): Seq;
  ledgerRecord(
    consumer: string,
    seq: Seq,
    attempts: number,
    outcome: 'done' | 'skip' | 'failed' | 'deferred' | null,
  ): void;
  ledgerCounts(consumer: string): LedgerCounts;
  /** Across every consumer — drives the app-wide processing panel. */
  ledgerCountsAll(): LedgerCounts & { pending: number };
  ledgerDeferred(consumer: string): Seq[];
  changesAt(seqs: Seq[]): Change[];
  headSeq(): Seq;
  scheduleAll(): ScheduleRow[];
  scheduleUpsert(row: ScheduleRow): void;
  scheduleDelete(jobId: string): void;
  close(): void;
}

const FEED_BATCH = 500;

interface DocRow {
  id: string;
  account_id: string;
  external_id: string;
  type: string;
  title: string | null;
  markdown: string | null;
  url: string | null;
  metadata: string;
  created_at: string | null;
  parent_id: string | null;
  content_hash: string;
  seq: number;
  archived_at: string | null;
  languages: string;
  ingested_at: string;
  updated_at: string;
}

interface AccountRow {
  id: string;
  source: string;
  identifier: string;
  config: string;
  status: string;
  cursor: string | null;
  progress: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  cadence: string | null;
  created_at: string;
}

function toDocument(r: DocRow): Document {
  return {
    id: r.id as DocumentId,
    accountId: r.account_id as AccountId,
    externalId: r.external_id,
    type: r.type,
    title: r.title,
    markdown: r.markdown,
    url: r.url ?? undefined,
    metadata: JSON.parse(r.metadata),
    createdAt: r.created_at,
    parentId: (r.parent_id as DocumentId) ?? null,
    contentHash: r.content_hash,
    seq: r.seq,
    archivedAt: r.archived_at,
    languages: JSON.parse(r.languages),
    ingestedAt: r.ingested_at,
    updatedAt: r.updated_at,
  };
}

function toAccount(r: AccountRow): Account {
  return {
    id: r.id as AccountId,
    source: r.source,
    identifier: r.identifier,
    config: JSON.parse(r.config),
    status: r.status as SyncStatus,
    cursor: r.cursor === null ? null : JSON.parse(r.cursor),
    progress: r.progress === null ? undefined : JSON.parse(r.progress),
    lastSyncAt: r.last_sync_at ?? undefined,
    lastError: r.last_error ?? undefined,
    cadence: r.cadence === null ? undefined : JSON.parse(r.cadence),
    createdAt: r.created_at,
  };
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
 * Compile user search text into an FTS5 MATCH expression.
 *
 * Supported syntax:
 *   term term            — implicit AND
 *   AND / OR / NOT       — boolean operators (UPPERCASE only; lowercase
 *                          and/or/not are ordinary search terms)
 *   -term                — exclude (shorthand for NOT)
 *   "a phrase"           — exact phrase
 *   term*                — prefix match
 *   ( … )                — grouping
 *
 * Every term is emitted as a quoted FTS5 string, so raw FTS5 syntax
 * (bare `-`, `:`, NEAR, column filters) can never leak through and throw.
 * Structural mistakes (unbalanced parens, negation with nothing positive
 * beside it) throw descriptive Errors — the MCP registry forwards those
 * to the calling LLM, which can then correct the query.
 */
type FtsToken =
  | { kind: 'op'; op: 'AND' | 'OR' | 'NOT' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }
  | { kind: 'str'; value: string; prefix: boolean; negated: boolean };

function tokenizeFts(text: string): FtsToken[] {
  const out: FtsToken[] = [];
  const re = /(-)?"([^"]*)"\s*(\*)?|(\()|(\))|([^\s()]+)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text)) !== null) {
    if (m[2] !== undefined) {
      const value = m[2].trim();
      if (value)
        out.push({
          kind: 'str',
          value,
          prefix: m[3] === '*',
          negated: m[1] === '-',
        });
    } else if (m[4]) out.push({ kind: 'lparen' });
    else if (m[5]) out.push({ kind: 'rparen' });
    else {
      let word = m[6];
      if (word === 'AND' || word === 'OR' || word === 'NOT') {
        out.push({ kind: 'op', op: word });
        continue;
      }
      const negated = word.startsWith('-');
      if (negated) word = word.slice(1);
      const prefix = word.endsWith('*');
      if (prefix) word = word.replace(/\*+$/, '');
      word = word.replace(/["*]/g, '');
      if (word) out.push({ kind: 'str', value: word, prefix, negated });
    }
  }
  return out;
}

function ftsQuery(text: string): string {
  const tokens = tokenizeFts(text);
  let pos = 0;

  // andGroup := (term | NOT term | ( orExpr ))+ — implicit AND between
  // operands. FTS5 has no unary NOT, so negations are emitted as trailing
  // binary NOTs: `a AND b NOT c NOT d` (associativity is irrelevant — any
  // grouping yields "matches a and b, minus c, minus d").
  const parseAnd = (): string => {
    const positives: string[] = [];
    const negatives: string[] = [];
    let pendingNot = false;
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.kind === 'rparen' || (t.kind === 'op' && t.op === 'OR')) break;
      pos += 1;
      if (t.kind === 'op') {
        // AND is the implicit joiner anyway; NOT flags the next operand.
        if (t.op === 'NOT') pendingNot = true;
        continue;
      }
      let operand: string;
      let negated = pendingNot;
      pendingNot = false;
      if (t.kind === 'lparen') {
        // eslint-disable-next-line @typescript-eslint/no-use-before-define
        operand = parseOr();
        if (tokens[pos]?.kind === 'rparen') pos += 1;
        else throw new Error('search query: missing closing ")"');
        if (!operand) continue; // empty group — ignore
      } else {
        operand = `"${t.value.replace(/"/g, '""')}"${t.prefix ? ' *' : ''}`;
        negated = negated || t.negated;
      }
      (negated ? negatives : positives).push(operand);
    }
    if (negatives.length && !positives.length)
      throw new Error(
        'search query: negation (-term / NOT) needs at least one positive term alongside it',
      );
    if (!positives.length) return '';
    let expr = positives.join(' AND ');
    for (const n of negatives) expr = `${expr} NOT ${n}`;
    return positives.length + negatives.length > 1 ? `(${expr})` : expr;
  };

  const parseOr = (): string => {
    const branches: string[] = [parseAnd()];
    while (pos < tokens.length) {
      const t = tokens[pos];
      if (t.kind !== 'op' || t.op !== 'OR') break;
      pos += 1;
      branches.push(parseAnd());
    }
    const parts = branches.filter(Boolean);
    if (parts.length === 0) return '';
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  };

  const expr = parseOr();
  if (pos < tokens.length) throw new Error('search query: unmatched ")"');
  return expr || '""';
}

export function openStore(dbPath: string, deps: StoreDeps): CoreStore {
  const db: BetterSqlite3.Database = new Database(dbPath);
  migrate(db);
  const now = deps.now ?? (() => new Date().toISOString());
  const nudge = new EventEmitter();
  nudge.setMaxListeners(0);
  let closed = false;

  // ── low-level helpers (all run inside the caller's transaction) ──────────

  const appendChange = (kind: Change['kind'], refId: string): Seq => {
    const r = db
      .prepare(`INSERT INTO changes(kind, ref_id, at) VALUES(?, ?, ?)`)
      .run(kind, refId, now());
    return Number(r.lastInsertRowid);
  };

  const getAccountRow = (id: string): AccountRow | undefined =>
    db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as
      | AccountRow
      | undefined;

  const findDocRow = (
    accountId: string,
    externalId: string,
    type: string,
  ): DocRow | undefined =>
    db
      .prepare(
        `SELECT * FROM documents WHERE account_id = ? AND external_id = ? AND type = ?`,
      )
      .get(accountId, externalId, type) as DocRow | undefined;

  const ftsDelete = (docId: string): void => {
    db.prepare(`DELETE FROM documents_fts WHERE doc_id = ?`).run(docId);
  };

  const ftsUpsert = (
    docId: string,
    title: string | null,
    markdown: string | null,
  ): void => {
    ftsDelete(docId);
    db.prepare(
      `INSERT INTO documents_fts(doc_id, title, markdown) VALUES(?, ?, ?)`,
    ).run(docId, title ?? '', markdown ?? '');
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
    const ts = now();
    if (existing) {
      const seq = appendChange('document', existing.id);
      db.prepare(
        `UPDATE documents SET title=?, markdown=?, url=?, metadata=?, created_at=?,
           parent_id=?, content_hash=?, seq=?, archived_at=NULL, languages=?, updated_at=?
         WHERE id=?`,
      ).run(
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
    db.prepare(
      `INSERT INTO documents(id, account_id, external_id, type, title, markdown, url,
         metadata, created_at, parent_id, content_hash, seq, archived_at, languages,
         ingested_at, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    ).run(
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
    ftsUpsert(id, input.title, input.markdown);
    return seq;
  };

  const archiveByRef = (accountId: string, ref: ExternalRef): Seq | null => {
    const row = findDocRow(accountId, ref.externalId, ref.type);
    if (!row || row.archived_at !== null) return null;
    const seq = appendChange('document', row.id);
    db.prepare(
      `UPDATE documents SET archived_at = ?, seq = ?, updated_at = ? WHERE id = ?`,
    ).run(now(), seq, now(), row.id);
    return seq;
  };

  // ── the write primitive ───────────────────────────────────────────────────

  const commitTx = db.transaction((batch: CommitBatch): Seq => {
    let last: Seq = Number(
      (
        db.prepare(`SELECT MAX(seq) AS s FROM changes`).get() as {
          s: number | null;
        }
      ).s ?? 0,
    );

    if ('consumer' in batch) {
      db.prepare(
        `INSERT INTO consumers(name, cursor) VALUES(?, ?)
         ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor`,
      ).run(batch.consumer, batch.cursor);
      if (batch.documents?.length) {
        // Worker emissions land under the worker's synthetic account,
        // atomically with its cursor.
        const synthetic = getOrCreateAccountTx('worker', batch.consumer);
        for (const doc of batch.documents) {
          const seq = upsertDocument(synthetic.id, doc);
          if (seq !== null) last = seq;
        }
      }
      if (batch.enrich?.length) {
        for (const e of batch.enrich) {
          const row = db
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
          db.prepare(
            `UPDATE documents SET markdown=?, metadata=?, seq=?, languages=?, updated_at=? WHERE id=?`,
          ).run(
            e.markdown,
            metadata,
            seq,
            JSON.stringify(languages),
            now(),
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
      // One statement, one pass: `doc_id` is UNINDEXED in the fts5 table, so
      // the per-document ftsDelete loop this replaces was a full FTS scan
      // PER document — quadratic on exactly the accounts big enough for the
      // stall to be felt (the whole cascade runs synchronously on the main
      // process, freezing every IPC until it finishes).
      db.prepare(
        `DELETE FROM documents_fts
          WHERE doc_id IN (SELECT id FROM documents WHERE account_id = ?)`,
      ).run(acc.id);
      db.prepare(`DELETE FROM documents WHERE account_id = ?`).run(acc.id);
      db.prepare(`DELETE FROM vault WHERE account_id = ?`).run(acc.id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(acc.id);
      last = appendChange('accountRemoved', acc.id);
      return last;
    }

    if ('purgeArchived' in batch) {
      const rows = db
        .prepare(
          `SELECT id FROM documents WHERE archived_at IS NOT NULL AND archived_at < ?`,
        )
        .all(batch.purgeArchived.before) as Array<{ id: string }>;
      for (const { id } of rows) {
        ftsDelete(id);
        db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
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
    for (const ref of batch.deletions ?? []) {
      const seq = archiveByRef(acc.id, ref);
      if (seq !== null) last = seq;
    }
    last = appendChange('account', acc.id);
    db.prepare(
      `UPDATE accounts SET cursor = ?, status = COALESCE(?, status),
         progress = COALESCE(?, progress),
         last_error = CASE WHEN ? THEN ? ELSE last_error END,
         last_sync_at = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify(batch.cursor ?? null),
      batch.status ?? null,
      batch.progress ? JSON.stringify(batch.progress) : null,
      batch.error !== undefined ? 1 : 0,
      batch.error ?? null,
      now(),
      acc.id,
    );
    return last;
  });

  const getOrCreateAccountTx = (
    source: string,
    identifier: string,
  ): AccountRow => {
    const found = db
      .prepare(`SELECT * FROM accounts WHERE source = ? AND identifier = ?`)
      .get(source, identifier) as AccountRow | undefined;
    if (found) return found;
    const id = newId<'account'>();
    db.prepare(
      `INSERT INTO accounts(id, source, identifier, config, status, created_at)
       VALUES(?, ?, ?, '{}', 'live', ?)`,
    ).run(id, source, identifier, now());
    appendChange('account', id);
    return getAccountRow(id)!;
  };

  // ── feed materialization ──────────────────────────────────────────────────

  const materializeRow = (r: {
    seq: number;
    kind: Change['kind'];
    ref_id: string;
  }): Change | null => {
    if (r.kind === 'document') {
      const doc = db
        .prepare(`SELECT * FROM documents WHERE id = ?`)
        .get(r.ref_id) as DocRow | undefined;
      // Row already purged — the tombstone further down the feed informs.
      return doc
        ? { seq: r.seq, kind: 'document', document: toDocument(doc) }
        : null;
    }
    if (r.kind === 'account') {
      const acc = getAccountRow(r.ref_id);
      return acc
        ? { seq: r.seq, kind: 'account', account: toAccount(acc) }
        : null;
    }
    if (r.kind === 'purge') {
      return { seq: r.seq, kind: 'purge', documentId: r.ref_id as DocumentId };
    }
    return {
      seq: r.seq,
      kind: 'accountRemoved',
      accountId: r.ref_id as AccountId,
    };
  };

  /** `high` = last RAW change row scanned — callers advance to it even when
   *  every row in the window materialized to nothing. */
  const materialize = (
    after: Seq,
    kinds?: Change['kind'][],
  ): { changes: Change[]; high: Seq } => {
    const kindFilter = kinds?.length
      ? ` AND kind IN (${kinds.map(() => '?').join(',')})`
      : '';
    const rows = db
      .prepare(
        `SELECT seq, kind, ref_id FROM changes WHERE seq > ?${kindFilter}
         ORDER BY seq LIMIT ${FEED_BATCH}`,
      )
      .all(after, ...(kinds?.length ? kinds : [])) as Array<{
      seq: number;
      kind: Change['kind'];
      ref_id: string;
    }>;
    const changes: Change[] = [];
    for (const r of rows) {
      const c = materializeRow(r);
      if (c) changes.push(c);
    }
    return { changes, high: rows.length ? rows[rows.length - 1].seq : after };
  };

  // ── the Query surface ─────────────────────────────────────────────────────

  const query: Query = {
    async document(id) {
      const r = db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id) as
        | DocRow
        | undefined;
      return r ? toDocument(r) : null;
    },
    async children(id) {
      const rows = db
        .prepare(
          `SELECT * FROM documents WHERE parent_id = ? AND archived_at IS NULL
           ORDER BY created_at`,
        )
        .all(id) as DocRow[];
      return rows.map(toDocument);
    },
    async byExternalId(account, externalId, type) {
      const r = findDocRow(account, externalId, type);
      return r ? toDocument(r) : null;
    },
    async search(q) {
      const limit = Math.min(q.limit ?? 50, 500);
      const offset = q.offset ?? 0;
      const filters: string[] = [];
      const params: unknown[] = [];
      if (!q.includeArchived) filters.push(`d.archived_at IS NULL`);
      if (q.type) {
        filters.push(`d.type = ?`);
        params.push(q.type);
      }
      if (q.account) {
        filters.push(`d.account_id = ?`);
        params.push(q.account);
      }
      // Bounds apply to the document's ORIGIN date (when the email/message
      // was written), falling back to ingest time for undated documents —
      // never to write order, which a newest-first backfill inverts.
      if (q.fromDate) {
        filters.push(`COALESCE(d.created_at, d.ingested_at) >= ?`);
        params.push(q.fromDate);
      }
      if (q.toDate) {
        filters.push(`COALESCE(d.created_at, d.ingested_at) <= ?`);
        params.push(q.toDate);
      }
      const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
      if (q.text?.trim()) {
        const rows = db
          .prepare(
            `SELECT d.*, snippet(documents_fts, 2, '<b>', '</b>', '…', 24) AS _snippet
             FROM documents_fts f JOIN documents d ON d.id = f.doc_id
             WHERE documents_fts MATCH ? ${where}
             ORDER BY bm25(documents_fts, 0, 4.0, 1.0)
             LIMIT ? OFFSET ?`,
          )
          .all(ftsQuery(q.text), ...params, limit, offset) as Array<
          DocRow & { _snippet: string }
        >;
        return rows.map((r) => ({ ...toDocument(r), snippet: r._snippet }));
      }
      const rows = db
        .prepare(
          `SELECT d.* FROM documents d WHERE 1=1 ${where}
           ORDER BY COALESCE(d.created_at, d.ingested_at) DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as DocRow[];
      return rows.map(toDocument);
    },
    async count(q) {
      const filters: string[] = [];
      const params: unknown[] = [];
      if (!q.includeArchived) filters.push(`archived_at IS NULL`);
      if (q.type) {
        filters.push(`type = ?`);
        params.push(q.type);
      }
      if (q.account) {
        filters.push(`account_id = ?`);
        params.push(q.account);
      }
      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const r = db
        .prepare(`SELECT COUNT(*) AS c FROM documents ${where}`)
        .get(...params) as { c: number };
      return r.c;
    },
    async accounts() {
      const rows = db
        .prepare(`SELECT * FROM accounts ORDER BY created_at`)
        .all() as AccountRow[];
      return rows.map(toAccount);
    },
  };

  // ── public surface ────────────────────────────────────────────────────────

  const store: CoreStore = {
    read: query,

    extractionStats() {
      // pendingOcr is a display-level approximation of the vision worker's
      // classify eligibility — it ignores size caps and tiny-image rules.
      const pendingOcr = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM documents
             WHERE json_extract(metadata,'$.extraction') IS NULL
               AND (json_extract(metadata,'$.mime') LIKE 'image/%'
                    OR json_extract(metadata,'$.mime') = 'application/pdf')
               AND archived_at IS NULL`,
          )
          .get() as { c: number }
      ).c;
      const processed = (
        db
          .prepare(
            `SELECT COUNT(*) AS c FROM documents
             WHERE json_extract(metadata,'$.extraction') IS NOT NULL
               AND archived_at IS NULL`,
          )
          .get() as { c: number }
      ).c;
      const rows = db
        .prepare(
          `SELECT id, title, json_extract(metadata,'$.filename') AS filename, type,
                  json_extract(metadata,'$.extraction.engine') AS engine, updated_at
           FROM documents
           WHERE json_extract(metadata,'$.extraction') IS NOT NULL AND archived_at IS NULL
           ORDER BY updated_at DESC, seq DESC LIMIT 10`,
        )
        .all() as Array<{
        id: string;
        title: string | null;
        filename: string | null;
        type: string;
        engine: string | null;
        updated_at: string;
      }>;
      return {
        pendingOcr,
        processed,
        recent: rows.map((r) => ({
          id: r.id as DocumentId,
          title: r.title,
          filename: r.filename,
          type: r.type,
          engine: r.engine ?? '',
          updatedAt: r.updated_at,
        })),
      };
    },

    async commit(batch) {
      const seq = commitTx(batch);
      nudge.emit('commit');
      return seq;
    },

    feed(after, opts) {
      return {
        [Symbol.asyncIterator]() {
          let cursor = after;
          return {
            async next(): Promise<IteratorResult<Change[]>> {
              for (;;) {
                if (closed) return { done: true, value: undefined };
                const { changes, high } = materialize(cursor, opts?.kinds);
                if (changes.length > 0) {
                  cursor = high;
                  return { done: false, value: changes };
                }
                if (high > cursor) {
                  cursor = high; // window held only unmaterializable rows
                  continue;
                }
                await new Promise<void>((resolve) => {
                  nudge.once('commit', resolve);
                });
              }
            },
            async return(): Promise<IteratorResult<Change[]>> {
              return { done: true, value: undefined };
            },
          };
        },
      };
    },

    vault: {
      async save(account, c) {
        db.prepare(
          `INSERT INTO vault(account_id, blob) VALUES(?, ?)
           ON CONFLICT(account_id) DO UPDATE SET blob = excluded.blob`,
        ).run(account, deps.encrypt(JSON.stringify(c)));
      },
      async load(account) {
        const r = db
          .prepare(`SELECT blob FROM vault WHERE account_id = ?`)
          .get(account) as { blob: Buffer } | undefined;
        if (!r) return null;
        return JSON.parse(deps.decrypt(r.blob)) as Credentials;
      },
      async delete(account) {
        db.prepare(`DELETE FROM vault WHERE account_id = ?`).run(account);
      },
    },

    identity: {
      async get() {
        const r = db
          .prepare(`SELECT value FROM meta WHERE key = 'identity'`)
          .get() as { value: string } | undefined;
        return r ? (JSON.parse(r.value) as Identity) : null;
      },
      async set(i) {
        db.prepare(
          `INSERT INTO meta(key, value) VALUES('identity', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        ).run(JSON.stringify(i));
      },
    },

    consents: {
      async latest(extension: ExtensionId) {
        const r = db
          .prepare(
            `SELECT * FROM consents WHERE extension_id = ? ORDER BY id DESC LIMIT 1`,
          )
          .get(extension) as
          | {
              extension_id: string;
              caps: string;
              manifest_version: string;
              granted_at: string;
            }
          | undefined;
        if (!r) return null;
        return {
          extensionId: r.extension_id as ExtensionId,
          caps: JSON.parse(r.caps),
          manifestVersion: r.manifest_version,
          grantedAt: r.granted_at,
        } as ConsentRecord;
      },
      async record(c) {
        db.prepare(
          `INSERT INTO consents(extension_id, caps, manifest_version, granted_at)
           VALUES(?, ?, ?, ?)`,
        ).run(
          c.extensionId,
          JSON.stringify(c.caps),
          c.manifestVersion,
          c.grantedAt,
        );
      },
    },

    maintenance: {
      async compact() {
        db.exec('VACUUM');
      },
      async export(destDir) {
        fs.mkdirSync(destDir, { recursive: true });
        const accounts = await query.accounts();
        fs.writeFileSync(
          path.join(destDir, 'accounts.json'),
          JSON.stringify(accounts, null, 2),
        );
        const out = fs.createWriteStream(path.join(destDir, 'documents.jsonl'));
        const rows = db
          .prepare(`SELECT * FROM documents`)
          .iterate() as IterableIterator<DocRow>;
        for (const r of rows) out.write(`${JSON.stringify(toDocument(r))}\n`);
        await new Promise<void>((resolve, reject) => {
          out.end(() => resolve());
          out.on('error', reject);
        });
      },
      async resetAll() {
        db.transaction(() => {
          // 'consents' deliberately survives: installed extensions live on
          // disk outside the DB, so wiping their grants would strand every
          // one of them in needs-consent after reset.
          for (const t of [
            'documents_fts',
            'documents',
            'changes',
            'consumers',
            'work_ledger',
            'vault',
            'schedule',
            'accounts',
          ]) {
            db.prepare(`DELETE FROM ${t}`).run();
          }
          db.prepare(`DELETE FROM meta WHERE key != 'schemaVersion'`).run();
        })();
        // DELETE alone never returns pages to the OS — the file (and the
        // WAL) keep their pre-reset size, so the Storage screen would still
        // show gigabytes after "Reset all". VACUUM rebuilds the file;
        // the TRUNCATE checkpoint then zeroes the WAL it wrote through.
        db.exec('VACUUM');
        db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
        nudge.emit('commit');
      },
    },

    // ── engine-only surface ──────────────────────────────────────────────────

    async createAccount(a) {
      const tx = db.transaction(() => {
        const id = newId<'account'>();
        const row = db
          .prepare(
            `INSERT INTO accounts(id, source, identifier, config, status, cadence, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source, identifier) DO UPDATE SET
               config = excluded.config,
               status = excluded.status
             RETURNING id`,
          )
          .get(
            id,
            a.source,
            a.identifier,
            JSON.stringify(a.config ?? {}),
            a.status ?? 'connecting',
            a.cadence ? JSON.stringify(a.cadence) : null,
            now(),
          ) as { id: string };
        appendChange('account', row.id);
        return row.id;
      });
      const id = tx();
      nudge.emit('commit');
      return toAccount(getAccountRow(id)!);
    },

    async getOrCreateAccount(source, identifier) {
      const row = db.transaction(() =>
        getOrCreateAccountTx(source, identifier),
      )();
      nudge.emit('commit');
      return toAccount(row);
    },

    async account(id) {
      const r = getAccountRow(id);
      return r ? toAccount(r) : null;
    },

    async setAccountCadence(id, cadence) {
      db.transaction(() => {
        db.prepare(`UPDATE accounts SET cadence = ? WHERE id = ?`).run(
          cadence ? JSON.stringify(cadence) : null,
          id,
        );
        appendChange('account', id);
      })();
      nudge.emit('commit');
    },

    async setAccountConfig(id, config) {
      db.transaction(() => {
        db.prepare(`UPDATE accounts SET config = ? WHERE id = ?`).run(
          JSON.stringify(config),
          id,
        );
        appendChange('account', id);
      })();
      nudge.emit('commit');
    },

    liveRefs(accountId) {
      const rows = db
        .prepare(
          `SELECT external_id, type, seq FROM documents WHERE account_id = ? AND archived_at IS NULL`,
        )
        .all(accountId) as Array<{
        external_id: string;
        type: string;
        seq: number;
      }>;
      return rows.map((r) => ({
        externalId: r.external_id,
        type: r.type,
        seq: r.seq,
      }));
    },

    consumerCursor(name) {
      const r = db
        .prepare(`SELECT cursor FROM consumers WHERE name = ?`)
        .get(name) as { cursor: number } | undefined;
      return r?.cursor ?? 0;
    },

    ledgerRecord(consumer, seq, attempts, outcome) {
      db.prepare(
        `INSERT INTO work_ledger(consumer, seq, attempts, outcome, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(consumer, seq) DO UPDATE
           SET attempts = excluded.attempts, outcome = excluded.outcome,
               updated_at = excluded.updated_at`,
      ).run(consumer, seq, attempts, outcome, now());
    },

    ledgerCounts(consumer) {
      const rows = db
        .prepare(
          `SELECT outcome, COUNT(*) AS c FROM work_ledger WHERE consumer = ? GROUP BY outcome`,
        )
        .all(consumer) as Array<{ outcome: string | null; c: number }>;
      const counts: LedgerCounts = { done: 0, skip: 0, failed: 0, deferred: 0 };
      for (const r of rows) {
        if (r.outcome && r.outcome in counts) {
          counts[r.outcome as keyof LedgerCounts] = r.c;
        }
      }
      return counts;
    },

    ledgerCountsAll() {
      const rows = db
        .prepare(
          `SELECT outcome, COUNT(*) AS c FROM work_ledger GROUP BY outcome`,
        )
        .all() as Array<{ outcome: string | null; c: number }>;
      const counts = { done: 0, skip: 0, failed: 0, deferred: 0, pending: 0 };
      for (const r of rows) {
        if (r.outcome && r.outcome in counts) {
          counts[r.outcome as keyof LedgerCounts] = r.c;
        }
      }
      const head =
        (
          db.prepare(`SELECT MAX(seq) AS s FROM changes`).get() as {
            s: number | null;
          }
        ).s ?? 0;
      const lags = db.prepare(`SELECT cursor FROM consumers`).all() as Array<{
        cursor: number;
      }>;
      counts.pending = lags.reduce(
        (max, r) => Math.max(max, head - r.cursor),
        0,
      );
      return counts;
    },

    ledgerDeferred(consumer) {
      const rows = db
        .prepare(
          `SELECT seq FROM work_ledger WHERE consumer = ? AND outcome = 'deferred' ORDER BY seq`,
        )
        .all(consumer) as Array<{ seq: number }>;
      return rows.map((r) => r.seq);
    },

    changesAt(seqs) {
      const out: Change[] = [];
      for (const seq of seqs) {
        const row = db
          .prepare(`SELECT seq, kind, ref_id FROM changes WHERE seq = ?`)
          .get(seq) as
          | { seq: number; kind: Change['kind']; ref_id: string }
          | undefined;
        if (!row) continue;
        const c = materializeRow(row);
        if (c) out.push(c);
      }
      return out;
    },

    headSeq() {
      const r = db.prepare(`SELECT MAX(seq) AS s FROM changes`).get() as {
        s: number | null;
      };
      return r.s ?? 0;
    },

    scheduleAll() {
      const rows = db.prepare(`SELECT * FROM schedule`).all() as Array<{
        job_id: string;
        cadence: string;
        last_run: string | null;
        next_run: string | null;
      }>;
      return rows.map((r) => ({
        jobId: r.job_id,
        cadence: JSON.parse(r.cadence) as Cadence,
        lastRun: r.last_run,
        nextRun: r.next_run,
      }));
    },

    scheduleUpsert(row) {
      db.prepare(
        `INSERT INTO schedule(job_id, cadence, last_run, next_run) VALUES(?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE
           SET cadence = excluded.cadence, last_run = excluded.last_run,
               next_run = excluded.next_run`,
      ).run(row.jobId, JSON.stringify(row.cadence), row.lastRun, row.nextRun);
    },

    scheduleDelete(jobId) {
      db.prepare(`DELETE FROM schedule WHERE job_id = ?`).run(jobId);
    },

    close() {
      closed = true;
      nudge.emit('commit'); // release blocked feed iterators
      db.close();
    },
  };

  return store;
}
