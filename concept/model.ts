/* eslint-disable */
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  KIAgent — CONCEPTUAL TYPE MODEL  (blueprint only — NOT wired into the app)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS IS
 *    A pure-types prototype of the *target* shape of the system. No
 *    implementations, no logic, nothing in here runs. The application never
 *    imports this file; deleting it changes nothing. Its only job is to let us
 *    judge ONE question: "is the model conceptually simpler than today?"
 *
 *  GROUND RULES (so it stays an honest blueprint)
 *    • Field names are PRESERVED from the current DB schema / published SDK
 *      (snake_case for document/account/sync fields). We are unifying *where*
 *      each type is defined, not renaming fields. No churn.
 *    • Every entity is defined ONCE here. The comments note how many parallel
 *      shapes each one replaces today.
 *    • Functions appear only as `declare` signatures — shapes, not bodies.
 *
 *  HOW TO READ
 *    Top to bottom. Six sections:
 *      1. Ids & the wire codec        — kills the bigint↔string scatter
 *      2. Core entities               — the "all entities" you asked for
 *      3. Connector-facing surface    — the SDK/context a connector receives
 *      4. The Platform object         — the one singleton app code reads from
 *      5. Extension Host (gated)      — extensions get a permissioned projection
 *      6. Renderer projection         — the derived snapshot the UI consumes
 */

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 1. IDS & THE WIRE CODEC                                                    ║
// ║   Today: `bigint` in the DB, `.toString()`/`BigInt(...)` sprinkled at      ║
// ║   every IPC + snapshot boundary (the single most-repeated reshape).        ║
// ║   Here: one branded id type + one codec. `toWire`/`fromWire` are the only  ║
// ║   places a conversion is allowed to happen.                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝

declare const __idBrand: unique symbol;
declare const __wireBrand: unique symbol;

/** A DB integer id. Still a real `bigint` at runtime; the brand is *optional*,
 *  so a plain bigint stays assignable both ways (zero migration friction). It
 *  documents intent (`AccountId` reads clearer than `bigint`); it does not, by
 *  itself, forbid passing a DocumentId where an AccountId is expected — that
 *  stricter guarantee is a deliberate later choice. */
export type Id<T extends string> = bigint & { readonly [__idBrand]?: T };

export type AccountId = Id<'Account'>;
export type DocumentId = Id<'Document'>;
export type AnnotationId = Id<'Annotation'>;
/** Tracked roots use a string UUID, not a DB integer. */
export type TrackedRootId = string;

/** The *wire* form of a DB id: a string, because `bigint` is not
 *  JSON-serializable and everything past the main process — renderer, IPC,
 *  out-of-process extensions — is serialized. Branded so a wire id can't be
 *  silently mixed with an arbitrary string, and so a wire AccountId reads
 *  distinctly from a wire DocumentId. This is the boundary type the renderer and
 *  the extension Host (§5) speak; `AccountId`/`DocumentId` stay main-process. */
export type WireId<T extends string> = string & { readonly [__wireBrand]?: T };
export type WireAccountId = WireId<'Account'>;
export type WireDocumentId = WireId<'Document'>;

/** The ONLY sanctioned id conversions. `toWire` for DB→IPC/renderer/extension;
 *  `fromWire` for the way back. Carrying the brand through the codec means a wire
 *  id round-trips to the same `Id<T>` it came from. */
export declare function toWire<T extends string>(id: Id<T>): WireId<T>;
export declare function fromWire<T extends string>(wire: WireId<T>): Id<T>;

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 2. CORE ENTITIES                                                          ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** A connector's stable string id, e.g. 'gmail' | 'imap' | 'local-folder'.
 *  Matches `documents.source` and `accounts.source`. */
export type ConnectorId = string;

/**
 * A configured source instance the user has connected (one Gmail login, one
 * tracked-folder set, …). Owns documents and a sync lifecycle.
 * Today: 3 shapes — `Account`, the raw `accounts` row, and `SnapshotAccount`.
 * Here: 1 shape + a projection (§5/§ renderer) derived from it.
 */
