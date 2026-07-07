# Architecture Consolidation — Design Spec

- **Date:** 2026-06-26
- **Status:** Draft for review
- **Type:** In-place refactor / consolidation (not a rewrite)
- **Scope:** All 5 phases (entities → platform → context/host → connector runtime → credentials/identity)

---

## 1. Motivation

KIAgent already contains the bones of every abstraction we want — a per-account
context object (`ConnectorContextImpl`), a permission-gated host facade
(`createHost`), typed dependency bundles (`boot/create*Services`), and a single
deliberately-single-sourced aggregate (`AppState`/`computeSnapshot`). The problem
is **not missing structure; it is duplicated structure.** Each concept exists two
or three times in parallel and the copies are kept in sync by hand.

Quantified (from a whole-codebase analysis):

| Symptom | Today |
|---|---|
| Representations of one **connector** | 6 — `Connector`, `ConnectorModule`, `RemoteConnector`, `ConnectorManifest`, `ExtensionManifest`, `ConnectorDescriptor` |
| Representations of one **account** | 3 — `Account`, raw `accounts` row, `SnapshotAccount` |
| `new XRepository(db)` call sites | ~85 (repositories are stateless, re-allocated per call) |
| `whenReady` boot closure | 362 lines, 3 mixed DI styles (values, lazy `() => T` getters, function refs) |
| Connector `backfill`/`delta` plumbing | ~3,100 lines of near-identical state machines across 6 connectors |
| Context surfaces over identical DB ops | 2 — raw `ConnectorContextImpl` (built-ins) and permission-gated `Host.db` (extensions) |
| Credential encryption schemes | 2 — `safeStorage` blobs (built-ins) + envelope-key AES-256-GCM (out-of-process) |
| Owner-identity sources of truth | 2 — `accounts` table + `identity.json` |
| Bespoke RPC protocols | 3 — `HostRouter`, `RemoteConnectorRouter`, DB worker bridge |

The single most-repeated reshape in the codebase is the **`bigint` (DB) ↔ `string`
(renderer/IPC) id conversion**, scattered with no shared codec.

### Why now / why these goals

User decisions captured during brainstorming:

- **Rebuild = in-place consolidation** of this repo. The app must keep running at
  every step; we build on existing investment rather than rewrite.
- **Keep the full extension platform** — out-of-process host, RPC, permissions,
  manifests, marketplace all stay. 3rd-party extensions are a core product goal.
  We unify the *duplicated* surfaces; we do not remove capability.
- **Primary drivers:** clarity/ownership, approachability for contributors, and
  faster feature work. (Not rebuild-for-its-own-sake.)

## 2. Goals & non-goals

### Goals

1. Define every core entity **once**, in a single canonical location, re-exported
   to all consumers and guarded against drift by a test.
2. Introduce **one `Platform` object** assembled at boot and passed by reference,
   so dependencies are *accessed* from one typed place instead of threaded through
   function arguments and lazy getters.
3. Collapse the two context surfaces (`ConnectorContextImpl` + `Host.db`) into one
   canonical `ConnectorContext`, with permissions as a thin wrapper layer.
4. Eliminate the ~3,100-line connector `backfill`/`delta` duplication with a
   shared run-context and generic state machines.
5. Unify credentials onto one encryption path with a blob registry, and make owner
   identity a single source of truth in the DB.

### Non-goals (explicitly out of scope for this work)

- **Field renames.** We do *not* rename `source_id`/`from_address`/`config_json`
  etc. to camelCase. The published SDK exposes these names and external connectors
  depend on them; renaming is high-churn, low-value, and fights "keep it working."
  We unify *where* types are defined, not *what fields are called*.
- **Removing the out-of-process / permission / marketplace machinery.** Kept.
- **Changing the SQLite schema shape.** Migrations already handle additive change;
  no destructive schema rework here (identity table in Phase 5 is additive).
- **Rewriting the renderer.** The renderer already has the proven pattern
  (`AppState` + `push-subscriptions` + `useAppStateSelector`); we feed it canonical
  types, we don't restructure it.

## 3. Guiding principles

- **One definition, many re-exports.** Imitate the `AppState` pattern (defined once
  in main, re-exported to renderer, guarded by a completeness test) for every
  entity.
