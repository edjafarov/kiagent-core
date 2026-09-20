# Writing extensions

This document currently documents only `host.attention`.

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

Each call is the complete open set for the extension; publish `[]` when no
items remain. The returned acknowledgement is made only after the change is
committed. Use `host.attention.resolve(id, revision)` for a targeted producer
resolution. There is intentionally no extension-side list or dismiss API.

Handle `ATTENTION_TX_FAILED`, `ATTENTION_OUTCOME_UNKNOWN`,
`ATTENTION_DB_UNAVAILABLE`, and `ATTENTION_DISPOSED` as rejected calls.
`ATTENTION_DB_UNAVAILABLE` can be returned by both `publish` and `resolve`.
Attention work is independent of
extension-call cancellation, so an admitted publication can still commit.
