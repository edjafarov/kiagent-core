/* eslint-disable */
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  KIAgent — GREENFIELD CONCEPT: no legacy, rebuilt from first principles
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS IS
 *    The answer to "what if there were no legacy at all — rebuild from
 *    scratch?" Standalone (imports nothing from model.ts, whose field names
 *    exist to serve the legacy SDK). NOT a proposal to actually rewrite —
 *    the in-place decision stands for good reasons. This is the north star,
 *    and a menu: each win below is tagged
 *      [IMPORTABLE]       — adoptable in-place, no rewrite needed
 *      [GREENFIELD-ONLY]  — priced in "rewrite"; know what you're not buying
 *    Gap-checked against the real src/ (3-agent sweep, 2026-07-02 — see
 *    gaps.md): Tier-1 (deletion lifecycle, worker emit, events cap, consent
 *    records, persisted progress) and Tier-4/5 (work outcomes, provider
 *    status, scheduler env, commit-path pipeline, prefs, logs, MCP surface,
 *    canonical projection) are folded in below. Tier-2 (connector
 *    expressiveness) and Tier-3 (extension lifecycle) remain open in gaps.md.
 *
 *  THE ONE IDEA
 *    The app is a log. Everything is a resumable consumer with a durable
 *    cursor over something:
 *
 *      Source      cursor over the OUTSIDE WORLD   → yields documents
 *      Worker      cursor over the DOCUMENT FEED   → does a job: analyze into
 *                                                    its own db, or act on the
 *                                                    world (files, net)
 *      Projection  cursor over the DOCUMENT FEED   → live renderer state
 *      MCP/query   plain readers
 *
 *    There is ONE plugin type — ExtensionModule (§7) — and it gets ALL the
 *    possibilities: activate() returns any mix of the roles above, and the
 *    contributions share the module's state (a Gmail extension can return a
 *    Source + a Worker that summarizes threads into its own db + a Worker
 *    that archives them, all closing over one client). The roles are NOT
 *    plugin categories — they are the shapes of the PROMISES a plugin makes
 *    to the engine: what its cursor is over, what commits transactionally,
 *    what the user must consent to. Think VS Code contribution points.
 *
 *  THE INFRASTRUCTURE PLANES (what a plugin builds ON)
 *    inference   LLM / vision-OCR behind ONE queue with two
 *                lanes — 'interactive' answers now, 'background' drains in
 *                idle / night / maintenance windows. Pluggable Providers
 *                make it location-transparent: in-process worker pool
 *                today, a LAN machine or cloud API tomorrow — callers
 *                never know. (§4)
 *    store       documents through the engine — PLUS each
 *                extension's own PRIVATE SQL database: its own tables in
 *                its own file. (§2, §7 `db` cap)
 *    files       user-approved folder roots; journaled, reviewable. (§7)
 *    net         outbound HTTP for connectors and workers. (§7)
 *    scheduler   cadence-as-data; the maintenance window lives here. (§8)
 *    mcp         the OUTWARD surface — extensions contribute TOOLS so any
 *                connected outside AI can drive what this platform knows
 *                and does. (§7)
 *
 *  WHY (the product): a non-technical person installs a plugin and their
 *  OWN machine's AI quietly does useful work on their OWN data — files,
 *  mail, life — nothing leaving home unless they explicitly choose a
 *  remote inference provider.
 *
 *    One Engine advances every cursor; the Store's single write primitive
 *    (`commit` = batch + cursor, one transaction) is the only way state
 *    changes. The pull model generalized to the WHOLE app: what pull-model.ts
 *    did for ingestion, this does for enrichment and the renderer too.
 *
 *  WHAT DIES *ONLY BECAUSE LEGACY DIED*
 *    ─ bigint ids + the entire wire codec (model.ts §1: WireId, toWire,
 *      fromWire, Wired<T>, and the most-repeated hand transform in src/)
 *        → ONE string id type (UUIDv7: time-ordered, index-friendly,
 *          app-generated, JSON-safe across SQLite/IPC/RPC with ZERO
 *          conversion).                                   [GREENFIELD-ONLY]
 *    ─ snake_case + `*_json` string fields
 *        → camelCase domain types carrying PARSED values; the storage layer
 *          owns serialization.                            [GREENFIELD-ONLY]
 *    ─ PendingDocument / Document twins
 *        → Document = DocumentInput + system fields, one shape.
 *    ─ adaptLegacy → nothing to adapt.
 *
 *  WHAT'S NEW BEYOND pull-model.ts — AND IMPORTABLE IN-PLACE
 *    ─ THE FEED: documents and accounts enter one ordered change log
 *      (`seq`). It is the app's internal bus.             [IMPORTABLE:
 *      add a seq column + changes table to the existing SQLite]
 *    ─ WORKER: "AI does a regular job on documents" = a consumer with a
 *      cursor over the feed. Replaces the InferenceJob queue, its worker
 *      wiring, and enqueueExtraction — idempotent re-runs for free. Its
 *      RESULTS deliberately stay in the plugin's own space (PrivateDb) or
 *      come back as documents — no first-class annotation/embedding schema
 *      until real workers show what deserves promotion.   [IMPORTABLE]
 *    ─ PROJECTION: renderer AppState = a pure reducer over the feed;
 *      reconnect resumes from `seq`. Replaces StateBus.publish + the
 *      hand-built snapshot reshape.                       [IMPORTABLE]
 *    ─ DELETION IS FIRST-CLASS: sources signal upstream deletions
 *      (Batch.deletions / reconcile()), documents archive then purge,
 *      account removal is ONE engine-owned cascade, and the feed carries
 *      tombstones so workers/projections learn data went AWAY.
 *    ─ CAPABILITIES SHRINK: no `db.write` cap EXISTS. Writes to the shared
 *      store are RETURN VALUES (Source batches) that the engine commits —
 *      a marketplace extension physically cannot corrupt the store.
 *
 *  WHAT STAYS
 *    The out-of-process extension platform (host processes, RPC,
 *    manifests, marketplace). It was the right call; greenfield keeps it
 *    and merely shrinks the surface it must expose.
 */

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 1. IDS — one type, no codec                                               ║
// ╚══════════════════════════════════════════════════════════════════════════╝

