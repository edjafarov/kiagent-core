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
  DocumentId,
  ErrorScope,
  ExtensionId,
  ExternalRef,
  Identity,
  Seq,
  Store,
  SyncStatus,
} from '@shared/contracts';

import type { AppDb, AppDbParam } from '../../db/app-db';
import { resetCoreStoreTables } from '../../db/repositories/core-maintenance';
import { accountsFrom, createCorpusQuery } from './corpus-query';
import { META_LEDGER_REKEYED } from './maintenance-keys';
import { createOutboxStore, type OutboxStore } from './outbox';
import {
  ACTIONABLE_VISUAL_SIZE_WHERE,
  EXTRACTED_DOCS_WHERE,
  PENDING_VISUAL_WHERE,
  repopulateSearchIndex,
} from './schema';
import { toAccount, toDocument, type AccountRow, type DocRow } from './rows';
import {
  createWriteTx,
  LEDGER_REKEY_PAGE,
  type AccountWriteOp,
  type AccountWriteResult,
  type CommitResult,
  type FolderScopeInput,
  type FolderScopeResult,
  type ReconcileCounts,
  type RekeyPageResult,
} from './write-tx';

export type { AccountRow, DocRow } from './rows';
export { CORPUS_LANGUAGES_SQL } from './corpus-query';

// The stats COUNT is pinned to its covering partial index with
// INDEXED BY: production corpora carry no sqlite_stat1 (nothing ever runs
// ANALYZE), and without stats the planner's default estimates prefer
// docs_account_recency — which re-runs the per-row json_extract
// scan over the whole corpus (~9s per count at 324k docs) that these
// indexes exist to kill. The unpinned fallback in extractionStats()
// preserves ensureQueryIndexes' degrade-don't-fail contract: if the index
// is missing, INDEXED BY fails to prepare ("no query solution") and the
// count falls back to the scan instead of erroring.
export const EXTRACTED_COUNT_SQL = `SELECT COUNT(*) AS c FROM documents INDEXED BY docs_extracted WHERE ${EXTRACTED_DOCS_WHERE}`;
/** Current change unresolved: no outcome yet, or deferred. */
export const VISUAL_WAITING_CURRENT_SQL = `SELECT documents.id FROM documents INDEXED BY docs_pending_visual
  LEFT JOIN work_ledger l ON l.consumer = ? AND l.seq = documents.seq
  WHERE ${PENDING_VISUAL_WHERE} AND ${ACTIONABLE_VISUAL_SIZE_WHERE}
    AND (l.outcome IS NULL OR l.outcome = 'deferred')`;
/** Any change still deferred — driven from the small partial ledger index,
 *  never by scanning `changes` (no index on ref_id). The redundant
 *  `IS NOT 'skip'` lets the planner prove the partial index's WHERE. */
export const VISUAL_WAITING_DEFERRED_SQL = `SELECT documents.id FROM work_ledger l INDEXED BY work_ledger_active
  JOIN changes c ON c.seq = l.seq AND c.kind = 'document'
  JOIN documents ON documents.id = c.ref_id
  WHERE l.consumer = ? AND l.outcome = 'deferred' AND l.outcome IS NOT 'skip'
    AND ${PENDING_VISUAL_WHERE} AND ${ACTIONABLE_VISUAL_SIZE_WHERE}`;
/** Non-skip ledger outcomes, counted through the partial work_ledger_active
 *  index (schema.ts); its WHERE must stay textually identical to the index's. */
export const LEDGER_ACTIVE_COUNT_SQL = `SELECT outcome, COUNT(*) AS c FROM work_ledger WHERE outcome IS NOT 'skip' GROUP BY outcome`;

interface BackupAsset {
  kind: 'copied' | 'external';
  path: string;
  size: number;
}

function referencedPaths(
  value: unknown,
  hint = '',
  out = new Set<string>(),
): Set<string> {
  if (typeof value === 'string') {
    if (
      path.isAbsolute(value) ||
      /(?:path|file|asset|recording|attachment)/i.test(hint)
    )
      out.add(value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => referencedPaths(item, hint, out));
    return out;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) =>
      referencedPaths(item, key, out),
    );
  }
  return out;
}