- **Published packages stay leaf dependencies.** `@alpha-cent/connector-sdk` and
  `@alpha-cent/extension-sdk` may have **no `@main` imports** (enforced by
  `src/__tests__/connector-sdk-conformance.test.ts`). Therefore *public* entity
  types live in the SDK and `@main` imports them; *internal* entity types live in
  `@main/domain`. Never the reverse.
- **Access, don't thread.** A dependency that exists before consumers are
  constructed should be *read from a stable object*, not passed down as an
  argument or a `() => T` getter.
- **Permissions are a wrapper, not a parallel surface.** One gate; built-ins get
  the ungated context, extensions get `gate(context, grants)`.
- **Every phase is independently shippable** and leaves the app fully working.

## 4. Target architecture overview

```
@alpha-cent/connector-sdk   ← canonical PUBLIC entity types (Document, Account, SyncStateRow, …)
        ▲ re-export                     (zero @main deps; external connectors compile against this)
        │
src/main/domain/            ← canonical INTERNAL entities + Id codec + projections
   id.ts, entities.ts, projections.ts, manifest.ts
        ▲ import
        │
src/main/platform/platform.ts   ← THE Platform object (assembled once at boot)
   db · repos() · contextFor() · converter · http · credentials · identity ·
   prefs · logger · scheduler · inference · registry · events · state · permissions
        ▲ passed by reference
        │
   ┌────┴───────────────┬──────────────────────┬─────────────────────┐
 IPC handlers      Scheduler/features      ConnectorContext        Extension Host
 register*(platform)  take(platform)     (public interface)     gate(context, grants)
                                              ▲
                                     ConnectorRunContext + Backfill/DeltaStateMachine
```

---

## 5. Phase 1 — Canonical entity types

### Current state

- Public doc types (`PendingDocument`, `Document`, `SyncStateRow`, `Account`) are
  defined in `packages/connector-sdk/src/index.ts` **and duplicated** in
  `src/main/context/types.ts`.
- `Account` has a third shape, `SnapshotAccount` (`src/main/snapshot.ts`), built by
  hand with `bigint→string` id conversion and joined-in `status`/`doc_count`.
- `TrackedRoot` is redefined inline inside `connector-context.ts` (a narrower shape)
  *and* in `repositories/tracked-roots.ts`.
- No shared id codec; `.toString()` / `BigInt(...)` appear at every snapshot and IPC
  boundary.

### Target state

**Two-tier canonical home.**

Public types stay in (and become the single home of) `@alpha-cent/connector-sdk`.
Delete the duplicate definitions in `src/main/context/types.ts`; everything in
`@main` imports from the SDK.

Internal types get a new `src/main/domain/` module:

```ts
// src/main/domain/id.ts  — one codec for the bigint↔wire boundary
declare const brand: unique symbol;
export type Id<T extends string> = bigint & { readonly [brand]?: T };
export const toWire   = (id: bigint): string => id.toString();
export const fromWire = <T extends string>(s: string): Id<T> => BigInt(s) as Id<T>;

export type AccountId  = Id<'Account'>;
export type DocumentId = Id<'Document'>;   // SDK keeps `DocumentId = bigint` (structural; see note)
```

> **Branding note.** The brand is declared *optional* (`[brand]?`) so a raw `bigint`
> stays assignable to `Id<T>` (and `Id<T>` to `bigint`) — the SDK's public
> `bigint`-typed members are unaffected and there is **zero** forced migration. Be
> honest about the trade-off: with an *optional* brand the types are still mutually
> assignable, so it documents intent (`AccountId` reads clearer than `bigint`) but
> does **not** enforce "can't pass a DocumentId where an AccountId is expected."
> True mixing-safety needs a *required* brand, which forces every id to flow through
> `fromWire`/a constructor — that friction is deferred (Open Question 1). The
> must-have deliverable here is the `toWire`/`fromWire` codec; the optional brand is
> a frictionless, intent-documenting bonus on top.

