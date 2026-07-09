/**
 * KIAgent domain contracts — the one place every entity and surface is defined.
 *
 * The design (see concept/greenfield.ts for the full rationale): the app is a
 * log. Sources, Workers, and Projections are all resumable consumers with a
 * durable cursor — over the outside world, over the document feed, over the
 * document feed — advanced by one Engine through one transactional write
 * primitive (`Store.commit`). Extensions are ONE plugin type whose activate()
 * returns any mix of contributions (sources / workers / tools / providers).
 *
 * This file is imported by main, renderer, and extension host alike. It must
 * stay runtime-free: types and interfaces only.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1. IDS — one string type, no wire codec
// ─────────────────────────────────────────────────────────────────────────────

declare const brand: unique symbol;
/** A UUIDv7 string. Branded per entity for compile-time safety; the runtime
 *  value is the SAME everywhere — DB, IPC, RPC, renderer, logs. */
export type Id<T extends string> = string & { readonly [brand]?: T };

export type AccountId = Id<'account'>;
export type DocumentId = Id<'document'>;
export type ExtensionId = Id<'extension'>;

/** Monotonic position in the change feed — the app's internal clock. */
export type Seq = number;

export type LogLevel = 'info' | 'warn' | 'error';

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE STORE — documents and the feed
// ─────────────────────────────────────────────────────────────────────────────

/** A document's natural key in its origin system — how sources refer to
 *  documents (parentage, deletions) without ever holding a DB id. */
export interface ExternalRef {
  externalId: string;
  type: string;
}

/** What a source provides — nothing more. Binary content with `markdown: null`
 *  means the ENGINE converts (built-in parsers, vision for scans). */
export interface DocumentInput {
  externalId: string;
  type: string; // 'email.thread' | 'file' | 'chat.message' | …
  title: string | null;
  markdown: string | null;
  binary?: { bytes: Uint8Array; mime: string; filename?: string };
  url?: string; // deep link back into the origin
  metadata: Record<string, unknown>;
  createdAt: string | null; // ISO-8601, origin time
  parent?: ExternalRef; // engine resolves in-transaction
}

/** What the store holds: the input plus system fields. One shape — no
 *  Pending/stored twin, no SDK copy, no renderer mirror. */
export interface Document extends Omit<DocumentInput, 'parent' | 'binary'> {
  id: DocumentId;
  accountId: AccountId;
  parentId: DocumentId | null;
  contentHash: string;
  seq: Seq;
  /** Soft-delete tombstone: live → archived → gone. Hidden from default
   *  queries; hard-purged later by engine maintenance. */
  archivedAt: string | null;
  /** Engine-detected at ingest (ISO-639-3) — feeds search stemming. */
  languages: string[];
  ingestedAt: string;
  updatedAt: string;
}

/** When recurring work runs. Declared as DATA on contributions — never a
 *  plugin-side timer: the platform's scheduler wakes the process. */
export type Cadence =
  | { every: string } // '15m', '1h'
  | { cron: string } // '0 9 * * 1'
  | 'manual';

export type SyncStatus =
  | 'connecting'
  | 'backfilling'
  | 'live'
  | 'paused'
  | 'needsReauth'
  | 'error';

export interface AccountProgress {
  done: number;
  totalEstimate?: number;
}

export interface Account {
  id: AccountId;
  source: string; // SourceDescriptor.id, e.g. 'gmail'
  identifier: string; // email address / phone / folder path
  config: Record<string, unknown>; // parsed — storage owns serialization
  status: SyncStatus;
  cursor: unknown; // persisted with every commit
  /** Engine-written with every commit — progress/error survive restart. */
  progress?: AccountProgress;
  lastSyncAt?: string;
  lastError?: string;
  cadence?: Cadence; // user's per-account override of the descriptor default
  createdAt: string;
}

