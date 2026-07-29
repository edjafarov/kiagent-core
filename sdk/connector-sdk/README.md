# @kiagent/connector-sdk

Contracts, source-error taxonomy, and shared utilities for building a
third-party [KIAgent](https://github.com/edjafarov/kiagent-core) connector.
This package is the vendoring target described in
[`docs/connectors-authoring-guide.md`](https://github.com/edjafarov/kiagent-core/blob/main/docs/connectors-authoring-guide.md)
extracted so nine (and counting) connector repos stop hand-copying the same
files.

It is **generated, not hand-written**: `contracts.ts` and `source-errors.ts`
are copied verbatim from `kiagent-core`'s `src/shared/` at build time, so a
connector compiling against a given SDK version is compiling against exactly
the platform types that version was cut from.

## Install

Not on the npm registry — installed straight from a GitHub release tarball,
same TOFU shape as a connector's own release:

```json
{
  "devDependencies": {
    "@kiagent/connector-sdk": "https://github.com/edjafarov/kiagent-core/releases/download/sdk-v1.0.0/kiagent-connector-sdk-1.0.0.tgz"
  }
}
```

It's a **devDependency**, not a runtime one — but that doesn't mean
types-only. Your `build.mjs` (esbuild) bundles the parts you actually
`import` (e.g. `SourceAuthError`, `requestWithRetry`) straight into your
`dist/index.js`; nothing resolves `@kiagent/connector-sdk` at the installed
extension's runtime. Only `/testing` (see below) is exempt — it never ends up
in a shipped bundle.

`npm install -D <url above>` (or paste the line and `npm install`). The
package uses classic Node module resolution — no `exports` map — so each
subpath below resolves via a small stub file at the package root
(`http.js` → `dist/http.js`, etc.), which is what makes
`@kiagent/connector-sdk/http` resolvable under a plugin's own
`moduleResolution: "node"` `tsconfig.json` without any extra config.

## The four entrypoints

### `@kiagent/connector-sdk` — contracts + source-error taxonomy

Everything in `src/shared/contracts.ts` and `src/shared/source-errors.ts` at
the pinned core vintage: `ExtensionModule`, `Source`, `Sender`, `Session`,
`AuthChannel`, `Account`, `Credentials`, `HostFor`, `SourceAuthError`,
`SourcePermanentError`, `sourceErrorCode`, and the rest of the surface
(§7 of the authoring guide).

```ts
import type { ExtensionModule, Source, Session } from '@kiagent/connector-sdk';
import { SourceAuthError } from '@kiagent/connector-sdk';

async function requireToken(session: Session): Promise<string> {
  const creds = await session.credentials();
  if (!creds?.password)
    throw new SourceAuthError('no credentials — reconnect the account');
  return creds.password;
}
```

### `@kiagent/connector-sdk/http` — the retry ladder

`requestWithRetry`, `retryAfterMs`, and the `NetFetch` / `HostResponse` /
`RetryPolicy` types, extracted from the Slack connector's client: transient
network/5xx errors retried with exponential backoff, 429s retried on their
own budget honoring a clamped `Retry-After`.

```ts
import { requestWithRetry, type HostResponse } from '@kiagent/connector-sdk/http';

const res: HostResponse = await requestWithRetry(
  () => host.net.fetch('https://slack.com/api/conversations.history') as Promise<HostResponse>,
  { label: 'slack conversations.history' },
);
```

### `@kiagent/connector-sdk/chat-day` — day-doc rendering

`dayKey`, `dayTitle`, `mergeMessages`, `renderDay`, and the
`NormalizedMessage` / `MediaDescriptor` / `MediaKind` types: normalize,
dedupe-and-merge, and render a day's worth of chat messages into a day
document's markdown body. Every rendering rule is a byte-for-byte contract
with existing day docs — no per-platform knowledge lives here.

```ts
import { dayKey, mergeMessages, renderDay, type NormalizedMessage } from '@kiagent/connector-sdk/chat-day';

const merged = mergeMessages(existing, incoming, (m) => m.tsMs);
const body = renderDay(merged);
const key = dayKey(merged[0].tsMs); // 'YYYY-MM-DD', for the day doc's externalId
```

### `@kiagent/connector-sdk/testing` — the shared test kit

`bundleLoadSmoke`, `jsonRes`, `scriptedFetch`, `fakeSession`,
`fakeAuthChannel`, `instantClock`. Generalized from the ms365 connector's
harness. **Test-only** — it pulls in `node:child_process` and `node:assert`,
which is exactly why it is its own subpath instead of living in the root
export: importing it from anywhere your entry bundles would drag those two
modules into `dist/index.js`.

```ts
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

test('bundle loads and activates', async () => {
  await bundleLoadSmoke({
    root: __dirname + '/..',
    selfId: 'slack',
    sourceIds: ['slack'],
    senderIds: ['slack'],
  });
}, 30_000);
```

Two things that will bite you if skipped:

- **One process (or one root) per smoke.** `bundleLoadSmoke` loads your built
  bundle with a plain `require`. Node's module cache is keyed by resolved
  path, so a second `bundleLoadSmoke` call against the *same* `root` in the
  same process gets back the first call's cached module — it never sees a
  rebuild in between. Give each smoke its own process, or its own `root`.
- **A typo'd option asserts nothing.** `sourceIds` and `senderIds` are each
  only checked when you pass them — there's no "assert empty" default. Spell
  the option name right, or the smoke passes while checking nothing about
  your sources/senders.

`scriptedFetch(...)` returns `{ fetchFn, calls, inits }`: `calls` is every
request URL in order, and `inits` is index-aligned with it (`inits[i]` is the
`init` object passed to `calls[i]`'s request, `undefined` for an init-less
GET) — the seam a send test uses to assert method/body on the one call it
cares about.

## Versioning

- `package.json` `version` is this package's own semver.
- `package.json` `kiagentCore` names the `kiagent-core` version the generated
  contracts were copied from — bump it whenever the contracts vintage
  changes, independently of `version`.

## Release

```
# bump version (and kiagentCore, if the contracts vintage changed) in package.json
scripts/release.sh
```

`release.sh` runs `npm test`, `npm pack`, and publishes
`gh release create sdk-v<version>` with the `.tgz` attached, on
`edjafarov/kiagent-core`. The resulting asset is what the devDependency line
above points at.