```ts
// src/main/domain/entities.ts  — internal entities, names preserved as-is
export const SYNC_STATUS = ['pending','backfilling','live','error','paused','needs_reauth'] as const;
export type SyncStatus = typeof SYNC_STATUS[number];   // the most load-bearing enum in the app

export interface TrackedRoot {
  id: string; account_id: AccountId;
  kind: 'fs' | 'drive' | 'ms-drive' | 'browser';
  abs_path?: string; external_id?: string; display_path?: string;
  include_glob: string[]; exclude_glob: string[];
  last_full_scan_at?: string; added_at?: string;
}
export interface InferenceJob {
  document_id: DocumentId;
  state: 'pending'|'processing'|'done'|'ocr_done'|'skipped'|'failed';
  reason?: string; attempts: number; last_error?: string;
  engine?: string; content_hash?: string;
}
export interface Identity { email: string; name?: string; avatarUrl?: string; provider?: 'google'|'microsoft'; }
// re-export the SDK public types so @main has ONE import surface:
export type { Account, Document, PendingDocument, SyncStateRow } from '@alpha-cent/connector-sdk';
```

```ts
// src/main/domain/projections.ts  — SnapshotAccount becomes derived, never hand-built
export function projectAccount(a: Account, s: SyncStateRow, counts: AccountCounts): SnapshotAccount {
  return { id: toWire(a.id), source: a.source, status: s.status, doc_count: counts.total, /* … */ };
}
```

**Manifest unification:** keep one Zod schema. `ExtensionManifest` becomes
`ConnectorManifest` + extension-only fields, produced by a *function*
(`connectorModuleToExtension` stops copying fields by hand; `isBuiltinManifest`
sentinel removed).

### What this deletes / collapses

- `src/main/context/types.ts` duplicate definitions → gone (import from SDK).
- 3 account shapes → `Account` + `projectAccount()`.
- inline `TrackedRoot` in `connector-context.ts` → `domain` definition.
- scattered `toString()`/`BigInt()` → `toWire`/`fromWire`.
- 6 connector representations → `Connector` (+ derived `ConnectorDescriptor` view) and
  one `Manifest` schema.

### Drift guard

A `domain/__tests__/entity-drift.test.ts` asserts (via `typecheck`) that
`SnapshotAccount` is structurally `ReturnType<typeof projectAccount>` and that the
SDK public types and `@main/domain` re-exports are identical — the same technique
`snapshot.ts`'s descriptor-completeness test already uses.

---

## 6. Phase 2 — The Platform object

### Current state

`main.ts whenReady` is a 362-line closure that (1) calls `createCoreServices`,
`createConnectorServices`, `createExtensionPlatform`, `registerIpcServices`, then
(2) assigns results to module-global `let x: T | null` variables, and (3) threads
them downward as a mix of values, `() => T` lazy getters (`getConverter`,
`getPrefsStore`, `getInferenceService`), and function refs. The `create*Services`
factories *already return typed bundles* — they're 80% of a DI container that gets
destructured and re-threaded instead of stored.

### Target state

```ts
// src/main/platform/platform.ts
export interface Platform {
  db: AppDb;
  repos(accountId?: AccountId): Repositories;        // cached bundle; replaces ~85 `new XRepository(db)`
  contextFor(accountId: AccountId): ConnectorContext; // replaces ctxFor closure AND Host.db duplication
  converter: Converter;
  http: { bearerFetch: BearerFetch };                // shared retry/backoff (was http-shared)
  credentials: CredentialStore;                      // ONE encryption path + blob registry (Phase 5)
  identity: IdentityStore;                            // single source of truth in DB (Phase 5)
  prefs: PrefsStore;                                  // live accessor → deletes getPrefsStore() getters
  logger: Logger;
  scheduler: Scheduler;
  inference: InferenceService;
  registry: ConnectorRegistry;
  events: EventBus;
  state: { publish(): Promise<void>; invalidate(): void };  // auto-invalidates on DB data_version change
  permissions: PermissionGate;                       // the ONE place check()/requiredPermission live (Phase 3)
}
```

`assemblePlatform()` calls the existing `create*Services` builders and stores their
results on one object. `main.whenReady` shrinks to:

```
build core → build engines → assemblePlatform → registerIpc(platform) → start(platform)
```

Because `platform` exists *before* handlers register, all three high-severity
arg-threading hotspots dissolve: `db` is read as `platform.db` / `platform.repos()`,
lazy getters become direct fields (`platform.converter`, `platform.prefs`), and the
per-mutation `publishState` callback becomes `platform.state.publish()` with
automatic invalidation on a DB `data_version` change subscription (kills the
"forgot to call publishState" bug class).

