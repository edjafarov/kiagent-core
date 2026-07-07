# Extension Marketplace + Runtime Design (v1)

**Date:** 2026-07-03 · **Branch:** `greenfield` · **Status:** approved design, pre-implementation

**Goal:** Make the marketplace work end-to-end: browse the `kia-plugins` catalog, install an
extension with consent, and have it actually run — contributing Sources the engine syncs like any
built-in. Closes `docs/rebuild/LEFTOVERS.md` #1 (extension platform runtime) and part of #16's
UI debt (the inert Marketplace screen).

**Architecture:** Out-of-process extension host — one Electron `utilityProcess` per enabled
extension, driven over a typed RPC protocol. All capability enforcement lives in the main
process (`HostRouter` = the runtime `gate()` from `concept/model.ts` §5). Sources contributed
by extensions are registered into the existing `SourceRegistry` as main-side proxies, so the
engine, scheduler, connect flow, and progress UI work unchanged. The marketplace backend is a
close port of the legacy GitHub-org catalog + 3-phase tarball installer, re-targeted at the
greenfield manifest.

**Tech stack:** Electron `utilityProcess` (structured-clone MessagePort RPC), zod (manifest
validation), `tar` (staged extract), existing `better-sqlite3` store (consents table already
shipped), GitHub REST (catalog), esbuild (extension bundles, in the extension repo).

## Decisions (user-approved 2026-07-03)

1. **Full end-to-end** — runtime + marketplace, not either alone.
2. **New contract only** — the host loads only greenfield-format extensions
   (`ExtensionModule`/`Source` from `src/shared/contracts.ts`). Legacy hostApi-2.x tarballs are
   rejected at manifest validation with a clear error. No compat adapter.
3. **Notion is the proof extension** — `kia-plugins/notion-kia-connector` gets rewritten
   against the new contract and published as a v2 release.
4. **Publish to `kia-plugins`** — real releases via `gh` CLI (user owns the org).
5. **Trimmed v1 UI** — two-pane browse, search, All/Official/Installed filters, README +
   permissions detail, install/update/uninstall/enable with consent modal, update badge.
   Dropped: user-added repos, version dropdown (always latest non-prerelease),
   Changelog/Versions tabs, silent subset updates (updates always re-show consent).
6. **Host model A: `utilityProcess`** — not a legacy `child_process.fork` port, not in-process.

## 1. Current state

**Greenfield already ships** (do not redesign):
- The full typed contract: `Cap` (8 caps), `Manifest`, `ExtensionModule<G>`,
  `HostFor<G>`/`CapSurfaces` (caps map 1:1 to host namespaces), `ConsentRecord`, `Source`,
  `McpTool`, `PrivateDb`, `ScopedFiles` — `src/shared/contracts.ts` §7.
- Consent persistence: `consents` table + `store.consents.{latest,record}`
  (`src/main/core/store/store.ts:816`), append-only, latest wins. **No consumer yet.**
- The engine/SourceRegistry pipeline every Source plugs into (`src/main/core/boot.ts`,
  `engine.ts`): engine owns pull loops, credential refresh, commits, progress; the engine's
  `connect()` wraps `AuthChannel` and vaults `prompt` answers' `password` field
  (`engine.ts:308-344`).
- Typed IPC idiom (`src/shared/ipc.ts`: `Invokes`/`Pushes` + channel arrays + generic preload
  bridge) and the one `push:app-state` projection.
- A second main-process webpack entry precedent (`mcpStdio.js`) and live MCP tool registration
  with disposers (`handle.registerTool`, `src/main/core/mcp/server.ts`).
- The inert Marketplace screen + reusable CSS (`src/renderer/screens/Marketplace/`).
- `src/main/platform/extension-host-entry.ts` — an `export {}` stub to be replaced.

**Legacy (branch `main`) provides the ported designs:** GitHub org catalog
(`org:kia-plugins topic:kia-plugin`, `.tgz` release assets, 5-min ETag cache, stale-on-error),
3-phase installer (preview → consent → commit; TOFU integrity pins; staged `tar strip:1`
extract; entry containment), fork-per-extension supervision (crash-loop breaker), install-time
all-or-nothing consent. Its RPC protocol and 38-method host surface are **not** ported — the
greenfield surface is far smaller and cap-shaped.

**Catalog reality:** the org has 4 repos (notion, whatsapp, instagram, slack), all
legacy-format. After this work, Notion is republished new-format; the other three show in the
catalog but fail preview with the "built for the legacy app" error until republished.

## 2. Component map

New files, main process unless noted:

| File | Responsibility |
|---|---|
| `src/shared/extension-rpc.ts` | wire message types + `PLATFORM_API_VERSION` (shared main/child; contracts.ts stays runtime-free) |
| `src/main/platform/manifest.ts` | zod schema + `validateManifest()` |
| `src/main/platform/extensions.ts` | `ExtensionRegistry`: discovery, installed records, enabled state, status machine, AppState snapshot |
| `src/main/platform/host-process.ts` | per-extension process supervisor over a `HostTransport` |
| `src/main/platform/transport.ts` | `HostTransport` interface + `utilityProcess` impl + `child_process.fork` impl (tests) |
| `src/main/platform/host-router.ts` | **gate()**: cap enforcement + dispatch to real capability surfaces |
| `src/main/platform/source-proxy.ts` | main-side `Source` proxy over RPC |
| `src/main/platform/extension-host-entry.ts` | child entry (replaces stub; new webpack entry `extensionHost`) |
| `src/main/marketplace/github-source.ts` | org search, releases, README (port) |
| `src/main/marketplace/github-cache.ts` | TTL+ETag+stale-on-error cache (port) |
| `src/main/marketplace/installer.ts` | preview/commit/uninstall/update, refs, TOFU |
| `src/main/marketplace/ipc.ts` | the 7 IPC handlers |
| `src/renderer/screens/Marketplace/` | functional screen (replaces inert chrome, reuses CSS) |
| `src/renderer/components/ConsentModal.tsx` | cap consent dialog |

## 3. Runtime

### 3.1 Manifest

`Manifest` in `contracts.ts` gains one field: `entry: string` — the relative path to the CJS
bundle, containment-checked (must resolve inside the extension dir). Everything else is the
shipped shape: `{ id, name, version, engine, contributes, caps, entry }`.

- **Ids** are branded `ExtensionId` strings with dotted `publisher.name` values
  (`kia.notion`), regex `^[a-z0-9-]+\.[a-z0-9-]+$`. The `Id<'extension'>` brand is nominal
  typing, not a UUID validator; the consents table stores TEXT and doesn't care.
- **`engine`** is a semver range checked against `PLATFORM_API_VERSION = '1.0.0'`
  (exported from `src/shared/extension-rpc.ts`; contracts.ts stays type-only).
- **Unknown `caps` are rejected** at validation (legacy silently dropped unknown permission
  strings, which hid typos).
- **Version** must be valid semver (drives update comparison).
- **Legacy cross-rejection:** a legacy manifest (has `hostApi`/`permissions`, lacks
  `engine`/`caps`) fails this schema → error `"This extension was built for the legacy app
  and is not compatible with this build."` The legacy app's schema requires `hostApi`, so it
  symmetrically rejects new-format tarballs.
- Validation happens at install preview AND at every boot discovery (a manifest that stops
  validating parks the extension in `errored`).

### 3.2 Disk layout

```
userData/extensions/
├── installed.json     # InstalledRecord[] — installer-owned, frozen per install
├── state.json         # { [id]: { enabled: boolean } } — mutable, mode 0o600
├── github-cache.json  # marketplace catalog cache
└── <id>/              # e.g. kia.notion/
    ├── manifest.json
    ├── dist/index.js  # (whatever manifest.entry names)
    └── data/          # extension-private dir (self.dataDir) — preserved across updates
```

`InstalledRecord = { id, version, ref, integrity?, installedAt, origin: 'marketplace' | 'dev' }`.
`integrity` is the SRI `sha512-…` TOFU pin; absent for `origin: 'dev'` (local-path installs).
Enabled-state lives ONLY in `state.json` (legacy learned this: the installer record is frozen
history, mutable state was migrated out).

### 3.3 States & lifecycle

Per-extension status machine (in-memory, projected to renderer via AppState):

```
disabled → enabled → activating → activated
                   ↘ needs-consent          (manifest caps ⊄ latest consent)
         any state → errored                 (validation/activation/crash-loop)
```

Boot (in `main.ts`, after store + SourceRegistry + MCP handle + OAuth broker are up):
discover `userData/extensions/*/manifest.json` (validation only — **no extension code runs in
the main process, ever**) → for each enabled extension, check `consents.latest(id)` covers
`manifest.caps` → fork its host process → `bootstrap` → child `require()`s the entry, calls
`ExtensionModule.activate(remoteHost)` → child replies `activated` with **serializable
contribution descriptors** → main registers proxies (sources into `SourceRegistry`, tools into
the MCP handle) → status `activated`.

