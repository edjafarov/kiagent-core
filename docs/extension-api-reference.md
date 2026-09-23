# Extension API reference

This document currently documents `host.attention` and manifest `fileRoots`.

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
