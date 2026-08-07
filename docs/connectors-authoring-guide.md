# Connector authoring guide

How to build, test and ship a third-party connector for KIAgent.

A **connector is an extension** — there is no separate connector concept. You
write one CJS bundle, declare a manifest, and return a `Source` (and
optionally a `Sender`) from `activate()`. The app installs it from a GitHub
release, runs it in its own process, and drives it.

This guide is the build-and-ship walkthrough. For *how the platform works*
— process model, the capability gate, the bundled/privileged tier — read
[`docs/architecture/extension-platform.md`](architecture/extension-platform.md)
first; it is the model, this is the recipe.

The worked example throughout is the published Slack connector
(`kia-plugins/slack-kia-connector`), which uses every mechanism described
here.

---

## 1. The contract is the SDK

The extension-facing API is
[`src/shared/contracts.ts`](../src/shared/contracts.ts) (§7 in particular) plus
the runtime error classes in
[`src/shared/source-errors.ts`](../src/shared/source-errors.ts) — republished,
generated verbatim at build time, as
[`@kiagent/connector-sdk`](https://github.com/edjafarov/kiagent-core/tree/main/sdk/connector-sdk).
Add it as a devDependency, pointed at the tagged release tarball (not the npm
registry):

```json
"devDependencies": {
  "@kiagent/connector-sdk": "https://github.com/edjafarov/kiagent-core/releases/download/sdk-v1.0.0/kiagent-connector-sdk-1.0.0.tgz"
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
[`src/shared/extension-rpc.ts`](../src/shared/extension-rpc.ts) — **`2.0.0`** at
the time of writing. Your manifest's `engine` range is checked against it at
install. 2.0.0 removed tolerance, not surface: manifests are parsed strictly
(unknown keys reject instead of being silently stripped) and
`contributes.senders` must be stated explicitly. An extension that works on
both the 1.2.0 and 2.0.0 platforms can declare `"engine": ">=1.2.0 <3.0.0"`.

### What is not plumbed yet

`ExtensionModule.activate()` returns any mix of `{ sources, tools, senders }`
— exactly what the wire protocol (`Contributions` in `extension-rpc.ts`)
carries.

The `files` and `commands` capabilities validate and consent
normally but **throw on every call** (`the 'files' capability is not supported
in this build yet` — see `src/main/platform/host-surfaces.ts`). Declaring them
buys you a scarier consent screen and nothing else.

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

The whole manifest is parsed **strictly**: a key the platform doesn't know
(top-level, inside `contributes`, or inside a `sources` object entry) rejects
the manifest instead of being silently ignored.

### caps

The eight namespace-granting caps (`query`, `net`, `files`, `db`, `ui`,
`commands`, `inference`, `events`) are tabulated in the
[architecture doc](architecture/extension-platform.md#capabilities). What you
need to *do* about them:

- Declare only what you use. Every cap is shown to the user before install.
- `send` grants **no host namespace**. It gates whether the main process will
  register your `contributes.senders` — see §7.
- `unsafe.mainProcess` is rejected outright for anything not shipped inside
  the app bundle. You cannot use it.
- `inference` calls are **forced onto the `'interactive'` lane** by the host
  surface, whatever `lane` you pass. Don't design around a background lane.
- `net.fetch` accepts `http(s)` URLs only, reaches **public internet
  destinations only**, and caps a response body at 50 MiB. Loopback, RFC1918
  LAN, link-local (including cloud metadata endpoints), CGNAT, IPv6
  unique-local, multicast and reserved addresses are refused — both when named
  directly and when a hostname resolves to one. Redirects are followed
  manually, up to 5 hops, and every hop is re-checked against the same policy;
  `authorization`/`cookie` headers are dropped when a redirect changes origin.
  If your service genuinely lives on a private address, open an issue rather
  than working around this.
- `db` gives you `private.db` in your own `host.self.dataDir` — never the
  shared corpus. There is no write path to the corpus except returning
  documents. Statements are policed by leading keyword: ordinary DML, DDL and
  transaction control are fine, but anything that can name a second database
  file is refused — `ATTACH`, `DETACH`, `VACUUM INTO`. `PRAGMA` is refused
  except for a self-scoped set (`user_version`, `application_id`, `table_info`,
  `table_list`, `table_xinfo`, `index_info`, `index_list`, `foreign_keys`,
  `foreign_key_list`, `page_count`, `freelist_count`, `integrity_check`,
  `quick_check`) — `user_version` is there so the usual migration idiom works.
- `events` refuses to emit names starting `extension.` or `platform.` (those
  are platform-emitted).

### contributes

- `sources: ["slack"]` — plain source ids, or `{ "id": "google-docs", "oauth":
  "google" }` to bind a source to a platform OAuth provider (`google` or
  `microsoft`, per `OAUTH_PROVIDER_IDS`). The binding is what makes
  `auth.oauth(scopes)` work in your connect flow and gets you platform-side
  token refresh before each pull — **the client secret stays main-side and you
  never see it.** OAuth-bound sources are surfaced separately at consent, so
  the user knows a provider sign-in window is coming before they install.
- `senders: ["slack"]` — source ids you provide an outbound transport for.
  **Required** (use `[]` for none). Each entry must also be a source *this
  same extension* contributes; the platform drops senders for ids you didn't
  declare or didn't return.
- `tools`, `commands` — declared tool/command ids; see §1's "not plumbed
  yet" for the `commands` capability caveat.

A source id already registered by another extension makes the install fail
(`source id 'slack' is already provided by kia.other`). Namespace yours if
there's any chance of collision.

---

## 4. The Source

```ts
interface Source<Cursor, Item> {
  readonly descriptor: SourceDescriptor;
  connect(auth: AuthChannel): Promise<{ identifier: string; config?: Record<string, unknown> }>;
  pull(session: Session, cursor: Cursor | null): AsyncIterable<Batch<Cursor, Item>>;
  toDocument(item: Item): DocumentInput | DocumentInput[] | null;
  fetchBytes?(session: Session, doc: Document): Promise<Uint8Array | null>;
  reconcile?(session: Session): AsyncIterable<ExternalRef[]>;
}
```

You do not write a sync loop, a retry policy, a backoff, a progress counter,
or a cursor store. The engine
([`src/main/core/engine/engine.ts`](../src/main/core/engine/engine.ts)) owns all
of it and commits your batch and your cursor in **one transaction**, so
"cursor advanced but rows lost" is not a state the store can reach.

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
`multiAccount` render in the source's config panel; `auth` is declarative and
currently has no runtime consumer. `id` must match a `contributes.sources`
entry or the platform logs a warning and skips your source.

### connect() and the AuthChannel

`connect()` returns **`{ identifier, config }` and no secrets**. Secrets reach
the encrypted vault by a different route, and this is the single most
important thing to get right:

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
`connect()` returns. Nothing else you collect is persisted as a secret — it
lands in `config`, which is *not* encrypted and is meant for non-secret
settings (workspace url, team id, selected folders).

> **If your token is not in a prompt field named `password`, it is never
> saved.** `session.credentials()` will return `null` on the first pull and
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
}
```

`externalId` + `type` is your document's natural key, and the only way you
ever refer to a document (parentage, deletions, reconcile). You never hold a
DB id.

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
path: PDF, DOCX, HTML, CSV, XLSX and text go through deterministic parsers
([`src/main/core/engine/convert.ts`](../src/main/core/engine/convert.ts)).
Images, unknown binaries and text-poor PDFs (a scan) stay `markdown: null` and
fall through to the vision worker's two-pass OCR/VLM pipeline. Conversion
keys off `binary.mime` and `binary.filename`, not off `type` — but the
*second* pass keys off `type`, so you need both right.

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

**Extension senders are reply-only today.** `SendIntent.kind` is typed
`'reply' | 'new'`, but composing a new message goes through `draft_message`,
which resolves a From address via `senderAddressFor` — and that throws
`compose is email-only — '<source>' accounts are reply-only` for any source
that isn't `imap` or `gmail`. So in practice your `send()` only ever sees
`kind: 'reply'`, always with an `outboundRef`. You still need to have written
`metadata.outbound` (§5) for any of it to happen: no `outbound` metadata, no
reply target, no send.

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
match. (Your *source* errors are a different mechanism — those classify by
`code`, per §6. Slack's source throws `— reconnect the account`; its sender
throws `— reconnect the account in Settings`. Both are correct for their
path.)

---

## 8. Testing

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
`fakeAuthChannel`, `instantClock`. It is a **separate subpath, never
re-exported from the root** — it pulls in `node:child_process` and
`node:assert`, so importing it from anything your entry bundles would drag
both into `dist/index.js`. Import it only from test files.

`bundleLoadSmoke` replaces the hand-rolled snippet above:

```ts
import { join } from 'node:path';
import type { HostFor } from '@kiagent/connector-sdk';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

test('bundle loads and activates', async () => {
  const host: HostFor<'net'> = {
    self: { id: 'slack', dataDir: '/tmp' },
    log: () => {},
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
  typo'd option name silently asserts nothing instead of failing loud.
- **`scriptedFetch`'s `inits` is index-aligned with `calls`.** `inits[i]` is
  the `init` argument passed to the request recorded at `calls[i]`
  (`undefined` for an init-less GET, recorded even for a call that throws) —
  the seam a send test uses to assert method/body on one specific call.

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
   extension has no consent record. Open **Marketplace** — your extension
   appears as its own row below the catalog ones, subtitled
   `v1.0.0 · dev install` — and click **Review permissions**. It activates
   immediately after you confirm.
2. **Every version bump re-parks it.** Consent is recorded against an exact
   manifest version, so bumping `manifest.version` during development sends
   you back to "Review permissions" each time. Expected; not a broken install.
   Leave the version alone while iterating and bump it once at release time.

Two caveats. There is **no UI for installing from an arbitrary path** — the
installer's local-path branch exists, but the only ref the app's Install
button ever passes comes from a catalog row, so the copy-the-directory route
above is the dev loop. And a dev install records no integrity pin, so none of
§10's TOFU rules bite yet — the first *marketplace* install of a given
id+version is what freezes the hash.

---

## 10. Releasing

The marketplace catalog is a GitHub search: **`org:kia-plugins topic:kia-plugin`**.
So your repo must live in the `kia-plugins` org and carry the `kia-plugin`
topic to be discoverable. The detail page renders your repo's `README.md` at
HEAD, and the pre-install icon is fetched from the fixed path `icon.png` at
the repo root (the manifest's icon path isn't knowable before download).

### Which version matters

Bump the version in **both** `manifest.json` and `package.json`, but they do
different jobs and it's worth knowing which is which:

- **`manifest.version` is what the platform compares.** The installed
  extension's version comes from its manifest, and `checkUpdates` compares it
  against `semver.coerce(release.tag_name)` of the repo's newest non-
  prerelease release. **The load-bearing pairing is `manifest.version` ↔ the
  git tag.** Tag `v2.2.1` (or `2.2.1`) for manifest version `2.2.1`.
- `package.json.version` names the `npm pack` tarball and nothing else. The
  installer takes the *first* `.tgz` asset on the release regardless of its
  name. Keep it in sync anyway — a mismatch is a lie in your repo that will
  eventually cost someone an hour.

### The release itself

```
npm test && npm run build
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

- [ ] `manifest.json` `id` is `publisher.name`, `engine` range covers the
      platform you tested against
- [ ] `caps` lists only what you use; typed as `ExtensionModule<…>` to match
- [ ] `@kiagent/connector-sdk` devDependency present, pinned to a `sdk-v*`
      release tarball, `kiagentCore` matching the platform you tested against
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