Deactivation (disable/uninstall/update/shutdown): unregister proxies → send `deactivate`
(child runs the module's `deactivate?()`, then exits) → kill after 2 s if still alive.

Crash: reject all in-flight RPC, unregister proxies, restart. Crash-loop breaker: 3 crashes in
60 s → status `errored` with the last error message. (Legacy's idle-parking is deferred — a
memory optimization, not correctness.)

### 3.4 Consent

- Install/update preview returns `manifest.caps` → renderer `ConsentModal` → confirm →
  `install-commit` records `store.consents.record({ extensionId, caps, manifestVersion:
  version, grantedAt })` and then activates. Grants are all-or-nothing per manifest.
- Host construction reads `consents.latest(id)`; `manifest.caps ⊄ consented caps` (e.g. dev
  dir edited, or record missing) → `needs-consent`; the Marketplace detail pane shows a
  "Review permissions" action that opens the same ConsentModal from the on-disk manifest and
  records a fresh consent, then activates.
- Updates ALWAYS re-show consent (trimmed v1 — no silent subset path).
- Uninstall does not delete consent rows (append-only audit trail by design).

### 3.5 Host process + transport

`HostTransport` abstracts the process so the RPC/supervision logic is testable under jest
(where `utilityProcess` does not exist):

```ts
interface HostTransport {
  send(msg: MainToChild): void;
  onMessage(cb: (msg: ChildToMain) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
  kill(): void; // SIGTERM-equivalent; supervisor escalates after 2s
}
```

- **Prod:** `utilityProcess.fork(<built extensionHost.js>, [], { serviceName: id })` —
  messages via `child.postMessage`/`child.on('message')` (structured clone; `Uint8Array`
  crosses without encoding).
- **Tests:** `child_process.fork(<same bundle>, { serialization: 'advanced' })`.
- The child entry detects its side: `process.parentPort` (utilityProcess) vs `process.send`
  (node fork), behind the same 20-line adapter.
- Webpack: add an `extensionHost` entry beside `mcpStdio` in the main-process config; resolve
  the built path at runtime the same way the MCP stdio entry is resolved for client configs.
- Child hardening (ported from legacy): `uncaughtException`/`unhandledRejection` → send
  `errored` + exit(1); `deactivate` acked by exiting; console rerouted to stderr logging.

### 3.6 RPC protocol (`src/shared/extension-rpc.ts`)

Symmetric `call`/`reply` envelopes — host calls originate child→main; source/tool invocations
originate main→child. All messages are a discriminated union on `kind`:

```ts
// Main → Child
| { kind: 'bootstrap'; v: 1; extensionId; entryAbsPath; dataDir; caps: Cap[] }
| { kind: 'call'; id: number; ns: 'source' | 'tool'; method: string; args: unknown[] }
| { kind: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
| { kind: 'event'; name: string; payload: unknown }      // host.events delivery
| { kind: 'src-next'; pullId: number }                    // demand one more batch
| { kind: 'src-abort'; pullId: number }                   // session.signal fired
| { kind: 'deactivate' }

// Child → Main
| { kind: 'ready' }                                       // after require(), before activate
| { kind: 'activated'; contributions: {
      sources: Array<{ descriptor: SourceDescriptor; hasFetchBytes: boolean; hasReconcile: boolean }>;
      tools: Array<{ name; description; inputSchema; tier? }>;
    } }
| { kind: 'errored'; error: string }
| { kind: 'call'; id: number; ns: Cap | 'base' | 'auth' | 'session';
    method: string; args: unknown[] }                     // host surface + callbacks
| { kind: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
| { kind: 'src-batch'; pullId: number; batch: WireBatch } // one per src-next
| { kind: 'src-done'; pullId: number }
| { kind: 'src-error'; pullId: number; error: string }
```

`WireBatch = { phase, items: DocumentInput[], deletions?, cursor, estimateTotal? }` — see §3.8.

### 3.7 gate(): HostRouter + capability surfaces

The child's `RemoteHost` is shape-only sugar; **enforcement is main-side**. `HostRouter` holds
the extension's granted `Set<Cap>` (from the consent record, which equals manifest caps) and a
1:1 namespace→cap map — greenfield's design makes legacy's per-method permission table
unnecessary:

`query→'query', net→'net', files→'files', db→'db', ui→'ui', commands→'commands',
inference→'inference', events→'events'`; `base` (self/log) and the `auth`/`session` callback
namespaces are ungated (they only function while main has a matching in-flight connect/pull).

Denied call → error reply `CAP_DENIED` + `logs` entry `extension.permission-violation`.

Main-side surface implementations (v1):

| Cap | Implementation |
|---|---|
| `query` | `store.read` (the same `Query` the MCP tools use) |
| `net` | main-side `fetch`; request `{url, init}` with string/bytes body; response `{status, headers, body: Uint8Array}` |
| `db` | per-extension SQLite file `<dataDir>/private.db` opened main-side; `exec`/`query` |
| `ui` | `notify` → existing renderer notification path |
| `inference` | the existing `Inference` plane, `'interactive'` lane |
| `events` | small main-side bus: extensions `on`/`emit`; platform emits `extension.activated`/`extension.deactivated` |
| `files` | **declared-but-rejected**: calls fail `"files cap is not supported in this build yet"` (folder-grant UI is its own design) |
| `commands` | **declared-but-rejected**, same pattern (no command palette exists yet) |

Sandbox honesty (concept/gaps.md #22) carries over unchanged: caps are a **cooperative
contract + audit surface**, not OS containment — the child process can `require('fs')`. The
consent dialog is honest about this framing; the real hard gates are install-time (integrity,
containment, validation) and main-side (every host call checked, store writes impossible —
there is no `db.write` cap by design).

### 3.8 Source proxying

For each contributed `SourceDescriptor`, main registers a proxy `Source`:

- **`toDocument` runs child-side.** The child-side runner drains the real source's batches,
  maps every item through the source's own pure `toDocument`, and ships
  `items: DocumentInput[]`; the proxy's `toDocument` is identity. One wire crossing per batch,
  never per item; the generic `Item` type never crosses.
- **`pull` is demand-driven:** the proxy's `AsyncIterable` sends `src-next`, the child
  advances the real iterator ONCE, replies `src-batch` (or `src-done`/`src-error`). Engine
  backpressure for free. `session.signal` abort → `src-abort` → child calls its local
  controller's abort. `session.credentials()`/`session.log()` → child→main `session` calls
  keyed by `pullId`.
- **`connect(auth)`** → main sends a `source.connect` call; the child runs the real
  `connect` with a proxy `AuthChannel` whose 4 verbs (`oauth`/`prompt`/`showQr`/`status`)
  RPC back to main and land on the engine-wrapped channel — so credential capture
  (`engine.ts:318`, vaulting `answers.password`) and the existing connect-flow UI work
  unchanged. Returns `{identifier, config}` (serializable by contract).
- **`fetchBytes`/`reconcile`** — plain call (Uint8Array reply) and the same credit-stream
  pattern respectively; only attached to the proxy when the child declares the real source
  has them.

**Registry integration:** `SourceRegistry` (boot.ts) gains `unregister(id)`. Deactivation
unregisters the extension's sources and stops their scheduler jobs; `engine.run` on an account
whose source is missing logs `"no source registered for account <id>"` and sets the account's
sync status to `error`, instead of throwing (the engine itself is untouched — this is the
existing "no source registered" error-level log path, not a distinct "extension disabled or removed"
message). Extension sources appear in the Add-source UI automatically (it's driven by
`sources:list` descriptors). Preview rejects manifests whose contributed source ids collide
with registered ones.

### 3.9 Tool proxying

Contributed tools register through the existing live `handle.registerTool` (already supports
add/dispose while clients are connected). The proxy's `call` RPCs main→child (`ns:'tool'`);
`tier: 'powerful'` tools are registered but the MCP registry's existing tier note applies
(future in-app gate) — v1 does not add per-tool consent.

## 4. Marketplace

### 4.1 Catalog (`github-source.ts` + `github-cache.ts`, ported)

- Official list: `GET /search/repositories?q=org:kia-plugins+topic:kia-plugin&per_page=100`;
  detail: repo releases (`per_page=30`) + raw README (`HEAD/README.md`, best-effort).
  Constants live in one config object (greenfield has no brand.ts).
- Installable release = latest **non-prerelease** release with a `.tgz` asset; no version
  picker in v1.
- Cache: 5-min TTL, ETag conditional GETs, 429/rate-limit → stale-if-available, fetch error →
  stale fallback; README uncached. Persisted at `userData/extensions/github-cache.json`.
- `checkUpdates()`: for installed records with `github:` refs, strip the pinned tag, resolve
  latest release, report `{ id, installedVersion, latestVersion, ref }` when newer.

### 4.2 Installer (`installer.ts`)

Ref forms accepted by `preview(ref)`:
- `github:owner/repo[@tag]` → release `.tgz` asset URL (integrity: TOFU pin on first install).
- `https://…` → direct tarball URL (TOFU likewise).
- **Local path** (absolute dir or `.tgz`) → `origin: 'dev'`, no integrity pin. This is the
  dev loop: iterating on an extension uses the exact same preview → consent → commit pipeline,
  no GitHub release needed.

`preview`: fetch/copy → SRI check (same-version reinstall must match the pin; tampered bytes
rejected) → staged extract to scratch (`tar.x({ strip: 1 })` — rejects path traversal) →
`validateManifest` (schema, engine range, entry containment, source-id collision, id
collision) → stage `Pending` under a random token (map capped at 8, oldest evicted) → return
`{ token, manifest, caps, version, sizeBytes, integrity }`. **No extension code executes.**

`commit({ token })`: move staging → `userData/extensions/<id>` (rename, EXDEV fallback),
write `InstalledRecord`, record consent, hot-activate. Update path: deactivate → replace dir
**preserving `data/`** → commit → re-activate.

`uninstall(id)`: refuse while `store.read.accounts()` still has accounts on the extension's
source ids (`"Remove this connector's sources before uninstalling it."`) → deactivate + kill →
remove dir + record + state entry. Consent history remains.

### 4.3 IPC (added to `src/shared/ipc.ts` `Invokes` + channel array)

| Channel | req → res |
|---|---|
| `marketplace:list` | `void` → `MarketplaceListItem[]` |
| `marketplace:detail` | `{owner, repo}` → `PluginDetail` |
| `marketplace:check-updates` | `void` → `UpdateInfo[]` |
| `extension:install-preview` | `{ref}` → `PreviewResult` (or `{error}`) |
| `extension:install-commit` | `{token}` → `{ok, id?} \| {ok: false, error}` |
| `extension:uninstall` | `{id}` → `{ok, error?}` |
| `extension:set-enabled` | `{id, enabled}` → `{ok, error?}` |
| `extension:grant-consent` | `{id}` → `{ok, error?}` (records consent for the on-disk manifest's caps, then re-activates if enabled — the §3.4 `needs-consent` recovery path) |

One family — legacy's duplicate `connector:*` aliases are not ported.

```ts
interface MarketplaceListItem {
  owner: string; repo: string; fullName: string;
  displayName: string; description: string;
  installedId?: string;          // matched via installed.json ref prefix github:owner/repo
}
interface PluginDetail {
  listing: MarketplaceListItem;
  readmeMarkdown: string;
  latest: { tag: string; version: string; publishedAt: string;
            tarballUrl: string | null; prerelease: boolean } | null;
}
```

Installed state, enablement, and the live status machine ride `push:app-state`: `AppState`
gains `extensions: ExtensionSnapshot[]` where
`ExtensionSnapshot = { id, name, version, origin, enabled, status, error?, caps, sourceIds,
ref? }`. The renderer never polls an invoke for installed state.

## 5. Renderer

**Marketplace screen** (replace the inert internals, keep the CSS/layout): left pane = search
(client-side name filter), three pills **All / Official store / Installed** (legacy's fourth
"Added by you" pill is dropped — dev installs surface through the Installed filter), rows with
Installed / Update / Disabled badges (update badge from `marketplace:check-updates`, fetched
once per screen mount); right pane per selection = README (markdown-rendered), the extension's
caps as human rows for installed extensions (from `ExtensionSnapshot.caps`), and the primary
action block: **Install** / **Update** / disabled **Installed** + Enable-Disable toggle +
**Uninstall** / disabled **"No installable release yet"** when `latest?.tarballUrl` is null /
**"Review permissions"** when `needs-consent` / error notice when `errored`.

**ConsentModal** (new component, both install and re-consent paths): identifier, version,
size, integrity (SRI, truncated), source ref, and one row per requested cap with icon, label,
description, risk tag. Cap catalog (the renderer-side registry, keyed by `Cap`):

| Cap | Label | Risk |
|---|---|---|
| `query` | Read your indexed documents | **elevated** |
| `net` | Access the internet | normal |
| `files` | Access approved folders *(not yet supported)* | normal |
| `db` | Keep its own private database | normal |
| `ui` | Show notifications | normal |
| `commands` | Register commands *(not yet supported)* | normal |
| `inference` | Use your AI models | normal |
| `events` | React to platform events | normal |

`query` is elevated because it reads the entire corpus; paired with `net` the modal is the
user's exfiltration-awareness moment — the description text says so plainly.

Markdown rendering: `react-markdown@^9.1.0` is already in `package.json` (currently unused in
the renderer) — use it for the README pane.

## 6. The Notion extension (repo `kia-plugins/notion-kia-connector`, v2)

- `manifest.json`: `{ "id": "kia.notion", "name": "Notion", "version": "2.0.0",
  "engine": "^1.0.0", "entry": "dist/index.js", "caps": ["net"],
  "contributes": { "sources": ["notion"] } }`
- `src/index.ts`: `export default { async activate(host) { return { sources:
  [createNotionSource(host)] }; } } satisfies ExtensionModule<'net'>` (dual
  `export default` + `module.exports` for the CJS `require()`).
- Source: descriptor `{ id: 'notion', name: 'Notion', documentTypes: ['notion.page'],
  auth: 'password', cadence: { every: '30m' } }`.
  - `connect(auth)`: `auth.prompt` with one field keyed **`password`** (`format: 'password'`,
    title "Internal Integration Secret") so the engine's existing capture path vaults it;
    validates via `host.net.fetch` against `GET /v1/users/me`; identifier = workspace/bot name.
  - `pull`: `POST /v1/search` with cursor `{ lastEditedTime, nextCursor?, phase?,
    dbListCursor?, dbQueue?, dbCursor? }`. Backfill (null `lastEditedTime`, a resumable
    `nextCursor`, or any `phase`) runs three resumable phases, each yielding one batch
    per Notion page with a crash-safe cursor: (1) pages via **ascending** search;
    (2) database discovery (`filter: database`); (3) a per-database **row sweep** via
    `POST /v1/databases/{id}/query` — v1's belt-and-suspenders, restored in v2.1.0
    (v2.0.x backfilled from search alone, and Notion's search index misses database
    rows, so database-heavy workspaces silently lost most documents). Rows already
    ingested in the same run aren't re-fetched; an unreadable page or broken database
    is warned and skipped (401 propagates). Once caught up, delta runs a **descending**
    scan that breaks at the floor (`lastEditedTime` − 60 s overlap) and ingests matched
    pages oldest-first in slices of 20, so the committed cursor only ever covers
    fully-ingested pages (v1's proven shape). A window containing only skipped items
    (trash/archive/database rows, no real page edits) yields one empty `live` batch
    pinning the scan ceiling, so the floor still advances — v1 parity; the v2.0.0
    release lacked this and re-scanned a widening window (fixed in v2.0.1). Fetches page
    blocks and flattens to markdown; respects Notion's ~3 rps limit with a simple
    inter-request delay; `phase: 'backfill'` until caught up, then `'live'` re-polls on
    cadence. Note: `reconcile` runs once per engine pull cycle — every 30 min at this
    cadence, vs v1's self-gated 24 h — a deliberate platform-owned-cadence trade
    (metadata-only listing, 3 rps-throttled). Since v2.1.0 its live-set also lists every
    database's rows (else the diff would archive swept-only rows); a database failure
    there propagates so the engine skips the diff on a partial listing.
  - Pure `toDocument(page)` → `DocumentInput` (markdown body, title, createdAt =
    last_edited_time, externalId = page id).
- Types via a vendored snapshot of `contracts.ts` (`src/kiagent-contracts.ts`) — per
  LEFTOVERS #15 the contract IS the SDK; npm SDK republication stays deferred.
- Build: esbuild → single CJS `dist/index.js`; pack `manifest.json + dist + README` as `.tgz`;
  publish GitHub release `v2.0.0` with the `.tgz` asset via `gh`; repo topic `kia-plugin`
  already set. Mutual format rejection with the legacy app is automatic (schema mismatch both
  directions).

### 6.1 The other three connectors (shipped 2026-07-04, same pattern)

`slack-kia-connector` v2.0.0, `instagram-kia-connector` v2.0.0,
`whatsapp-kia-connector` v2.0.0 — each repo replicates the Notion template
(vendored contracts, esbuild CJS bundle, v2 manifest, offline jest suite,
released `.tgz`). Design deltas the ports introduced:

- **No read-modify-write.** v1 connectors merged into stored docs via
  `findBySourceId`; v2 upserts replace whole documents by externalId. Slack
  re-renders complete days (delta clamps history `oldest` down to the local
  day start of `latest_ts − 24h`; catch-up windows >7 days route through the
  page-aligned backfill walker). Instagram and WhatsApp — whose upstreams
  can't re-supply history (Graph returns ~20 msgs/thread; Baileys re-delivery
  isn't guaranteed) — carry the `query` cap and union new messages with the
  stored doc's `metadata.messages` ledger via `query.byExternalId` in pull().
- **Binary ingest.** Slack files / IG media / WA media are emitted as `file`
  documents with `DocumentInput.binary` + `markdown: null` (engine converts;
  null-markdown deep-extraction enrollment is implicit). Parent edges replace
  v1's `doc://` markdown links.
- **Pairing auth.** WhatsApp `connect()` drives QR pairing through
  `auth.showQr` (wizard renders scannable QR); `pull()` owns one long-lived
  Baileys socket and never returns while healthy — history-sync batches are
  `backfill` phase, `messages.upsert` batches are `live`.
- **Auth-error convention** (all four): typed auth errors propagate,
  message ends "— reconnect the account"; no client-level retry of 401/190.

Platform follow-ups the ports surfaced (tracked in the ledger): the extension
host lacks a safeStorage/vault surface, so WhatsApp's Baileys creds blob is
plaintext (0600) in its dataDir (injectable codec seam ready); the engine has
no `needsReauth` flip yet; host `net.fetch` has no platform retry/backoff —
connector retry loops are load-bearing.

### 6.2 Extension OAuth + the Google Docs connector (shipped 2026-07-05)

`AuthChannel.oauth(scopes)` was RPC-plumbed for extension sources but
dead-ended in the connect broker ("no OAuth profile registered"). Enabler
(commits fb0c444 + 0766862): `contributes.sources` entries may now be
`string | { id, oauth: 'google' }`; `registerContributions` registers the
bundled Google OAuth profile + refresher under the extension's source id
(same broker/refreshers instances the engine uses; unregistered on every
removal path — deactivate, uninstall, crash, upgrade). The binding is
disclosed at install consent, re-review, and Marketplace detail ("Signs in
with your Google account (<source ids>)") because the extension chooses its
scopes at connect time under the platform's Google client identity —
`Credentials` still records no granted-scope set (follow-up if more
providers land). `sourceContributions()` in `platform/manifest.ts` is the
single normalization helper for the union.

`google-docs-kia-connector` v2.0.0 (repo is NEW — v1 lived inside
alpha-cent, not a standalone repo): `kia.google-docs`, caps [net, query],
source id `google-docs`, `auth: 'oauth'` (drive.readonly), optional
folder-scoping prompt at connect (blank = My Drive). Design deltas from v1:
native Docs export straight to `text/markdown` (v1 exported HTML through the
host converter); convertible binaries ≤ 25 MiB ride `DocumentInput.binary`
(engine extracts; metadata carries both v1 keys and the engine's
`mime`/`filename`/`sizeBytes` aliases for classify/vision); cursor is
`{ page_token, backfill_done }` — interrupted backfill re-walks idempotently
(revision/md5 hash-skip via `query.byExternalId` makes re-walks cheap, and
refuses to skip rows whose extraction previously failed); delta commits
cursors page-aligned per `changes.list` page; invalid page token yields a
recovery cursor that re-enters backfill instead of v1's `runFullRescan`
(which could delete OTHER accounts' docs — bug fixed structurally);
`reconcile()` is the full BFS listing and throws on any partial failure.
Deliberate drops: tracked-roots picker UI (one prompt instead), multi-root,
Shared Drives, Sheets/Slides export (all v1-parity or v1-deferred).

### 6.3 Connect-time folder picker (`pickFolders`, shipped 2026-07-05)

The two §6.2 drops that hurt most in practice — the paste-a-folder-URL prompt
and single-root tracking — were reversed one release later (core
`32163bf..177959b`, connector v2.1.0). `AuthChannel` gained one verb:

```ts
pickFolders(spec: FolderPickerSpec): Promise<FolderNode[]>
// spec = { modes: {key,label}[], multiSelect?, roots(mode), children(id), count?(id) }
```

A source hands the platform lazy tree callbacks; the renderer shows the SAME
`FolderPickerModal` the local-folder source uses (lazy tree, covering-root
multi-select with chips, per-row `counting… / N files / N+ files`), now
parameterized over an injected `dataSource` (default = the local-FS IPC, so
the three pre-existing callers are untouched). The broker mirrors the
`prompt()` pending-request mechanism with a `folder-picker` ConnectEvent and
five `accounts:picker-*` channels; cancel rejects with
`'folder selection cancelled'` and surfaces as the normal connect error.
For extension sources the spec's callbacks stay in the child: main services
the picker's lazy loads by calling BACK into the suspended child
(`endpoint.call('source','picker-roots'|'picker-children'|'picker-count')`)
— the symmetric RPC transport supports main→child calls while `connect()`
awaits a child→main auth call, no protocol change needed. Synthetic renderer
paths (`'/'`-joined node ids) are percent-encoded injectively (`%`→`%25`,
`\`→`%5C`; empty ids skipped) so contract-legal exotic ids cannot corrupt
covering-root selection (review finding I1).

The google-docs connector (v2.1.0) drives it with My Drive + Shared-with-me
tabs and a budgeted recursive count (BFS over `files.list`, 20 pages / 50k
files, `capped` → "N+"; errors resolve `null`, never fail the flow), and now
tracks multiple roots: `config.roots: {rootFolderId, rootName}[]` (legacy
v2.0.0 `rootFolderId` normalized transparently), backfill/reconcile seed one
shared walked set across roots (overlap ingested once), delta's ancestor
walk matches against the root-id set with the `'root'` alias resolved once.
Still dropped: Shared Drives, Sheets/Slides export; local-folder still uses
its `folder-paths` prompt special-case (unifying it onto `pickFolders` is a
recorded follow-up).

## 7. Error handling

| Failure | Behavior |
|---|---|
| preview: network/integrity/schema/engine-range/containment | typed error string → inline notice in the install UI; nothing staged |
| activation throw / child crash | status `errored` + message in AppState → Marketplace detail + Logs screen; crash-loop breaker (3/60 s) |
| cap denial | `CAP_DENIED` error to the extension + `permission-violation` log entry |
| catalog fetch failure / rate limit | stale cache if present, else error notice in the list pane (screen stays alive) |
| uninstall with live accounts | refused with the "remove sources first" message |
| pull error in child | `src-error` → engine's existing per-account error/retry path (same as built-in source throw) |
| child unresponsive at deactivate | killed after 2 s |

## 8. Testing

- **Unit (main):** manifest schema (valid, unknown-cap rejection, legacy-format rejection,
  entry containment); installer (TOFU first-pin + tamper rejection, traversal rejection,
  collision rejection, dev-path refs, pending-token eviction); github-source/cache (TTL, ETag
  304, rate-limit → stale, stale-on-error) with injected fetch; HostRouter (each cap granted
  vs denied, unknown ns, violation logging); source-proxy pull semantics (demand-driven
  ordering, abort, credentials round-trip, error propagation) over an in-memory transport pair.
- **Integration (jest, node-fork transport):** a fixture extension (tiny in-repo tarball)
  goes preview → consent → commit → activate in a REAL child process → contributes a source →
  engine drives a pull end-to-end into a temp store → disable kills the process → uninstall
  removes the dir. Crash-loop: fixture that exits(1) on activate trips the breaker.
- **Renderer:** Marketplace list/filter/badges from mocked bridge; install flow opens
  ConsentModal and commits on confirm; needs-consent shows Review permissions; ConsentModal
  renders the cap catalog (elevated styling for `query`).
- **Notion repo:** `toDocument` + cursor logic unit-tested against recorded API fixtures.
- **Manual e2e:** install Notion from the real org, paste a real integration token, watch a
  workspace sync; MCP client sees the documents.

## 9. Phasing — one spec, two implementation plans

1. **Plan A — runtime:** contracts `entry` field, extension-rpc, manifest, registry/state,
   transport + host process + child entry, HostRouter + surfaces, source/tool proxies,
   consent enforcement, boot activation, installer with **local-path refs only**, minimal
   `extension:*` IPC (`install-preview`/`install-commit`/`set-enabled`/`uninstall`), AppState
   extensions projection. No new UI in this plan: consent is recorded by the
   `install-commit` handler; the flow is exercised by the integration tests and, manually,
   by driving `window.kiagent.invoke('extension:install-preview', …)` from devtools.
   **Deliverable:** a fixture extension installs from a local tarball, activates, and
   contributes a source the engine syncs; its account appears in the normal Sources UI.
2. **Plan B — marketplace + Notion:** github-source + cache + check-updates, `github:` refs in
   the installer, `marketplace:*` IPC, the functional Marketplace screen + ConsentModal (the
   consent UI gate in front of preview→commit, including the `needs-consent` re-consent path),
   the Notion v2 port + publish to `kia-plugins`. **Deliverable:** browse the real org in-app,
   install Notion with consent, connect a workspace, sync it.

## 10. Out of scope (deferred, tracked)

- `workers`/`providers` contributions (feed-consumer and provider proxying are their own
  designs); `files` and `commands` cap surfaces (declared-but-rejected in v1).
- WhatsApp/instagram/slack ports; bundled-extension seeding (`assets/bundled-*` — returns
  with the WhatsApp port).
- User-added repos, version dropdown, Changelog/Versions tabs, silent subset updates,
  idle-parking, per-tool `powerful` consent, npm SDK packages, extension secrets in keychain
  (gaps #21), OS-level sandboxing (gaps #22 stance unchanged).
- On completion: update `docs/rebuild/LEFTOVERS.md` #1/#16 and `concept/gaps.md` #20 notes.
