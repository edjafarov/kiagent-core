# `concept/` — a types-only blueprint

This folder is **not part of the app.** It's a pure-types prototype of the
*target* shape of KIAgent's core — entities and the platform/context/SDK surface,
expressed as TypeScript `interface`/`type` declarations with no implementations.

- The application **never imports** it. Deleting the folder changes nothing.
- It is **inert**: `eslint-disable`d, valid under `strict`, not a `*.test.ts`, so
  it doesn't affect lint, tests, or runtime. (It *is* valid TS so it won't break
  `npm run typecheck`.)
- Its only purpose: judge one question — **"is this conceptually simpler than what
  we have today?"** — before touching a single line of real code.

👉 **Read [`model.ts`](./model.ts) top to bottom.** It's organized in six sections:
ids & wire codec → core entities → connector-facing surface → the Platform object
→ the (gated) extension Host → renderer projection.

> Field names are **preserved** from the current DB/SDK (snake_case for
> document/account/sync fields). We're deciding *where* types live and *how they
> connect*, not renaming fields — that keeps the eventual migration low-churn.

---

## The whole idea in three moves

1. **Every entity defined once.** Today one "connector" has 6 representations and
   one "account" has 3; ids are converted `bigint↔string` by hand everywhere.
   → one definition per entity + one `toWire`/`fromWire` codec.
2. **One `Platform` object** assembled at boot and passed by reference, so code
   *reads* its dependencies (`platform.repos()`, `platform.prefs`, `platform.state`)
   instead of having `db` / lazy getters / callbacks threaded through arguments.
3. **One context surface, gated for extensions.** The connector context and the
   extension `Host` stop being two parallel implementations of the same DB ops —
   the Host becomes `gate(platform, context, grants)`.

---

## Entity inventory (what `model.ts` defines)

| Entity | One-liner | Replaces today |
|---|---|---|
| `Id<T>` + `toWire`/`fromWire` | branded bigint id + the only sanctioned wire codec | ad-hoc `.toString()`/`BigInt()` at every boundary |
| `Account` | a connected source instance | `Account` + raw row + `SnapshotAccount` (3) |
| `SyncState` / `SyncStatus` | per-account progress + lifecycle status | type with no home, inside the 782-line accounts repo |
| `PendingDocument` / `Document` | the spine; every source normalizes into it | SDK copy + `context/types.ts` copy + `DocumentUpsert` |
| `TrackedRoot` | a tracked folder/drive | schema + repo + inline copy + renderer mirror |
| `Credentials` | decrypted OAuth tokens | 2 encryption schemes, duplicated persisters |
| `Identity` | the app owner | DB **and** `identity.json` (2 sources of truth) |
| `Manifest` / `ConnectorDescriptor` | one plugin-metadata schema + a pure-data view | `Connector`/`Module`/`Remote`/`ConnectorManifest`/`ExtensionManifest`/`Descriptor` (6) |
| `InferenceJob`, `Annotation`, `DocumentLanguage`, `DocumentEmbedding`, `CadenceConfig`, `LogRecord` | supporting entities | scattered / near-duplicate definitions |
| `Extension` / `PermissionGrant` | installed-extension lifecycle + granted-permission record | inline string arrays, no stored install/enable/grant entity |
| `DocumentOps<TId>` | the per-account doc+sync verbs, defined once, id-parameterized | the five verbs spelled on `ConnectorContextImpl` **and** re-spelled (renamed) on `Host.db` |
| `ConnectorContext` | `DocumentOps` + capability handles a connector reads | concrete `ConnectorContextImpl` leaked into `createInstance` |
| `ConnectorRunContext` | the one bag a backfill/delta run captures | `BackfillArgs` + `DeltaArgs` + `ImapRunDeps` (3) |
| `Platform` | the one singleton app code reads from | `whenReady` closure + module globals + lazy getters |
| `Host` + `gate()` + `PermissionGate` | extension surface as a gated platform projection | parallel `Host` impl + 3 scattered permission checks |
| `AppState` / `SnapshotAccount` / `projectAccount` | renderer aggregate, derived not hand-built | hand-built snapshot reshape |

