# Plugin authoring guide

How to build, test and ship a third-party plugin for KIAgent: data-source
connectors, MCP tools, and optional outbound senders.

For agents: start here, then read the SDK README and the actual contracts
linked below. Dated specs/plans describe historical or proposed work; they
are not a replacement for the shipped runtime.

Reviewed against core **v0.138.0** (`83f18005`) on **2026-11-28**. Platform
API: **2.21.0**. SDK package source: **1.14.0**. These are independent
versions: a manifest's `engine` range is checked against the platform API, the
SDK is whichever tarball you pinned, and the SDK's `package.json`
`kiagentCore` field names the core release its contracts were generated from.

A **plugin is an extension**. A connector is an extension contributing a
`Source`; a tool-only extension need not contribute a source. Write one CJS
bundle, declare a manifest, and return any mix of `sources`, `tools`,
`senders` and `calendarWriters` from `activate()`. The app installs it from a
GitHub release, runs it in its own process, and drives it.

This guide is the build-and-ship walkthrough. For *how the platform works*
— process model, the capability gate, the bundled/privileged tier — read
[`docs/architecture/extension-platform.md`](architecture/extension-platform.md)
first; it is the model, this is the recipe.

The worked connector example is the published Slack connector
(`kia-plugins/slack-kia-connector`). Choose the sections relevant to your
contributions; a read-only data source does not need a Sender or custom tool.

### Choose the integration boundary first

| Goal | Supported extension surface |
| --- | --- |
| Add searchable external data | Return a `Source`; the engine drives `pull()` and commits `toDocument()` results |
| Expose a custom operation to MCP clients | Declare and return `McpTool` contributions; use only the host capabilities needed by the operation |
| Reply through an external service | Return a `Sender` for a source you contribute, with the `send` cap and outbound document metadata |
| Create or change calendar events | Return a `CalendarWriter` for a source you contribute, with the `calendar.write` cap |
| Keep private plugin state | Use the `db` capability; its database is separate from the shared corpus |
| Run local AI over data | Use `inference`, with declarations matching the tested host/SDK versions |

An extension's CJS bundle runs in the desktop host, not inside a browser or
an external application. Those applications need an explicit transport to
the data source. The SDK is not an HTTP client for uploading to KiAgent.

There is currently **no supported general-purpose HTTP document-upload
endpoint**. Local `/mcp` and Remote MCP expose MCP operations, not a corpus
ingestion API. The loopback server checks Host/Origin and does not provide a
browser upload/CORS contract. `host.net.fetch` is outbound public HTTP(S)
only; it cannot connect to a localhost or private-network helper.

For externally pushed data, a plugin-owned authenticated public HTTPS
service can persist events which a `Source` polls. That service, its upload
API, account pairing and retention are additional software the author must
provide. Make any storage outside the user's machine explicit during setup.
For local-only ingestion, external software can instead export stable
Markdown/text files into a user-selected folder indexed by the built-in
local-folder source. Include original URLs in file content; the local
source's structured URL points to the file. Automatic browser-to-file
delivery may need a separately installed native-messaging helper. No such
helper or direct local upload bridge is supplied by the connector SDK.

Do not bypass unsupported host capabilities by writing KiAgent's database
or adding an undocumented listener and describing it as a platform API.
See §4 for the durable ingestion contract and §8 for end-to-end validation.

---

## 1. The contract is the SDK

The extension-facing API is
[`src/shared/contracts.ts`](../src/shared/contracts.ts) (§3, §3b and §7 in particular), the
shared database/filesystem/network contracts and SQL helpers, plus the runtime
error classes in [`src/shared/source-errors.ts`](../src/shared/source-errors.ts)
and the file policy in `src/shared/file-indexability.ts` (also
`source-options.ts`) — republished, generated verbatim at build time, as
[`@kiagent/connector-sdk`](https://github.com/edjafarov/kiagent-core/tree/dev/sdk/connector-sdk).
Add it as a devDependency, pointed at the tagged release tarball (not the npm
registry):

```json
"devDependencies": {
  "@kiagent/connector-sdk": "https://github.com/edjafarov/kiagent-core/releases/download/sdk-v1.14.0/kiagent-connector-sdk-1.14.0.tgz"
}
```

and import from it:

```ts
import type { ExtensionModule, Source, Session } from '@kiagent/connector-sdk';
import { SourceAuthError } from '@kiagent/connector-sdk';
```

`devDependency` doesn't mean types-only here: `SourceAuthError` and friends
are real runtime classes, and esbuild bundles whatever you `import` straight
into your `dist/index.js` — nothing resolves `@kiagent/connector-sdk` at the
installed extension's runtime. (The one exception is `@kiagent/connector-sdk/testing`,
§8 below — never import it from your entry.)

Two rules:

- **Match the SDK version to the platform you're building against.** The
  package's own `kiagentCore` field (in its `package.json`) names the
  `kiagent-core` version its contracts were generated from — that's your
  provenance, in place of a hand-written commit-sha header.
- **Never patch the SDK's files.** Bump the devDependency instead — a new
  `sdk-v*` release is cut whenever the contracts change (see the SDK's own
  README for the release flow).

The platform's own API version is `PLATFORM_API_VERSION` in
[`src/shared/extension-rpc.ts`](../src/shared/extension-rpc.ts) — **`2.21.0`** at
the time of writing. Your manifest's `engine` range is checked against it at
install. 2.0.0 removed tolerance, not surface: manifests are parsed strictly
(unknown keys reject instead of being silently stripped) and
`contributes.senders` must be stated explicitly.

`"engine": "^2.0.0"` is accepted by every 2.x app, but a feature added later
does not exist on an older one. Declare a range that starts at the platform
version that introduced everything you use, so an older app refuses the install
with `requires platform <range>; this build is <version>` instead of failing at
runtime. Where the changelog and the contracts name a version:

| Platform | Added |
|---|---|
| 2.1.0 | `database.schema` descriptors for the `db` capability |
| 2.3.0 | manifest `fileRoots` |
| 2.4.0 | `FolderScopeUpdate.archiveRefs`, `FolderPickerSpec.note` |
| 2.5.0 | `contributes.ui` pages |
| 2.6.0 | calendar sources (`calendar.event` documents) |
| 2.7.0 | `Source.listAddressedTo` |
| 2.9.0 | `documentPage` `afterSeq`; inference `grammar` and `topLogprobs` |
| 2.10.0 | the `github` OAuth provider |
| 2.11.0 | `host.inference.embed` |
| 2.12.0 | per-account source options (`descriptor.options`) |
| 2.13.0 | file policy v5 formats |
| 2.14.0 | `Source.fetchAddressedAttachment` |
| 2.15.0 | `Sender.drafts`; `SendIntent.bodyHtml` and `attachments` |
| 2.16.0 | the `calendar.write` cap and `CalendarWriter` |
| 2.18.0 | `contributes.prepareExport` and the manifest `sync` block |
| 2.20.0 | `host.role.get()` and the `sync.role` event |
| 2.21.0 | `CalendarWriter.updateEvent` |

A connector using the `db` capability must also publish a database descriptor
and declare it in `manifest.json`; the actionable missing-descriptor error is:
`PLUGIN_DB_DESCRIPTOR_REQUIRED: database.schema is required for db-capability plugins`.

### What the host provides

`ExtensionModule.activate()` returns any mix of
`{ sources, tools, senders, calendarWriters }` (senders and calendar writers
keyed by source id) — exactly what the wire protocol (`Contributions` in
`extension-rpc.ts`) carries. Every host also has `host.self` (`id`, `dataDir`),
`host.log(level, msg)` and `host.role.get()`, with no capability needed.