export interface Credentials {
  accessToken?: string;
  refreshToken?: string;
  password?: string;
  /** OAuth app credentials ride the vault too — never plaintext config. */
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

/** One entry in the change log. An archive is an ordinary 'document' change
 *  (archivedAt set); 'purge' and 'accountRemoved' are tombstones. */
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

/** THE write primitive — the only one. Batch and cursor commit in one
 *  transaction, so "cursor saved but rows not committed" cannot be written. */
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
  | {
      consumer: string;
      cursor: Seq;
      documents?: DocumentInput[];
      enrich?: EnrichInput[];
    }
  /** ONE cascade: purge documents (tombstones into the feed), delete cursor,
   *  config, credentials. */
  | { removeAccount: AccountId }
  /** Engine maintenance: archived-long-enough tombstones become gone. */
  | { purgeArchived: { before: string } };

/** Read-only query surface — shared verbatim by the renderer, MCP, and the
 *  `query` capability. */
export interface Query {
  document(id: DocumentId): Promise<Document | null>;
  children(id: DocumentId): Promise<Document[]>;
  byExternalId(
    account: AccountId,
    externalId: string,
    type: string,
  ): Promise<Document | null>;
  /** Full-text with trigram fallback, weighted ranking, stemming fed by
   *  Document.languages. Index built INSIDE the commit transaction.
   *
   *  `text` supports boolean syntax: terms are ANDed by default, quoted
   *  phrases match exactly, `-term`/NOT excludes, uppercase OR alternates,
   *  `term*` prefix-matches, parentheses group. Malformed queries throw a
   *  descriptive Error rather than an FTS5 syntax error.
   *
   *  Without `text` the result is a recency listing ordered by the
   *  document's origin date (createdAt, falling back to ingestedAt) —
   *  NOT by write order, which inverts after a newest-first backfill.
   *  `fromDate`/`toDate` bound that same origin date (inclusive). */
  search(q: {
    text?: string;
    type?: string;
    account?: AccountId;
    includeArchived?: boolean; // default false
    fromDate?: string;
    toDate?: string;
    limit?: number;
    offset?: number;
  }): Promise<Array<Document & { snippet?: string }>>;
  count(q: {
    type?: string;
    account?: AccountId;
    includeArchived?: boolean;
  }): Promise<number>;
  accounts(): Promise<Account[]>;
}

export interface ConsentRecord {
  extensionId: ExtensionId;
  caps: readonly Cap[];
  manifestVersion: string;
  grantedAt: string;
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
  extractionStats(): Promise<ExtractionStats>;
  /** Tail the change log from a position. Live: keeps yielding. */
  feed(
    after: Seq,
    opts?: { kinds?: Change['kind'][] },
  ): AsyncIterable<Change[]>;
  /** Engine-only in practice — no extension ever holds this. */
  commit(batch: CommitBatch): Promise<Seq>;
  /** ONE credential scheme, ONE identity row. */
  vault: {
    save(account: AccountId, c: Credentials): Promise<void>;
    load(account: AccountId): Promise<Credentials | null>;
    delete(account: AccountId): Promise<void>;
  };
  identity: {
    get(): Promise<Identity | null>;
    set(i: Identity): Promise<void>;
  };
  /** Append-only — the history IS the audit trail. */
  consents: {
    latest(extension: ExtensionId): Promise<ConsentRecord | null>;
    record(c: ConsentRecord): Promise<void>;
  };
  maintenance: {
    compact(): Promise<void>;
    export(destDir: string): Promise<void>;
    resetAll(): Promise<void>;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. SOURCE — cursor over the outside world
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceDescriptor {
  id: string; // 'gmail'
  name: string;
  documentTypes: string[];
  /** Drives the connect-flow UI declaratively. */
  auth: 'oauth' | 'password' | 'pairing' | 'none';
  multiAccount?: boolean;
  /** Default re-pull cadence once backfill completes. */
  cadence?: Cadence;
}

/** 'backfill' = catching up (drives the progress bar); 'live' = current. */
export type PullPhase = 'backfill' | 'live';

export interface Batch<Cursor, Item> {
  phase: PullPhase;
  items: Item[];
  /** Items observed to be GONE upstream — archived in the same transaction. */
  deletions?: ExternalRef[];
  cursor: Cursor; // committed WITH the items
  estimateTotal?: number;
}

/** Residual per-account capabilities while pulling — all reads. */
export interface Session {
  readonly account: Account;
  readonly signal: AbortSignal;
  /** ONE credential verb. The platform refreshes OAuth before returning. */
  credentials(): Promise<Credentials | null>;
  log(level: LogLevel, msg: string): void;
}

/** A folder node shown in the connect-time folder picker. `id` is opaque and
 *  source-defined (a Drive folder id, a filesystem path, …); it never
 *  contains `/`. */
export interface FolderNode {
  id: string;
  name: string;
  hasChildren: boolean;
}

/** Result of a recursive file count under one folder. `capped` means the
 *  count budget ran out and `count` is a lower bound. */
export interface FolderCount {
  count: number;
  capped: boolean;
}

/** Tree callbacks + display options a source hands to
 *  {@link AuthChannel.pickFolders}. Callbacks are invoked lazily while the
 *  picker is open; they may reject — the picker shows the node as empty /
 *  uncounted rather than failing the flow. */
export interface FolderPickerSpec {
  /** Tabs shown in the picker, in order; at least one. */
  modes: Array<{ key: string; label: string }>;
  /** Allow selecting multiple folders (covering-root semantics). */
  multiSelect?: boolean;
  /** Top-level nodes for a mode tab. */
  roots(modeKey: string): Promise<FolderNode[]>;
  /** Child FOLDERS of a node (files are not listed in the picker). */
  children(id: string): Promise<FolderNode[]>;
  /** Recursive file count under a node; omit the method (or resolve null)
   *  when counting is unavailable. */
  count?(id: string): Promise<FolderCount | null>;
}

/** Interactive account establishment — the one moment a source talks to the
 *  UI. Credentials from `oauth()` are persisted by the platform. */
export interface AuthChannel {
  oauth(scopes: string[]): Promise<Credentials>;
  showQr(qr: string): void;
  prompt(schema: unknown): Promise<Record<string, unknown>>;
  status(msg: string): void;
  /** Show the shared folder-picker UI backed by the given tree callbacks.
   *  Resolves with the selected folders (covering roots — never both a node
   *  and its own descendant). Rejects if the user cancels. */
  pickFolders(spec: FolderPickerSpec): Promise<FolderNode[]>;
}

/** The entire connector-authoring surface. */
export interface Source<Cursor = unknown, Item = unknown> {
  readonly descriptor: SourceDescriptor;
  connect(
    auth: AuthChannel,
  ): Promise<{ identifier: string; config?: Record<string, unknown> }>;
  /** `null` cursor = from the beginning. Live sources keep yielding. Retry,
   *  backoff, throttling, progress, persistence: all engine-owned. */
  pull(
    session: Session,
    cursor: Cursor | null,
  ): AsyncIterable<Batch<Cursor, Item>>;
  /** PURE — unit-testable with fixtures. One upstream item may map to
   *  several documents (e.g. an email thread plus its attachments). */
  toDocument(item: Item): DocumentInput | DocumentInput[] | null;
  /** Optional random-access bytes for deep extraction. */
  fetchBytes?(session: Session, doc: Document): Promise<Uint8Array | null>;
  /** Optional full listing of what EXISTS upstream; the engine diffs and
   *  archives what is no longer listed. */
  reconcile?(session: Session): AsyncIterable<ExternalRef[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE INFERENCE PLANE — LLM / vision behind one queue
// ─────────────────────────────────────────────────────────────────────────────

/** 'interactive' answers a user or MCP call NOW; 'background' drains in
 *  idle / night / maintenance windows. */
export type Lane = 'interactive' | 'background';

/** ONE front door to models. Nobody loads a model or owns a GPU queue. */
export interface Inference {
  complete(
    prompt: string,
    opts?: { maxTokens?: number; lane?: Lane },
  ): Promise<string>;
  /** Vision: OCR, layout, "what is in this image". */
  see(
    image: Uint8Array,
    prompt: string,
    opts?: { mime?: string; lane?: Lane },
  ): Promise<string>;
  /** OCR only: image/page in, plain text out. Distinct from `see` because
   *  cheap native OCR and the costly VLM route to DIFFERENT providers —
   *  the two-pass pipeline addresses them by kind. */
  read(
    image: Uint8Array,
    opts?: { mime?: string; lane?: Lane },
  ): Promise<string>;
}

export type ProviderStatus =
  | 'ready'
  | 'standby'
  | 'unsupported' // this hardware can't run it
  | { downloading: { pct: number } }
  | { error: string };

/** The pluggable BACK of the front door — in-process pool today, LAN or
 *  cloud tomorrow; callers never know. */
export interface InferenceProvider {
  readonly id: string; // 'local' | 'lan:mac-studio' | 'anthropic'
  readonly supports: Array<'complete' | 'see' | 'read'>;
  status(): ProviderStatus;
  handle(req: {
    kind: 'complete' | 'see' | 'read';
    payload: unknown;
    lane: Lane;
  }): Promise<unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. WORKER — the one feed-consumer role
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerSession {
  readonly signal: AbortSignal;
  /** Sugar over the Inference plane, pinned to the 'background' lane. */
  inference(prompt: string, opts?: { maxTokens?: number }): Promise<string>;
  /** Vision sugar over the Inference plane, pinned to the 'background' lane. */
  see(
    image: Uint8Array,
    prompt: string,
    opts?: { mime?: string },
  ): Promise<string>;
  /** OCR sugar over the Inference plane, pinned to the 'background' lane. */
  read(image: Uint8Array, opts?: { mime?: string }): Promise<string>;
  /** Bytes via the document's own source (its `fetchBytes`). */
  fetchBytes(doc: Document): Promise<Uint8Array | null>;
  /** Emitted docs are committed by the ENGINE (under the worker's synthetic
   *  account) in the SAME transaction as this worker's cursor. */
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

/** 'done' advances; 'skip' is terminal (never retried); 'defer' parks the
 *  change for the worker's NEXT scheduled window — the two-pass pattern.
 *  A thrown error retries up to maxAttempts, records 'failed', moves on. */
export type WorkOutcome = 'done' | 'skip' | 'defer';

/** A consumer with a durable cursor over the document feed. Results live in
 *  the module's PrivateDb or come back as documents via emit(). Delivery is
 *  at-least-once: `work` must be idempotent. */
export interface Worker {
  readonly name: string;
  readonly version: number;
  /** 'live' (default) reacts as changes land; a Cadence fires on schedule
   *  with everything since the cursor. */
  readonly schedule?: 'live' | Cadence;
  /** 'propose' turns actions into approval cards instead of executing. */
  readonly review?: 'auto' | 'propose';
  /** Bounded retries for thrown errors (default 3). */
  readonly maxAttempts?: number;
  matches(change: Change): boolean; // PURE
  work(change: Change, session: WorkerSession): Promise<WorkOutcome | void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. PROJECTION — the renderer subscribes; nothing is "published" at it
// ─────────────────────────────────────────────────────────────────────────────

/** Renderer state = a pure reducer over the feed. The platform runs it and
 *  ships diffs over IPC tagged with `seq`; a reconnecting window resumes
 *  from its last seq. */
export interface Projection<S> {
  init(read: Query): Promise<S>;
  apply(state: S, changes: Change[]): S; // PURE
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. EXTENSIONS — contributions are return values, capabilities are shape
// ─────────────────────────────────────────────────────────────────────────────

/** NOTE THE ABSENCE of 'db.write': writes to the shared store are return
 *  values (Source batches, Worker emits) committed by the engine. */
export type Cap =
  | 'query'
  | 'net'
  | 'files'
  | 'db'
  | 'ui'
  | 'commands'
  | 'inference'
  | 'events'
  /** Privileged, bundled-tier only: run in the main process and receive the
   *  opaque main-process handle as activate()'s extras.mainProcess. Rejected
   *  for marketplace/dev extensions at manifest validation. */
  | 'unsafe.mainProcess';

/** Platform-side OAuth providers an extension source may bind to. The
 *  platform owns the provider's profile (auth URL + token exchange) and
 *  refresher — the extension never sees a client secret.
 *
 *  Single source of truth for the accepted set: the registry
 *  (`oauth-providers.ts`, via `Record<OAuthProviderId, …>`) and the manifest
 *  validator (`manifest.ts`) both derive from this array, so neither can
 *  drift from `OAuthProviderId` or from each other. */
export const OAUTH_PROVIDER_IDS = ['google', 'microsoft'] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number];

/** A `contributes.sources` entry: a bare source id, or an id plus an OAuth
 *  provider binding — `{ id: 'google-docs', oauth: 'google' }` makes
 *  `auth.oauth(scopes)` work during that source's connect flow and enables
 *  platform-side token refresh during pull. */
export type SourceContribution =
  | string
  | { id: string; oauth: OAuthProviderId };

/** A source that signs in through a platform OAuth provider. Surfaced at
 *  install/update/review consent and on the marketplace detail view — the
 *  user must see that a third-party source will open a provider sign-in
 *  window before install, not only at connect time. */
export interface OAuthSourceBinding {
  id: string;
  provider: OAuthProviderId;
}

export interface Manifest {
  id: ExtensionId;
  name: string;
  version: string;
  engine: string; // platform semver range
  /** Relative path to the CJS bundle, e.g. 'dist/index.js' — must resolve
   *  inside the extension directory (containment-checked at validation). */
  entry: string;
  /** Optional relative path to a PNG icon inside the package (conventionally
   *  'icon.png' — the marketplace also fetches that fixed path from the repo
   *  root pre-install). Same containment check as `entry`; ≤200 KB. Authors
   *  shipping a brand's mark must use the official, unmodified asset per
   *  that brand's guidelines. */
  icon?: string;
  contributes: {
    sources?: SourceContribution[];
    workers?: string[];
    tools?: string[];
    providers?: string[];
    commands?: Array<{ id: string; title: string }>;
  };
  caps: Cap[];
}

/** A tool on the outward MCP surface. `call` captures the module's caps via
 *  closure — the tool reaches exactly as far as the user consented. */
export interface McpTool {
  readonly name: string; // 'find_receipts', 'archive_thread'
  readonly description: string;
  readonly inputSchema: unknown; // JSON Schema
  /** 'powerful' = raw-SQL-class reach: off by default, individually
   *  consented — not bundled into install. */
  readonly tier?: 'standard' | 'powerful';
  call(args: Record<string, unknown>): Promise<unknown>;
}

/** An extension's OWN database: its own tables in its own SQLite file. */
export interface PrivateDb {
  exec(sql: string, params?: unknown[]): Promise<void>;
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<Row[]>;
}

/** Rooted at folders the USER approved for this extension — never the disk. */
export interface ScopedFiles {
  list(rel: string): Promise<string[]>;
  read(rel: string): Promise<Uint8Array>;
  write(rel: string, data: Uint8Array): Promise<void>;
  move(from: string, to: string): Promise<void>;
}

export interface CapSurfaces {
  query: { query: Query };
  /** The platform's fetch — shared retry/backoff applies by default. */
  net: { net: { fetch(url: string, init?: unknown): Promise<unknown> } };
  files: { files: ScopedFiles };
  db: { db: PrivateDb };
  ui: { ui: { notify(msg: string, level?: LogLevel): void } };
  commands: {
    commands: {
      register(id: string, handler: (args: unknown) => unknown): () => void;
    };
  };
  /** Real-time model access ('interactive' lane) — for commands and tools. */
  inference: { inference: Inference };
  /** Lifecycle + cross-extension signals ONLY. Data changes are the feed. */
  events: {
    events: {
      on(event: string, cb: (payload: unknown) => void): () => void;
      emit(event: string, payload: unknown): void;
    };
  };
  /** Privileged, bundled-tier only: main-process handle passed as
   *  extras.mainProcess in activate(), not as a host surface. */
  'unsafe.mainProcess': {};
}

export interface BaseHost {
  self: { id: ExtensionId; dataDir: string };
  log(level: LogLevel, msg: string): void;
}

type UnionToIntersection<U> = (
  U extends unknown ? (u: U) => void : never
) extends (i: infer I) => void
  ? I
  : never;

/** A host whose SHAPE is its grants — an ungranted namespace does not exist. */
export type HostFor<G extends Cap> = BaseHost &
  UnionToIntersection<CapSurfaces[G]>;

/** THE one plugin type. activate() returns any MIX of contributions, which
 *  share module state via closure. */
export interface ExtensionModule<G extends Cap = Cap> {
  activate(
    host: HostFor<G>,
    /** Bundled-tier only: set when granted caps include 'unsafe.mainProcess'
     *  AND the child runtime was given a mainApi handle. Undefined otherwise
     *  — including always for out-of-process (forked) children. */
    extras?: { mainProcess: unknown },
  ): Promise<{
    sources?: Source[];
    workers?: Worker[];
    tools?: McpTool[];
    providers?: InferenceProvider[];
  }>;
  deactivate?(): void | Promise<void>;
}

/** Runtime status of an installed extension, projected into AppState. */
export type ExtensionStatus =
  | 'disabled'
  | 'needs-consent'
  | 'activating'
  | 'activated'
  | 'errored';

export interface ExtensionSnapshot {
  id: string;
  name: string;
  version: string;
  origin: 'marketplace' | 'dev' | 'bundled';
  enabled: boolean;
  status: ExtensionStatus;
  error?: string;
  caps: Cap[];
  sourceIds: string[];
  /** Sources bound to a platform OAuth provider — rendered alongside caps
   *  wherever permissions are shown (marketplace detail, review consent). */
  oauthSources: OAuthSourceBinding[];
  /** data:image/png;base64 URI of the manifest icon, loaded from the
   *  installed dir — absent when the manifest declares none. */
  iconDataUrl?: string;
  ref?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. PLATFORM SERVICES — prefs, logs, mcp, the canonical projection
// ─────────────────────────────────────────────────────────────────────────────

/** Get-started checklist latches — nullable ISO timestamps, set once by the
 *  main process when each step's real signal fires. "Ever completed": a later
 *  disconnect/removal never un-checks a step. */
export interface OnboardingPrefs {
  sourceBackfilledAt: string | null; // step 1 — any account reaches 'live'
  mcpConnectedAt: string | null; // step 2 — first MCP client connected
  firstQueryAt: string | null; // step 3 — first tools/call served
  dismissedAt: string | null; // manual Skip
}

/** App-level settings — not per-account (Account.config), not per-extension
 *  (PrivateDb). */
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
  onboarding: OnboardingPrefs;
}

export interface Prefs {
  get(): AppPrefs;
  patch(p: Partial<AppPrefs>): Promise<void>; // deep-merge; sanitized on load
  onChange(cb: (p: AppPrefs) => void): () => void;
}

/** ONE log sink. The MCP call audit rides it too (scope 'mcp.call'). */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string; // 'engine' | 'source:gmail' | 'worker:…' | 'mcp.call'
  msg: string;
  fields?: Record<string, unknown>;
}

export interface LogStore {
  tail(opts?: { scope?: string; level?: LogLevel }): AsyncIterable<LogRecord[]>;
  export(): Promise<string>; // zip path, for a bug report
}

/** One MCP tool call as seen by the user-facing activity feed — the
 *  enriched sibling of the raw 'mcp.call' LogSink audit. Written to
 *  <dataDir>/mcp-activity.jsonl by BOTH processes (main for HTTP sessions,
 *  the mcpStdio sibling for client-spawned stdio); read only by main.
 *  See src/main/core/mcp/activity.ts. */
export interface McpActivityRecord {
  ts: string; // ISO timestamp
  transport: 'http' | 'stdio';
  client: string | null; // MCP initialize clientInfo.name, e.g. "claude-desktop"
  tool: string;
  ok: boolean;
  ms: number;
  summary: string; // one human line, e.g. `search "invoices" → 12 hits`
  detail?: string[]; // document titles touched (absent when none)
  error?: string; // present when ok === false
}

/** Records kept/replayed by the activity feed — the file's rotation target
 *  and the renderer's list cap (shared: the renderer can't import main). */
export const MCP_ACTIVITY_RECENT_MAX = 200;

/** The outward MCP surface. Local transport = loopback (auth-free by
 *  binding); anything remote requires bearer/OAuth. */
export interface Mcp {
  readonly http: { port: number; auth: 'loopback' | { bearer: string } } | null;
  readonly stdio: boolean;
  clients: {
    detected(): Promise<
      Array<{ id: string; name: string; connected: boolean }>
    >;
    connect(id: string): Promise<void>;
  };
}

/** THE canonical renderer projection — shipped by the platform so main and
 *  renderer cannot drift. Derived fields live in init() and apply() only. */
export interface AppState {
  accounts: Array<{
    account: Account;
    docCount: number;
    recent: Array<{ id: DocumentId; title: string | null; ts: string }>;
  }>;
  processing: {
    pending: number;
    done: number;
    skipped: number;
    failed: number;
  };
  mcp: { port: number | null; clients: number };
  identity: Identity | null;
  prefs: AppPrefs;
  extensions: ExtensionSnapshot[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. ENGINE & SCHEDULER
// ─────────────────────────────────────────────────────────────────────────────

export interface Handle {
  readonly status: SyncStatus;
  /** The per-consumer ledger — drives the processing UI. */
  stats(): Promise<{
    pending: number;
    done: number;
    skipped: number;
    failed: number;
    deferred: number;
  }>;
  stop(): Promise<void>;
}

/** The one state machine. Owns transactional commits, parent resolution,
 *  status transitions, retry/backoff, cadence, and feeding workers +
 *  projections. Commit-path pipeline: convert → detect languages → index. */
export interface Engine {
  connect(source: Source, auth: AuthChannel): Promise<Account>;
  run(account: Account): Handle; // pull → commit, forever
  /** Stop the sync, then ONE transactional cascade via `removeAccount`. */
  remove(account: AccountId): Promise<void>;
  attach(worker: Worker): Handle; // tail feed → work; cursor journaled
  project<S>(
    projection: Projection<S>,
    onDiff: (state: S, seq: Seq) => void,
  ): Handle;
}

/** The live signals ALL throttling derives from — one place. */
export interface SchedulerEnv {
  onBattery: boolean;
  thermal: 'nominal' | 'fair' | 'serious';
  appFocus: 'focused' | 'unfocused' | 'hidden';
  userActive: boolean;
}

/** The ONE timing authority — nothing else owns a timer. Durable:
 *  lastRun/nextRun persist; a missed window catches up on boot. */
export interface Scheduler {
  readonly env: SchedulerEnv;
  jobs(): Promise<
    Array<{
      id: string; // 'source:gmail:acc123' | 'worker:drive-organizer'
      cadence: Cadence;
      lastRun: string | null;
      nextRun: string | null;
    }>
  >;
  trigger(id: string): Promise<void>; // "Sync now" / "Run now"
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