declare const brand: unique symbol;
/** A UUIDv7 string. Branded per entity for compile-time safety, but the
 *  runtime value is the SAME everywhere — DB, IPC, RPC, renderer, logs.
 *  There is no toWire/fromWire in this design. */
export type Id<T extends string> = string & { readonly [brand]?: T };

export type AccountId = Id<'account'>;
export type DocumentId = Id<'document'>;
export type ExtensionId = Id<'extension'>;

/** Monotonic position in the change feed — the app's internal clock. */
export type Seq = number;

export type LogLevel = 'info' | 'warn' | 'error';

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 2. THE STORE — documents and the feed                                     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** A document's natural key in its origin system — how sources refer to
 *  documents (parentage, deletions) without ever holding a DB id. */
export interface ExternalRef {
  externalId: string;
  type: string;
}

/** What a source provides — nothing more. Note: parsed `metadata` (not a
 *  `*_json` string), parentage by natural key (never a DB id), and binary
 *  content as data (`markdown: null` + `binary` set ⇒ the ENGINE converts:
 *  built-in parsers for pdf/docx/…, the inference plane's `see` for images
 *  and scans. Conversion is not a source concern — and not a plugin kind
 *  either: "install better OCR" = install an InferenceProvider supporting
 *  'read' (OCR) or 'see' (vision); a pluggable format-parser registry is
 *  additive if an exotic format ever demands it). */
export interface DocumentInput {
  externalId: string;                       // natural key in the origin system
  type: string;                             // 'email.thread' | 'file' | 'chat.message' | …
  title: string | null;
  markdown: string | null;
  binary?: { bytes: Uint8Array; mime: string; filename?: string };
  url?: string;                             // deep link back into the origin
  metadata: Record<string, unknown>;
  createdAt: string | null;                 // ISO-8601, origin time
  parent?: ExternalRef;                     // engine resolves in-transaction
}

/** What the store holds: the input plus system fields. ONE shape — there is
 *  no Pending/stored twin, no SDK copy, no renderer mirror. */
export interface Document extends Omit<DocumentInput, 'parent' | 'binary'> {
  id: DocumentId;
  accountId: AccountId;
  parentId: DocumentId | null;
  contentHash: string;
  seq: Seq;                                 // position in the feed
  /** Soft-delete tombstone: the origin item vanished (or the user removed
   *  it). Hidden from default queries; hard-purged later by engine
   *  maintenance. Three states: live → archived → gone. */
  archivedAt: string | null;
  /** Engine-detected at ingest (ISO-639-3) — feeds language-aware search
   *  stemming. Enrichment this cheap and universal lives ON the document;
   *  everything richer is a worker's private business. */
  languages: string[];
  ingestedAt: string;
  updatedAt: string;
}

/** DELIBERATE ABSENCE: no Annotation / Embedding entity. Derived results
 *  live in the producing plugin's own space (PrivateDb, §7) or come back
 *  as documents. A shared enrichment schema would be speculation until
 *  real workers show which shapes deserve promotion — and adding one
 *  later is purely additive. */

/** When recurring work runs. Declared as DATA on contributions (sources,
 *  workers) — never as a plugin-side timer: an extension-host
 *  process may not even be RUNNING when its moment comes; the platform's
 *  scheduler wakes it. Being data also means the install dialog can say
 *  "runs nightly on your Documents folder" before the user consents. */