export interface Account {
  id: AccountId;
  source: ConnectorId;
  identifier: string; // unique-per-source natural key (email, folder-set id, …)
  display_name?: string;
  /** Parsed ONCE from the `config_json` TEXT column at the repo boundary —
   *  never re-`JSON.parse`d at each reader, as happens today. */
  config_json?: Record<string, unknown>;
  /** Path to the encrypted credentials blob (see Credentials). */
  credentials_blob_path?: string;
  enabled: boolean;
}

/** The lifecycle status that drives the scheduler — the most load-bearing enum
 *  in the app. (In real code this would also be backed by a `const` array so the
 *  runtime has the list; here, types only, we keep it a pure union.) */
export type SyncStatus =
  | 'pending'
  | 'backfilling'
  | 'live'
  | 'error'
  | 'paused' // user-paused
  | 'needs_reauth'; // dead refresh token / 401 — scheduler stops until re-auth

/** Per-account sync progress + cursor. Today lives inside the 782-line
 *  AccountsRepository with no owning type home. */
export interface SyncState {
  account_id: AccountId;
  status: SyncStatus;
  backfill_total_estimate?: number;
  backfill_done_count?: number;
  /** Connector-private resume token (Gmail historyId, Graph deltaLink, IMAP
   *  uid cursor, …). Opaque to the platform. */
  cursor_json?: Record<string, unknown>;
  last_sync_at?: Date;
  last_error?: string;
}

/** The shape every sync-state writer accepts: any subset of fields, but `status`
 *  is always required (it drives the scheduler). Named once and referenced by the
 *  context, the repo, and the Host — instead of re-spelled `Partial & Pick` at
 *  each of the three. */
export type SyncStateUpdate = Partial<SyncState> & Pick<SyncState, 'status'>;

/** Everything a connector hands in to be stored — before it gets an id. */
export interface PendingDocument {
  source: ConnectorId;
  source_id: string; // connector-local id; UNIQUE(source, source_id, type)
  type: string; // 'email' | 'thread' | 'file' | 'doc' | …  (connector-defined)
  parent_id?: DocumentId;
  title: string;
  markdown: string | null; // normalized body; null for binary-only docs
  metadata: Record<string, unknown>;
  source_url: string;
  content_hash?: string;
  from_address?: string;
  created_at: Date;
}

/** A stored document — the spine of the whole app. Every source normalizes into
 *  this one table. */
export interface Document extends PendingDocument {
  id: DocumentId;
  account_id: AccountId; // owning account
  ingested_at: Date;
  updated_at: Date;
}

/** Detected language for a document (1-to-many; an email can be DE body +
 *  EN signature). `lang` = ISO 639-3 ('und' = undetermined). */
export interface DocumentLanguage {
  document_id: DocumentId;
  lang: string;
  score: number; // 0..1 proportion of text in this language
}

/** Vector embedding for semantic search. */
export interface DocumentEmbedding {
  document_id: DocumentId;
  model: string;
  embedding: Uint8Array; // portable binary; a Node Buffer is still assignable
}

/** A note/label attached to a document (user- or system-authored). */
export interface Annotation {
  id: AnnotationId;
  document_id: DocumentId;
  kind: string;
  author: string;
  content: string;
  metadata: Record<string, unknown>;
  created_at: Date;
  expires_at?: Date;
}

/** A folder/drive the user tracks for ingestion. Polymorphic by `kind`.
 *  Today: 4 kind-specific insert branches duplicating column lists + a
 *  renderer mirror `SnapshotTrackedRoot`. */
export interface TrackedRoot {
  id: TrackedRootId;
  account_id: AccountId;
  kind: 'fs' | 'drive' | 'ms-drive' | 'browser';
  abs_path?: string; // fs / browser
  external_id?: string; // drive / ms-drive
  display_path?: string;
  include_glob: string[];
  exclude_glob: string[];
  last_full_scan_at?: string;
  added_at?: string;
}

/** Decrypted OAuth credentials. Persisted as an encrypted blob on disk; the
 *  path is `Account.credentials_blob_path`. Today: two independent encryption
 *  schemes + token-persist logic duplicated across Gmail/MS365 persisters. */
export interface Credentials {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scope: string;
  token_type: 'Bearer';
}

