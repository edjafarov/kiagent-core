/* eslint-disable */
/**
 * ════════════════════════════════════════════════════════════════════════════
 *  KIAgent — ALTERNATIVE CONCEPT: THE PULL MODEL  (blueprint only, like model.ts)
 * ════════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS IS
 *    A more radical alternative to §3 + §5 of `model.ts`. Everything else there
 *    — §1 ids & wire codec, §2 entities, §4 Platform, §6 renderer projection —
 *    carries over unchanged, so this file imports it instead of restating it.
 *
 *  THE TWO MOVES
 *    A. Connectors become resumable READ-ONLY streams ("sources"). Every
 *       personal-data source is, at bottom, a stream of items behind a cursor:
 *       Gmail backfill = pages of threads, Graph delta = a change feed, IMAP
 *       IDLE = live events, a tracked folder = scan + watcher events. Today each
 *       connector re-implements the imperative loop AROUND its stream (~3,100
 *       lines of paging/resume/abort/progress plumbing). Here the source yields
 *       batches; ONE engine owns every side effect.
 *
 *       The invariant that replaces the whole ConnectorContext / Host.db story:
 *       a source READS the outside world and NEVER WRITES platform state.
 *       The engine is the only writer.
 *
 *    B. Permission checks become capabilities. `gate()` returns an object whose
 *       SHAPE is the grant set — an ungranted namespace does not exist, at
 *       compile time here and at RPC-registration time in the real host.
 *       Holding the reference IS the permission.
 *
 *  WHAT DISSOLVES  (vs model.ts, which already halved today's surface)
 *    ─ ConnectorInstance (7 methods)        → Source.pull (1 verb) + fetchBytes?
 *    ─ ConnectorContext / Host.db twin      → engine is the sole writer; gone
 *    ─ ConnectorRunContext + ProgressSink   → Session (6 members); engine counts
 *    ─ BackfillSpec / DeltaSpec engines     → SyncEngine, written & tested once
 *    ─ SyncStateUpdate on the SDK           → engine-internal status transitions
 *    ─ emitStreamEvent + wizard side-channel→ AuthChannel, scoped to connect()
 *    ─ CredentialBox on the SDK             → platform persists; Session lends
 *    ─ enqueueExtraction on the SDK         → engine policy (text-poor ⇒ queue)
 *    ─ PendingDocument.parent_id (a DB id
 *      forced into connector hands)         → ParentRef by natural key
 *    ─ PermissionGate / PermissionHolder /
 *      hasPermission / 'permission.violation' → capability construction
 *
 *  WHAT IT COSTS (honest)
 *    ─ The published imperative connector SDK becomes a different CONTRACT, not
 *      a different spelling — external connectors need `adaptLegacy` (bottom).
 *    ─ The engine concentrates all sync complexity in one component. That is
 *      the point — but that one component has to be excellent.
 */

import type {
  Account,
  AccountId,
  Connector,
  ConnectorDescriptor,
  ConnectorId,
  ConnectorStore,
  Credentials,
  Document,
  DocumentOps,
  PendingDocument,
  Platform,
  PlatformEvent,
  PlatformEventPayload,
  SyncStatus,
  WireAccountId,
  WireDocumentId,
} from './model';

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ A. THE SOURCE — a connector as a resumable read-only stream               ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** What a yielded batch means. `backfill` advances the progress bar; `delta`
 *  and `live` feed the live account. (A periodic reconcile is engine policy:
 *  re-pull from a null cursor and let upsert-dedup absorb it.) */
export type PullPhase = 'backfill' | 'delta' | 'live';

export interface Batch<Cursor, Item> {
  phase: PullPhase;
  items: Item[];
  /** Cursor positioned AFTER this batch. The engine persists it in the SAME
   *  transaction as the batch's documents — resume-safety by construction,
   *  killing the "cursor saved but docs not committed" bug class outright. */
  cursor: Cursor;
  /** Optional running total for progress ("~12,400 threads"). */
  estimateTotal?: number;
}

