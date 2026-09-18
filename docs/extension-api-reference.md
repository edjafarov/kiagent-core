# Extension API reference

This document currently documents only `host.attention`.

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