### Migration approach

1. Land `Platform` as an *additive* object that wraps the existing module-globals
   (each field delegates to today's getter). No behavior change.
2. Migrate IPC handler registration to `register*(platform)`, replacing
   getter/value/function-ref params one handler-file at a time (each shippable).
3. Once all consumers read from `platform`, delete the module-globals and lazy
   getters.

### What this deletes / collapses

- 362-line `whenReady` → ~50–60 lines.
- `getConverter` / `getPrefsStore` / `getInferenceService` getters → gone.
- ~85 `new XRepository(db)` → `platform.repos().<name>` (cached).
- Manual `publishState`/`stateGate.invalidate` threading → `platform.state` + auto-invalidate.

---

## 7. Phase 3 — Unify ConnectorContext & the extension Host

### Current state

Two surfaces over **identical** DB operations:

- **Built-ins:** `Connector.createInstance(account, ctx)` receives a concrete
  `ConnectorContextImpl` — the concrete class is leaked into the public contract.
  Constructed in 3 places (scheduler `ctxFor`, `host.ts` `db()` closure, inference
  `applyExtractionResult` via `new ConnectorContextImpl(db, 0n)`), with an optional
  4th `caps` arg bolted on "so the ~60 existing 2/3-arg sites stay valid."
- **Extensions:** `createHost().db` re-wraps the same `upsert/find/saveSyncState`
  methods behind permission gates.

Permission enforcement is scattered across `host.ts` `check()`,
`extension-host-router.ts` `requiredPermission(ns, method)`, and implicit
fail-closed defaults (absent `connectorOwnership` ⇒ `ownsAccount` returns false).

### Target state

- Promote the public surface to an **interface** `ConnectorContext` (the documented
  subset; `ConnectorContextImpl` becomes its internal implementation, relocated
  `context/ → platform/` since it is platform-coupled). `Connector.createInstance`
  takes `ConnectorContext`, not the concrete class.
- One constructor path: `platform.contextFor(accountId)` (replaces all 3 ad-hoc
  construction sites and the `caps` overload).
- **`PermissionGate`** module is the single home for `check()` /
  `requiredPermission()` / fail-closed defaults. The extension `Host` becomes:

```ts
const host = gate(platform.contextFor(accountId), grantedPermissions);
```

So built-ins use the ungated context and extensions use a *wrapper* over the same
object — eliminating the parallel `Host.db` surface. The `HOST_SURFACE` drift guard
in `extension-sdk` stays as the RPC manifest.

### Migration approach

1. Extract `ConnectorContext` interface from `ConnectorContextImpl` (the SDK's
   `ConnectorHost` is already a near-exact narrowing — align them).
2. Introduce `platform.contextFor`; redirect the 3 construction sites to it.
3. Introduce `PermissionGate`; route `host.ts`/`HostRouter` checks through it.
4. Re-express the extension `Host` as `gate(context, grants)`; delete duplicated
   `Host.db` method bodies.

### What this deletes / collapses

- Concrete class leaked into public contract → interface.
- 3 construction sites + `caps` overload → `platform.contextFor`.
- 2 context surfaces → 1 context + 1 gate wrapper.
- 3 permission-check locations → 1 `PermissionGate`.

### Optional follow-on (flagged, not required this pass)

`HostRouter` and `RemoteConnectorRouter` reimplement the same
call/reply/progress/dispose pattern; a shared `RpcRouter` could absorb both. Listed
as a stretch item; not on the critical path.

---

## 8. Phase 4 — ConnectorRunContext & generic state machines

### Current state

The worst arg-threading by volume. Each connector hand-rolls a bag threaded 4–6
layers deep, with **inconsistent shapes**:

- gmail/google-docs/ms365/onedrive use per-function `BackfillArgs` / `DeltaArgs`
  (`{ ctx, converter, accountId, getAccessToken, signal, onProgress, … }`).
- imap uses a monolithic `ImapRunDeps` (`{ ctx, converter, client, index, … }`).
- local-folder uses inline closures.

~1,900 lines across 6 `backfill.ts` + ~1,200 across 6 `delta.ts`, all implementing
the same shape: resume-from-cursor → page → process-item-in-pool → upsert → save
cursor. Two parser implementations (gmail/ms365, ~120 lines each) duplicate
header/body/attachment walking. The `bearerFetch` error *string* format is
regex-matched by delta callers — a fragile, load-bearing contract.

### Target state

```ts
// one shape for all connectors, built ONCE in createInstance and captured
interface ConnectorRunContext {
  ctx: ConnectorContext;          // db ops + converter + http + logger + progress
  accountId: AccountId;
  signal: AbortSignal;
  progress: ProgressSink;
  getAccessToken?(): Promise<string>;
}

// generic engines — connectors supply only the provider-specific closures
class BackfillStateMachine<Cursor, Item> {
  constructor(opts: {
    loadCursor(): Promise<Cursor | null>;
    loadPage(cursor: Cursor | null): Promise<{ items: Item[]; next: Cursor | null }>;
    processItem(item: Item): Promise<void>;
    saveCursor(cursor: Cursor): Promise<void>;
  }) {}
  run(run: ConnectorRunContext): Promise<BackfillResult>;   // handles resume/page/abort/progress
}
class DeltaStateMachine<Cursor, Item> { /* symmetric */ }
```

- `BackfillArgs` / `DeltaArgs` / `ImapRunDeps` → one `ConnectorRunContext`. (imap
  moves client creation into a `runWith` wrapper instead of the function signature.)
- Generic engines own resume/paging/progress/abort; connectors provide
  `loadPage`/`processItem`/cursor codecs only.
- Shared `email-shared/parser-utils.ts` (`collectHeaders`, `findBody`,
  `collectAttachments`, `formatRecipient`, `parseDate`) → gmail/ms365 parsers drop
  from ~120 to ~50 lines each.
- Move the `bearerFetch` error-string contract *into* `bearerFetch` (callers pass
  `[pattern, name]` tuples) so delta files stop regex-matching a format string.
- Introduce a common `BackfillResult` (`status: 'ok'|'partial'|'error', resumeAt?`)
  so the scheduler can unify post-run handling.

### What this deletes / collapses

- ~3,100 lines of duplicated state machines → 2 generic engines + thin per-connector
  closures (target ≥40% reduction).
- 3 inconsistent run-arg shapes → 1.
- 2 parsers' shared logic → 1 util module.
- fragile error-string contract → enforced inside `bearerFetch`.

---

## 9. Phase 5 — Consolidate credentials & identity

### Current state

- **Two encryption schemes:** `safeStorage` blobs in `oauth/*.bin` for built-ins;
  envelope-key AES-256-GCM in `connector-host-adapter.ts` for out-of-process
  connectors.
- Token persist logic duplicated across `persistGmailAccount` and
  `persistMs365FromSignInToken` (~73 lines each: email lookup → token blob →
  accounts upsert).
- **No blob registry** — orphaned `*.bin` files accumulate when accounts are
  deleted without a working cascade.
- **Owner identity is a second source of truth**: `identity.json` (chmod 0600)
  alongside the `accounts` table; lenient parsing silently degrades on corruption.
- `AccountsRepository` is 782 lines mixing 4 concerns (account CRUD, sync_state,
  connector_cadence, deletes).

### Target state

- **`CredentialStore`** on the platform: one `load(account)` / `save(account, token)`
  / `deleteFor(account)` API over a single encryption path, backed by a
  `TokenBlobRegistry` (`deleteBlob`, `listOrphans`) so deletes cascade and orphans
  are reapable.
- Extract `persistTokenAccount(...)` shared by Gmail/MS365 (the two persisters
  collapse to thin adapters).
- **`IdentityStore`** on the platform, backed by a new additive `identity` table
  (`owner_id=1, email, name, avatar_url, provider`) — `identity.json` removed after a
  one-time migration. Fail-fast on corrupt reads (return null only on ENOENT).
- **Split `AccountsRepository`** into `AccountRepository`, `SyncStateRepository`,
  `ConnectorCadenceRepository` (~200 lines each); deduplicate
  `upsertAccountWithFreshSyncState`/`upsertAccountResumeSync` into
  `upsertAccount(input, resetSyncState: boolean)`.

### What this deletes / collapses

- 2 encryption schemes → 1 path (+ registry).
- 2 × 73-line persisters → 1 `persistTokenAccount`.
- `identity.json` second source of truth → DB row.
- 782-line `AccountsRepository` → 3 focused repositories.

---

## 10. Cross-cutting concerns

- **Keep the app running.** Every phase is additive-then-subtractive: introduce the
  new seam delegating to old code, migrate consumers incrementally, delete the old
  path last. No "big bang" cutover.
- **Drift guards as tests.** Each consolidation that removes a duplicate adds a
  compile-time/`typecheck` guard so it can't silently re-fork (mirroring the
  existing `HOST_SURFACE` and snapshot-descriptor guards).