---

## Before → after (the ergonomic payoff)

**A connector run** — stop threading a per-connector bag 4–6 layers deep:

```ts
// today — a different shape per connector, passed down every call
async function runBackfill(a: { ctx; converter; accountId; getAccessToken; signal; onProgress }) {
  const page = await gmailFetch(a.ctx, a.getAccessToken, ...);
  for (const t of page) await buildThread(a.ctx, a.converter, a.accountId, t); // a.* everywhere
}

// concept — build the run context ONCE, capture it
async startBackfill(run: ConnectorRunContext) {
  const page = await this.fetchPage(run);          // run carries ctx, token, signal, progress
  for (const t of page) await run.ctx.upsertDocument(this.buildThread(t));
}
```

**An IPC handler** — stop threading `db` + lazy getters + `publishState`:

```ts
// today
registerDataMaintenance({ db, getConverter, getPrefsStore, publishState });
//   inside: new DocumentsRepository(db) … getConverter()() … publishState()

// concept
registerDataMaintenance(platform);
//   inside: platform.repos.documents … platform.converter … platform.state.publish()
```

**The id boundary** — one codec instead of hand-conversion:

```ts
// today
return { id: account.id.toString(), status: row.status ?? 'pending', /* …by hand… */ };

// concept
return projectAccount(account, sync, counts);   // toWire happens once, inside
```

**The extension Host** — a gated projection, not a hand-mirrored twin:

```ts
// today: Host.db re-implements upsert/find/saveSyncState over a separate ConnectorContextImpl
// concept: Host.db IS DocumentOps<WireId> — the same verbs, re-parameterized + gated
const host = gate(platform, { extensionId: extId, accountId, grants });
```

---

## How to react to this

This is a thinking artifact — push on it:

- **Entities** (`model.ts` §2): missing anything? wrong field on `Account`/`Document`?
  any entity that should *not* be elevated (e.g. connector-private index tables)?
- **`ConnectorContext`** (§3): is this the right surface a connector should see —
  too much? too little?
- **`Platform`** (§4): right set of accessors? anything that should *not* live on
  one object?
- **Host/permissions** (§5): does `gate()` capture how you want extensions scoped?

Once the shape feels right, the migration story (how we get the real code here
without a rewrite, in shippable steps) is the separate spec at
`docs/superpowers/specs/2026-06-26-architecture-consolidation-design.md`.

---

## A more radical alternative: `pull-model.ts`

[`pull-model.ts`](./pull-model.ts) keeps §1/§2/§4/§6 of `model.ts` and replaces
§3+§5 with two bigger moves: **connectors become resumable read-only streams**
(`Source.pull` yields batches; ONE engine owns every write, cursor, retry,
progress tick and status transition — a source can't write platform state *by
construction*), and **permission checks become capabilities** (`gate()` returns
a host whose *shape* is the grant set; an ungranted namespace doesn't exist).
Its header carries the dissolve scorecard and the honest costs. Judge them side
by side.

---

## The no-legacy thought experiment: `greenfield.ts`

[`greenfield.ts`](./greenfield.ts) answers "what if we could rebuild from
scratch?" — standalone, importing nothing. Its one idea: **the app is a log**;
Source (world→documents), Worker (a job per change — analyze into the plugin's
own database, or act on the world), and Projection (feed→renderer state) are
all the same concept — a resumable consumer with a durable cursor — advanced
by one Engine through one transactional write primitive. One string id type (UUIDv7) deletes the entire wire codec.
It is **not** a rewrite proposal: its header tags every win `[IMPORTABLE]`
(adoptable in-place — the feed, Deriver, Projection) or `[GREENFIELD-ONLY]`
(string ids, camelCase/parsed fields) so it can serve as the north star for
the in-place migration rather than an alternative to it.

It also spells out the platform's **infrastructure planes** plugins build on:
inference (one queue, two lanes — real-time vs. idle/night — with pluggable
local/LAN/cloud providers), the store plus a private per-extension SQL
database, scoped filesystem access, net, the scheduler, and an MCP surface
that extensions extend with tools.