/** The residual per-account capabilities a source may use while pulling.
 *  Everything here is a READ or connector-private — by construction a source
 *  cannot write platform state. Replaces ConnectorRunContext + most of
 *  ConnectorContext. */
export interface Session {
  readonly account: Account;
  readonly signal: AbortSignal;
  readonly dataDir: string;
  /** Connector-private KV (unchanged from model.ts §3). */
  readonly store: ConnectorStore;
  /** OAuth sources; refreshes transparently. */
  getAccessToken?(): Promise<string>;
  /** Password/basic-auth sources (IMAP); decrypted on demand, never a path. */
  loadCredentials(): Promise<Credentials | null>;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

/** Interactive account establishment — the ONE moment a source talks to the
 *  UI. Replaces emitStreamEvent + the pairing-wizard side-channel; re-auth
 *  (`needs_reauth`) is the engine re-opening this channel. Credentials from
 *  `oauth()` are persisted by the PLATFORM — the source never sees the blob. */
export interface AuthChannel {
  oauth(scopes: string[]): Promise<Credentials>;
  showQr(qr: string): void;
  prompt(schema: unknown): Promise<Record<string, unknown>>;
  status(msg: string): void;
}

/** How a source expresses parentage: by natural key, never by DB id — a pure
 *  source never holds a DocumentId. The engine resolves it inside the commit
 *  transaction (parents must appear in the stream before their children). */
export interface ParentRef {
  source_id: string;
  type: string;
}

/** The pure mapping result. `binary` set (with `markdown: null`) means the
 *  ENGINE converts via the worker pool — the last side effect leaves the
 *  connector. */
export interface NormalizedItem {
  doc: Omit<PendingDocument, 'parent_id'>;
  parent?: ParentRef;
  binary?: { bytes: Uint8Array; mime: string; filename?: string };
}

/**
 * THE ENTIRE CONNECTOR-AUTHORING SURFACE. One I/O verb (`pull`), one optional
 * random-access verb (`fetchBytes`), two pure functions. Compare
 * `Connector` + `ConnectorInstance` + `ConnectorContext` in model.ts §3.
 */
export interface Source<Cursor = unknown, Item = unknown> {
  readonly descriptor: ConnectorDescriptor;

  /** Establish an account interactively; returns its natural key + config.
   *  (Field names preserved: `config_json` as in `Account`.) */
  connect(auth: AuthChannel): Promise<{
    identifier: string;
    config_json?: Record<string, unknown>;
  }>;

  /** THE verb. Yield batches from wherever `cursor` points — `null` means
   *  "from the beginning" (backfill); live sources simply keep yielding.
   *  Abort (via `session.signal` / generator return), retry with backoff,
   *  throttling, progress, cursor persistence, dedup by
   *  UNIQUE(source, source_id, type): ALL engine-owned. */
  pull(session: Session, cursor: Cursor | null): AsyncIterable<Batch<Cursor, Item>>;

  /** PURE: item → document (or null to skip). Unit-testable with fixtures;
   *  the engine chooses when/where mapping runs and logs the raw item on
   *  failure. */
  toDocument(item: Item): NormalizedItem | null;

  /** PURE. Unchanged from model.ts. */
  buildSourceUrl(sourceId: string, type: string, metadata: Record<string, unknown>): string;