/** The app owner's identity. Today: a SECOND source of truth in identity.json
 *  outside the DB. Here: a single row. */
export interface Identity {
  email: string;
  name?: string;
  avatarUrl?: string;
  provider?: 'google' | 'microsoft';
}

/** Per-account polling cadence override (focused vs unfocused window). Missing
 *  → scheduler default. */
export interface CadenceConfig {
  account_id: AccountId;
  focused_ms: number;
  unfocused_ms: number;
}

/** A queued deep-extraction (OCR/VLM) job for a text-poor document. */
export interface InferenceJob {
  document_id: DocumentId;
  state: 'pending' | 'processing' | 'ocr_done' | 'done' | 'skipped' | 'failed';
  reason?: string;
  attempts: number;
  last_error?: string;
  engine?: string;
  content_hash?: string;
}

/** A structured log line. Today: near-duplicate definitions in main + renderer. */
export interface LogRecord {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  msg: string;
  [field: string]: unknown;
}

/** A permission an extension has been granted — the persisted consent record.
 *  Today grants exist only as inline string arrays on a manifest/holder, with no
 *  record of WHAT was granted, or WHEN. (`Permission` and `Manifest` are defined
 *  in §3.) */
export interface PermissionGrant {
  extension_id: ConnectorId;
  permission: Permission;
  granted_at: Date;
}

/** An INSTALLED extension and its lifecycle — the entity an extension platform
 *  with a marketplace needs, but the model otherwise lacked (we had only the
 *  static `Manifest` and the runtime `ExtensionModule`). A connector is just an
 *  extension whose manifest contributes a source. */
export interface Extension {
  id: ConnectorId;
  manifest: Manifest;
  version: string;
  source: 'builtin' | 'marketplace' | 'sideloaded';
  enabled: boolean;
  installed_at: Date;
  grants: Permission[]; // currently-granted permissions (see PermissionGrant)
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 3. CONNECTOR DESCRIPTOR, MANIFEST & THE CONNECTOR-FACING SURFACE           ║
// ║   "the context/SDK a connector receives"                                   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export interface ConnectorCapabilities {
  multiAccount: boolean;
  requiresAuth: boolean;
  supportsBackfill: boolean;
  supportsDelta: boolean;
  supportsRealtime: boolean;
}

/** A permission string an extension may hold, e.g. 'db.write' | 'net'. */
export type Permission = string;

/** ONE manifest schema. Today: `ConnectorManifest` and `ExtensionManifest` are
 *  two schemas for the same metadata, reconciled by hand-copying fields.
 *  Here: a connector manifest is an extension manifest minus the extra fields,
 *  produced by a function — never field-copied. */
export interface Manifest {
  id: ConnectorId;
  displayName: string;
  version: string;
  hostApi: string; // host API version the extension targets
  entry: string; // runtime entry module ('builtin' for first-party)
  icon?: string;
  permissions: Permission[];
  activationEvents: string[];
  contributes: {
    sources: Array<{ id: ConnectorId; displayName: string }>;
    commands?: Array<{ id: string; title: string }>; // a CommandContribution
  };
}

/** The descriptor data of a connector (no behaviour). Today re-presented as
 *  `ConnectorModule`, `RemoteConnector`, `ConnectorDescriptor` — here it is one
 *  shape, and the renderer's view is a thin projection of it. */
export interface ConnectorDescriptor {
  id: ConnectorId;
  displayName: string;
  capabilities: ConnectorCapabilities;
  icon?: string;
}

/** Progress + log sink handed to a backfill run. */
export interface ProgressSink {
  update(done: number, totalEstimate: number | null): void;
  log(level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>): void;
}

/**
 * THE PER-ACCOUNT DOCUMENT + SYNC OPERATIONS — defined ONCE, parameterized by
 * the id representation at the boundary. In-process connectors get bigint
 * `DocumentId`s; out-of-process extensions (everything serializes over RPC) get
 * the wire string form. The extension `Host.db` (§5) is literally this interface
 * re-parameterized and gated — THAT is what "a projection, not a twin" means,
 * enforced by the types instead of asserted in a comment. (Today the same five
 * verbs are spelled once on `ConnectorContextImpl` and again, renamed, on
 * `Host.db`.)
 */