The `files`, `db`, and `net` capabilities are asynchronous, lifecycle-owned
host services. Their public contracts are available from the SDK root:
`ScopedFiles`, `FileRef`, `ScopedFileHandle`, `PluginDb`, `PluginDbSession`,
`PluginDbStep`, `PluginDbParams`, `PluginNet`, `PluginNetInit`, and
`PluginNetResult`. They do not provide synchronous filesystem or private
SQLite fallbacks.

The package also has subpaths: `/http` (`requestWithRetry`), `/chat-day`
(day-document rendering), `/testing` (§8) and `/ui` (page types). The SDK
README lists them.

---

## 2. Repo skeleton

Copy this shape; it is what the Slack connector ships.

```
manifest.json          # the platform reads this
package.json           # names + versions the npm-pack tarball
build.mjs              # esbuild → single CJS file
tsconfig.json
jest.config.js
icon.png               # optional, ≤200 KB, also read from the repo root pre-install
README.md              # rendered on the marketplace detail page
src/
  index.ts             # entry: default-exports the ExtensionModule
  source.ts            # the Source
  sender.ts            # optional Sender
  client.ts            # your API client
  __tests__/
dist/index.js          # build output — what `entry` points at
```

`build.mjs` — the whole thing:

```js
import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/index.js',
});
```

`src/index.ts` — note the dual export; the host `require()`s the bundle and
accepts either shape, but shipping both is what keeps it working across
esbuild upgrades (and §8 has a test for exactly that):

```ts
import type { ExtensionModule } from '@kiagent/connector-sdk';
import { createSlackSender } from './sender';
import { createSlackSource } from './source';

const mod = {
  async activate(host) {
    return {
      sources: [createSlackSource(host)],
      // Keyed by SOURCE id, and listed in manifest contributes.senders.
      senders: { slack: createSlackSender(host) },
    };
  },
} satisfies ExtensionModule<'net' | 'send'>;

export default mod;
module.exports = mod;
```

The `ExtensionModule<'net' | 'send'>` type parameter is your cap list.
`HostFor<G>` builds the host's shape from it, so an ungranted namespace does
not exist at compile time either — if you type it honestly, TypeScript catches
a `host.query.…` call you never asked permission for.

### Tool-only plugins

For example, a corpus lookup tool can use `ExtensionModule<'query'>`, a
manifest with `caps: ["query"]` and
`contributes: { tools: ["yourname_lookup"], senders: [] }`, and this entry:

```ts
import type { ExtensionModule, HostFor, McpTool } from '@kiagent/connector-sdk';

const createLookup = (host: HostFor<'query'>): McpTool => ({
  name: 'yourname_lookup',
  description: 'Find indexed documents by text.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1 } },
    required: ['text'],
    additionalProperties: false,
  },
  async call(args) {
    if (
      typeof args.text !== 'string' || !args.text.trim()
      || Object.keys(args).some(key => key !== 'text')
    ) {
      throw new Error('Expected only a non-empty text string');
    }
    return host.query.search({ text: args.text, limit: 10 });
  },
});

const mod = {
  async activate(host) {
    return { tools: [createLookup(host)] };
  },
} satisfies ExtensionModule<'query'>;

export default mod;
module.exports = mod;
```

Keep declared tool IDs and returned names aligned and choose names that do
not collide with core or other plugins. Validate arguments in `call`; a
JSON Schema declaration is not a substitute for runtime validation.
`McpTool.tier: 'powerful'` is advisory metadata, not a confirmation gate.
For outbound messaging, use the Sender flow in §7 so the platform owns user
confirmation. Dispose timers, subscriptions and other resources you create
in `deactivate()`. Returning a tool does not grant shared-corpus write access.

---

## 3. The manifest

Validated by [`src/main/platform/manifest.ts`](../src/main/platform/manifest.ts)
before any of your code is loaded. Rejections are shown to the user verbatim,
so a bad manifest is a visible install failure, not a silent one.

```json
{
  "id": "kia.slack",
  "name": "Slack",
  "version": "2.2.1",
  "engine": "^2.0.0",
  "entry": "dist/index.js",
  "caps": ["net", "send"],
  "contributes": {
    "sources": ["slack"],
    "senders": ["slack"]
  },
  "icon": "icon.png"
}
```

| Field | Rule |
|---|---|
| `id` | must match `^[a-z0-9-]+\.[a-z0-9-]+$` — `publisher.name`. It is the install directory name and the consent key. |
| `name` | non-empty display string |
| `version` | valid semver. **This is the version the platform compares for updates** — see §10. |
| `engine` | valid semver *range*, checked against `PLATFORM_API_VERSION`. Install fails with `requires platform <range>; this build is <version>`. |
| `entry` | relative path to your CJS bundle; must resolve *inside* the package directory |
| `icon` | optional, must end `.png`, must resolve inside the package, ≤ 200 KB (`MAX_ICON_BYTES`) |
| `caps` | array from the fixed `CAPS` list |
| `contributes` | what you register. **Required**, and `contributes.senders` must be present — the source ids you ship an outbound Sender for, or `[]` for none. |
| `database` | optional `{ "schema": "<path>" }`; required with the `db` cap (see below). |
| `fileRoots` | optional, up to 8 read-only home-relative folders; needs the `files` cap, marketplace tier only. See [`extension-api-reference.md`](extension-api-reference.md). |
| `sync` | optional `{ forward?: string[], deliver?: string[] }`: which of your `host.ui.handle` names are writes, for multi-device sync. Needs the `ui` cap, and only bundled extensions can call `ui.handle`. |

The whole manifest is parsed **strictly**: a key the platform doesn't know
(top-level, inside `contributes`, or inside a `sources` object entry) rejects
the manifest instead of being silently ignored.

### caps

