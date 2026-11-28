# Writing extensions

This document currently documents only `host.attention`. For the manifest,
the Source/Sender contracts and the rest of the host surface, see
[`connectors-authoring-guide.md`](connectors-authoring-guide.md); for
`host.secrets`, `fileRoots` and the folder-scope fields, see
[`extension-api-reference.md`](extension-api-reference.md).

## Publishing attention items

Request the `attention` capability and publish a full snapshot after your
authoritative work has committed:

```js
await host.attention.publish([
  {
    id: `${host.self.id}:invoice-123`,
    producer: host.self.id,
    kind: 'waiting',
    title: 'Invoice needs review',
    detail: null,
    priority: 2,
    dueAt: null,
    expiresAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    revision: 1,
    state: 'open',
    resolvedBy: null,
    actions: [],
  },
]);
```

`host` here is `HostFor<'attention'>` (declare `"caps": ["attention"]` in the
manifest). Each call is the complete open set for the extension; publish `[]` when no
items remain. The returned acknowledgement is made only after the change is
committed. Use `host.attention.resolve(id, revision)` for a targeted producer
resolution. There is intentionally no extension-side list or dismiss API.

The host validates every item and rejects the whole batch, storing nothing, if
one is invalid; the reasons come back in `rejected`. The rules, from
`src/main/attention/validate.ts`:

- `producer` is your extension id, and `id` starts with `<producer>:`, uses
  only `[a-z0-9._:-]` and is at most 120 characters. Ids are unique within a
  batch.
- `kind` is `'waiting'`, `'happening'` or `'upcoming'`; `priority` is 1, 2 or 3.
- `title` is 1 to 80 characters and `detail` at most 160, single-line.
- `revision` is a positive integer; `createdAt` and `updatedAt` are required
  timestamps in milliseconds, `dueAt` and `expiresAt` are a timestamp or `null`.
- `state` and `resolvedBy` must agree: `open` and `expired` need `resolvedBy: null`; `resolved` needs `'producer'` or `'user'`.
- At most 3 `actions`, each `{ id, label, target: { view, params? } }`, with a
  label of at most 24 characters. The `view` and the `params` keys must be on the
  product's attention allow-list; anything else rejects the item.
- `people` is optional, at most 8 entries of `{ kind: 'email' | 'chat-handle' |
  'speaker', namespace?, value }`. A `namespace` is required unless the kind is
  `email`, and an email value must be lower case.

Handle `ATTENTION_TX_FAILED`, `ATTENTION_OUTCOME_UNKNOWN`,
`ATTENTION_DB_UNAVAILABLE`, and `ATTENTION_DISPOSED` as rejected calls.
`ATTENTION_DB_UNAVAILABLE` can be returned by both `publish` and `resolve`.
Attention work is independent of
extension-call cancellation, so an admitted publication can still commit.
