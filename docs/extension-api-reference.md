# Extension API reference

This document currently documents `host.attention`, `host.secrets`, `host.prefs`,
`host.role`, manifest `fileRoots`, the folder-scope additions of platform 2.4.0, and a few
smaller host-surface additions (`documentPage`, the newer `host.inference` options,
`McpTool.overview`). The build-and-ship walkthrough, the manifest and the Source and Sender
contracts are in [`connectors-authoring-guide.md`](connectors-authoring-guide.md). The types
come from `@kiagent/connector-sdk`; the current platform API is **2.21.0** (`PLATFORM_API_VERSION`
in `src/shared/extension-rpc.ts`) and the current SDK is **1.14.0**.

## `host.attention`

Extensions granted the `attention` capability publish their complete open-item
snapshot through `host.attention`:

```ts
await host.attention.publish(items); // { rejected: { id, reason }[] }
await host.attention.resolve(id, revision?); // { rejected: { id, reason }[] }
```

`publish` is always the complete set for that producer. An empty array means
that the producer has nothing open. The producer identity is bound by the host;
the payload cannot publish for another extension. The acknowledgement arrives
after the database transaction commits. A rejected validation result is
returned in `rejected` and is not partially stored.

The field rules (id format, text limits, at most 3 actions) are in
[`writing-extensions.md`](writing-extensions.md). A batch with any invalid item is
rejected whole.

There is no `list` or `dismiss` method on the extension surface. Core-owned UI
reads the resulting feed. Mutations may reject with `ATTENTION_TX_FAILED` or
`ATTENTION_OUTCOME_UNKNOWN`; a closed attention database rejects publish and
resolve with `ATTENTION_DB_UNAVAILABLE`; after service shutdown they reject
with `ATTENTION_DISPOSED`.

## `host.secrets`

Bundled extensions granted the `secrets` capability (rejected for any other tier)
keep one account-wide secret per name:

```ts
await host.secrets.get(name); // string | null
await host.secrets.put(name, value); // rejects with SyncReadOnly on a read-only copy
const off = host.secrets.onChange((name) => {}); // own put, or a secret arriving from the leader
```

`name` matches `/^[a-z0-9-]{1,40}$/`, and the value must be a string. The value is stored
encrypted as the vault row `secret:<extension id>:<name>`, so it travels to the other devices
like a login. The extension id is the caller's own and is never an argument.

## `host.prefs`

An extension granted the `prefs` capability keeps settings that belong to the user. They are
stored under `<extension id>.<name>` in the `user_prefs` table and reach every device. Unlike
`secrets`, `prefs` is not restricted to bundled extensions.

```ts
await host.prefs.get(name); // unknown | undefined
await host.prefs.set(name, value); // value must be JSON
const off = host.prefs.onChange((name, value) => {}); // another device changed one
```

`name` is a non-empty string without dots. On a device that is not the leader, `set` is
stored by the leader and rejects when the leader cannot be reached.

## `host.role` and the `sync.role` event

Every host has `host.role.get()`, with no capability needed. It resolves to a `SyncRoleWire`:
`leader`, `follower`, `multiDevice`, `epoch`, `priorRenewedAt` and `reason`. A device that is
alone reports `leader: true`. With the `events` capability, the platform event `sync.role`
fires on every change, with the same object as its payload:

```ts
import type { SyncRoleWire } from '@kiagent/connector-sdk';

const role = await host.role.get();
const off = host.events.on('sync.role', (payload) => {
  const next = payload as SyncRoleWire;
  if (next.leader) { /* start work that only the leader should do */ }
});
```

## `documentPage`

`host.query.documentPage` pages documents by type. It is optional on the `Query` type, so
call it as `host.query.documentPage?.(...)`. Besides `afterId`, `limit` and `types` it takes:

- `afterSeq` (platform 2.9.0) — rows whose change `seq` is greater, oldest change first. Archived rows are
  included (check `archivedAt`) so a consumer can drop what it derived from them; `afterId`
  is ignored when `afterSeq` is set.
- `topLevel: true` — only documents without a parent (attachments and other child documents
  are skipped before paging).

## `host.inference` options

Beyond `complete`, `see`, `read`, `hear`, `lane()` and `describe(kind, { lane })`, the
extension surface has:

- `complete(prompt, opts)` with `profile: 'deterministic'`, `system`, `generation` (the token
  from `describe()`; a stale one rejects with `ModelChangedError`), `task`, `budgetKey`, and
  two options that constrain local decoding and are ignored by remote providers:
  `schema` (a JSON Schema the reply must match; best effort, so still validate the reply) and
  `grammar` (a GBNF grammar; exclusive with `schema`). `grammar` arrived in platform 2.9.0.
- `completeWithMeta(prompt, opts)` — the same options, plus `topLogprobs: n`, and resolves to
  `{ text, providerId, modelId, firstTokens? }`. `firstTokens` lists the top-n alternatives of
  the first generated token and is local only.
- `embed(texts, { task? })` (platform 2.11.0) — resolves to `{ vectors: Float32Array[], modelId }`,
  one vector per input text in order. It runs on the background lane only.

Errors cross the extension boundary as plain `Error`s, so discriminate on `err.name`, never
`instanceof`: `LaneClosedError` (the background lane is closed, or the local model is held for
another kind), `ContextOverflowError` (the request did not fit the model's context; retry with a
smaller prompt) and `ModelChangedError`.

## MCP tools: `overview`

An `McpTool` returned from `activate()` may set `overview: true`. `digital_memory_info` then
calls it with no arguments and includes the result under `more[<tool name>]`, so a client sees
what the tool offers without a separate call. The tool must answer a call with `{}` quickly and
with a small result. `foreground: false` opts a tool out of pausing background ingest while it
runs, for a tool that waits on that very work. `tier` is advisory metadata only.

## Manifest `fileRoots` (platform 2.3.0)

A marketplace extension that needs to read local folders declares them in its
manifest. The user approves them together with the capabilities at install;
there is no runtime folder prompt.

```json
{
  "engine": "^2.3.0",
  "caps": ["files"],
  "fileRoots": [
    { "id": "claude", "path": "~/.claude", "purpose": "Claude Code session history" }
  ]
}
```

- `id` matches `^[a-z][a-z0-9-]{0,31}$` and is unique; it is the root id the
  extension passes to `host.files`.
- `path` starts with `~/` and names a folder under the user's home: no empty,
  `.` or `..` segments, not `~/` itself, not `~/Library` or a folder directly
  inside it. `purpose` is 1–200 characters and is shown on the consent screen.
- At most 8 roots. Requires the `files` capability. Marketplace (external)
  tier only — bundled extensions use `mainApi.grantRoot`.
- Every root is **read-only**.

**Consent.** The consent record stores the declared `{id, path}` pairs. An
update is covered while every root it declares was consented (a subset, like
capabilities); a new or changed root puts the extension in `needs-consent`
and revokes its folders until the user reviews it.

**Granting.** Each time the extension activates, the platform revokes its
folders and grants every declared root that exists. The realpath must stay
inside the home folder and must not overlap the app's own data folder or
`~/Library` (or one level below). A missing folder is skipped, not an error.
Folders are revoked on disable, uninstall and consent lapse. A folder created
after the extension activated is picked up on the next activation (for
example, after restarting KIA).

**Using it.** `host.files.roots()` returns
`[{ id, name: '<declared ~/ path>', writable: false }]` for the granted roots;
a declared root that is absent from the list was not granted (see the log).

## Folder scope: `archiveRefs` and the picker note (platform 2.4.0)

A connector with `folderScope: true` edits its scope through
`manageFolders`, which returns a `FolderScopeUpdate`. Platform 2.4.0 adds two
optional fields. Declare `"engine": "^2.4.0"` to use them.

- `FolderScopeUpdate.archiveRefs?: ExternalRef[]` — exact per-document
  archival, for documents that span folders (an Outlook conversation lives in
  Inbox AND Sent) so no single `scope_root_id` says "this leaves scope". Core
  archives each ref in the same transaction as the config write, after the
  stamp archive (`archiveScopeRootIds`); a ref that is already archived or
  unknown is a no-op. Build the refs with the same helper that builds the
  emitted documents' `externalId` and `type`.
- `FolderPickerSpec.note?: string` — one muted line the picker shows above
  its Save button, the connector's own word on what Save does. Display only.

A scope Save also grants the account's next reconcile pass an allowance:
`full` when the Save archived rows (both mass-archive refusals are waived),
`ratio` for a first declaration or an unchanged re-save (only the >50%
shrink refusal is waived). An account whose config declares no
`folderRoots`, `roots` or `paths` runs no reconcile until its first Save.