export type Cadence =
  | { every: string }                       // '15m', '1h'
  | { cron: string }                        // '0 9 * * 1'
  | 'manual';

export type SyncStatus =
  | 'connecting' | 'backfilling' | 'live' | 'paused' | 'needsReauth' | 'error';

export interface Account {
  id: AccountId;
  source: string;                           // SourceDescriptor.id, e.g. 'gmail'
  identifier: string;                       // email address / phone / folder path
  config: Record<string, unknown>;          // parsed — storage owns serialization
  status: SyncStatus;
  cursor: unknown;                          // persisted with every commit (below)
  /** Engine-written with every commit — the progress bar and error banner
   *  survive an app restart (was sync_state.backfill_done_count /
   *  _total_estimate / last_error in today's schema). */
  progress?: AccountProgress;
  lastSyncAt?: string;
  lastError?: string;
  cadence?: Cadence;                        // user's per-account override of the descriptor default
  createdAt: string;
}

export interface AccountProgress {
  done: number;
  totalEstimate?: number;
}

export interface Credentials {
  accessToken?: string;
  refreshToken?: string;
  password?: string;
  /** OAuth app credentials ride the vault too — today they sit PLAINTEXT
   *  in accounts.config_json; that path must not carry over. */
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
}

export interface Identity {
  name: string;
  emails: string[];
  phones: string[];
  avatarUrl?: string;
}

/** One entry in the change log. Every consumer below reads this. An archive
 *  is an ordinary 'document' change (archivedAt set); 'purge' and
 *  'accountRemoved' are tombstones — without them, workers and projections
 *  could never learn that data went AWAY. */
export type Change =
  | { seq: Seq; kind: 'document'; document: Document }
  | { seq: Seq; kind: 'purge'; documentId: DocumentId }
  | { seq: Seq; kind: 'account'; account: Account }
  | { seq: Seq; kind: 'accountRemoved'; accountId: AccountId };

/** Write vision/OCR output back onto an EXISTING document — the second half
 *  of the two-pass pipeline. Merges metadata, replaces markdown, reindexes
 *  FTS, emits a 'document' change. `contentHash` is untouched: the source's
 *  own content still dedupes on its next real change. */
export interface EnrichInput {
  documentId: DocumentId;
  markdown: string;
  metadata?: Record<string, unknown>;
}

/** THE write primitive — the only one. A source's batch and the cursor that
 *  produced it commit in ONE transaction — the "cursor saved but rows not
 *  committed" bug class cannot be written. A worker commits its cursor plus
 *  any documents it emitted (also atomic); its private-db writes remain
 *  at-least-once, so `work` must be idempotent. */
export type CommitBatch =
  | {
      account: AccountId;
      documents: DocumentInput[];
      /** Upstream-deleted items — engine sets archivedAt in the SAME tx. */
      deletions?: ExternalRef[];
      cursor: unknown;
      status?: SyncStatus;
      progress?: AccountProgress;
      error?: string | null;
    }
  | { consumer: string; cursor: Seq; documents?: DocumentInput[]; enrich?: EnrichInput[] }
  /** ONE cascade: purge the account's documents (tombstones into the feed),
   *  delete cursor, config, credentials. */
  | { removeAccount: AccountId }
  /** Engine maintenance: archived-long-enough tombstones become gone. */
  | { purgeArchived: { before: string } };

/** Read-only query surface — shared verbatim by the renderer, MCP, and the
 *  `query` capability. Defined once. */
export interface Query {
  document(id: DocumentId): Promise<Document | null>;
  children(id: DocumentId): Promise<Document[]>;
  byExternalId(account: AccountId, externalId: string, type: string): Promise<Document | null>;
  /** Implementation contract, not just a signature: full-text with a
   *  fuzzy (trigram) fallback, weighted ranking, multilingual stemming fed
   *  by Document.languages. The index is built INSIDE the commit
   *  transaction — search never lags ingest. */
  search(q: {
    text?: string;
    type?: string;
    account?: AccountId;
    includeArchived?: boolean;              // default false — tombstones stay out of sight
    limit?: number;
    offset?: number;
  }): Promise<Array<Document & { snippet?: string }>>;
  count(q: { type?: string; account?: AccountId; includeArchived?: boolean }): Promise<number>;
  accounts(): Promise<Account[]>;
}

/** One row of Settings → Local processing's "Recently processed" list. */
export interface RecentExtraction {
  id: DocumentId;
  title: string | null;
  filename: string | null;
  type: string;
  engine: string; // 'local-ocr' | 'local-ocr+vlm' — from metadata.extraction.engine
  updatedAt: string;
}

/** Vision-pipeline queue counters for Settings → Local processing. */
export interface ExtractionStats {
  pendingOcr: number;
  processed: number;
  recent: RecentExtraction[]; // newest first, max 10
}

