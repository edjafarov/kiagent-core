# Connector authoring guide

How to add a new data-source connector to KIAgent **without re-introducing the
mistakes we've already paid for**. This is the cross-cutting guide; per-source
design rationale lives in `docs/superpowers/specs/*-connector-design.md`.

A connector pulls a personal/team source (Gmail, Slack, Notion, WhatsApp,
browser history, a local folder…) into the indexed corpus. The subsystem
already carries a real shared layer — **your job is mostly to fill in
source-specific gaps, not to rebuild the pipeline.** Most of the recurring bugs
below came from re-implementing something that was already shared, or from
forgetting one of the ~7 places a connector has to be wired in.

---

## 1. The contract

Two interfaces in `src/main/connectors/types.ts`:

- **`Connector`** (`types.ts:42`) — the static descriptor, one per source:
  `id`, `displayName`, `capabilities` (`multiAccount`, `requiresAuth`,
  `supportsBackfill`, `supportsDelta`, `supportsRealtime`), plus
  `getAccountSchema()`, `validateAccount(input)`, `createInstance(account, ctx)`.
- **`ConnectorInstance`** (`types.ts:54`) — the live per-account object the
  scheduler drives: `startBackfill(progress)`, `pollDelta()`, optional
  `startRealtime?/stopRealtime?`, `requestStop?()`, `shutdown()`,
  `buildSourceUrl(...)`.

Register it in **one** place: `registerBuiltinConnectors` in
`src/main/connectors/index.ts`. The `ConnectorRegistry`
(`src/main/scheduler/registry.ts`) throws on duplicate ids.

The scheduler (`src/main/scheduler/scheduler.ts`) does the rest automatically:
it builds a per-account `ctx`, runs backfill **detached** (a Gmail backfill can
take hours), flips `sync_state.status` to `live`, then polls `pollDelta` on a
focus-aware cadence (30s focused / 120s unfocused / 600s tray, overridable per
source via the `connector_cadence` table). Auth failures flip to
`needs_reauth`; other errors to `error`. **You do not write the sync loop.**

---

## 2. Reuse the shared layer — do not rebuild it

Before writing anything, know what already exists. Most duplication bugs are
"I didn't know this was shared."

| Need | Use | Where |
|---|---|---|
| Write a doc (UPSERT + FTS + trigram + language + `account_id`) | `ctx.upsertDocument(pending)` | `context/connector-context.ts:111` |
| Delete / archive a doc | `ctx.deleteDocument` / `ctx.archiveDocument` | `connector-context.ts:173` |
| Dedupe by source id / content hash | `ctx.findBySourceId` / `ctx.findByContentHash` | `connector-context.ts:202` |
| Load/save the delta cursor & status | `ctx.loadSyncState` / `ctx.saveSyncState` | `connector-context.ts:258` |
| Reset sync-state for re-backfill | `resetSyncStateForBackfill` / `setSyncStatus` | `db/sync-state.ts:24` |
| Create / restart an account | `upsertAccountWithFreshSyncState` + `restartAccountAndBroadcast` | `accounts/persist.ts:40` |
| Full OAuth instance (backfill/delta/token-refresh skeleton) | `createOAuthInstance` | `connectors/oauth-shared/create-instance.ts:51` |
| Encrypted token blob (encode/decode/save/load) | `oauth-shared/safe-storage-blob.ts` | — |
| GET HTTP client with retry/timeout/backoff | `http-shared/bearer-fetch.ts` | — |
| Convert raw html/text/pdf/docx/xlsx → markdown | `ctx.converter.convert(...)` | `converter/index.ts` |
| Counts / last-doc / purge | `countDocumentsForAccount`, `recentDocumentsForAccount`, `collectAccountDocumentIds` | `db/recompute-counts.ts` |
| Per-source UI row, badge, doc count, actions | one `CONNECTOR_REGISTRY` entry | `renderer/connectors-registry.ts` |
| Management IPC (list/sync/pause/remove/retry/cadence) | already generic | `ipc/connector-lifecycle-handlers.ts` |

**OAuth connectors** (gmail, google-docs, ms365, onedrive) are ~30-line adapters
around `createOAuthInstance` — copy `gmail/index.ts:37`, not the whole thing.
**Paste-token connectors** (slack, notion) are near-twins; copy the cleaner
**Notion** (`connectors/notion/`, flat account, no tracked_roots, no migration).

---

## 3. The data model in one screen

- **`accounts`** (`db/schema.sql:29`) — one row per connected account.
  `config_json` = non-secret config; secrets go in an encrypted blob referenced
  by `credentials_blob_path` (never in the DB).
- **`sync_state`** (`schema.sql:41`) — one row per account: `status`,
  backfill progress counters, and **`cursor_json`** (your connector-defined
  delta cursor — the only sync state you own).
- **`tracked_roots`** (`schema.sql:51`) — sub-units (folders / drives / browser
  profiles). Only "folder-bearing" connectors use these (local-folder=`fs`,
  google-docs=`drive`, onedrive=`ms-drive`, browser=`browser`). Flat connectors
  (gmail, slack, notion, whatsapp) use none.