The manifest accepts these caps: `query`, `net`, `files`, `db`, `ui`,
`commands`, `inference`, `events`, `attention`, `prefs`, `secrets`, `sync`,
`send`, `calendar.write` and `unsafe.mainProcess`. All but the last three map
to a host namespace (`CapSurfaces` in contracts.ts). The
[architecture doc](architecture/extension-platform.md#capabilities) tabulates
them; [`extension-api-reference.md`](extension-api-reference.md) has the newer
surfaces. What you need to *do* about them:

- Declare only what you use. Every cap is shown to the user before install.
- `send` and `calendar.write` grant **no host namespace**. They gate whether
  the main process will register your `contributes.senders` and
  `contributes.calendarWriters` — see §7.
- `unsafe.mainProcess`, `sync` and `secrets` are privileged: a manifest that
  declares any of them is rejected unless the extension ships inside the app
  bundle (`this extension requires <cap> — only extensions bundled with the app
  may use it`). You cannot use them.
- `attention`, `prefs` and the other newer namespaces are documented in
  [`writing-extensions.md`](writing-extensions.md) and
  [`extension-api-reference.md`](extension-api-reference.md).
- `ui` gives a marketplace extension `host.ui.notify` only; `handle`,
  `unhandle`, `call` and `broadcast` are refused for it. A marketplace
  extension can still contribute a page with `contributes.ui` (below).
- `commands`: `host.commands.register` is rejected at runtime today. The
  manifest still accepts `contributes.commands` entries.
- `inference` calls default to the `'interactive'` lane and honor a
  caller-supplied `lane` option; a caller that selects `'background'` must
  handle the lane being closed and failing fast with `LaneClosedError` while
  the processing window is closed. The surface also has `lane()`,
  `describe(kind, { lane })`, a generation guard on `complete()`, the
  decoding options `schema`, `grammar` and `topLogprobs`, `completeWithMeta()`
  and `embed()` (background lane only). Across RPC, inspect error `name`
  (`LaneClosedError`, `ContextOverflowError`, and `ModelChangedError` with its
  structured fields), not `instanceof`. Details are in
  [`extension-api-reference.md`](extension-api-reference.md); the
  [architecture doc](architecture/extension-platform.md#capabilities) covers the
  lane states.
- `net.fetch` accepts `http(s)` URLs only, reaches **public internet
  destinations only**, and caps a response body at 100 MiB. Loopback, RFC1918
  LAN, link-local (including cloud metadata endpoints), CGNAT, IPv6
  unique-local, multicast and reserved addresses are refused — both when named
  directly and when a hostname resolves to one. Redirects are followed
  manually, up to 5 hops, and every hop is re-checked against the same policy;
  `authorization`/`cookie` headers are dropped when a redirect changes origin.
  If your service genuinely lives on a private address, open an issue rather
  than working around this.
- `host.net.fetch` keeps the same `fetch(url, init?)` method. `PluginNetInit`
  accepts `signal` for caller cancellation and `timeoutMs` for a deadline;
  cancellation is not retried. The result is a `PluginNetResult` with a
  `Uint8Array` body and lowercase string headers.
- `db` is a worker-backed plugin database in the extension's prepared data
  namespace — never the shared corpus. There is no write path to the corpus
  except returning documents. Statements are policed by leading keyword:
  ordinary DML, DDL and transaction control are fine, but anything that can
  name a second database file is refused — `ATTACH`, `DETACH`, `VACUUM INTO`.
  `PRAGMA` is refused except for a self-scoped set (`user_version`,
  `application_id`, `table_info`, `table_list`, `table_xinfo`, `index_info`,
  `index_list`, `foreign_keys`, `foreign_key_list`, `page_count`,
  `freelist_count`, `integrity_check`, `quick_check`).
- `files` is rooted at folders the user approved for this extension. Trusted
  bundled integrations call `mainProcess.files.grantRoot()` with their exact
  plugin id (for example, `kiagent.documents`); activation-qualified owners
  such as `kiagent.documents:h1` and another plugin's id are rejected. The
  grant is shared by every activation of that plugin, while handles and
  watchers remain bound to their individual activation. Use the `{ root, rel }`
  `FileRef` shape; canonicalization returns another scoped
  reference, and `ScopedFileHandle.id` is an opaque owner/incarnation-bound
  handle, never an OS file descriptor or raw path. Trusted user grants are the
  source of roots; ordinary plugin calls cannot name arbitrary filesystem
  paths. `FileInfo.blocks` is part of stat/fstat metadata and `mtimeMs` uses
  the exact `Number(mtimeNs / 1_000_000n) + Number(mtimeNs % 1_000_000n) / 1e6`
  conversion.
- `files.write()` accepts `ifAbsent`, `atomic`, and `mode`. With `atomic: true`,
  the host writes and syncs a unique exclusive no-follow sibling, applies a
  validated mode in `0..0o777`, and publishes it with an in-directory rename;
  it never removes the destination first. The default mode preserves an
  existing mode or uses a secure mode for a new file. `ifAbsent` preserves
  no-overwrite behavior, including on publication collisions. A zero-progress
  handle write is rejected and cleaned up.
  These scoped capabilities are not a full-OS-sandbox claim; the platform
  still keeps trusted user-grant and privileged integration boundaries
  explicit. Reuse the asynchronous host I/O surface for ordinary connector
  state, certificate and storage writes rather than opening paths directly.
- `events` refuses to emit names starting `extension.` or `platform.` (those
  are platform-emitted). Current core delivers `(payload, meta)`, with
  host-stamped `meta.from` and `meta.at`; check provenance when accepting
  peer events. Events have no persistence or replay and are not a durable
  browser-ingestion queue.

### contributes

- `sources: ["slack"]` — plain source ids, or `{ "id": "google-docs", "oauth":
  "google" }` to bind a source to a platform OAuth provider (`google`,
  `microsoft` or `github`, per `OAUTH_PROVIDER_IDS`). The binding is what makes
  `auth.oauth(scopes)` work in your connect flow and gets you platform-side
  token refresh before each pull — **the client secret stays main-side and you
  never see it.** OAuth-bound sources are surfaced separately at consent, so
  the user knows a provider sign-in window is coming before they install.
  **Only connectors installed from the store (the `kia-plugins` org) may bind
  an OAuth provider.** A connector installed from any other GitHub repository
  with an `oauth` source is refused at install: `This connector asks to sign in
  through KIAgent's own Google or Microsoft access, which only store connectors
  can use.` Such a connector has to collect its own credential through
  `auth.prompt`.
- `senders: ["slack"]` — source ids you provide an outbound transport for.
  **Required** (use `[]` for none). Each entry must also be a source *this
  same extension* contributes; the platform drops senders for ids you didn't
  declare or didn't return.
- `calendarWriters: ["google-calendar"]` — optional; source ids you provide a
  `CalendarWriter` for. Same rules as `senders`, and it needs the
  `calendar.write` cap (§7).
- `prepareExport: ["whatsapp"]` — optional; source ids whose `Source` implements
  `prepareExport` (§4).
- `tools` — declared tool ids. A tool returned from `activate()` that is not
  declared in `contributes.tools` is skipped with a warning, and a tool whose
  name is already registered (a builtin or another extension's) is refused.
- `commands` — `{ "id", "title" }` objects. Commands remain subject to the
  command capability, and `host.commands.register` is rejected at runtime today.
- `ui` — pages for the app's sidebar: `{ id, slot: "screen", title, nav?, params? }`
  with the bundle at `dist/ui/<id>.js` (a regular file, at most 5 MiB; a missing
  one fails install). A page is trusted code that runs in the app's renderer.
  The SDK README's "Contributing a page" has the build recipe.

A source id already registered by another extension makes the install fail
(`source id 'slack' is already provided by kia.other`). Namespace yours if
there's any chance of collision.

### Database descriptors and migrations

A connector with `caps: ["db"]` must declare a schema file in its manifest:

```json
{
  "engine": ">=2.1.0 <3.0.0",
  "caps": ["db"],
  "database": { "schema": "dist/database.json" }
}
```

`database.schema` must be a non-empty path that resolves inside the extension
directory, and the file must exist. The descriptor is declarative JSON, not
executable JavaScript. Generate `dist/database.json` from the connector's
exported immutable historical migration arrays, and keep those arrays
append-only. Its public shape is `PluginDatabaseDescriptor`:

```json
{
  "format": 1,
  "objects": [{ "name": "settings", "kind": "table" }],
  "modules": [{
    "name": "main",
    "migrations": [{
      "version": 0,
      "statements": ["CREATE TABLE {{settings}} (id TEXT)"]
    }]
  }],
  "legacy": {
    "tables": [{ "name": "settings", "columns": ["id"] }]
  }
}
```

The `objects` list contains the registered tables, indexes, views and
triggers. Every module migration has an ascending integer `version` and its
exact statements. A version-zero store with idempotent `CREATE` schema needs
an explicit version-zero/bootstrap migration. A direct legacy store is
described by a non-empty `legacy.tables` list with neither `versionTable` nor
`userVersionModule`; versioned legacy stores may name either of those fields.
`private.db` is the only initial legacy basename. The host owns the directory
and shared worker; retain the legacy database and its WAL sources intact.

Use explicit `{{logical}}` markers only in SQL code. Markers inside SQL string
literals, quoted identifiers and comments remain literal text. Logical names
match `[a-z][a-z0-9_]*`; `pluginIdentifier(id, name)` produces a quoted name
with the collision-resistant prefix `p_` + the full UTF-8 plugin id encoded as
hex + `__`. Prefixing prevents collisions; it is not authorization. The
native authorizer is the security boundary.

The database bridge accepts SQL values `null`, `string`, finite `number`,
`bigint`, `boolean`, `Date`, and `Uint8Array`. It rejects `undefined`,
non-finite numbers and unsupported objects. Safe-range integers may be read as
numbers; larger integers remain exact `bigint` values. Binary values are
`Uint8Array`; booleans and dates are normalized by the bridge.

`db.transaction()` provides the only transaction authority: use the supplied
`tx` object for every operation in the callback. Ordinary SDK calls made
inside that transaction reject; do not add product-side queues or retries.
If the worker reports `DB_WORKER_CRASHED`, an ambiguous write is not
automatically replayed. `batch()` and `migrate()` remain asynchronous and
worker-backed.

Migration uses one shared worker and one shared database file while preserving
the `private.db`/WAL sources. It does not require LLM rerun or reingestion.
The new marker does not protect pre-gate older binaries: an older binary
cannot read the new marker. Downgrade is supported only with a matching
pre-migration backup.

---

## 4. The Source

```ts
interface Source<Cursor, Item> {
  readonly descriptor: SourceDescriptor;
  connect(auth: AuthChannel): Promise<{
    identifier: string;
    config?: Record<string, unknown>;
    credentials?: Credentials;
  }>;
  prepareExport?(ctx: ExportContext): Promise<void>;
  pull(session: Session, cursor: Cursor | null): AsyncIterable<Batch<Cursor, Item>>;
  toDocument(item: Item): DocumentInput | DocumentInput[] | null;
  fetchBytes?(session: Session, doc: Document): Promise<Uint8Array | null>;
  reconcile?(session: Session): AsyncIterable<ExternalRef[]>;
  manageFolders?(session: Session, channel: FolderSelectionChannel): Promise<FolderScopeUpdate<Cursor>>;
  reauthenticate?(account: Account, auth: AuthChannel): Promise<void>;
  // owner-channel mail only (below): listAddressedTo?, fetchAddressedAttachment?
}
```

`Source` also declares `readMessageEvidence?`, a bounded evidence lookup that
core's own sources implement. The extension RPC does not carry it, so a
marketplace connector cannot provide it.

You do not write a sync loop, a retry policy, a backoff, a progress counter,
or a cursor store. The engine
([`src/main/core/engine/engine.ts`](../src/main/core/engine/engine.ts)) owns all
of it and commits your batch and your cursor in **one transaction**, so
"cursor advanced but rows lost" is not a state the store can reach.

### pull() — durable pagination and external transports

A batch has `{ phase, items, cursor, deletions?, estimateTotal? }`. `phase`
is `'backfill'` while catching up and `'live'` when current. Fetch bounded
pages, yield each with its next cursor, and finish a finite iterator once
caught up; the descriptor/account cadence schedules the next run. A live
iterator can instead keep yielding. Check `session.signal` during long work
and between requests so pause/disconnect can stop it.

The upstream page must be replayable from the previously committed cursor
after a crash. Do not consume-and-delete upstream events merely by fetching
them. There is no Source post-commit acknowledgement callback; design a
plugin-owned queue around replay/retention and cursor-based reads. Preserve
the next cursor even for empty pages by yielding a batch. Define a full
resync path for expired cursors instead of silently skipping history.

`host.net.fetch` returns a serializable `HostResponse` with `status`,
`statusText`, lowercase `headers`, and `body: Uint8Array`; it is not a browser
`Response` and has no `.json()` method. Import `HostResponse` and
`requestWithRetry` from `@kiagent/connector-sdk/http`, check status, decode
the body with `TextDecoder`, and validate the parsed data. The retry helper
handles bounded request retries; source-level failure/restart remains
engine-owned. Distinguish revoked credentials (§6) from transient failures.

For a plugin-owned relay, authenticate upload and read access, isolate
accounts, validate payload schemas/limits, deduplicate retries, retain data
for offline clients, and document deletion/retention. Provider login cookies
are not a plugin pairing credential. Capture/export software and the relay
must be implemented and tested separately from the CJS connector.

### descriptor

```ts
descriptor: {
  id: 'slack',
  name: 'Slack',
  documentTypes: ['slack.day', 'slack.thread', 'file'],
  auth: 'password',
  multiAccount: true,
  cadence: { every: '15m' },
}
```

`cadence` is the field with teeth: it becomes the account's default re-pull
schedule at connect (`{ every: '15m' }`, `{ cron: '0 9 * * 1' }`, or
`'manual'`), and the user can override it per account. `documentTypes` and
`multiAccount` render in the source's config panel; `auth` is declarative
(`'oauth' | 'password' | 'pairing' | 'none'`) and no extension-facing code
reads it. `id` must match a `contributes.sources` entry or the platform logs a
warning and skips your source. Other optional fields: `folderScope` (see
below), `options` (below), and `compose: 'email'` (§7). A source that lists
`CALENDAR_EVENT_DOCUMENT_TYPE` (`'calendar.event'`) in `documentTypes` is a
calendar source; the SDK README's "Calendar sources" gives the metadata and
Markdown layout contract.

### connect() and the AuthChannel

`connect()` returns **`{ identifier, config }`; `config` holds no secrets**.
Secrets reach the encrypted vault by a different route, and this is the single
most important thing to get right:

```ts
interface AuthChannel {
  oauth(scopes: string[]): Promise<Credentials>;
  showQr(qr: string): void;
  prompt(schema: unknown): Promise<Record<string, unknown>>;
  status(msg: string): void;
  pickFolders(spec: FolderPickerSpec): Promise<FolderNode[]>;
}
```

The engine wraps the `AuthChannel` it hands you and captures credentials out
of the flow:

- whatever `auth.oauth(scopes)` resolves to is captured wholesale;
- from `auth.prompt(schema)`, **only the answer field literally named
  `password`** is captured, into `Credentials.password`.

Whatever was captured is written to the vault under the new account id after
`connect()` returns. If `connect()` also returns `credentials`, they are merged
over what was captured (for a 2FA password, say). Nothing else you collect is
persisted as a secret — it lands in `config`, which is *not* encrypted and is
meant for non-secret settings (workspace url, team id, selected folders).

> **If your token is not in a prompt field named `password` (and you do not
> return it as `credentials`), it is never saved.** `session.credentials()` will return `null` on the first pull and
> your source will look broken. The Slack connector's `xoxp-` token is
> collected as `properties.password` for exactly this reason.

The prompt schema is a JSON-Schema-ish object read best-effort by
[`src/renderer/screens/Sources/prompt-guidance.ts`](../src/renderer/screens/Sources/prompt-guidance.ts).
Conventions it understands:

- top-level `description` → intro paragraph
- top-level `x-steps: [{ title, body?, link?, copy? }]` → numbered setup steps.
  `link` must be `https://` (anything else is dropped); `copy` renders as a
  copyable preformatted block — how the Slack connector hands the user its
  Slack-app manifest YAML. A step without a `title` is skipped, not an error.
- `properties.<key>` → one input each. `title` is the label, `description` the
  help text, `examples[0]` the placeholder. `format: 'password'` masks it (as
  does a key matching `/password|secret|token/i`); `format: 'folder-path'` and
  `'folder-paths'` render folder pickers.

Validate the credential inside `connect()` — a real API call, checking the
granted scopes — and `throw` a plain `Error` with an actionable message if it
fails. The user sees that string. The Slack connector rejects an `xoxb-` bot
token by prefix before touching the network, then calls `auth.test` and lists
any missing scopes by name.

`connect()` upserts on `(source, identifier)`: returning the same identifier
for a re-authenticated account keeps its existing id and its documents.

### Folder management and reconnect

For a folder-scoped source, set `descriptor.folderScope: true` and implement
`manageFolders`. It receives existing credentials via `Session` and a
`FolderSelectionChannel` (`status` and `pickFolders` only). It must not
authenticate or persist state. Return the complete canonical config,
transformed cursor, and archive/scope changes in `FolderScopeUpdate`; core
owns the durable write. `config.folderRoots` is canonical and root IDs are
opaque. Supply `archiveScopeRootIds` (an empty array is legal); a removed
root still covered by a retained root belongs in `reattributeScopeRoots`,
not the archive list. A root cannot be in both. Keep at least one root, or
remove the account instead. The folder picker supports `selected` and
`purpose: 'manage'` with source-provided `modes`, `roots` and `children`
callbacks, optional counts, and `expand` for ancestors of selected nodes.
See the comments on `FolderScopeUpdate` in contracts.ts before implementing
root removal or attribution repair. **Runtime exception to those comments:**
`archiveNullScoped` is currently logged as refused and never forwarded to
the store (`engine.applyScope`); do not rely on it to archive or repair rows.
`FolderScopeUpdate.archiveRefs` (per-document archival, for documents that span
folders) and `FolderPickerSpec.note` are described in
[`extension-api-reference.md`](extension-api-reference.md).

Implement `reauthenticate(account, auth)` to reconnect an existing account:
verify the provider identity matches that account, throw on a mismatch,
and return no config (reconnect preserves scope). Do not author
`descriptor.hasReauthenticate`; core derives it from the implemented method.
Use the SDK's `fakeFolderSelectionChannel` (§8) to test management without
accidentally granting OAuth or prompt access in the test harness.

A connector that keeps a login outside the vault (a session file, say) can
implement `prepareExport(ctx)` and list its source id in
`contributes.prepareExport`. Before an account's login is copied to another
device, core awaits it so the login is in the vault; `ctx.credentials()` and
`ctx.save(credentials)` read and write that account's vault entry. During a
pull, `session.saveCredentials(credentials)` does the same, replacing the
stored login; it throws once the pull has ended.

### Per-account options (platform 2.12.0)

A source can declare up to 8 boolean toggles on its **runtime** descriptor:
`descriptor.options = [{ key, label, description?, type: 'boolean', default }]`.
The keys are `/^[a-z][A-Za-z0-9]{0,39}$/`, a `label` is 1 to 60 characters and
a `description` at most 200. Core shows them in an **Options** card on the
account page and stores the values at `account.config.options.<key>`. A
source whose options fail validation is not registered, and a warning is logged
(`validateSourceOptions(options)` from the SDK returns the reason, or `null`).

Read a value in `pull` with `optionValue(descriptor, session.account.config, key)`
from the SDK; it falls back to the declared default. Changing a toggle restarts
a running loop, so the next `pull` sees the new value. Options are owned by
core: `connect()` and `manageFolders` cannot set or reset them, and re-adding
an account keeps them. If an option changes what is indexed, emit
`deletions` for documents it no longer covers; core does not infer them.

### pull()

```ts
async *pull(session, cursor) {
  const token = await requireToken(session);   // session.credentials()
  // ... yield { phase, items, deletions?, cursor, estimateTotal? }
}
```

`cursor === null` means "from the beginning". Yield `phase: 'backfill'` while
catching up (it drives the progress bar) and `phase: 'live'` once current.
Each yielded `Batch` is committed with its cursor atomically.

The iterator is **demand-driven**: the main process asks for exactly one batch
at a time (`src-next`), so engine backpressure applies to you for free — just
`yield` and let the platform pace you. `session.signal` is an `AbortSignal`;
honour it. `session.credentials()` is the one credential verb, and the
platform refreshes OAuth tokens before returning them.

Set `estimateTotal` when you can; it is what turns the progress bar from a
spinner into a bar.

Commit a `'live'` batch right after your last `'backfill'` batch. On a weak
host the background inference lane stays closed (`'until-synced'`) until each
source's backfill has been followed by a committed `'live'` batch, so a source
that blocks until the next upstream change before saying `live` holds that lane
shut.

### toDocument()

Pure and synchronous — one upstream item to zero, one, or many
`DocumentInput`s. Keep it pure: it is the part of your connector that unit-
tests against fixtures with no network and no host.

### fetchBytes() — not optional in practice

It is typed optional, and if you ship binary content without it, that content
is **silently never OCR'd or transcribed, forever**. The vision and audio
workers call `session.fetchBytes(doc)`, and a `null` return is a *terminal*
`'skip'` — the document is never revisited.

If your documents carry images, PDFs, or audio, implement `fetchBytes`.

### reconcile() — and the identity invariant

`reconcile()` is the offline-deletion channel: yield the full listing of what
exists upstream, and the engine archives everything live that isn't in it.

The invariant is unforgiving. Yield **one ref per live document you have ever
emitted, including children (attachments, files inside a thread), carrying
exactly the `{ externalId, type }` the corresponding `DocumentInput`
carried.** A typo'd type string, a changed externalId scheme after an upgrade,
or listing parents while you emit children will read as "everything was
deleted upstream". Derive both sides' keys from one shared builder function —
never write the key twice.

There is a backstop, not a safety net. Unless the account's config just
changed, the engine refuses a reconcile pass that either:

- came back **empty** over a non-empty corpus (always a broken listing, never
  normal churn — this one applies at any size), or
- would archive **more than 100 documents and more than 50% of the account's
  live documents**.

It logs and surfaces `refusing to archive N of M documents`, and the user's
escape hatch is re-saving the account's settings. Note the absolute floor: a
partial-but-not-empty listing bug on an account under ~100 documents sails
straight through. Test reconcile on a big corpus.

---

## 5. The document model

```ts
interface DocumentInput {
  externalId: string;
  type: string;          // 'email.thread' | 'file' | 'chat.message' | …
  title: string | null;
  markdown: string | null;
  binary?: { bytes: Uint8Array; mime: string; filename?: string };
  url?: string;          // deep link back into the origin
  metadata: Record<string, unknown>;
  createdAt: string | null;   // ISO-8601, origin time
  parent?: ExternalRef;       // engine resolves in-transaction
  scopeRootId?: string;       // folder-scoped sources: FolderRootSelection.id that contains this document
}
```

Within an account, `externalId` + `type` is your document's natural key, and the only way you
ever refer to a document (parentage, deletions, reconcile). You never hold a
DB id.

Reuse that key when upstream content changes: emit the complete updated
document, not a delta to append to its Markdown. A random ID or capture time
in the key creates a new document on every import. Namespace IDs when a
source aggregates providers or identities that may otherwise collide.
`createdAt` is the origin time, or `null` when unknown; keep capture/sync time
in separate metadata. Preserve the canonical origin link in `url`, and
include it in Markdown when users should be able to find it by text search.

Partial snapshots are not proof of deletion. Merge them with retained state
or clearly model them as partial documents; do not replace a complete
document with an incomplete tail by accident. For an observed deletion,
emit the original `{ externalId, type }` in `Batch.deletions`. Implement
`reconcile()` only when your listing is authoritative for the whole account.
Validate external input and render it as content, preserving role/order/code
where relevant; imported instructions are data, not instructions to execute.

### type literals are load-bearing

`type` is a free string *except* for two literals. Both the vision classifier
([`src/main/workers/vision/classify.ts`](../src/main/workers/vision/classify.ts))
and the audio classifier
([`src/main/workers/audio/classify.ts`](../src/main/workers/audio/classify.ts))
open with the same gate:

```ts
if (doc.type !== 'attachment' && doc.type !== 'file') return 'skip';
```

If you type your PDFs `'slack.file'` instead of `'file'`, they will index as
metadata and never be OCR'd. The Slack connector's `documentTypes` are
`['slack.day', 'slack.thread', 'file']` — the shared literal is deliberate.

### metadata keys the platform reads

`metadata` is yours, but these keys are consumed:

| Key | Read by |
|---|---|
| `mime` | vision + audio classifiers (`image/*`, `audio/*`, `application/pdf`), and the VLM decodability check |
| `filename` | both classifiers, falling back to `title`, for extension sniffing |
| `sizeBytes` | vision classifier — images under 8 KB are skipped as decoration |
| `ext` | audio classifier's extension hint when there is no mime |
| `extraction` | **set by the workers, not by you.** It is the re-entrancy marker: once present, both classifiers skip the document. Do not write it yourself or you will permanently suppress extraction. |
| `outbound` | reply targets — below |

### Letting the engine convert binaries

Set `markdown: null` and pass `binary` and the engine converts on the commit
path: PDF, DOCX, PPTX, ODT, EPUB, legacy DOC, RTF, SRT/VTT subtitles, HTML, CSV,
spreadsheets (XLSX, ODS, XLS), email files (`.eml`, `.emlx`, `.msg`) and plain
text go through deterministic parsers
([`src/main/core/engine/convert.ts`](../src/main/core/engine/convert.ts)).
Images, unknown binaries and text-poor PDFs (a scan) stay `markdown: null` and
fall through to the vision worker's two-pass OCR/VLM pipeline. Conversion
keys off `binary.mime` and `binary.filename`, not off `type` — but the
*second* pass keys off `type`, so you need both right.

Whether a given file is worth fetching at all is decided by one policy,
`decideFileIndexing({ profile, filename, mime, sizeBytes })`, exported from the
SDK. Use `profile: 'cloud-drive'`. An `ignore` decision carries a `reason`
(cloud profiles ignore archives and audio/video, among others); an `index`
decision names the `pipeline` (`'converter'` or `'vision'` for a cloud drive)
and `bytes`: `'eager'` ships `binary` in the batch, `'deferred'` commits a
metadata-only row and leaves the bytes to a later `fetchBytes`, and `'none'`
commits a name-only row. The eager cap for documents and PDFs is
`MAX_CLOUD_BINARY_BYTES` (25 MiB), and one later `fetchBytes` can return up to
`MAX_FETCH_BYTES` (100 MiB, also the `host.net.fetch` body cap). Mailbox,
archive, address-book and notebook containers (mbox, ZIP, vCard, ENEX, PST)
are expanded only by the built-in local-folder source.
`FILE_POLICY_VERSION` (currently 5) is bumped whenever a change makes
previously ignored files indexable.

### metadata.outbound — reply targets

If your source can be replied to, write an `outbound` object and the app's
`draft_reply` MCP tool works against your documents without any platform
change:

```ts
metadata: {
  outbound: {
    ref: { channel: 'C123', ts: '1700000000.000100' },  // opaque, yours
    display: '#general',                                 // MUST be a string
    targets: [                                           // optional
      { key: '09:15', ref: { channel: 'C123', ts: '…' }, display: '#general — 09:15 alice' },
    ],
  },
}
```

- `ref` is **opaque to the platform** and round-trips verbatim to your
  `Sender` as `SendIntent.outboundRef`. Put whatever addressing you need in
  it.
- `display` **must be a string**, or the whole hook is inert — the resolver
  checks `typeof outboundMeta.display === 'string'` before taking this branch
  and otherwise falls through to bundled email resolution (which will reject
  your document's type).
- `targets[]` is optional per-message addressing: the model picks a `key` it
  can see in the document body, never a ref it invents. An entry missing `ref`
  or with a non-string `display` is treated as absent, never half-used. This
  is how a Slack day-document lets a reply thread under one specific message.

Grounding is the point: recipients come only from stored document metadata.
The model supplies a key at most.

---

## 6. Errors and the auth taxonomy

Import them from `@kiagent/connector-sdk`. The two classes:

```ts
export class SourceAuthError extends Error { readonly code = 'auth'; }
export class SourcePermanentError extends Error { readonly code = 'permanent'; }
```

What the engine does with them:

| What you throw from `pull()` | Result |
|---|---|
| `SourceAuthError` (or anything with `code: 'auth'`) | account → `needsReauth`, sync **stops**. No retries, no supervisor restart, no boot resume. Only the user's explicit Retry or a fresh connect restarts it. |
| `SourcePermanentError` (or `code: 'permanent'`) | account → `error` immediately, skipping the retry budget |
| anything else | transient: up to **5** retries with backoff, then `error` |

**The engine classifies on the `code` property, never `instanceof`.** That is
deliberate and it is why a bundled copy works: esbuild inlines
`@kiagent/connector-sdk`'s `SourceAuthError` into your `dist/index.js`, so
your copy is a different class object from the platform's, and errors
crossing the process boundary arrive as plain `Error`s carrying `code`
rehydrated from the wire. All three classify identically. It also means you
can skip the class entirely and set `code = 'auth'` on your own API-error
type — the taxonomy is the property, not the hierarchy.

Get this right or you burn the retry budget on a revoked token and land the
account in a generic `error` state with no re-auth affordance:

```ts
async function requireToken(session: Session): Promise<string> {
  const creds = await session.credentials();
  const token = creds?.password;
  if (!token)
    throw new SourceAuthError('no Slack credentials — reconnect the account');
  return token;
}
```

Throw it for a 401/403 from upstream too, not just a missing credential.

---

## 7. Senders (outbound)

To send, declare `caps: ["send"]` **and** `contributes.senders: ["<source
id>"]`, and return `senders` from `activate()` keyed by source id.

`send` grants no host namespace. The direction is inward: the host calls your
`Sender.send(intent, ctx)` — and only ever *after* a user confirmation gate.
Extensions cannot initiate a send.

```ts
async send(intent: SendIntent, ctx?: SenderContext): Promise<SendResult> {
  const token = ctx?.credentials?.password;
  if (!token)
    throw new Error('no Slack credentials — reconnect the account in Settings');
  // intent.outboundRef is exactly what your toDocument wrote as metadata.outbound.ref
  …
  return { externalMessageId: ts };
}
```

Note `ctx.credentials`. Your child process has no vault access, so the host
resolves the account's credentials and passes them in at send time. Do not
cache a token across sends.

**Extension senders are reply-only unless the source is an email source.**
`SendIntent.kind` is typed `'reply' | 'new'`, but composing a new message goes
through `draft_message`, which resolves a From address via `senderAddressFor` —
and that throws `compose is email-only — '<source>' accounts are reply-only`
for any source that isn't `imap`, `gmail` or declared as an email source. So
unless you opt in, your `send()` only ever sees `kind: 'reply'`, always with an
`outboundRef`. You still need to have written `metadata.outbound` (§5) for any
of it to happen: no `outbound` metadata, no reply target, no send.

To let accounts of your source originate mail, set `compose: 'email'` on the
runtime `SourceDescriptor`. Core then asks for no From address; your Sender
sends as the account's own mailbox and sees `kind: 'new'` intents.

A `SendIntent` can also carry `bcc`, `bodyHtml` (the Markdown rendered as
email HTML by core; send it with `bodyMarkdown` as the text part, and ignore it
if your service has no HTML) and `attachments` (`{ filename, mime,
contentBase64 }[]`, base64 so the intent stays plain data over the RPC). The
host calls `send()` with a 60 second timeout.

### Provider drafts (platform 2.15.0)

A Sender may also carry `drafts: DraftMirror` when the service keeps drafts
(Gmail, Outlook): the Outbox draft is then also a provider draft, kept in step
both ways. `DraftMirror` has `create(intent, ctx)` returning a `DraftRef`
(`{ accountId, id, threadId? }`), `update(ref, patch, ctx)` (returns the ref,
since ids may change; only the fields in the `DraftPatch` change), `read(ref,
ctx)` (a `DraftReadResult`: `draft`, `sent`, `deleted` or `gone`), `remove(ref,
ctx)` and `send(ref, ctx)`, which sends the provider draft as it is and follows
the same never-retry rules as `send()`. Every op gets the account's credentials
in `ctx` and each has a 60 second timeout. Drafts need no manifest entry beyond
the sender itself: core learns which senders have `drafts` from what `activate()`
returns.

### The auth-marker string contract

This one is a genuine cross-repo string contract. The outbound error
classifier
([`src/main/outbound/error-copy.ts`](../src/main/outbound/error-copy.ts)) picks
page copy and gates the Try-again button off:

```ts
const AUTH_MARKERS =
  /reconnect .* in Settings|no Gmail credentials|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i;
```

**End your sender's auth-failure messages with `reconnect … in Settings`** and
they classify as `auth` / retryable, with your message shown to the user.
Anything else falls through to `unknown` — "the app could not confirm
delivery… the message MAY still have been sent" — with no Try-again button.
The literal `in Settings` is required; a bare "reconnect the account" does not
match.

There is a second contract, `/^not sent: /`. Start the message with `not sent:
` when you can *prove* nothing left the device — your live connection is down,
the platform refused the recipient up front, the reply target is gone — and it
is neither auth nor quota. It is checked before every other marker, so a reason
that happens to mention "429" or "reconnect" is not re-routed. (Your *source* errors are a different mechanism — those classify by
`code`, per §6. Slack's source throws `— reconnect the account`; its sender
throws `— reconnect the account in Settings`. Both are correct for their
path.)

### Calendar writers (platform 2.16.0)

A calendar source can also let the app create events. Declare
`caps: ["calendar.write"]` and `contributes.calendarWriters: ["<source id>"]`,
and return `calendarWriters` from `activate()` keyed by source id. As with
senders, the host calls you only after a user confirmation gate, passes the
account's credentials in `ctx`, and drops a writer whose cap, manifest entry or
source is missing.

```ts
import type { CalendarWriter } from '@kiagent/connector-sdk';

const writer: CalendarWriter = {
  async listCalendars(ctx) {
    // WritableCalendar[]: { id, name, color, primary, canWrite, shared, timeZone }
    return [];
  },
  async createEvent(intent, ctx) {
    // intent.idempotencyKey is stable per create attempt; derive the provider's
    // idempotency id from it so a retry is safe.
    return { eventId: 'e1', iCalUID: null, htmlLink: null, conferenceUrl: null, conferencePending: false, note: null };
  },
  // Optional (platform 2.21.0). Without it the host answers with an error
  // starting `unsupported:`.
  async updateEvent(patch, ctx) {
    return { eventId: patch.eventId, htmlLink: null };
  },
};
```

`EventIntent` carries `calendarId`, `title`, `start`/`end` (a timed event is an
ISO instant with offset; all-day is `YYYY-MM-DD` with an exclusive end),
`timeZone`, `attendees`, `conference` (`'none' | 'auto'`) and `category`.
`EventPatch` addresses an event by `accountId`, `calendarId` and `eventId` and
changes only the fields present; `start`, `end` and `timeZone` travel together,
`location: null` clears the location, and for a recurring event the id is the
occurrence's, so only that occurrence changes. Timed events only. Throw an
`Error` with a message fit to show the user when the provider refuses.

---

## 8. Testing

Run `tsc --noEmit` via a `typecheck` script independently of your test suite:
the sample ts-jest configuration below disables TypeScript diagnostics.
Build/test against the pinned released SDK, not a freshly regenerated local
copy that silently contains newer contracts.

Your test suite is yours, but three things earn their keep:

**Pin the timezone.** If you bucket anything by day — a per-day document, a
day-start cursor clamp — put this at the top of `jest.config.js`:

```js
process.env.TZ = 'UTC';
module.exports = { testEnvironment: 'node', transform: { '^.+\\.tsx?$': ['ts-jest', { diagnostics: false }] } };
```

Then, because that pin *masks* local/UTC conflation bugs, add one suite that
actually varies the zone. A runtime `process.env.TZ` flip does not reach
Jest's test context (V8 caches dates per vm-context), so the honest version
bundles the real module with esbuild and runs it in child processes spawned
with different `TZ` values — see the Slack connector's `timezone.test.ts`.

**Assert the doc-type literals.** A test that pins `type` to `'file'` for
attachments is the cheapest possible guard against §5's silent-no-OCR
failure — that bug has no symptom at ingest time.

**Load the built bundle.** The CJS/ESM interop in `src/index.ts` is exactly
what breaks silently on an esbuild upgrade, and it breaks at *install* time,
in the user's app, not in your unit tests. Use `bundleLoadSmoke` from
`@kiagent/connector-sdk/testing` (see below) instead of hand-rolling this.

Building a `HostFor<G>` literal for the smoke is also how you prove your cap
list is honest: if the object type-checks with only the namespaces you
declared, you aren't reaching for anything you didn't ask for.

### The testing kit — `@kiagent/connector-sdk/testing`

The SDK ships a test-only subpath with the pieces every connector's suite
re-invents: `bundleLoadSmoke`, `jsonRes`, `scriptedFetch`, `fakeSession`,
`fakeAuthChannel`, `fakeFolderSelectionChannel`, `instantClock`. It is a **separate subpath, never
re-exported from the root** — it pulls in `node:child_process` and
`node:assert`, so importing it from anything your entry bundles would drag
both into `dist/index.js`. Import it only from test files.

`bundleLoadSmoke` replaces the hand-rolled snippet above:

```ts
import { join } from 'node:path';
import { LONE_ROLE, type HostFor } from '@kiagent/connector-sdk';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

test('bundle loads and activates', async () => {
  const host: HostFor<'net'> = {
    self: { id: 'slack', dataDir: '/tmp' },
    log: () => {},
    role: { get: async () => LONE_ROLE },
    net: { fetch: async () => { throw new Error('unused in this smoke test'); } },
  };
  await bundleLoadSmoke({
    root: join(__dirname, '..'),
    selfId: 'slack',
    sourceIds: ['slack'],
    senderIds: ['slack'],
    host,
  });
}, 30_000);
```

Three gotchas worth knowing before you script around them:

- **One process (or one root) per smoke.** `bundleLoadSmoke` `require()`s
  your built `dist/index.js`. Node's module cache is keyed by resolved path,
  so a second `bundleLoadSmoke` call against the same `root` in the same
  process gets back the first call's cached module, never a rebuild in
  between — run one smoke per process, or give each its own root.
- **`sourceIds` / `senderIds` are opt-in assertions, not defaults.** Each is
  only checked when you pass it; there's no "assert empty" fallback. A
  typo'd option name silently asserts nothing instead of failing loud. There is
  no equivalent for `calendarWriters`.
- **It runs your build first.** `bundleLoadSmoke` executes `npm run build` in
  `root` (override with `buildCommand`) before it `require()`s `dist/index.js`.
  Without a `host` option it activates against a minimal host that has only
  `self`, `log` and a `net.fetch` that throws.
- **`scriptedFetch`'s `inits` is index-aligned with `calls`.** `inits[i]` is
  the `init` argument passed to the request recorded at `calls[i]`
  (`undefined` for an init-less GET, recorded even for a call that throws) —
  the seam a send test uses to assert method/body on one specific call.

### End-to-end acceptance

For sources, verify first import, unchanged replay, changed content under
the same key, explicit deletion, multiple-account isolation, pagination,
restart before commit, expired cursors, revoked credentials, 429/5xx and
cancellation. Include incomplete upstream snapshots if the service can
return them. Binary sources need a deferred `fetchBytes` extraction check.
Tools need invalid-argument and missing-capability checks; senders need the
real confirmation path as well as transport unit tests.

Install in the real app (§9), grant permissions, connect an account, and
wait for a committed source batch. Use an MCP-connected client to `search`
for distinctive imported text and then `get` the returned document ID.
Confirm full content, updates and origin URLs. Standard ingestion already
provides search/get; a custom tool is only needed for additional behavior.
Test contributed tools via the client's tool list and an actual call too.

Hosted-client access depends on the product's Remote MCP configuration,
the client's support and an app that is running/reachable. A pasted origin
URL alone does not give the client access to the local corpus. Do not claim
end-to-end readiness from unit tests or a bundle-load smoke alone.

---

## 9. Running it locally before you publish

You do not need to cut a release to see your connector run. Boot-time
discovery scans the app's extensions directory for **any** subdirectory
containing a valid `manifest.json`:

```
<userData>/extensions/<any-dir-name>/
    manifest.json
    dist/index.js
    icon.png
```

The directory name is irrelevant (entries are keyed by manifest id). Build,
copy the package in, restart the app. The extension is discovered with
`origin: 'dev'` and is enabled by default.

Then two things will happen that look like bugs and aren't:

1. **It parks at `needs-consent` instead of activating.** A dev-dropped
   extension has no consent record. Open **Settings › Extensions** — your
   extension is listed under Installed with a **Review permissions** button.
   It activates immediately after you confirm.
2. **Every version bump re-parks it.** Consent is recorded against an exact
   manifest version, so bumping `manifest.version` during development sends
   you back to "Review permissions" each time. Expected; not a broken install.
   Leave the version alone while iterating and bump it once at release time.

Two caveats. There is **no UI for installing from a local path** — the
installer's local-path branch exists, but the app's Add flow only takes a
GitHub repository (§10), so the copy-the-directory route above is the dev
loop. And a dev install records no integrity pin, so none of §10's TOFU rules
bite yet — the first install of a given id+version from GitHub is what freezes
the hash.

---

## 10. Releasing

The marketplace catalog is a GitHub search: **`org:kia-plugins topic:kia-plugin`**.
So your repo must live in the `kia-plugins` org and carry the `kia-plugin`
topic to be discoverable in the store. The detail page renders your repo's
`README.md` at HEAD, and the pre-install icon is fetched from the fixed path
`icon.png` at the repo root (the manifest's icon path isn't knowable before
download).

### Installing from any GitHub repository

A user can also add a connector that is not in the store. The Add sheet takes
`owner/repo`, `owner/repo@tag`, `github:owner/repo[@tag]`, or a
`https://github.com/owner/repo` address (also `.git` or `/releases/tag/<tag>`).
A link `kiagent://install?repo=<owner>/<repo>[&tag=<tag>]` opens the sheet
prefilled; it works only in a product build that sets `urlScheme`. Outside
`kia-plugins` the sheet shows the repository and a "Not reviewed by KIAgent"
notice. What the installer does:

- The repository must be public. Renames and transfers are followed, and the
  repository's numeric id is recorded.
- With no tag, it takes the newest non-prerelease release that has a `.tgz`
  asset **and** whose `manifest.json` at that release's tag has an `engine`
  range admitting the running app. Keep `manifest.json` at the repo root for
  that reason. If only a newer release exists and it needs a newer app, the
  user sees "This connector needs a newer version of KIAgent." With `@tag`, that
  release must carry a `.tgz`.
- Guards run at preview, again before a running extension is stopped, and
  again at commit. An extension that is bundled with the app is never replaced
  (`'<id>' is bundled with the app and cannot be replaced from the
  marketplace`). An update from a different repository than the one installed
  is refused (`… a different publisher, so KIAgent won't replace it`). A
  connector installed from outside the store that declares an OAuth-bound
  source is refused (§3).
- The download is capped at 200 MiB, and extraction at 20,000 entries and 512
  MiB; a package containing links is refused.

### Which version matters

Bump the version in **both** `manifest.json` and `package.json`, but they do
different jobs and it's worth knowing which is which:

- **`manifest.version` is what the platform compares.** The installed
  extension's version comes from its manifest, and `checkUpdates` compares it
  against `semver.coerce(release.tag_name)` of the repo's newest non-
  prerelease release that has a package and that this app can run. **The
  load-bearing pairing is `manifest.version` ↔ the git tag.** Tag `v2.2.1` (or
  `2.2.1`) for manifest version `2.2.1`. A newer release that needs a newer app
  is shown to the user as "Needs a newer KIAgent", not offered.
- `package.json.version` names the `npm pack` tarball and nothing else. The
  installer takes the *first* `.tgz` asset on the release regardless of its
  name. Keep it in sync anyway — a mismatch is a lie in your repo that will
  eventually cost someone an hour.

### The release itself

```
npm run typecheck && npm test && npm run build
npm pack --dry-run   # inspect the shipped file list first
npm pack            # → slack-kia-connector-2.2.1.tgz
gh release create v2.2.1 slack-kia-connector-2.2.1.tgz
```

Your `package.json` `files` array must include `manifest.json`, `dist`, and
your icon:

```json
"files": ["manifest.json", "dist", "README.md", "icon.png"]
```

The tarball is extracted with `strip: 1`, which is exactly right for `npm
pack`'s `package/` prefix — `manifest.json` must land at the top level after
that strip.

Two package-level rejections to know about:

- **Never ship a `data/` directory.** `data/` is reserved for extension-private
  state and a package containing one is refused at preview.
- A source id another installed extension already provides fails the install.

### Integrity pinning and consent

The first install of a given **id + version** freezes a `sha512` integrity
hash. Re-installing that same id+version with different bytes is rejected
(`integrity check failed: bytes differ from the pinned install for this
version`). Practical consequence: **never re-tag or replace a published
release's tarball.** Cut a new patch version instead. Plain `http:` refs are
rejected outright.

Install and update both run the same three phases: preview (download, pin,
extract to staging, validate the manifest — *no extension code executes*),
consent, commit. The consent sheet shows the **full capability list** every
time, not a diff of what changed — so an update that adds a cap is visible,
but so is every cap you already had. Consent is recorded against the exact
manifest version and cap set; an installed extension whose manifest no longer
matches its consent record parks at `needs-consent` and the user gets a
"Review permissions" button instead of a running extension.

One last thing: an extension **cannot be uninstalled while accounts exist for
its sources** ("Remove this connector's sources before uninstalling it"). Say
so in your README if your connector is likely to be trialled and dropped.

---

## Checklist

- [ ] `manifest.json` `id` is `publisher.name`, `engine` range starts at the
      platform that introduced every feature you use and covers the platform you
      tested against; `manifest.json` is also at the repo root
- [ ] `caps` lists only what you use; typed as `ExtensionModule<…>` to match
- [ ] `@kiagent/connector-sdk` devDependency present, pinned to a `sdk-v*`
      release tarball, `kiagentCore` matching the platform you tested against
- [ ] No `oauth` source binding unless the connector ships through the store
- [ ] Secret collected in a prompt field named exactly `password` (or via
      `auth.oauth`) — nothing secret in `connect()`'s returned `config`
- [ ] `fetchBytes` implemented if you emit any binary content
- [ ] Binary documents typed `'file'` or `'attachment'`, with `metadata.mime`
      / `filename` / `sizeBytes`
- [ ] `reconcile` (if any) yields the same `{externalId, type}` keys
      `toDocument` emits, from a shared builder — tested on a corpus over 100
      documents
- [ ] Auth failures throw `SourceAuthError` (or `code: 'auth'`)
- [ ] Sender auth failures end with `reconnect … in Settings`
- [ ] `TZ=UTC` pinned in jest config; bundle-load test present
- [ ] `manifest.version` == `package.json` version == git tag
- [ ] `files` in `package.json` includes `manifest.json`, `dist`, `icon.png`;
      no `data/` directory in the tarball
- [ ] Repo in `kia-plugins` with the `kia-plugin` topic, `icon.png` and
      `README.md` at the root