function backupAssets(
  profileDir: string | undefined,
  destination: string,
  values: unknown[],
): BackupAsset[] {
  if (!profileDir) return [];
  const root = fs.realpathSync(profileDir);
  const copiedDir = path.join(destination, 'assets');
  const assets: BackupAsset[] = [];
  const seen = new Set<string>();
  const inside = (candidate: string) => {
    const rel = path.relative(root, candidate);
    return (
      rel === '' ||
      (rel !== '..' &&
        !rel.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(rel))
    );
  };
  for (const reference of referencedPaths(values)) {
    const candidate = path.resolve(
      path.isAbsolute(reference) ? reference : root,
      reference,
    );
    let resolved: string;
    let size = 0;
    try {
      resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      // Preserve the reference in the manifest even if the asset disappeared
      // between the DB read and export; there is no file to copy.
      assets.push({ kind: 'external', path: reference, size: 0 });
      continue;
    }
    if (!inside(resolved)) {
      assets.push({ kind: 'external', path: reference, size });
      continue;
    }
    const relative = path.relative(root, resolved).split(path.sep).join('/');
    if (seen.has(relative)) continue;
    seen.add(relative);
    const target = path.join(copiedDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(resolved, target);
    assets.push({ kind: 'copied', path: relative, size });
  }
  assets.sort((a, b) => a.path.localeCompare(b.path));
  return assets;
}

/** Injected so the store stays testable and Electron-free. */
export interface StoreDeps {
  /** Credential blob encryption (Electron safeStorage in production). */
  encrypt(plain: string): Buffer;
  decrypt(blob: Buffer): string;
  /** Cheap language detection for search stemming (ISO-639-3). */
  detectLanguages(text: string): string[];
  now?(): string;
  /** Profile root whose app-owned referenced assets are included in exports. */
  profileDir?: string;
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
  /** Documents that entered the store at or after `since` (ISO), per
   *  account — new items only: updates, moves and restores of older
   *  documents do not count. Archived documents are left out. */
  addedSince(
    since: string,
  ): Promise<Array<{ accountId: AccountId; count: number }>>;
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
  /** Status-only account write: `status` and `last_error`, nothing else.
   *
   *  It exists because `store.commit` is otherwise the ONLY door to a status
   *  change, and `write-tx.ts:423-431` stamps `last_sync_at = ?` on every
   *  commit unconditionally — so an empty `commit({documents: [], cursor, …})`
   *  used purely to move a status makes the account render as having just
   *  synced. `engine.reconnect` is the caller that must not lie about that:
   *  it fetches no page and commits no document.
   *
   *  Omitted keys are left alone (`COALESCE` / the same `CASE WHEN` idiom the
   *  commit path uses for `last_error`), so `{ error: null }` CLEARS the error
   *  while `{}` would clear nothing — and `errorScope` narrows that clear to
   *  one origin, as on commit. Never touches `cursor` or `config`. */
  setAccountStatus(
    id: AccountId,
    patch: {
      status?: SyncStatus;
      error?: string | null;
      errorScope?: ErrorScope;
    },
  ): Promise<void>;
  /** (externalId, type, seq) for every non-archived document under an
   *  account — the diff surface `reconcile()` archiving needs, without
   *  paying for full Document rows (title/markdown/metadata) just to compare
   *  keys. `seq` lets a caller exclude documents committed after some point
   *  in time (see reconcilePass's TOCTOU guard in engine.ts). */
  /** Live (unarchived) refs for an account, ordered by (externalId, type).
   *  Pass `after`/`limit` to walk the account in keyset-paged windows —
   *  required for large accounts: one unpaged read of a multi-million-document
   *  account exceeds the structured-clone ceiling and kills the DB worker. */
  liveRefs(
    accountId: AccountId,
    after?: { externalId: string; type: string } | null,
    limit?: number,
  ): Promise<Array<ExternalRef & { seq: Seq }>>;
  /** Reconcile a connector listing against the corpus without either side
   *  of the diff crossing the worker boundary. Stage the listing in bounded
   *  batches, ask for counts, then archive — see write-tx.ts for why nothing
   *  proportional to the account may be returned. */
  reconcileBegin(accountId: AccountId): Promise<void>;
  reconcileStage(accountId: AccountId, refs: ExternalRef[]): Promise<void>;
  reconcileDiff(accountId: AccountId, startSeq: Seq): Promise<ReconcileCounts>;
  /** Archives every eligible-but-unlisted document; returns the count. */
  reconcileArchive(accountId: AccountId, startSeq: Seq): Promise<number>;
  reconcileEnd(accountId: AccountId): Promise<void>;
  /** ONE transaction: config + cursor + archive-the-roots-the-source-named +
   *  one `changes` row per archived document. Returns COUNTS ONLY — never row
   *  sets; passing a per-account row array across the DB-worker boundary is
   *  what OOM'd the main process on a 3.7M-document account.
   *  `input.archiveScopeRootIds` is the explicit IN-list computed by the
   *  SOURCE (R8) — core never set-differences over `folderRoots`, and an
   *  empty array (archive nothing) is legal. `input.reattributeScopeRoots`
   *  is the same source's answer for the removed roots a RETAINED root still
   *  covers (C-46/D5): those are re-stamped, not archived, and naming one
   *  root in both arrays THROWS.
   *  `{stale: true}` and no write means the stored config moved since
   *  `expectedConfigJson` was read.
   *
   *  CALLER CONTRACT — recovery after a rejection or a lost reply (C-29).
   *  In the production main process this call crosses the DB-worker bridge,
   *  which COMMITS the transaction and only then posts its reply
   *  (db/bridge.ts). A worker death in that window rejects the in-flight
   *  promise (`DB_WORKER_CRASHED`) although the archive is already durable.
   *  A rejection is therefore NOT proof that nothing ran. On any rejection —
   *  and after any post-`stop()` failure in the flow around this call:
   *   1. re-read the account and compare the PARSED `config.folderRoots`
   *      against what you meant to write. Deep-equal => it committed: the
   *      archive is durable, so restart the account's loop with the NEW
   *      cursor and let the compensating backfill run. Not equal => nothing
   *      was written: restart the loop on the OLD state.
   *   2. compare `folderRoots`, never the config JSON TEXT — this procedure
   *      appends R1's legacy `roots`/`paths` mirror inside the transaction,
   *      so the stored text is deliberately not `JSON.stringify(config)`.
   *   3. never retry this call as recovery: the stale-write guard makes the
   *      retry a no-op (`stale: true`), which is safe but is not the
   *      compensating action.
   *  Leaving a previously running account stopped after such a failure is
   *  the bug this contract exists to prevent. */
  applyFolderScope(input: FolderScopeInput): Promise<FolderScopeResult>;
  consumerCursor(name: string): Promise<Seq>;
  ledgerRecord(
    consumer: string,
    seq: Seq,
    attempts: number,
    outcome: 'done' | 'skip' | 'failed' | 'deferred' | null,
  ): Promise<void>;
  ledgerCounts(consumer: string): Promise<LedgerCounts>;
  /** Durable, change-free attempt counter (see work_attempts in schema.ts).
   *  Returns the count INCLUDING this attempt. */
  bumpAttempt(consumer: string, docId: string, key: string): Promise<number>;
  /** Drop attempt rows of consumers no longer attached (retired worker
   *  versions). No-op when `active` is empty. */
  pruneAttempts(active: readonly string[]): Promise<void>;
  /** Across every consumer — drives the app-wide processing panel. `pending`
   *  is the largest feed lag among `consumers` (default: every consumer row);
   *  pass the live workers so a retired consumer's stale cursor is ignored. */
  ledgerCountsAll(
    consumers?: readonly string[],
  ): Promise<LedgerCounts & { pending: number }>;
  /** #139: in-memory generation, bumped by every write that can move
   *  `ledgerCountsAll` or `visualWaitingCount` — commits (consumer cursors
   *  move `pending`), feed nudges, ledger and consumers writes. Synchronous:
   *  never a DB call. The 5 s count tick and the 60 s waiting count skip
   *  their queries while it has not moved. */
  ledgerGen(): number;
  /** Bump `ledgerGen` for a ledger write made outside the store's own
   *  methods (alpha-cent's `ledgerRetry` patch calls this). */
  markLedgerChanged(): void;
  /** The account's live-document count and its archived (not yet purged)
   *  document ids, read by ONE statement so both come from the same
   *  snapshot — seeds the app projection, whose archived index lets a
   *  restore count back in (alpha-cent #180). Store-level on purpose: `Query`
   *  is the extension/MCP read surface. */
  archiveSnapshot(
    account: AccountId,
  ): Promise<{ live: number; archived: DocumentId[] }>;
  /** ONE bounded page of deferred seqs, keyset-paged: seqs strictly greater
   *  than `after`, ascending, at most `limit`. Deliberately has no unbounded
   *  form — a 2.1M-entry backlog returned in one reply both blew the
   *  structured-clone budget crossing the DB worker boundary and, once
   *  materialized by `changesAt`, pinned ~2 GB of main heap for the whole
   *  re-drive loop (main-process OOM, 2026-08-24). */
  ledgerDeferred(consumer: string, after: Seq, limit: number): Promise<Seq[]>;
  /** Cheap existence probe for the re-drive gate — never materializes the
   *  backlog just to ask whether it is empty. */
  ledgerHasDeferred(consumer: string): Promise<boolean>;
  /** Resolve many ledger entries in ONE statement. The re-drive terminally
   *  skips every entry whose document no longer matches; one round trip per
   *  entry meant 2.1M round trips through the worker bridge. */
  ledgerRecordMany(
    consumer: string,
    entries: Array<{
      seq: Seq;
      attempts: number;
      outcome: 'done' | 'skip' | 'failed' | 'deferred' | null;
    }>,
  ): Promise<void>;
  changesAt(seqs: Seq[]): Promise<Change[]>;
  /** #59 §0: every deferred ledger row is keyed on its document's current
   *  seq. False on a profile upgraded from an older build until the paged
   *  re-key repair finishes; every re-drive entry point is a no-op until
   *  then. Cached in memory once true. */
  ledgerRekeyed(): Promise<boolean>;
  /** ONE page of the re-key repair (one writer call). Callers loop until
   *  `done`, yielding between pages; progress survives a quit. */
  ledgerRekeyPage(limit?: number): Promise<RekeyPageResult>;
  headSeq(): Promise<Seq>;
  scheduleAll(): Promise<ScheduleRow[]>;
  scheduleUpsert(row: ScheduleRow): Promise<void>;
  scheduleDelete(jobId: string): Promise<void>;
  /** Fires after the core tables are deleted, before VACUUM/checkpoint. */
  onReset(listener: () => void): () => void;
  close(): Promise<void>;
  outbox: OutboxStore;
}

const FEED_BATCH = 500;
/** `changesAt` resolves its seqs in IN-lists of this size (one statement per
 *  chunk; well under SQLite's bound-variable ceiling). */
const CHANGES_AT_CHUNK = 500;

export function openStore(db: AppDb, deps: StoreDeps): CoreStore {
  const now = deps.now ?? (() => new Date().toISOString());
  const nudge = new EventEmitter();
  nudge.setMaxListeners(0);
  // Shared with outbox.ts's onChange: create/transition/expireOverdue fire it
  // from inside that module, and commit() fires it directly below for the
  // removeAccount cascade, which deletes outbox rows in SQL (ON DELETE
  // CASCADE, schema.ts:561) without ever calling into outbox.ts.
  const outboxChanged = new EventEmitter();
  outboxChanged.setMaxListeners(0);
  const resetListeners = new Set<() => void>();
  let closed = false;
  let rekeyed = false;
  // #139: see CoreStore.ledgerGen.
  let gen = 0;
  const bumpGen = (): void => {
    gen += 1;
  };
  /** Every feed nudge also moves the generation. */
  const emitCommit = (): void => {
    bumpGen();
    nudge.emit('commit');
  };

  // The procedural, read-your-own-writes commit transaction runs on the RAW
  // connection. In-process (tests, stdio, DB worker host) the AppDb exposes
  // `_conn`, so the tx runs directly here; the worker-backed client has none —
  // there `commit` is dispatched to the worker via `db.proc('commit', …)`
  // where an identical `createWriteTx` handle is registered (db/worker-entry).
  const writeTx = db._conn
    ? createWriteTx(db._conn, { detectLanguages: deps.detectLanguages, now })
    : null;
  // #135: account writers run on the writer connection (see write-tx.ts
  // accountWrite) so the last-published mark is taken with the COMMIT.
  const accountWrite = async (
    w: AccountWriteOp,
  ): Promise<AccountWriteResult> =>
    writeTx
      ? writeTx.accountWrite(w)
      : ((await db.proc!('accountWrite', w)) as AccountWriteResult);

  // The read surface lives in corpus-query.ts so the read worker and the stdio
  // sibling share the exact implementation. The writer keeps explicit cache
  // invalidation: its own commits never change its PRAGMA data_version.
  const corpus = createCorpusQuery(db);
  const { query } = corpus;

  // ── low-level read helpers ────────────────────────────────────────────────

  const getAccountRow = async (id: string): Promise<AccountRow | undefined> => {
    const rows = await db.all(`SELECT * FROM accounts WHERE id = ?`, [id]);
    return rows[0] as unknown as AccountRow | undefined;
  };

  // ── feed materialization ──────────────────────────────────────────────────

  const materializeRow = async (
    r: {
      seq: number;
      kind: Change['kind'];
      ref_id: string;
    },
    everySeq = false,
  ): Promise<Change | null> => {
    if (r.kind === 'document') {
      const doc = (
        await db.all(`SELECT * FROM documents WHERE id = ?`, [r.ref_id])
      )[0] as unknown as DocRow | undefined;
      // Row already purged — the tombstone further down the feed informs.
      // #59 §0: a document is fed only under its CURRENT seq. An older change
      // of the same document materializes to nothing: the newer change is
      // later in the log and feeds it, so every ledger row a feed consumer
      // writes is keyed on documents.seq. `everySeq` (read-only projections
      // only) keeps the older rows, each paired with the current document.
      return doc && (everySeq || doc.seq === r.seq)
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
    everySeq = false,
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
      const c = await materializeRow(r, everySeq);
      if (c) changes.push(c);
    }
    return { changes, high: rows.length ? rows[rows.length - 1].seq : after };
  };

  // ── the Query surface ─────────────────────────────────────────────────────

  // ── public surface ────────────────────────────────────────────────────────

  /** Index-pinned count with the unpinned scan as the degraded-boot fallback. */
  async function countDocs(
    pinnedSql: string,
    unpinnedWhere: string,
  ): Promise<number> {
    try {
      return ((await db.all(pinnedSql))[0] as { c: number }).c;
    } catch {
      return (
        (
          await db.all(
            `SELECT COUNT(*) AS c FROM documents WHERE ${unpinnedWhere}`,
          )
        )[0] as { c: number }
      ).c;
    }
  }

  const store: CoreStore = {
    read: query,

    async addedSince(since) {
      // The change log is append-only and stamped as it is written, so
      // `at` rises with `seq`: find the first change at/after `since` by
      // bisecting the primary key (no index on `at`), then join the
      // document changes from there to the documents they inserted.
      const max =
        (
          (await db.all(`SELECT MAX(seq) AS m FROM changes`))[0] as {
            m: number | null;
          }
        ).m ?? 0;
      let lo = 1;
      let hi = max + 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const row = (
          await db.all(
            `SELECT seq, at FROM changes WHERE seq >= ? ORDER BY seq LIMIT 1`,
            [mid],
          )
        )[0] as { seq: number; at: string } | undefined;
        if (!row || row.at >= since) hi = mid;
        else lo = row.seq + 1;
      }
      if (lo > max) return [];
      return (await db.all(
        `SELECT d.account_id AS accountId, COUNT(*) AS count
           FROM changes c
           JOIN documents d ON d.id = c.ref_id AND d.ingest_seq = c.seq
          WHERE c.seq >= ? AND c.kind = 'document' AND d.archived_at IS NULL
          GROUP BY d.account_id`,
        [lo],
      )) as Array<{ accountId: AccountId; count: number }>;
    },

    async visualWaitingCount(consumer) {
      // #59 §0: once every deferred row is keyed on its document's current
      // seq, the deferred branch is a strict subset of the current one (a
      // stale deferred seq becomes a terminal skip). Until the re-key repair
      // finishes it stays, so the count never dips while the repair runs.
      const rekeyedNow = await store.ledgerRekeyed();
      const sql = (pinned: boolean) => {
        const strip = (q: string) =>
          pinned
            ? q
            : q
                .replace(' INDEXED BY docs_pending_visual', '')
                .replace(' INDEXED BY work_ledger_active', '');
        return rekeyedNow
          ? `SELECT COUNT(*) AS c FROM (${strip(VISUAL_WAITING_CURRENT_SQL)})`
          : `SELECT COUNT(*) AS c FROM (${strip(VISUAL_WAITING_CURRENT_SQL)} UNION ${strip(VISUAL_WAITING_DEFERRED_SQL)})`;
      };
      const params = rekeyedNow ? [consumer] : [consumer, consumer];
      try {
        return ((await db.all(sql(true), params))[0] as { c: number }).c;
      } catch {
        return ((await db.all(sql(false), params))[0] as { c: number }).c;
      }
    },

    async extractionStats() {
      const processed = await countDocs(
        EXTRACTED_COUNT_SQL,
        EXTRACTED_DOCS_WHERE,
      );
      const rows = (await db.all(
        `SELECT id, title, json_extract(metadata,'$.filename') AS filename, type,
                  json_extract(metadata,'$.extraction.engine') AS engine, updated_at
           FROM documents
           WHERE ${EXTRACTED_DOCS_WHERE}
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
      const { seq, logged } = writeTx
        ? writeTx.commit(batch)
        : ((await db.proc!('commit', batch)) as CommitResult);
      bumpGen();
      // #135: wake feeds only when the commit appended a change row. A
      // cursor-only consumer commit, or an account commit inside its sync
      // tick, has nothing for a feed to read.
      if (logged) {
        corpus.invalidateLanguages();
        emitCommit();
      }
      // The cascade runs entirely in SQL (schema.ts:561's ON DELETE CASCADE)
      // and never calls outbox.ts, so it can't fire onChange itself — and
      // whether it actually took outbox rows with it isn't observable from
      // `seq` alone. Fire unconditionally: an extra "may have changed" signal
      // is harmless (consumers re-read list/count), a missed one is not.
      if ('removeAccount' in batch) outboxChanged.emit('change');
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
                    opts?.everySeq,
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

    outbox: createOutboxStore(db, {
      now,
      encrypt: deps.encrypt,
      decrypt: deps.decrypt,
      changed: outboxChanged,
    }),

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
              file_roots: string | null;
              pages: number;
            }
          | undefined;
        if (!r) return null;
        return {
          extensionId: r.extension_id as ExtensionId,
          caps: JSON.parse(r.caps),
          manifestVersion: r.manifest_version,
          grantedAt: r.granted_at,
          fileRoots: r.file_roots ? JSON.parse(r.file_roots) : [],
          pages: r.pages === 1,
        } as ConsentRecord;
      },
      async record(c) {
        await db.run(
          `INSERT INTO consents(extension_id, caps, manifest_version, granted_at, file_roots, pages)
           VALUES(?, ?, ?, ?, ?, ?)`,
          [
            c.extensionId,
            JSON.stringify(c.caps),
            c.manifestVersion,
            c.grantedAt,
            JSON.stringify(c.fileRoots ?? []),
            c.pages ? 1 : 0,
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
        const exportFiles = async (heldDb: AppDb) => {
          fs.mkdirSync(destDir, { recursive: true });
          if (heldDb.backup)
            await heldDb.backup(path.join(destDir, 'kiagent.db'));
          const accounts = await accountsFrom(heldDb);
          fs.writeFileSync(
            path.join(destDir, 'accounts.json'),
            JSON.stringify(accounts, null, 2),
          );
          const out = fs.createWriteStream(
            path.join(destDir, 'documents.jsonl'),
          );
          // The async AppDb has no streaming `.iterate()`; read the set and
          // serialize it (export is an on-demand maintenance op, not a hot path).
          const rows = (await heldDb.all(
            `SELECT * FROM documents`,
          )) as unknown as DocRow[];
          for (const r of rows) out.write(`${JSON.stringify(toDocument(r))}\n`);
          await new Promise<void>((resolve, reject) => {
            out.end(() => resolve());
            out.on('error', reject);
          });
          const assets = backupAssets(
            deps.profileDir,
            destDir,
            accounts
              .flatMap((account) => [account.config])
              .concat(rows.map((row) => JSON.parse(row.metadata))),
          );
          fs.writeFileSync(
            path.join(destDir, 'backup-manifest.json'),
            JSON.stringify({ version: 1, assets }, null, 2),
          );
        };
        if (db.withExclusive)
          await db.withExclusive((heldDb) =>
            exportFiles(
              db.backup === undefined
                ? { ...heldDb, backup: undefined }
                : heldDb,
            ),
          );
        else await exportFiles(db);
      },
      async resetAll() {
        // 'consents' deliberately survives: installed extensions live on
        // disk outside the DB, so wiping their grants would strand every
        // one of them in needs-consent after reset. One batch = one atomic
        // transaction (the AppDb primitive that replaces db.transaction()).
        //
        // Read the pre-reset accounts BEFORE the wipe so the same batch can
        // announce each removal through the feed.
        const accounts = await query.accounts();
        // The app projection (and every other feed consumer) derives its
        // account list incrementally from the change feed; the repository
        // performs the wipe and announces removals atomically.
        await resetCoreStoreTables(db, accounts, now);
        // design §7: the deletion boundary is the durable reset event. VACUUM
        // and checkpoint are follow-up maintenance and may fail independently.
        for (const listener of resetListeners) {
          try {
            listener();
          } catch {
            // A reset observer must not make a completed wipe look failed.
          }
        }
        // DELETE alone never returns pages to the OS — the file (and the
        // WAL) keep their pre-reset size, so the Storage screen would still
        // show gigabytes after "Reset all". VACUUM rebuilds the file;
        // the TRUNCATE checkpoint then zeroes the WAL it wrote through.
        await db.exec('VACUUM');
        await db.exec(`PRAGMA wal_checkpoint(TRUNCATE)`);
        corpus.invalidateLanguages();
        emitCommit();
        // `DELETE FROM accounts` above cascades in SQL to `outbox` (ON
        // DELETE CASCADE, schema.ts:561) the same way commit()'s
        // removeAccount branch does — outbox.ts never observes either
        // wipe, so this fires unconditionally rather than leave a factory
        // reset silently stale for anything watching the outbox.
        outboxChanged.emit('change');
      },
    },

    // ── engine-only surface ──────────────────────────────────────────────────

    async createAccount(a) {
      const { id } = await accountWrite({ op: 'create', ...a });
      emitCommit();
      return toAccount((await getAccountRow(id))!);
    },

    async getOrCreateAccount(source, identifier) {
      const { id, logged } = await accountWrite({
        op: 'getOrCreate',
        source,
        identifier,
      });
      if (logged) emitCommit();
      return toAccount((await getAccountRow(id))!);
    },

    async account(id) {
      const r = await getAccountRow(id);
      return r ? toAccount(r) : null;
    },

    async setAccountCadence(id, cadence) {
      const { logged } = await accountWrite({ op: 'cadence', id, cadence });
      if (logged) emitCommit();
    },

    async setAccountConfig(id, config) {
      const { logged } = await accountWrite({ op: 'config', id, config });
      if (logged) emitCommit();
    },

    async setAccountStatus(id, patch) {
      // Reconcile passes and reconnects call this, mostly with the status the
      // account already has. Write, log a change and wake every feed only
      // when the status or last_error actually differs (write-tx accountWrite).
      const { logged } = await accountWrite({ op: 'status', id, ...patch });
      if (logged) emitCommit();
    },

    async liveRefs(accountId, after, limit) {
      // Ordered by (external_id, type) so the UNIQUE(account_id, external_id,
      // type) index serves both the range seek and the ordering — no sort, and
      // each page is an index range scan rather than a rescan of the account.
      const rows = (await db.all(
        `SELECT external_id, type, seq FROM documents
           WHERE account_id = ? AND archived_at IS NULL
                 ${after ? `AND (external_id, type) > (?, ?)` : ''}
           ORDER BY external_id, type
                 ${typeof limit === 'number' ? `LIMIT ?` : ''}`,
        [
          accountId,
          ...(after ? [after.externalId, after.type] : []),
          ...(typeof limit === 'number' ? [limit] : []),
        ],
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

    // Each of these runs on the RAW connection — in-process directly, worker-
    // backed via the matching registered procedure (db/worker-entry). They
    // MUST share one connection: the staging table is TEMP, so a listing
    // staged on one connection is invisible to any other.
    async reconcileBegin(accountId) {
      if (writeTx) writeTx.reconcileBegin(accountId);
      else await db.proc!('reconcileBegin', { accountId });
    },

    async reconcileStage(accountId, refs) {
      if (writeTx) writeTx.reconcileStage(accountId, refs);
      else await db.proc!('reconcileStage', { accountId, refs });
    },

    async reconcileDiff(accountId, startSeq) {
      return writeTx
        ? writeTx.reconcileDiff(accountId, startSeq)
        : ((await db.proc!('reconcileDiff', {
            accountId,
            startSeq,
          })) as ReconcileCounts);
    },

    async reconcileArchive(accountId, startSeq) {
      const archived = writeTx
        ? writeTx.reconcileArchive(accountId, startSeq)
        : ((await db.proc!('reconcileArchive', {
            accountId,
            startSeq,
          })) as number);
      if (archived > 0) {
        corpus.invalidateLanguages();
        emitCommit();
      }
      return archived;
    },

    async reconcileEnd(accountId) {
      if (writeTx) writeTx.reconcileEnd(accountId);
      else await db.proc!('reconcileEnd', { accountId });
    },

    async applyFolderScope(input) {
      const result = writeTx
        ? writeTx.applyFolderScope(input)
        : ((await db.proc!('applyFolderScope', input)) as FolderScopeResult);
      if (result.archived > 0) corpus.invalidateLanguages();
      // Search index and renderer both refresh off this: the feed iterators
      // in feed() block on 'commit', and the account row itself changed.
      if (!result.stale) emitCommit();
      return result;
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
      bumpGen();
    },

    async bumpAttempt(consumer, docId, key) {
      const rows = (await db.all(
        `INSERT INTO work_attempts(consumer, doc_id, key, n, updated_at)
         VALUES(?, ?, ?, 1, ?)
         ON CONFLICT(consumer, doc_id, key) DO UPDATE
           SET n = n + 1, updated_at = excluded.updated_at
         RETURNING n`,
        [consumer, docId, key, now()],
      )) as Array<{ n: number }>;
      return rows[0].n;
    },

    async pruneAttempts(active) {
      if (active.length === 0) return;
      await db.run(
        `DELETE FROM work_attempts WHERE consumer NOT IN (${active
          .map(() => '?')
          .join(', ')})`,
        [...active],
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

    async archiveSnapshot(account) {
      // One statement, one read snapshot: a count and a list read by two
      // statements could straddle an archive and seed the projection with a
      // document both counted live and indexed as archived.
      const row = (
        await db.all(
          `SELECT
             (SELECT COUNT(*) FROM documents
                WHERE account_id = ? AND archived_at IS NULL) AS live,
             (SELECT json_group_array(id) FROM documents
                WHERE account_id = ? AND archived_at IS NOT NULL) AS archived`,
          [account, account],
        )
      )[0] as { live: number; archived: string };
      return {
        live: row.live,
        archived: JSON.parse(row.archived) as DocumentId[],
      };
    },

    ledgerGen() {
      return gen;
    },

    markLedgerChanged() {
      bumpGen();
    },

    async ledgerCountsAll(consumers) {
      // Runs every 5 s. Counting 'skip' rows directly means scanning the whole
      // ledger (millions of rows, ~230 ms); instead count the rest through the
      // partial work_ledger_active index and derive skip from the total. One
      // statement, so both counts come from the same snapshot.
      const rows = (await db.all(
        `SELECT 0 AS total, outcome, c FROM (${LEDGER_ACTIVE_COUNT_SQL})
         UNION ALL SELECT 1, NULL, COUNT(*) FROM work_ledger`,
      )) as Array<{ total: number; outcome: string | null; c: number }>;
      const counts = { done: 0, skip: 0, failed: 0, deferred: 0, pending: 0 };
      let total = 0;
      let notSkip = 0;
      for (const r of rows) {
        if (r.total) {
          total = r.c;
          continue;
        }
        notSkip += r.c;
        if (r.outcome && r.outcome in counts) {
          counts[r.outcome as keyof LedgerCounts] = r.c;
        }
      }
      counts.skip = total - notSkip;
      const head =
        (
          (await db.all(`SELECT MAX(seq) AS s FROM changes`))[0] as {
            s: number | null;
          }
        ).s ?? 0;
      const lags = (await db.all(
        `SELECT name, cursor FROM consumers`,
      )) as Array<{
        name: string;
        cursor: number;
      }>;
      const live = consumers ? new Set(consumers) : null;
      counts.pending = lags
        .filter((r) => !live || live.has(r.name))
        .reduce((max, r) => Math.max(max, head - r.cursor), 0);
      return counts;
    },

    async ledgerDeferred(consumer, after, limit) {
      const rows = (await db.all(
        `SELECT seq FROM work_ledger
          WHERE consumer = ? AND outcome = 'deferred' AND seq > ?
          ORDER BY seq LIMIT ?`,
        [consumer, after, limit],
      )) as Array<{ seq: number }>;
      return rows.map((r) => r.seq);
    },

    async ledgerHasDeferred(consumer) {
      const rows = await db.all(
        `SELECT 1 FROM work_ledger WHERE consumer = ? AND outcome = 'deferred' LIMIT 1`,
        [consumer],
      );
      return rows.length > 0;
    },

    async ledgerRecordMany(consumer, entries) {
      if (entries.length === 0) return;
      const ts = now();
      // 5 bound params per row against SQLite's 32766-variable ceiling; the
      // chunk is sized well under it so a caller's page size can grow without
      // silently tripping "too many SQL variables".
      const PER_STATEMENT = 500;
      for (let i = 0; i < entries.length; i += PER_STATEMENT) {
        const slice = entries.slice(i, i + PER_STATEMENT);
        const values = slice.map(() => '(?, ?, ?, ?, ?)').join(', ');
        const params: AppDbParam[] = [];
        for (const e of slice)
          params.push(consumer, e.seq, e.attempts, e.outcome, ts);
        // eslint-disable-next-line no-await-in-loop
        await db.run(
          `INSERT INTO work_ledger(consumer, seq, attempts, outcome, updated_at)
           VALUES ${values}
           ON CONFLICT(consumer, seq) DO UPDATE
             SET attempts = excluded.attempts, outcome = excluded.outcome,
                 updated_at = excluded.updated_at`,
          params,
        );
      }
      bumpGen();
    },

    async changesAt(seqs) {
      // #59 §0: a ledger seq is always its document's CURRENT seq, so it
      // resolves through `documents` (docs_seq), never through `changes`,
      // which pruning removes. A seq no document carries any more (changed
      // since and re-fed under its new seq, or purged) resolves to nothing.
      if (seqs.length === 0) return [];
      const bySeq = new Map<number, DocRow>();
      for (let i = 0; i < seqs.length; i += CHANGES_AT_CHUNK) {
        const slice = seqs.slice(i, i + CHANGES_AT_CHUNK);
        // eslint-disable-next-line no-await-in-loop
        const rows = (await db.all(
          `SELECT * FROM documents WHERE seq IN (${slice.map(() => '?').join(',')})`,
          slice,
        )) as unknown as DocRow[];
        for (const r of rows) bySeq.set(r.seq, r);
      }
      const out: Change[] = [];
      for (const seq of seqs) {
        const r = bySeq.get(seq);
        if (r) out.push({ seq, kind: 'document', document: toDocument(r) });
      }
      return out;
    },

    async ledgerRekeyed() {
      if (rekeyed) return true;
      rekeyed =
        (
          await db.all(`SELECT 1 FROM meta WHERE key = ?`, [
            META_LEDGER_REKEYED,
          ])
        ).length > 0;
      return rekeyed;
    },

    async ledgerRekeyPage(limit = LEDGER_REKEY_PAGE) {
      const r = writeTx
        ? writeTx.rekeyLedgerPage(limit)
        : ((await db.proc!('rekeyLedgerPage', { limit })) as RekeyPageResult);
      bumpGen();
      if (r.done) rekeyed = true;
      return r;
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

    onReset(listener) {
      resetListeners.add(listener);
      return () => resetListeners.delete(listener);
    },

    async close() {
      closed = true;
      nudge.emit('commit'); // release blocked feed iterators
      await db.close();
    },
  };

  return store;
}