- **Published-SDK conformance.** `connector-sdk-conformance.test.ts` must stay green
  throughout — it is the guarantee that external connectors keep compiling.
- **IPC/bigint boundary.** All `bigint→string` crossings go through `toWire`/
  `fromWire`; a lint/grep check forbids raw `.toString()` on ids at IPC edges.
- **Testing.** Existing tests (345 files under `__tests__`) are the safety net;
  refactors keep public behavior, so most tests should pass unchanged. New seams get
  focused unit tests (`platform`, `PermissionGate`, the two state machines,
  `CredentialStore`).

## 11. Sequencing & shippability

| Phase | Delivers | Risk | Depends on |
|---|---|---|---|
| 1 Entities + Id codec + projections | The "types for all entities" foundation | Low (proven pattern) | — |
| 2 Platform object | The "singleton that gives access to the platform" | Low–Med | 1 |
| 3 ConnectorContext + Host + PermissionGate | One context surface | Med | 1, 2 |
| 4 ConnectorRunContext + state machines | Kills ~3,100-line duplication | Med | 1, 3 |
| 5 Credentials + Identity | One creds path, identity in DB | Med | 1, 2 |

Phases 1→2→3 are the spine; 4 and 5 can be reordered or interleaved after 3. Each
phase is a shippable PR series.

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Branded ids break call sites passing raw `bigint` | Optional brand (`[brand]?`) keeps `bigint` assignable; opt-in adoption |
| Touching the published SDK breaks external connectors | Public types stay in the SDK; conformance test gates every change |
| `Platform` becomes a god-object / hidden coupling | It's an *accessor* of already-existing singletons, typed and read-only-ish; no new logic lives on it |
| Generic state machines can't express a connector's quirks | Connectors keep full control of `loadPage`/`processItem`/cursor codec; engine only owns the loop |
| Large refactor stalls mid-flight | Additive-then-subtractive per phase; app ships working at every step |
| Identity DB migration loses `identity.json` data | One-time read-and-import migration with the JSON retained until verified |