- **`documents`** (`schema.sql:2`) — UPSERT key is `UNIQUE(source, source_id,
  type)`. Ownership is the **`account_id` column**, stamped automatically by
  `upsertDocument` because the ctx is account-scoped. **Use the column. Do not
  invent a new `metadata.account_id`-style ownership convention** (see §5.1).

---

## 4. End-to-end checklist for a new connector

Touch every box or the feature ships half-wired. The cleanest reference is
**Notion** (paste-token) or **Gmail** (OAuth).

**Connector logic** — `src/main/connectors/<name>/`
- [ ] `index.ts` — export the `Connector` object. Paste-token: build client →
      directory → return instance. OAuth: delegate to `createOAuthInstance`.
- [ ] `client.ts` — API client. GET-based? wrap `bearer-fetch.ts`. POST-based?
      bespoke, but **parse `Retry-After` defensively** (§5.6).
- [ ] `backfill.ts` — write via `ctx.upsertDocument`; call
      `progress.update(done, total)`; save the **initial cursor** even if the
      source is empty (§5.3).
- [ ] `delta.ts` — load cursor (guard "backfill first"), upsert changes,
      **advance the cursor to the newest _observed_ item, not the newest
      _ingested_ one** (§5.3); save `{status:'live', cursor_json, last_sync_at}`.
- [ ] `add-account.ts` (auth connectors) — `validate<Name>...()` returning
      `{ok, error?, message?}`.

**Registration & DB**
- [ ] `reg.register(<name>Connector)` in `connectors/index.ts`.
- [ ] **Ownership: nothing to do for new rows** — `upsertDocument` stamps
      `account_id`. Add a branch to `backfillDocumentAccountIds`
      (`db/recompute-counts.ts`) **only** if you're migrating pre-existing rows.
- [ ] If you have **binary content** (images / PDFs / attachments), register a
      `ByteSource` in `deep-extraction/byte-sources.ts` — otherwise OCR/VLM
      never re-fetches your bytes (§5.7).
- [ ] A **migration** in `db/migrations.ts` **only** if you change the
      account/tracked-root cardinality model — and that means a *destructive*
      migration; gate it with a test (§5.5).

**IPC**
- [ ] Add channel constant(s) in `ipc/channels.ts` (the exhaustive
      `ipc-channels.test.ts` contract is now single-sourced from `ChannelMap`).
- [ ] Register the add-account handler in `ipc/connector-account-handlers.ts`.
      Management channels are already generic — nothing to add.

**Renderer / UI**
- [ ] One `CONNECTOR_REGISTRY` entry in `renderer/connectors-registry.ts` wires
      the row, status badge, doc count, and actions via the generic `AccountRow`.
- [ ] Paste-token / QR flow only: add a dialog — extend the existing token
      dialog rather than cloning `SlackConnectDialog`/`NotionConnectDialog`.
- [ ] Expose the channel through the preload bridge.

**Dependencies** (the qrcode incident — §5.2)
- [ ] Main-process-only SDKs → `release/app/package.json` (externalized).
- [ ] Anything the **renderer** value-imports → **ROOT** `package.json`
      (webpack bundles it). `import type` is fine either way.

**Tests** — full jest suite is the merge gate (per-file runs hide breakage).
The two guard tests below already protect you; keep them green.

---

## 5. The recurring mistakes (and the one-line rule for each)

These are mined from git history. Each bit us on **two or more** connectors.

### 5.1 "Indexed 0 documents" — bit Slack, WhatsApp, **and** Notion
**Symptom:** docs index fine but the UI shows `Indexed 0` and disconnect-purge
deletes nothing (orphaning every doc). **Cause:** ownership used to be encoded
per-connector in ad-hoc `metadata` JSON, and the counting functions in
`recompute-counts.ts` had to know all 6+ conventions; a new source fell through
to 0. **Fixed structurally** (`9555f90`, `150b0c3`): a real
`documents.account_id` column + a registry-cross-checked guard test
(`src/__tests__/recompute-counts-all-sources.test.ts`).
> **Rule:** rely on the `account_id` column written by `upsertDocument`; never
> invent a new metadata ownership key. Keep the all-sources guard test green.

### 5.2 Renderer dep in `release/app` → broken `require()` — the qrcode incident
**Symptom:** `qrcode` was added to `release/app/package.json`; webpack
externalizes all `release/app` deps, so the contextIsolated renderer emitted an
unresolvable `require("qrcode")` and the WhatsApp pairing QR never rendered.
Fails only at runtime. **Fixed** (`8bfee42`) + guard test
`src/__tests__/renderer-externals.test.ts`.
> **Rule:** renderer value-imports go in ROOT `package.json`; only
> main-process deps go in `release/app`. (Same trap at build-time: any `@main`
> module the renderer value-imports must be node-builtin-free — split node-free
> catalogs out, e.g. `models.ts`.)