export interface DocumentOps<TDocId = DocumentId> {
  upsertDocument(doc: PendingDocument): Promise<TDocId>;
  deleteDocument(id: TDocId): Promise<void>;
  archiveDocument(id: TDocId, reason: string): Promise<void>;
  findBySourceId(source: ConnectorId, sourceId: string, type: string): Promise<Document | null>;
  findByContentHash(hash: string): Promise<Document[]>;
  saveSyncState(state: SyncStateUpdate): Promise<void>;
  loadSyncState(): Promise<SyncState | null>;
}

/** Connector-private persistence — a namespaced home for what are today bespoke
 *  index tables (`imap_message_index`, `drive_folder_index`) that a connector
 *  otherwise has to hand-create on the shared `db`. Scoped to this connector;
 *  invisible to others. Keeps connector-private state OUT of the elevated core
 *  entities while still giving it a typed home. */
export interface ConnectorStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * THE CONNECTOR CONTEXT — the single per-account surface a connector is given.
 * Today this is the concrete class `ConnectorContextImpl`, leaked into the public
 * `createInstance` signature. Here it is `DocumentOps` (the shared core, above)
 * plus the capability handles a connector reads off this object instead of having
 * them threaded in: no raw `db`, no `safeStorage`, no callbacks passed by arg.
 */
export interface ConnectorContext extends DocumentOps<DocumentId> {
  readonly accountId: AccountId;

  // — capabilities, read off the platform instead of threaded —
  readonly converter: Converter; // shared doc→markdown converter (worker pool)
  readonly storage: CredentialBox; // encrypt/decrypt for THIS account's secrets
  readonly dataDir: string; // connector's namespaced scratch dir
  readonly store: ConnectorStore; // connector-private persistence (see above)
  emitStreamEvent(event: ConnectorStreamEvent): void; // e.g. a QR during pairing
  /** Queue deep OCR/VLM for a doc. Account-scoped sugar over
   *  `platform.inference.enqueue` — the same one service, not a parallel queue. */
  enqueueExtraction(id: DocumentId): void;
}

/** Per-account secret box (replaces the two ad-hoc encryption schemes). */
export interface CredentialBox {
  isEncryptionAvailable(): boolean;
  load(): Promise<Credentials | null>;
  save(creds: Credentials): Promise<void>;
}

/** A pairing/stream lifecycle event surfaced to the connection wizard.
 *  `accountId` is a STRING here (crosses IPC). */
export interface ConnectorStreamEvent {
  connectorId: ConnectorId;
  accountId: WireAccountId; // crosses IPC to the wizard — wire string form
  qr?: string;
  status?: string;
  error?: string;
}

/**
 * THE RUN CONTEXT — the ONE bag a connector captures for a backfill/delta run.
 * Today: 3 inconsistent shapes (`BackfillArgs`, `DeltaArgs`, `ImapRunDeps`) plus
 * inline closures, each hand-threaded 4–6 layers deep across ~3,100 lines.
 * Here: built once, captured once.
 */
export interface ConnectorRunContext {
  readonly ctx: ConnectorContext;
  readonly account: Account;
  readonly signal: AbortSignal;
  readonly progress: ProgressSink;
  /** Present only for OAuth connectors; refreshes transparently. */
  getAccessToken?(): Promise<string>;
}

export interface BackfillResult {
  status: 'ok' | 'partial' | 'error';
  resumeAt?: Record<string, unknown>;
}

/**
 * The connector runtime. Stable today and kept as-is — but `createInstance` now
 * takes the `ConnectorContext` *interface* instead of a concrete class.
 */
export interface ConnectorInstance {
  startBackfill(run: ConnectorRunContext): Promise<BackfillResult>;
  pollDelta(run: ConnectorRunContext): Promise<void>;
  startRealtime?(run: ConnectorRunContext): Promise<void>;
  stopRealtime?(): Promise<void>;
  reconcile?(run: ConnectorRunContext): Promise<void>;
  requestStop?(): void;
  shutdown(): Promise<void>;
  buildSourceUrl(sourceId: string, type: string, metadata: Record<string, unknown>): string;
}

