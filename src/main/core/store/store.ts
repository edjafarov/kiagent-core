import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import type {
  Account,
  AccountId,
  Cadence,
  Change,
  ConsentRecord,
  Credentials,
  Document,
  DocumentId,
  ExtensionId,
  ExternalRef,
  Identity,
  Query,
  Seq,
  Store,
  SyncStatus,
} from '@shared/contracts';

import type { AppDb, AppDbParam } from '../../db/app-db';
import { newId } from '../ids';
import { stemVariants } from '../stemming';
import {
  buildSnippet,
  extractTerms,
  foldForNegation,
  rrfMerge,
  toTrigramMatch,
} from './fuzzy';
import { repopulateSearchIndex } from './schema';
import { createWriteTx } from './write-tx';

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
  liveRefs(accountId: AccountId): Promise<Array<ExternalRef & { seq: Seq }>>;
  consumerCursor(name: string): Promise<Seq>;
  ledgerRecord(
    consumer: string,
    seq: Seq,
    attempts: number,
    outcome: 'done' | 'skip' | 'failed' | 'deferred' | null,
  ): Promise<void>;
  ledgerCounts(consumer: string): Promise<LedgerCounts>;
  /** Across every consumer — drives the app-wide processing panel. */
  ledgerCountsAll(): Promise<LedgerCounts & { pending: number }>;
  ledgerDeferred(consumer: string): Promise<Seq[]>;
  changesAt(seqs: Seq[]): Promise<Change[]>;
  headSeq(): Promise<Seq>;
  scheduleAll(): Promise<ScheduleRow[]>;
  scheduleUpsert(row: ScheduleRow): Promise<void>;
  scheduleDelete(jobId: string): Promise<void>;
  close(): Promise<void>;
}

const FEED_BATCH = 500;