## 13. Success criteria

- **0** duplicate entity definitions (guard test passes); `context/types.ts`
  duplicates deleted.
- `new XRepository(` outside the `repos()` factory: **~85 → ~0**.
- `whenReady` body: **362 → < ~60 lines**; no `() => T` service getters remain.
- One `ConnectorContext` interface; `ConnectorContextImpl` no longer referenced by
  the public `Connector` contract; one `PermissionGate`.
- Connector `backfill`+`delta` LOC reduced **≥40%**; one `ConnectorRunContext`.
- One credential encryption path + blob registry; identity served from the DB;
  `AccountsRepository` split into 3.
- `connector-sdk-conformance.test.ts` and the full suite green throughout.

## 14. Open questions

1. **Branding depth (Phase 1):** ship the *optional* brand now, or land just the
   `toWire`/`fromWire` codec and defer branding? (Recommendation: codec now, optional
   brand now, mandatory brand never — keep it frictionless.)
2. **Domain home (Phase 1):** keep public types in `@alpha-cent/connector-sdk`, or
   promote them to a dedicated `@alpha-cent/domain` package both SDKs import?
   (Recommendation: stay in `connector-sdk` to avoid a new package; revisit only if
   `extension-sdk` needs them without the connector surface.)
3. **RPC unification (Phase 3):** fold `HostRouter`/`RemoteConnectorRouter` into one
   `RpcRouter` now, or leave as a flagged stretch item? (Recommendation: defer.)
4. **Phase 4 vs 5 order:** which first after Phase 3? (Recommendation: 4 — it's the
   biggest clarity win and most-requested by "faster feature work.")