export interface Connector {
  readonly descriptor: ConnectorDescriptor;
  getAccountSchema(): unknown; // JSON schema for the connect form
  validateAccount(input: unknown): { ok: true } | { ok: false; error: string };
  createInstance(account: Account, ctx: ConnectorContext): Promise<ConnectorInstance>;
}

/**
 * GENERIC RUN ENGINES (concept) — the inputs that let ONE state machine replace
 * the per-connector backfill/delta copy-paste. A connector supplies only these
 * closures; the engine owns resume/paging/abort/progress.
 */
export interface BackfillSpec<Cursor, Item> {
  loadCursor(): Promise<Cursor | null>;
  loadPage(cursor: Cursor | null): Promise<{ items: Item[]; next: Cursor | null }>;
  processItem(item: Item): Promise<void>;
  saveCursor(cursor: Cursor): Promise<void>;
}
export type DeltaSpec<Cursor, Item> = BackfillSpec<Cursor, Item>;

/** Resolves the original bytes of a deep-extraction candidate (one per source). */
export interface ByteSource {
  source: ConnectorId;
  fetch(
    candidate: { documentId: DocumentId; metadata: Record<string, unknown> },
  ): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; kind: 'unavailable' | 'gone'; detail: string }>;
}

/** Opaque shared services referenced above (kept as handles in the concept). */
export interface Converter {
  toMarkdown(bytes: Uint8Array, mime: string, filename?: string): Promise<string>;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 4. THE PLATFORM OBJECT                                                     ║
// ║   The ONE typed singleton, assembled once at boot and passed by reference. ║
// ║   Replaces: ~85 `new XRepository(db)`, the 362-line `whenReady` closure,    ║
// ║   the `() => T` lazy getters, and the `publishState` callback threading.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

export interface Platform {
  /** INTERNAL escape hatch for the rare raw query — main process only, never
   *  handed to a connector or extension. Everything else goes through `repos`. */
  readonly db: AppDb;
  /** Cached repository bundle — replaces the ~85 per-call `new XRepository(db)`.
   *  A property, not a method: it's a fixed bundle, so it reads like the rest. */
  readonly repos: Repositories;
  /** The per-account connector context (replaces the `ctxFor` closure AND the
   *  duplicate `Host.db` surface). */
  contextFor(accountId: AccountId): ConnectorContext;