export interface DocRow {
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

export interface AccountRow {
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

function ftsQuery(text: string, expand?: (term: string) => string[]): string {
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
        negated = negated || t.negated;
        const quoted = `"${t.value.replace(/"/g, '""')}"${t.prefix ? ' *' : ''}`;
        // Stem expansion widens POSITIVE plain terms only: phrases (value
        // contains whitespace), prefix terms and negations stay raw so their
        // exact semantics survive.
        const variants =
          expand && !negated && !t.prefix && !/\s/.test(t.value)
            ? expand(t.value)
            : [];
        operand = variants.length
          ? `(${[
              quoted,
              ...variants.map((v) => `"${v.replace(/"/g, '""')}"`),
            ].join(' OR ')})`
          : quoted;
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

export function openStore(db: AppDb, deps: StoreDeps): CoreStore {
  const now = deps.now ?? (() => new Date().toISOString());
  const nudge = new EventEmitter();
  nudge.setMaxListeners(0);
  let closed = false;

  // The procedural, read-your-own-writes commit transaction runs on the RAW
  // connection. In-process (tests, stdio, DB worker host) the AppDb exposes
  // `_conn`, so the tx runs directly here; the worker-backed client has none —
  // there `commit` is dispatched to the worker via `db.proc('commit', …)`
  // where an identical `createWriteTx` handle is registered (db/worker-entry).
  const writeTx = db._conn
    ? createWriteTx(db._conn, { detectLanguages: deps.detectLanguages, now })
    : null;

  // Distinct languages present in the corpus (∪ 'eng'), feeding query-side
  // stem expansion. Invalidated on every commit, recomputed lazily — a
  // search-as-you-type burst pays for the DISTINCT scan once.
  let corpusLangsCache: string[] | null = null;
  const corpusLanguages = async (): Promise<string[]> => {
    if (corpusLangsCache) return corpusLangsCache;
    const rows = (await db.all(
      `SELECT DISTINCT languages FROM documents`,
    )) as unknown as Array<{ languages: string }>;
    const set = new Set<string>(['eng']);
    for (const r of rows)
      for (const l of JSON.parse(r.languages) as string[]) set.add(l);
    corpusLangsCache = [...set];
    return corpusLangsCache;
  };

  // ── low-level read helpers ────────────────────────────────────────────────

  const getAccountRow = async (id: string): Promise<AccountRow | undefined> => {
    const rows = await db.all(`SELECT * FROM accounts WHERE id = ?`, [id]);
    return rows[0] as unknown as AccountRow | undefined;
  };

  const findDocRow = async (
    accountId: string,
    externalId: string,
    type: string,
  ): Promise<DocRow | undefined> => {
    const rows = await db.all(
      `SELECT * FROM documents WHERE account_id = ? AND external_id = ? AND type = ?`,
      [accountId, externalId, type],
    );
    return rows[0] as unknown as DocRow | undefined;
  };

  // ── feed materialization ──────────────────────────────────────────────────

  const materializeRow = async (r: {
    seq: number;
    kind: Change['kind'];
    ref_id: string;
  }): Promise<Change | null> => {
    if (r.kind === 'document') {
      const doc = (
        await db.all(`SELECT * FROM documents WHERE id = ?`, [r.ref_id])
      )[0] as unknown as DocRow | undefined;
      // Row already purged — the tombstone further down the feed informs.
      return doc
        ? { seq: r.seq, kind: 'document', document: toDocument(doc) }
        : null;
    }
    if (r.kind === 'account') {
      const acc = await getAccountRow(r.ref_id);
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
  const materialize = async (
    after: Seq,
    kinds?: Change['kind'][],
  ): Promise<{ changes: Change[]; high: Seq }> => {
    const kindFilter = kinds?.length
      ? ` AND kind IN (${kinds.map(() => '?').join(',')})`
      : '';
    const rows = (await db.all(
      `SELECT seq, kind, ref_id FROM changes WHERE seq > ?${kindFilter}
         ORDER BY seq LIMIT ${FEED_BATCH}`,
      [after, ...(kinds?.length ? kinds : [])],
    )) as Array<{
      seq: number;
      kind: Change['kind'];
      ref_id: string;
    }>;
    const changes: Change[] = [];
    for (const r of rows) {
      const c = await materializeRow(r);
      if (c) changes.push(c);
    }
    return { changes, high: rows.length ? rows[rows.length - 1].seq : after };
  };

  // ── the Query surface ─────────────────────────────────────────────────────

  const query: Query = {
    async document(id) {
      const r = (
        await db.all(`SELECT * FROM documents WHERE id = ?`, [id])
      )[0] as unknown as DocRow | undefined;
      return r ? toDocument(r) : null;
    },
    async children(id) {
      const rows = (await db.all(
        `SELECT * FROM documents WHERE parent_id = ? AND archived_at IS NULL
           ORDER BY created_at`,
        [id],
      )) as unknown as DocRow[];
      return rows.map(toDocument);
    },
    async byExternalId(account, externalId, type) {
      const r = await findDocRow(account, externalId, type);
      return r ? toDocument(r) : null;
    },
    async search(q) {
      const limit = Math.min(q.limit ?? 50, 500);
      const offset = q.offset ?? 0;
      const filters: string[] = [];
      const params: AppDbParam[] = [];
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
        const langs = await corpusLanguages();
        const rows = (await db.all(
          `SELECT d.*, snippet(documents_fts, 2, '<b>', '</b>', '…', 24) AS _snippet
             FROM documents_fts f JOIN documents d ON d.id = f.doc_id
             WHERE documents_fts MATCH ? ${where}
             ORDER BY bm25(documents_fts, 0, 4.0, 1.0, 2.0, 0.5)
             LIMIT ? OFFSET ?`,
          [
            ftsQuery(q.text, (term) => stemVariants(term, langs)),
            ...params,
            limit,
            offset,
          ],
        )) as unknown as Array<DocRow & { _snippet: string }>;

        // Fuzzy fallback (trigram substring recall + RRF, spec 2026-07-11):
        // only when the exact+stemmed pass left the FIRST page short — good
        // queries never pay for a second index scan, near-misses (compound
        // words, truncations) get rescued.
        if (offset === 0 && rows.length < limit) {
          const { positive, negated } = extractTerms(q.text);
          // Cannot-represent-it ⇒ don't-fuzz: (a) every positive term must
          // survive into the trigram AND group — a silently dropped <3-char
          // term would smuggle partial matches past the implicit-AND
          // grammar; (b) grouped negation (NOT (a b)) has no flat-term
          // representation, so its exclusions can't be re-applied to fuzzy
          // hits. Such queries get no fuzzy pass.
          const triMatch =
            positive.every((t) => t.length >= 3) && !/\bNOT\s*\(/.test(q.text)
              ? toTrigramMatch(positive)
              : null;
          if (triMatch) {
            const triRows = (await db.all(
              `SELECT d.* FROM documents_tri t JOIN documents d ON d.id = t.doc_id
                 WHERE documents_tri MATCH ? ${where}
                 ORDER BY bm25(documents_tri) LIMIT ?`,
              [triMatch, ...params, limit],
            )) as unknown as DocRow[];
            // A NOT-excluded document must never resurface via fuzzy: drop
            // hits containing any negated term (substring match, Unicode
            // lowercase — deliberately broader than FTS token semantics).
            // Both sides are folded the same way the primary index folds
            // tokens (NFKC, ё→е, lowercase, diacritics stripped), so this
            // filter can never be WEAKER than the grammar's own negation
            // (e.g. -uber must still drop a hit containing über).
            const negatedFolded = negated.map((n) => foldForNegation(n));
            const safe = triRows.filter((r) => {
              const haystack = foldForNegation(
                `${r.title ?? ''}\n${r.markdown ?? ''}`,
              );
              return !negatedFolded.some((n) => haystack.includes(n));
            });
            const snippets = new Map(rows.map((r) => [r.id, r._snippet]));
            // Fuzzy may only FILL the page's remaining slots, never displace
            // an exact match: rows already in the primary list pass through
            // (they merge, adding rank signal without growing the union),
            // new rows are capped to the free slots.
            const seen = new Set(rows.map((r) => r.id));
            let free = limit - rows.length;
            const capped: DocRow[] = [];
            for (const r of safe) {
              if (seen.has(r.id)) capped.push(r);
              else if (free > 0) {
                capped.push(r);
                free -= 1;
              }
            }
            const fused = rrfMerge<DocRow>(rows, capped, (r) => r.id, limit);
            return fused.map((r) => ({
              ...toDocument(r),
              snippet:
                snippets.get(r.id) ?? buildSnippet(r.markdown ?? '', positive),
            }));
          }
        }
        return rows.map((r) => ({ ...toDocument(r), snippet: r._snippet }));
      }
      const rows = (await db.all(
        `SELECT d.* FROM documents d WHERE 1=1 ${where}
           ORDER BY COALESCE(d.created_at, d.ingested_at) DESC
           LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )) as unknown as DocRow[];
      return rows.map(toDocument);
    },
    async count(q) {
      const filters: string[] = [];
      const params: AppDbParam[] = [];
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
      const r = (
        await db.all(`SELECT COUNT(*) AS c FROM documents ${where}`, params)
      )[0] as { c: number };
      return r.c;
    },
    async accounts() {
      const rows = (await db.all(
        `SELECT * FROM accounts ORDER BY created_at`,
      )) as unknown as AccountRow[];
      return rows.map(toAccount);
    },
  };

  // ── public surface ────────────────────────────────────────────────────────

  const store: CoreStore = {
    read: query,

    async extractionStats() {
      // pendingOcr is a display-level approximation of the vision worker's
      // classify eligibility — it ignores size caps and tiny-image rules.
      const pendingOcr = (
        (
          await db.all(
            `SELECT COUNT(*) AS c FROM documents
             WHERE json_extract(metadata,'$.extraction') IS NULL
               AND (json_extract(metadata,'$.mime') LIKE 'image/%'
                    OR json_extract(metadata,'$.mime') = 'application/pdf')
               AND archived_at IS NULL`,
          )
        )[0] as { c: number }
      ).c;
      const processed = (
        (
          await db.all(
            `SELECT COUNT(*) AS c FROM documents
             WHERE json_extract(metadata,'$.extraction') IS NOT NULL
               AND archived_at IS NULL`,
          )
        )[0] as { c: number }
      ).c;
      const rows = (await db.all(
        `SELECT id, title, json_extract(metadata,'$.filename') AS filename, type,
                  json_extract(metadata,'$.extraction.engine') AS engine, updated_at
           FROM documents
           WHERE json_extract(metadata,'$.extraction') IS NOT NULL AND archived_at IS NULL
           ORDER BY updated_at DESC, seq DESC LIMIT 10`,
      )) as Array<{
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
      const seq = writeTx
        ? writeTx.commit(batch)
        : ((await db.proc!('commit', batch)) as Seq);
      corpusLangsCache = null;
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
                // Arm the wakeup BEFORE reading. `materialize` is a worker-RPC
                // macrotask once the DB is off-thread, so a producer `commit`
                // (which fires `nudge.emit('commit')`) can land while we read.
                // Registering the listener first guarantees such an emit is not
                // lost between an empty read and the wait — otherwise the feed
                // parks until the *next* commit (an intermittent stall).
                let fire!: () => void;
                const woke = new Promise<void>((resolve) => {
                  fire = resolve;
                });
                nudge.once('commit', fire);
                let waiting = false;
                try {
                  const { changes, high } = await materialize(
                    cursor,
                    opts?.kinds,
                  );
                  if (changes.length > 0) {
                    cursor = high;
                    return { done: false, value: changes };
                  }
                  if (high > cursor) {
                    cursor = high; // window held only unmaterializable rows
                    continue;
                  }
                  waiting = true;
                } finally {
                  // Every path that does NOT wait (return / continue / throw)
                  // must drop the armed listener, or `next()` leaks one per
                  // iteration. The wait path keeps it — that's the wakeup.
                  if (!waiting) nudge.removeListener('commit', fire);
                }
                await woke;
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
        // The credential blob is encrypted here on MAIN (Electron safeStorage),
        // then the ciphertext Buffer is bound like any other parameter.
        await db.run(
          `INSERT INTO vault(account_id, blob) VALUES(?, ?)
           ON CONFLICT(account_id) DO UPDATE SET blob = excluded.blob`,
          [account, deps.encrypt(JSON.stringify(c))],
        );
      },
      async load(account) {
        const r = (
          await db.all(`SELECT blob FROM vault WHERE account_id = ?`, [account])
        )[0] as { blob: Buffer } | undefined;
        if (!r) return null;
        return JSON.parse(deps.decrypt(r.blob)) as Credentials;
      },
      async delete(account) {
        await db.run(`DELETE FROM vault WHERE account_id = ?`, [account]);
      },
    },

    identity: {
      async get() {
        const r = (
          await db.all(`SELECT value FROM meta WHERE key = 'identity'`)
        )[0] as { value: string } | undefined;
        return r ? (JSON.parse(r.value) as Identity) : null;
      },
      async set(i) {
        await db.run(
          `INSERT INTO meta(key, value) VALUES('identity', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [JSON.stringify(i)],
        );
      },
    },

    consents: {
      async latest(extension: ExtensionId) {
        const r = (
          await db.all(
            `SELECT * FROM consents WHERE extension_id = ? ORDER BY id DESC LIMIT 1`,
            [extension],
          )
        )[0] as
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
        await db.run(
          `INSERT INTO consents(extension_id, caps, manifest_version, granted_at)
           VALUES(?, ?, ?, ?)`,
          [
            c.extensionId,
            JSON.stringify(c.caps),
            c.manifestVersion,
            c.grantedAt,
          ],
        );
      },
    },

    maintenance: {
      async compact() {
        await db.exec('VACUUM');
        // documents has a TEXT primary key, so VACUUM may renumber its
        // implicit rowids — which BOTH search tables' rows are pinned to
        // (schema v2/v3). Rebuild the pinning right after; the rebuild stems
        // in JS, so in-process it runs directly on the raw connection and
        // worker-backed it dispatches to the registered proc (same pattern
        // as `commit`).
        if (db._conn) repopulateSearchIndex(db._conn);
        else await db.proc!('rebuildSearchIndex', null);
      },
      async export(destDir) {
        fs.mkdirSync(destDir, { recursive: true });
        const accounts = await query.accounts();
        fs.writeFileSync(
          path.join(destDir, 'accounts.json'),
          JSON.stringify(accounts, null, 2),
        );
        const out = fs.createWriteStream(path.join(destDir, 'documents.jsonl'));
        // The async AppDb has no streaming `.iterate()`; read the set and
        // serialize it (export is an on-demand maintenance op, not a hot path).
        const rows = (await db.all(
          `SELECT * FROM documents`,
        )) as unknown as DocRow[];
        for (const r of rows) out.write(`${JSON.stringify(toDocument(r))}\n`);
        await new Promise<void>((resolve, reject) => {
          out.end(() => resolve());
          out.on('error', reject);
        });
      },
      async resetAll() {
        // 'consents' deliberately survives: installed extensions live on
        // disk outside the DB, so wiping their grants would strand every
        // one of them in needs-consent after reset. One batch = one atomic
        // transaction (the AppDb primitive that replaces db.transaction()).
        await db.batch([
          ...[
            'documents_fts',
            'documents_tri',
            'documents',
            'changes',
            'consumers',
            'work_ledger',
            'vault',
            'schedule',
            'accounts',
          ].map((t) => ({ sql: `DELETE FROM ${t}` })),
          { sql: `DELETE FROM meta WHERE key != 'schemaVersion'` },
        ]);
        // DELETE alone never returns pages to the OS — the file (and the
        // WAL) keep their pre-reset size, so the Storage screen would still
        // show gigabytes after "Reset all". VACUUM rebuilds the file;
        // the TRUNCATE checkpoint then zeroes the WAL it wrote through.
        await db.exec('VACUUM');
        await db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
        corpusLangsCache = null;
        nudge.emit('commit');
      },
    },

    // ── engine-only surface ──────────────────────────────────────────────────

    async createAccount(a) {
      const id = newId<'account'>();
      // One batch = one atomic transaction: the account UPSERT (RETURNING id
      // so a conflicting row's EXISTING id feeds the change) plus its feed
      // change row land together or not at all.
      const results = await db.batch([
        {
          sql: `INSERT INTO accounts(id, source, identifier, config, status, cadence, created_at)
             VALUES(?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source, identifier) DO UPDATE SET
               config = excluded.config,
               status = excluded.status
             RETURNING id`,
          params: [
            id,
            a.source,
            a.identifier,
            JSON.stringify(a.config ?? {}),
            a.status ?? 'connecting',
            a.cadence ? JSON.stringify(a.cadence) : null,
            now(),
          ],
        },
        {
          sql: `INSERT INTO changes(kind, ref_id, at) VALUES('account', ?, ?)`,
          params: [{ $fromStep: 0, column: 'id' }, now()],
        },
      ]);
      const accId = (results[0].row as { id: string }).id;
      nudge.emit('commit');
      return toAccount((await getAccountRow(accId))!);
    },

    async getOrCreateAccount(source, identifier) {
      const found = (
        await db.all(
          `SELECT * FROM accounts WHERE source = ? AND identifier = ?`,
          [source, identifier],
        )
      )[0] as unknown as AccountRow | undefined;
      if (found) {
        nudge.emit('commit');
        return toAccount(found);
      }
      const id = newId<'account'>();
      await db.batch([
        {
          sql: `INSERT INTO accounts(id, source, identifier, config, status, created_at)
             VALUES(?, ?, ?, '{}', 'live', ?)`,
          params: [id, source, identifier, now()],
        },
        {
          sql: `INSERT INTO changes(kind, ref_id, at) VALUES('account', ?, ?)`,
          params: [id, now()],
        },
      ]);
      nudge.emit('commit');
      return toAccount((await getAccountRow(id))!);
    },

    async account(id) {
      const r = await getAccountRow(id);
      return r ? toAccount(r) : null;
    },

    async setAccountCadence(id, cadence) {
      await db.batch([
        {
          sql: `UPDATE accounts SET cadence = ? WHERE id = ?`,
          params: [cadence ? JSON.stringify(cadence) : null, id],
        },
        {
          sql: `INSERT INTO changes(kind, ref_id, at) VALUES('account', ?, ?)`,
          params: [id, now()],
        },
      ]);
      nudge.emit('commit');
    },

    async setAccountConfig(id, config) {
      await db.batch([
        {
          sql: `UPDATE accounts SET config = ? WHERE id = ?`,
          params: [JSON.stringify(config), id],
        },
        {
          sql: `INSERT INTO changes(kind, ref_id, at) VALUES('account', ?, ?)`,
          params: [id, now()],
        },
      ]);
      nudge.emit('commit');
    },

    async liveRefs(accountId) {
      const rows = (await db.all(
        `SELECT external_id, type, seq FROM documents WHERE account_id = ? AND archived_at IS NULL`,
        [accountId],
      )) as Array<{
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

    async consumerCursor(name) {
      const r = (
        await db.all(`SELECT cursor FROM consumers WHERE name = ?`, [name])
      )[0] as { cursor: number } | undefined;
      return r?.cursor ?? 0;
    },

    async ledgerRecord(consumer, seq, attempts, outcome) {
      await db.run(
        `INSERT INTO work_ledger(consumer, seq, attempts, outcome, updated_at)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(consumer, seq) DO UPDATE
           SET attempts = excluded.attempts, outcome = excluded.outcome,
               updated_at = excluded.updated_at`,
        [consumer, seq, attempts, outcome, now()],
      );
    },

    async ledgerCounts(consumer) {
      const rows = (await db.all(
        `SELECT outcome, COUNT(*) AS c FROM work_ledger WHERE consumer = ? GROUP BY outcome`,
        [consumer],
      )) as Array<{ outcome: string | null; c: number }>;
      const counts: LedgerCounts = { done: 0, skip: 0, failed: 0, deferred: 0 };
      for (const r of rows) {
        if (r.outcome && r.outcome in counts) {
          counts[r.outcome as keyof LedgerCounts] = r.c;
        }
      }
      return counts;
    },

    async ledgerCountsAll() {
      const rows = (await db.all(
        `SELECT outcome, COUNT(*) AS c FROM work_ledger GROUP BY outcome`,
      )) as Array<{ outcome: string | null; c: number }>;
      const counts = { done: 0, skip: 0, failed: 0, deferred: 0, pending: 0 };
      for (const r of rows) {
        if (r.outcome && r.outcome in counts) {
          counts[r.outcome as keyof LedgerCounts] = r.c;
        }
      }
      const head =
        (
          (await db.all(`SELECT MAX(seq) AS s FROM changes`))[0] as {
            s: number | null;
          }
        ).s ?? 0;
      const lags = (await db.all(`SELECT cursor FROM consumers`)) as Array<{
        cursor: number;
      }>;
      counts.pending = lags.reduce(
        (max, r) => Math.max(max, head - r.cursor),
        0,
      );
      return counts;
    },

    async ledgerDeferred(consumer) {
      const rows = (await db.all(
        `SELECT seq FROM work_ledger WHERE consumer = ? AND outcome = 'deferred' ORDER BY seq`,
        [consumer],
      )) as Array<{ seq: number }>;
      return rows.map((r) => r.seq);
    },

    async changesAt(seqs) {
      const out: Change[] = [];
      for (const seq of seqs) {
        const row = (
          await db.all(`SELECT seq, kind, ref_id FROM changes WHERE seq = ?`, [
            seq,
          ])
        )[0] as
          | { seq: number; kind: Change['kind']; ref_id: string }
          | undefined;
        if (!row) continue;
        const c = await materializeRow(row);
        if (c) out.push(c);
      }
      return out;
    },

    async headSeq() {
      const r = (await db.all(`SELECT MAX(seq) AS s FROM changes`))[0] as {
        s: number | null;
      };
      return r.s ?? 0;
    },

    async scheduleAll() {
      const rows = (await db.all(`SELECT * FROM schedule`)) as Array<{
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

    async scheduleUpsert(row) {
      await db.run(
        `INSERT INTO schedule(job_id, cadence, last_run, next_run) VALUES(?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE
           SET cadence = excluded.cadence, last_run = excluded.last_run,
               next_run = excluded.next_run`,
        [row.jobId, JSON.stringify(row.cadence), row.lastRun, row.nextRun],
      );
    },

    async scheduleDelete(jobId) {
      await db.run(`DELETE FROM schedule WHERE job_id = ?`, [jobId]);
    },

    async close() {
      closed = true;
      nudge.emit('commit'); // release blocked feed iterators
      await db.close();
    },
  };

  return store;
}