export interface Store {
  read: Query;
  /** OCR/VLM queue + processed counts — drives Settings → Local processing. */
  extractionStats(): ExtractionStats;
  /** Tail the change log from a position. Live: keeps yielding. */
  feed(after: Seq, opts?: { kinds?: Change['kind'][] }): AsyncIterable<Change[]>;
  /** Engine-only in practice; see capabilities — no extension ever holds this. */
  commit(batch: CommitBatch): Promise<Seq>;
  /** ONE credential scheme (not two), ONE identity row (not DB + identity.json). */
  vault: {
    save(account: AccountId, c: Credentials): Promise<void>;
    load(account: AccountId): Promise<Credentials | null>;
    /** Part of the account-removal cascade — today's app orphans the blob. */
    delete(account: AccountId): Promise<void>;
  };
  identity: { get(): Promise<Identity | null>; set(i: Identity): Promise<void> };
  /** Append-only — the history IS the audit trail. Host construction reads
   *  the latest record; a manifest asking for more than the last grant
   *  forces re-consent. */
  consents: {
    latest(extension: ExtensionId): Promise<ConsentRecord | null>;
    record(c: ConsentRecord): Promise<void>;
  };
  /** "Your data never leaves home" earns trust; "and you can take all of
   *  it with you as files" completes it. */
  maintenance: {
    compact(): Promise<void>;
    export(destDir: string): Promise<void>;
    resetAll(): Promise<void>;
  };
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 3. SOURCE — cursor over the outside world (pull-model.ts, unencumbered)   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export interface SourceDescriptor {
  id: string;                               // 'gmail'
  name: string;
  documentTypes: string[];
  /** Drives the connect-flow UI declaratively. (The old supportsBackfill /
   *  Delta / Realtime flags dissolve — under the pull model those aren't
   *  separate lifecycles anymore, just phases of one stream.) */
  auth: 'oauth' | 'password' | 'pairing' | 'none';
  multiAccount?: boolean;
  /** Default re-pull cadence once backfill completes (push/live sources
   *  omit it). User-overridable per account — replaces CadenceConfig. */
  cadence?: Cadence;
}

/** 'backfill' = catching up (initial run or after a gap) — drives the
 *  progress bar; 'live' = current. Nobody consumed a third distinction. */
export type PullPhase = 'backfill' | 'live';

export interface Batch<Cursor, Item> {
  phase: PullPhase;
  items: Item[];
  /** Items observed to be GONE upstream (Gmail 404, Graph `deleted` flag,
   *  IMAP UID-set diff). The engine archives them in the same transaction. */
  deletions?: ExternalRef[];
  cursor: Cursor;                           // committed WITH the items
  estimateTotal?: number;
}

/** Residual per-account capabilities while pulling — all reads. Private
 *  storage isn't here: the module captures its PrivateDb (§7) from
 *  `activate()`'s host, like any other cap. */
export interface Session {
  readonly account: Account;
  readonly signal: AbortSignal;
  /** ONE credential verb. The platform refreshes OAuth before returning,
   *  so `accessToken` is always fresh — no getAccessToken twin, no refresh
   *  logic in any source. */
  credentials(): Promise<Credentials | null>;
  log(level: LogLevel, msg: string): void;
}

/** Interactive account establishment — the one moment a source talks to the
 *  UI. Re-auth is the engine re-opening this channel. Credentials returned
 *  by `oauth()` are persisted by the platform; the source never stores them. */
export interface AuthChannel {
  oauth(scopes: string[]): Promise<Credentials>;
  showQr(qr: string): void;
  prompt(schema: unknown): Promise<Record<string, unknown>>;
  status(msg: string): void;
}

/** The entire connector-authoring surface: one I/O verb, one pure mapper,
 *  one optional random-access re-fetch. */
export interface Source<Cursor = unknown, Item = unknown> {
  readonly descriptor: SourceDescriptor;
  connect(auth: AuthChannel): Promise<{ identifier: string; config?: Record<string, unknown> }>;
  /** `null` cursor = from the beginning. Live sources simply keep yielding.
   *  Retry, backoff, throttling, progress, persistence: all engine-owned. */
  pull(session: Session, cursor: Cursor | null): AsyncIterable<Batch<Cursor, Item>>;
  /** PURE — unit-testable with fixtures; engine logs the raw item on failure.
   *  One upstream item may map to several documents (e.g. an email thread plus its attachments). */
  toDocument(item: Item): DocumentInput | DocumentInput[] | null;
  /** Optional random-access bytes for deep extraction. */
  fetchBytes?(session: Session, doc: Document): Promise<Uint8Array | null>;
  /** Optional full listing of what EXISTS upstream right now. The engine
   *  runs it on cadence or after cursor invalidation, diffs against the
   *  store, and archives everything no longer listed — the second
   *  delete-detection pattern real sources need (IMAP UID diff, Drive full
   *  rescan) when the delta feed alone can't be trusted. */
  reconcile?(session: Session): AsyncIterable<ExternalRef[]>;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 4. THE INFERENCE PLANE — LLM / vision behind one queue                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** Which queue lane a request rides. 'interactive' answers a user or an MCP
 *  call NOW; 'background' is deferrable — the scheduler drains it in idle /
 *  night / maintenance windows. Engine-invoked work (conversion, workers)
 *  defaults to 'background'; the 'inference' capability defaults to
 *  'interactive'. */
export type Lane = 'interactive' | 'background';

/** ONE front door to models. Every consumer — engine conversion, workers,
 *  commands, MCP tools — calls this; nobody loads a model, owns a GPU queue,
 *  or knows where compute lives. Deliberately minimal: adding a kind later
 *  (embeddings, when semantic search earns its place) is purely additive. */
export interface Inference {
  complete(prompt: string, opts?: { maxTokens?: number; lane?: Lane }): Promise<string>;
  /** Vision: OCR, layout, "what is in this image". */
  see(image: Uint8Array, prompt: string, opts?: { mime?: string; lane?: Lane }): Promise<string>;
  /** OCR only: image/page in, plain text out. Distinct from `see` because
   *  cheap native OCR and the costly VLM route to DIFFERENT providers —
   *  the two-pass pipeline addresses them by kind. */
  read(image: Uint8Array, opts?: { mime?: string; lane?: Lane }): Promise<string>;
}

/** The pluggable BACK of the front door. Swapping providers moves the
 *  compute without touching one caller: in-process worker pool today, the
 *  Mac Studio on the LAN tomorrow, a cloud API where the user opts in.
 *  Providers are themselves an extension contribution (§7) — "let this
 *  plugin serve inference" is just another consent. */
/** Readiness is platform-visible; HOW a provider gets ready (model
 *  catalog, hardware tiering, checksummed resumable downloads, disk
 *  preflight, server spawn) is its own private business behind status(). */
export type ProviderStatus =
  | 'ready'
  | 'standby'
  | 'unsupported'                           // this hardware can't run it
  | { downloading: { pct: number } }
  | { error: string };

export interface InferenceProvider {
  readonly id: string;                      // 'local' | 'lan:mac-studio' | 'anthropic'
  readonly supports: Array<'complete' | 'see' | 'read'>;
  status(): ProviderStatus;
  handle(req: { kind: 'complete' | 'see' | 'read'; payload: unknown; lane: Lane }): Promise<unknown>;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 5. WORKER — the one feed-consumer role (the "AI does a job" kind)         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export interface WorkerSession {
  readonly signal: AbortSignal;
  /** Sugar over the Inference plane (§4), pinned to the 'background' lane. */
  inference(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
  /** Vision sugar over the Inference plane, pinned to the 'background' lane. */
  see(image: Uint8Array, prompt: string, opts?: { mime?: string }): Promise<string>;
  /** OCR sugar over the Inference plane, pinned to the 'background' lane. */
  read(image: Uint8Array, opts?: { mime?: string }): Promise<string>;
  /** Bytes via the document's own source (its `fetchBytes`). */
  fetchBytes(doc: Document): Promise<Uint8Array | null>;
  /** The typed half of "results come back as documents": emitted docs are
   *  committed by the ENGINE (under the worker's own synthetic account) in
   *  the SAME transaction as this worker's cursor — atomic, unlike
   *  private-db writes. A worker still never writes the store directly. */
  emit(doc: DocumentInput): void;
  /** Write back onto an EXISTING document — committed by the ENGINE in the
   *  SAME transaction as this worker's cursor (see CommitBatch.enrich).
   *
   *  RE-ENTRANCY OBLIGATION: an enrich write-back re-emits the document as a
   *  'document' change on the feed. A worker whose matches() would re-match
   *  its own enrichment MUST guard against re-processing it (e.g. by checking
   *  a metadata marker the enrich sets) or it will loop forever. */
  enrich(e: EnrichInput): void;
  log(level: LogLevel, msg: string): void;
}

/** What became of one change. 'done' advances; 'skip' is terminal —
 *  recorded, never retried (unsupported format, too large); 'defer' parks
 *  it for the worker's NEXT scheduled window — which is exactly how
 *  two-pass pipelines work (cheap OCR now → defer → expensive VLM later,
 *  only if still text-poor). A thrown error retries with backoff up to
 *  maxAttempts, then records 'failed' and MOVES ON — a poison document can
 *  never stall the cursor. */
export type WorkOutcome = 'done' | 'skip' | 'defer';

/** A Worker is to the document feed exactly what a Source is to Gmail: a
 *  consumer with a durable cursor. The engine tails the feed, filters by
 *  `matches`, calls `work`, advances the cursor — replacing the
 *  InferenceJob queue table, enqueueExtraction, and every per-pipeline
 *  loop. WHAT the work is is the module's business, bounded by its caps:
 *    caps: db          → analyze, keep results in its PrivateDb ("deriver")
 *    caps: files / net → reorganize folders, send, file        ("actor")
 *  (These used to be two roles; with results plugin-private they differ
 *  only by grants, so the HOST expresses the difference, not the type.)
 *  Results and cursor live in different files, so delivery is
 *  at-least-once: `work` must be idempotent. Re-run after a version bump =
 *  reset the cursor to 0. A worker that moves files feeds the folder's
 *  Source, which re-ingests, which wakes workers again — the loop is the
 *  feature. */
export interface Worker {
  readonly name: string;
  readonly version: number;
  /** 'live' (default) reacts as changes land; a Cadence means the engine
   *  fires on schedule with everything since the cursor — "reorganize my
   *  drive nightly" is a one-line declaration. */
  readonly schedule?: 'live' | Cadence;
  /** Trust knob for workers whose caps reach the world: 'propose' turns
   *  actions into approval cards ("move these 40 files?" — approve once /
   *  always-allow) instead of executing. Every executed action is
   *  journaled and, where possible, undoable. */
  readonly review?: 'auto' | 'propose';
  /** Bounded retries for thrown errors (default 3). The engine keeps a
   *  per-worker ledger (change → attempts/outcome), surfaced via
   *  Handle.stats — the pipeline is debuggable, not a black box. */
  readonly maxAttempts?: number;
  matches(change: Change): boolean;         // PURE — which changes it wants
  work(change: Change, session: WorkerSession): Promise<WorkOutcome | void>;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 6. PROJECTION — the renderer subscribes; nothing is "published" at it     ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** Renderer state = a pure reducer over the feed. The platform runs it,
 *  ships diffs over IPC tagged with `seq`; a reconnecting window resumes
 *  from its last seq instead of receiving a hand-rebuilt snapshot. MCP and
 *  any future surface (menu bar, watch app) are just more projections. */
export interface Projection<S> {
  init(read: Query): Promise<S>;
  apply(state: S, changes: Change[]): S;    // PURE
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 7. EXTENSIONS — contributions are return values, capabilities are shape   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export interface Manifest {
  id: ExtensionId;
  name: string;
  version: string;
  engine: string;                           // platform semver range
  contributes: {
    sources?: string[];                     // descriptor ids the module returns
    workers?: string[];
    tools?: string[];                       // MCP tools it adds to the outward surface
    providers?: string[];                   // inference backends it offers
    commands?: Array<{ id: string; title: string }>;
  };
  caps: Cap[];
}

/** The outward AI surface. The platform runs an MCP server; its built-in
 *  tools (search, read document, list accounts) are Query re-exposed.
 *  Extensions EXTEND it: a returned tool teaches any connected outside
 *  model (Claude on this machine, an assistant on the user's phone) a
 *  capability that didn't exist before — and because `call` captures the
 *  module's caps via closure, the tool can query, infer, and act exactly
 *  as far as the user consented, and no further. */
export interface McpTool {
  readonly name: string;                    // 'find_receipts', 'archive_thread'
  readonly description: string;
  readonly inputSchema: unknown;            // JSON Schema
  /** 'powerful' = raw-SQL-class reach (today's query_sql/get_schema): off
   *  by default, individually consented — not bundled into install. */
  readonly tier?: 'standard' | 'powerful';
  call(args: Record<string, unknown>): Promise<unknown>;
}

/** An extension's OWN database: its own tables in its own SQLite file under
 *  its dataDir. Full SQL, real schema, zero platform risk — physically a
 *  different file from the store, which stays engine-write-only. (A "kv"
 *  is just the first table you create here — not a separate concept.) */
export interface PrivateDb {
  exec(sql: string, params?: unknown[]): Promise<void>;
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<Row[]>;
}

/** NOTE THE ABSENCE: there is no 'db.write'. Writes to the shared store are
 *  return values — Source batches — committed by the engine. The
 *  marketplace's blast radius on your data STORE is zero by construction;
 *  reach into the WORLD exists only as the explicit, user-visible grants
 *  below. */
export type Cap =
  | 'query' | 'net' | 'files' | 'db' | 'ui' | 'commands' | 'inference' | 'events';

/** What the user actually granted, when, against which manifest version.
 *  `Manifest.caps` is a REQUEST; this is the answer. Persisted append-only
 *  in the Store (§2 `consents`); host construction reads the latest one. */
export interface ConsentRecord {
  extensionId: ExtensionId;
  caps: readonly Cap[];
  manifestVersion: string;
  grantedAt: string;
}

/** Rooted at folders the USER approved for this extension (like tracked
 *  roots) — never dataDir-relative, never the whole disk. */
export interface ScopedFiles {
  list(rel: string): Promise<string[]>;
  read(rel: string): Promise<Uint8Array>;
  write(rel: string, data: Uint8Array): Promise<void>;
  move(from: string, to: string): Promise<void>;
}

interface CapSurfaces {
  query: { query: Query };
  /** The platform's fetch, not bare: shared retry/backoff (429/5xx,
   *  Retry-After) applies by default so workers/tools don't reinvent it. */
  net: { net: { fetch(url: string, init?: unknown): Promise<unknown> } };
  files: { files: ScopedFiles };
  db: { db: PrivateDb };
  ui: { ui: { notify(msg: string, level?: LogLevel): void } };
  commands: { commands: { register(id: string, handler: (args: unknown) => unknown): () => void } };
  /** Real-time model access ('interactive' lane) — for commands and MCP
   *  tools; includes see(). Engine-invoked roles get inference via their
   *  sessions, and the old enqueue(docId)/onResult extension API dissolves —
   *  that shape IS a Worker. */
  inference: { inference: Inference };
  /** Lifecycle + cross-extension signals ONLY ('extension.activated',
   *  custom events namespaced by sender). DATA changes are NOT events —
   *  they are the feed; register a Worker or Projection for those. Without
   *  this cap, a tools-only extension could never be notified of anything. */
  events: {
    events: {
      on(event: string, cb: (payload: unknown) => void): () => void;
      emit(event: string, payload: unknown): void;
    };
  };
}

export interface BaseHost {
  self: { id: ExtensionId; dataDir: string };
  log(level: LogLevel, msg: string): void;
}

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I,
) => void
  ? I
  : never;

/** A host whose SHAPE is its grants — an ungranted namespace does not exist,
 *  at compile time here and at RPC-registration time in the real host. */
export type HostFor<G extends Cap> = BaseHost & UnionToIntersection<CapSurfaces[G]>;

/** THE one plugin type. An extension declares its behavior by returning it —
 *  no register-me API, no lifecycle to get wrong — and may return any MIX of
 *  roles, which share module state via closure (and capture `host` for
 *  whatever caps they hold). Splitting the roles in the CONTRACT (instead of
 *  one do-everything interface) is what lets the engine know what commits
 *  with which cursor, and the user see an honest consent screen. */
export interface ExtensionModule<G extends Cap = Cap> {
  activate(host: HostFor<G>): Promise<{
    sources?: Source[];
    workers?: Worker[];                     // capture `host` for db / world access
    tools?: McpTool[];                      // extend the MCP surface
    providers?: InferenceProvider[];        // offer an inference backend
  }>;
  deactivate?(): void | Promise<void>;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 8. PLATFORM SERVICES — prefs, logs, mcp, the canonical projection         ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** App-level settings — not per-account (that's Account.config), not
 *  per-extension (that's PrivateDb). One store, patch semantics, one
 *  change signal; the settings screens read and patch THIS. */
export interface AppPrefs {
  theme: 'system' | 'light' | 'dark';
  logLevel: LogLevel;
  launchAtLogin: boolean;
  showInMenuBar: boolean;
  processing: { enabled: boolean; window: 'always' | 'night' | 'idle' };
  privacy: { browserHistory: boolean; sendDiagnostics: boolean };
  /** Local model management: `override` pins a catalog model id ('auto' =
   *  hardware tier), `autoInstall` lets deferred vision work trigger the
   *  download (a Settings Cancel sets it false). */
  models: { override: string; autoInstall: boolean };
}

export interface Prefs {
  get(): AppPrefs;
  patch(p: Partial<AppPrefs>): Promise<void>;  // deep-merge; sanitized on load
  onChange(cb: (p: AppPrefs) => void): () => void;
}

/** ONE log sink. Every `log()` in this file — sessions, hosts, engine —
 *  writes here with its scope auto-set; rotation/retention is internal.
 *  The MCP call audit rides this same sink (scope 'mcp.call') instead of
 *  being a second bespoke store — given query_sql-class tools exist, calls
 *  against your life's data MUST leave a queryable trail. */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;                            // 'engine' | 'source:gmail' | 'worker:…' | 'mcp.call'
  msg: string;
  fields?: Record<string, unknown>;
}

export interface LogStore {
  tail(opts?: { scope?: string; level?: LogLevel }): AsyncIterable<LogRecord[]>;
  export(): Promise<string>;                // zip path, for a bug report
}

/** The outward MCP surface, typed. Tools come from three tiers: built-ins
 *  (Query re-exposed), extension McpTools (§7), and 'powerful' escape
 *  hatches — each tier consented separately. Local transport = loopback
 *  (auth-free by binding); anything remote requires bearer/OAuth. */
export interface Mcp {
  readonly http: { port: number; auth: 'loopback' | { bearer: string } } | null;
  readonly stdio: boolean;
  clients: {
    /** Claude Desktop, Cursor, VS Code… — detect them and write our server
     *  into their config (backed up), so "connect your AI" is one click. */
    detected(): Promise<Array<{ id: string; name: string; connected: boolean }>>;
    connect(id: string): Promise<void>;
  };
}

/** THE canonical renderer projection — shipped by the platform, not
 *  reinvented per window, so main and renderer cannot drift (the problem
 *  model.ts solved with projectAccount stays solved). Derived fields live
 *  in exactly two places: init() computes from Query, apply() folds
 *  Changes; anything not derivable from those two inputs doesn't belong
 *  in AppState. */
export interface AppState {
  accounts: Array<{
    account: Account;                       // status/progress/lastError ride along (§2)
    docCount: number;
    recent: Array<{ id: DocumentId; title: string | null; ts: string }>;
  }>;
  processing: { pending: number; done: number; skipped: number; failed: number };
  mcp: { port: number | null; clients: number };
  identity: Identity | null;
  prefs: AppPrefs;
}
export declare const appProjection: Projection<AppState>;

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 9. ENGINE & BOOT — the only writer, and the whole main.ts                 ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export interface Handle {
  readonly status: SyncStatus;
  /** The per-consumer ledger: drives the processing UI and makes the
   *  pipeline debuggable ("why is this document stuck?"). */
  stats(): Promise<{ pending: number; done: number; skipped: number; failed: number; deferred: number }>;
  stop(): Promise<void>;
}

/** The one state machine. Owns: transactional commits, parent resolution,
 *  status transitions, retry/backoff, cadence, and feeding workers +
 *  projections. Sources, workers, and projections are all "a cursor to
 *  advance" to it.
 *
 *  THE COMMIT-PATH PIPELINE (inside ingest, so search never lags data):
 *    1. convert — deterministic parsers (pdf/docx/html…) in a crash-
 *       isolated, backpressured pool; text-poor results are LEFT for a
 *       vision worker (the 'defer' two-pass pattern, §5)
 *    2. detect  — Document.languages (cheap, universal)
 *    3. index   — full-text + trigram rows, same transaction
 *  Conversion is deterministic engine work, NOT inference — only the
 *  text-poor minority ever costs a model call. */
export interface Engine {
  connect(source: Source, auth: AuthChannel): Promise<Account>;
  run(account: Account): Handle;            // pull → commit, forever
  /** Stop the sync, then ONE transactional cascade via `removeAccount`:
   *  purge documents (tombstones into the feed), delete cursor, config,
   *  and credentials (vault.delete — today's app leaks the blob). */
  remove(account: AccountId): Promise<void>;
  attach(worker: Worker): Handle;           // tail feed → work; cursor journaled
  project<S>(projection: Projection<S>, onDiff: (state: S, seq: Seq) => void): Handle;
}

/** The ONE timing authority — nothing else in the system owns a timer, and
 *  no plugin does either (its process may be asleep; the scheduler wakes
 *  it). Durable: lastRun/nextRun persist, a window missed while the app was
 *  closed catches up on boot. Central: backoff, battery, and quota
 *  throttling happen here for everyone. The engine registers every cadence
 *  found on contributions; this surface is what the UI reads and pokes. */
/** The live signals ALL throttling derives from — one place, not per-
 *  subsystem heuristics: background-lane concurrency (0 on battery, reduced
 *  when thermally 'fair'), cadence tiers (sync fast while focused, slow in
 *  tray), and ingest yield (back off while the user is actively driving
 *  the UI). */
export interface SchedulerEnv {
  onBattery: boolean;
  thermal: 'nominal' | 'fair' | 'serious';
  appFocus: 'focused' | 'unfocused' | 'hidden';
  userActive: boolean;
}

export interface Scheduler {
  readonly env: SchedulerEnv;
  jobs(): Promise<Array<{
    id: string;                             // 'source:gmail:acc123' | 'worker:drive-organizer'
    cadence: Cadence;
    lastRun: string | null;
    nextRun: string | null;
  }>>;
  trigger(id: string): Promise<void>;       // "Sync now" / "Run now"
}

export interface Platform {
  store: Store;
  engine: Engine;
  scheduler: Scheduler;
  inference: Inference;
  prefs: Prefs;
  logs: LogStore;
  mcp: Mcp;
  sources: { get(id: string): Source | undefined; list(): SourceDescriptor[] };
}

/** The whole of main.ts: boot, connect windows to projections, done.
 *  No 362-line whenReady closure, no three DI styles — construction happens
 *  once, in one place, and everything downstream reads `platform`.
 *  boot() also owns: versioned schema migration (forward-only, tracked —
 *  today's untracked idempotent steps don't scale) and the app sign-in
 *  gate (an RP OAuth flow producing Store.identity — a BOOT concern,
 *  unrelated to per-source connector OAuth). */
export declare function boot(config: { dataDir: string }): Promise<Platform>;