### 5.3 Delta cursor stalls forever — bit Notion twice
**Symptoms:** (a) a trashed/filtered item at the head was skipped *without
advancing the cursor*, so it re-walked every tick; (b) an empty workspace left
the cursor undefined → `JSON.stringify` dropped it → "no cursor" thrown forever.
> **Rule:** advance the cursor to the newest **observed** timestamp (not the
> newest ingested), and **always persist a cursor** — floor it at epoch
> (`new Date(0)`) so an empty source still has one.

### 5.4 Multi-account queries not scoped to the owning account — Notion
**Symptom:** with two Notion workspaces connected, workspace A's nightly
deletion-reconcile archived workspace B's pages (B's pages aren't in A's live
set). Fixed (`b4da211`) — but note `notion/reconcile.ts` still scopes by the
*renameable* `metadata.workspace`, a latent bug now that `account_id` exists.
> **Rule:** every reconcile/purge/count query must filter by
> `account_id = ctx.accountId`. Never join on a renameable display string.

### 5.5 Account-model changes force a destructive migration — local-folder, browser
Changing cardinality (per-profile → unified "Browsers"; per-folder → one
machine account) has no in-place reshape — it deletes legacy accounts +
`sync_state` + `tracked_roots` + their docs and rebuilds.
> **Rule:** a shipped connector's account-model change = a destructive,
> **idempotent** (sentinel-guarded, re-runs every boot) migration. Gate it with
> a dedicated test (purge X / preserve Y) and require a manual smoke before
> shipping.

### 5.6 `Retry-After` → `NaN` → busy-retry loop — Notion then Slack
`Number(retryAfter)` returns `NaN` for an HTTP-date Retry-After;
`sleep(NaN*1000)` resolves immediately → near-busy retry loop until the budget
aborts. Notion fixed it first; Slack ported the fix (`3ef11a8`).
> **Rule:** clamp non-finite Retry-After to a default; floor 1s, cap 60s. If you
> don't share a retry core, you *will* reintroduce this per connector.

### 5.7 Binary content with no `ByteSource` → never OCR'd
The deep-extraction drain re-fetches original bytes through
`deep-extraction/byte-sources.ts`. A connector with images/PDFs that doesn't
register one ships those docs text-poor forever, silently.
> **Rule:** binary content ⇒ register a `ByteSource` (return `'gone'` for
> permanently lost bytes, `'unavailable'` for retryable).

### 5.8 Backfill progress in the wrong unit — Slack
Slack's `backfill_done_count` counts *conversations*, not docs, so the UI showed
"5,582 documents of ~442" and the generic `recomputeMissingDocCounts` would
clobber it. Fixed by a per-source backfill-units helper + excluding slack from
the recompute (`recompute-counts.ts:139`).
> **Rule:** if your backfill counter isn't in documents, declare its unit and
> exclude it from the generic doc-count recompute.

### 5.9 Live-socket connectors (WhatsApp) — the ban-risk cluster
Two sockets sharing one Signal key store corrupted auth and lost messages.
> **Rule:** exactly one socket behind an `ensureStarted` gate, serialized
> ingest, backoff+jitter reconnect, an abandoned-session reaper, and atomic
> auth-blob writes that preserve a corrupt blob rather than overwriting it.

---

## 6. Auth: prefer paste-token from a user-created internal app

For Slack the rate-limit exemption is **load-bearing**: since 2025-05-29 Slack
throttles non-Marketplace apps to ~1 req/min, while a user's *internal* app
keeps Tier 3 (~50 req/min). A bundled OAuth app would be marketplace-distributed
and crippled — so each user creates their own internal app from a bundled
manifest and pastes the `xoxp-` token (which also removes the need for a
token-refresh worker). Notion followed the same pattern; WhatsApp avoids cloud
auth entirely.
> **Rule:** for personal-corpus connectors, prefer paste-token from a
> user-created internal app/integration. Reach for bundled OAuth only when the
> API gives internal apps no rate advantage (the Google/MS family). Secrets
> always go in an encrypted `safeStorage` blob, never in `config_json` or the DB.

---

## 7. Known shared-layer gaps worth closing first

If you're about to copy-paste, consider factoring instead — these are the
highest-leverage refactors the audit surfaced:

1. **`createPasteTokenConnector()` factory + a shared `TokenPasteDialog`** —
   Slack/Notion duplicate `index.ts` / `token.ts` / `add-account.ts` / dialog
   almost verbatim. (`token.ts` in both is a no-op wrapper around
   `safe-storage-blob` — call it directly.)
2. **A `runDelta(ctx, …)` envelope** — 8 delta files repeat
   load-cursor → guard "backfill first" → save-live.
3. **Fix `notion/reconcile.ts` to scope by `account_id`** (§5.4) — latent
   multi-workspace data loss, not just cleanup.
4. **Route `gmail/delta.ts` through `bearer-fetch`** — it has its own retry-less,
   timeout-less `fetchJson`, the exact freeze `bearer-fetch` exists to prevent.
5. **`findOrCreateSingletonAccount` + a `NameDirectory` base** — browser /
   local-folder / whatsapp each re-implement both.
