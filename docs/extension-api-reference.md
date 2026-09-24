# Extension API reference

This document currently documents `host.attention`, manifest `fileRoots` and
the folder-scope additions of platform 2.4.0.

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

There is no `list` or `dismiss` method on the extension surface. Core-owned UI
reads the resulting feed. Mutations may reject with `ATTENTION_TX_FAILED` or
`ATTENTION_OUTCOME_UNKNOWN`; a closed attention database rejects publish and
resolve with `ATTENTION_DB_UNAVAILABLE`; after service shutdown they reject
with `ATTENTION_DISPOSED`.

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