  /** Optional random-access re-fetch for deep extraction (was ByteSource). */
  fetchBytes?(session: Session, doc: Document): Promise<Uint8Array | null>;
}

/** THE one state machine — written once, tested once; replaces the ~3,100
 *  lines of per-connector plumbing AND the scheduler's per-account loops.
 *  Owns: transactional commit of items+cursor, parent resolution, conversion,
 *  SyncStatus transitions (pending→backfilling→live→…), progress, retry,
 *  abort, and the inference-enqueue policy (text-poor ⇒ queue — no longer a
 *  connector decision). On `Platform` (§4), `scheduler` collapses into this. */
export interface SyncEngine {
  run(account: Account, source: Source): SyncHandle;
}
export interface SyncHandle {
  readonly status: SyncStatus;
  stop(): Promise<void>;
}

/** On `Platform` (§4), `registry: ConnectorRegistry` becomes this. */
export interface SourceRegistry {
  get(id: ConnectorId): Source | undefined;
  list(): ConnectorDescriptor[];
}

/** Compatibility bridge: the published imperative SDK keeps working. The
 *  adapter runs a legacy ConnectorInstance against a shim context whose
 *  `upsertDocument` feeds the engine as yielded items — so external connectors
 *  are unaffected while first-party ones migrate one at a time. */
export declare function adaptLegacy(connector: Connector): Source;

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ B. CAPABILITIES — permission = holding the reference                      ║
// ╚══════════════════════════════════════════════════════════════════════════╝

/** The closed grant vocabulary (refines model.ts's open `Permission = string`).
 *  The persisted consent record (`PermissionGrant`, §2) stays — construction
 *  reads it. */
export type Cap =
  | 'db.read'
  | 'db.write'
  | 'net'
  | 'files'
  | 'secrets'
  | 'ui'
  | 'commands'
  | 'inference';

/** What each grant unlocks. A namespace maps to a narrowed, wire-id view of
 *  the SAME platform services — never a second implementation. */
interface CapSurfaces {
  'db.read': {
    db: Pick<DocumentOps<WireDocumentId>, 'findBySourceId' | 'findByContentHash' | 'loadSyncState'>;
  };
  'db.write': { db: DocumentOps<WireDocumentId> };
  net: { net: { fetch(url: string, init?: unknown): Promise<unknown> } };
  files: {
    /** Paths are RELATIVE TO `self.dataDir` — the sandbox is the type's contract. */
    files: {
      read(rel: string): Promise<Uint8Array>;
      write(rel: string, data: Uint8Array): Promise<void>;
      list(rel: string): Promise<string[]>;
    };
  };
  secrets: {
    /** Keys are namespaced per extension by the platform. */
    secrets: { get(key: string): Promise<string | null>; set(key: string, val: string): Promise<void> };
  };
  ui: { ui: { notify(msg: string, level?: 'info' | 'warn' | 'error'): void } };
  commands: { commands: { register(id: string, handler: (args: unknown) => unknown): () => void } };
  inference: { inference: { enqueue(documentId: WireDocumentId): Promise<void> } };
}

/** What EVERY extension gets, grant-free. Note: no `hasPermission` — an
 *  extension introspects its capabilities by property presence. */
export interface BaseHost {
  self: { id: ConnectorId; dataDir: string; accountId?: WireAccountId };
  events: {
    on<E extends PlatformEvent>(e: E, cb: (p: PlatformEventPayload[E]) => void): () => void;
  };
}

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I,
) => void
  ? I
  : never;

/** A host whose SHAPE is its grants. No `check()` call sites, no
 *  `requiredFor` table, no 'permission.violation' event — an ungranted
 *  namespace simply does not exist. The out-of-process RPC layer enforces the
 *  same truth by never registering ungranted methods. */
export type HostFor<G extends Cap> = BaseHost & UnionToIntersection<CapSurfaces[G]>;

export interface GrantScope<G extends Cap = Cap> {
  extensionId: ConnectorId;
  /** Set → account-scoped host (db verbs resolve against this account). */
  accountId?: AccountId;
  grants: readonly G[];
}

/** e.g. `gate(platform, { extensionId, accountId, grants: ['net', 'db.read'] })`
 *  returns `BaseHost & { net: … } & { db: <read-only> }` — and nothing else. */
export declare function gate<G extends Cap>(platform: Platform, scope: GrantScope<G>): HostFor<G>;

export interface ExtensionModule<G extends Cap = Cap> {
  activate(host: HostFor<G>): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