  readonly converter: Converter;
  readonly http: Http;
  readonly credentials: CredentialStore;
  readonly identity: IdentityStore;
  readonly prefs: PrefsStore;
  readonly logger: Logger;
  readonly scheduler: Scheduler;
  readonly inference: InferenceService;
  /** Connectors — the data-source kind of extension. */
  readonly registry: ConnectorRegistry;
  /** Installed extensions + their lifecycle (enable/disable, version, grants). */
  readonly extensions: ExtensionRegistry;
  /** Commands contributed by extensions (replaces ad-hoc command wiring). */
  readonly commands: CommandRegistry;
  readonly events: EventBus;
  /** Snapshot publishing; auto-invalidates on a DB data-version change, so no
   *  mutation site has to remember to call it. */
  readonly state: StateBus;
  /** The ONE place permission checks live (replaces the 3 scattered today). */
  readonly permissions: PermissionGate;
}

/** Stateless, cached query objects — one per table-cluster. */
export interface Repositories {
  documents: DocumentsRepo;
  accounts: AccountsRepo;
  syncState: SyncStateRepo;
  trackedRoots: TrackedRootsRepo;
  cadence: CadenceRepo;
  inferenceJobs: InferenceJobsRepo;
}

export interface DocumentsRepo {
  upsert(doc: PendingDocument & { account_id: AccountId }): Promise<{ id: DocumentId }>;
  get(id: DocumentId): Promise<Document | null>;
  delete(id: DocumentId): Promise<void>;
  search(query: string, opts?: { limit?: number }): Promise<Document[]>;
  countForAccount(accountId: AccountId): Promise<number>;
}
export interface AccountsRepo {
  list(): Promise<Account[]>;
  get(id: AccountId): Promise<Account | null>;
  upsert(input: Omit<Account, 'id'>, resetSyncState: boolean): Promise<AccountId>;
  remove(id: AccountId): Promise<void>;
}
export interface SyncStateRepo {
  load(accountId: AccountId): Promise<SyncState | null>;
  save(accountId: AccountId, state: SyncStateUpdate): Promise<void>;
}
export interface TrackedRootsRepo {
  listForAccount(accountId: AccountId): Promise<TrackedRoot[]>;
}
export interface CadenceRepo {
  get(accountId: AccountId): Promise<CadenceConfig | null>;
  set(cfg: CadenceConfig): Promise<void>;
}
export interface InferenceJobsRepo {
  insert(id: DocumentId): Promise<void>; // raw persistence; app code calls InferenceService.enqueue
  claimNext(): Promise<InferenceJob | null>;
}

export interface Http {
  /** Shared retry/backoff bearer fetch (was http-shared). Error contract is
   *  enforced HERE, not regex-matched by callers. */
  bearerFetch(url: string, token: string, init?: unknown): Promise<unknown>;
}

/** One credential path + a blob registry (kills orphaned blobs). */
export interface CredentialStore {
  load(account: Account): Promise<Credentials | null>;
  save(account: Account, creds: Credentials): Promise<void>;
  deleteFor(account: Account): Promise<void>;
  listOrphans(): Promise<string[]>;
}

/** Owner identity, single-sourced in the DB. */
export interface IdentityStore {
  get(): Promise<Identity | null>;
  set(identity: Identity): Promise<void>;
  clear(): Promise<void>;
}

export interface PrefsStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

export interface Logger {
  log(record: LogRecord): void;
  child(tag: string): Logger;
}

export interface StateBus {
  publish(): Promise<void>;
  invalidate(): void;
  subscribe(cb: (state: AppState) => void): () => void;
}

export interface ConnectorRegistry {
  get(id: ConnectorId): Connector | undefined;
  list(): ConnectorDescriptor[];
}

/** Installed-extension lifecycle (the marketplace surface). */
export interface ExtensionRegistry {
  get(id: ConnectorId): Extension | undefined;
  list(): Extension[];
  setEnabled(id: ConnectorId, enabled: boolean): Promise<void>;
}

/** Commands contributed by extensions — one registry instead of ad-hoc wiring. */
export interface CommandRegistry {
  run(commandId: string, args?: unknown): Promise<unknown>;
  list(): string[];
}

export interface Scheduler {
  start(): Promise<void>;
  restartAccount(accountId: AccountId): Promise<void>;
  removeAccount(accountId: AccountId): Promise<void>;
}

/** The ONE app-facing way to queue deep extraction. `ConnectorContext.enqueueExtraction`
 *  is account-scoped sugar over this; `InferenceJobsRepo.insert` is the persistence
 *  underneath. One behaviour in three layers — not three queues. */
export interface InferenceService {
  enqueue(id: DocumentId): Promise<void>;
}

export interface EventBus {
  on<E extends PlatformEvent>(event: E, cb: (payload: PlatformEventPayload[E]) => void): () => void;
  emit<E extends PlatformEvent>(event: E, payload: PlatformEventPayload[E]): void;
}

/** Opaque DB handle (worker-thread connection behind an interface). */
export interface AppDb {
  all(sql: string, params?: unknown[]): Promise<unknown[]>;
  run(sql: string, params?: unknown[]): Promise<unknown>;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 5. THE EXTENSION HOST (a gated projection of the platform)                 ║
// ║   The full out-of-process extension platform stays. The key simplification ║
// ║   is that the Host is no longer a parallel re-implementation of the DB      ║
// ║   surface — it is `gate(platform, grants)`.                                ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** Who a permission check is about: an extension id + the permissions it holds.
 *  Named (not inline) so the gate, `gate()`, and `Host.self` all agree. */
export interface PermissionHolder {
  id: ConnectorId;
  grants: Permission[];
}

export interface PermissionGate {
  /** Throws PermissionDenied if the holder lacks `permission`. */
  check(holder: PermissionHolder, permission: Permission): void;
  /** The permission a given host method requires (single source of truth). */
  requiredFor(namespace: string, method: string): Permission | null;
}

/** Platform events an extension may subscribe to. */
export interface PlatformEventPayload {
  'document.indexed': { documentId: WireDocumentId; sourceId: string; ts: string };
  'source.synced': { sourceId: string; status: string; error?: string };
  'extension.activated': { extensionId: string };
  'extension.deactivated': { extensionId: string };
  'permission.violation': { extensionId: string; permission: string; callSite: string };
  'inference.completed': { taskId: string; ok: boolean };
}
export type PlatformEvent = keyof PlatformEventPayload;

/**
 * The single normalized surface every extension receives in `activate(host)`.
 * Namespaced for clarity and permissioned per call. Each namespace is a narrowed,
 * gated view of the same platform services above — NOT a second implementation.
 */
export interface Host {
  /** The SAME `DocumentOps` (§3) a connector gets — re-parameterized to wire
   *  string ids because an extension is out-of-process and everything it sends or
   *  receives is serialized. Same verb names, gated per call. Present only on an
   *  account-scoped host (see `gate`). */
  db: DocumentOps<WireDocumentId>;
  net: { fetch(url: string, init?: unknown): Promise<unknown> };
  files: {
    read(path: string): Promise<Uint8Array>;
    write(path: string, data: Uint8Array): Promise<void>;
    list(dir: string): Promise<string[]>;
  };
  secrets: { get(key: string): Promise<string | null>; set(key: string, val: string): Promise<void> };
  ui: { notify(msg: string, level?: 'info' | 'warn' | 'error'): void };
  events: { on<E extends PlatformEvent>(e: E, cb: (p: PlatformEventPayload[E]) => void): () => void };
  commands: { register(id: string, handler: (args: unknown) => unknown): () => void };
  inference: { enqueue(documentId: WireDocumentId): Promise<void> };
  /** This extension's own scope. Wire ids, since `self` crosses the process line.
   *  `accountId` is set only for an account-scoped host. */
  self: { id: ConnectorId; dataDir: string; accountId?: WireAccountId; hasPermission(p: Permission): boolean };
}

/** The whole point of §5: the extension Host is a *derivation* of the platform,
 *  narrowed and gated — not a hand-mirrored twin. Scope is explicit and lives in
 *  one argument: an account-scoped host (`scope.accountId` set) can reach that
 *  account's documents via `Host.db`; a global host (no `accountId`) gets the
 *  account-free surface and its `db` calls reject. The platform resolves the
 *  account context internally — the caller no longer threads it in. */
export declare function gate(platform: Platform, scope: GrantScope): Host;

/** Who the host is for and what it may reach. */
export interface GrantScope {
  extensionId: ConnectorId;
  accountId?: AccountId; // set → account-scoped host (enables Host.db)
  grants: Permission[];
}

export interface ExtensionModule {
  activate(host: Host): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ 6. RENDERER PROJECTION                                                      ║
// ║   The proven `AppState` pattern: one aggregate, single-sourced across       ║
// ║   main+renderer. The fix: `SnapshotAccount` is DERIVED, never hand-built.   ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** What the renderer shows for one account — a pure projection of
 *  Account + SyncState + counts. `id` is the wire form, produced by `toWire`. */
export interface SnapshotAccount {
  id: WireAccountId;
  source: ConnectorId;
  display_name?: string;
  status: SyncStatus;
  doc_count: number;
  backfill_done_count?: number;
  backfill_total_estimate?: number;
  last_error?: string;
  recent_documents: Array<{ ts: string; title: string; from_address?: string }>;
}

export interface AccountCounts {
  total: number;
  recent: Array<{ ts: string; title: string; from_address?: string }>;
}

/** The single source of truth for the renderer. */
export interface AppState {
  accounts: SnapshotAccount[];
  auth: { signedIn: boolean; localMode: boolean; email?: string; name?: string; avatarUrl?: string };
  mcp: { port: number | null; bearer: string };
  cadence: Record<string, { focused_ms: number; unfocused_ms: number }>;
}

/** The ONE function that builds a SnapshotAccount, so main and renderer can
 *  never field-drift (guarded by a test, exactly like today's AppState). */
export declare function projectAccount(
  account: Account,
  sync: SyncState,
  counts: AccountCounts,
): SnapshotAccount;
