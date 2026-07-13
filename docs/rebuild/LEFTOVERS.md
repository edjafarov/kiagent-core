# Greenfield rebuild — leftovers

What the `greenfield` branch changed, simplified, or deliberately did not carry
over from the legacy app. Each item is either **behavioral** (the app acts
differently), **deferred** (planned, tracked as an issue), or a **deviation**
(blueprint says one thing, code does another — flagged for a decision).

## Deferred features (tracked as issues)

1. **Extension platform runtime** — landed: manifest validation, a
   consent-gated utilityProcess host, source/tool proxies, a local-path
   installer, `extension:*` IPC, and an AppState projection (plan
   `docs/superpowers/plans/2026-07-03-extension-runtime.md`). Plan B landed
   too (plan `docs/superpowers/plans/2026-07-03-marketplace-notion.md`): the
   GitHub catalog over the `kia-plugins` org (`marketplace:*` IPC, SRI/TOFU
   pinning), a functional Marketplace screen with ConsentModal, and the
   Notion connector ported and published as
   `kia-plugins/notion-kia-connector` v2.0.0.
2. **Inference providers** — two providers now ship, registered in
   `src/main/providers/index.ts`:
   - `apple-vision` (capability: `read`) — a bundled Swift/Vision helper
     (`native/vision-helper/main.swift`, compiled to
     `assets/vision/darwin-<arch>/kia-vision` by
     `scripts/build-vision-helper.mjs`) does native OCR. darwin-only; ready
     as soon as the helper binary is present, no download.
   - `local-llm` (capabilities: `complete` + `see`) — a vendored
     `llama-server` (`scripts/fetch-llama-server.mjs` →
     `assets/llama/<slug>/llama-server`) fronts a tiered, curated Gemma GGUF
     model with hardware-tier selection (RAM-based; CPU hosts force the
     smallest tier) and auto-download on first use (SHA-256-verified,
     resumable, cancellable via `inference:cancel`). No user model picking
     in this pass — `prefs.models.override` is the only escape hatch.
   Both run through the same one-front-door/two-lane/provider-registry
   plane. Deferred to Phase C: the Windows WinRT OCR helper now BUILDS and
   is vendored into win32 packaging (`scripts/build-windows-ocr-helper.mjs`,
   run by `scripts/vendor-deep-extraction.mjs`) but no runtime `read`
   provider is registered for it — it ships as dead weight; the GLM-OCR WASM
   fallback exists only as a model descriptor (`GLM_OCR_MODEL` in
   `local-llm/models.ts`), never loaded or registered; Vulkan/accel probing
   has parsing/detection scaffolding (`parseVulkanDevices`, `detectBackend`
   in `local-llm/backend.ts`) but the `--list-devices` spawn is not wired —
   non-darwin hosts still resolve platform-arch only.
3. **Vision/OCR worker** — implemented
   (`src/main/workers/vision/vision-worker.ts`): a two-pass pipeline driven
   by `classifyDocument` (candidate = text-poor PDF/image under the size
   caps). Pass 1 OCRs via the `read` capability (native/free where
   available); if that yields enough text the document is enriched
   immediately with `**Text content (OCR):**` markdown and the work is
   `done`. Pass 2 falls through to the `see` VLM capability for genuinely
   image-only content, enriching with a `**Description:**` section; if no
   `see` provider is ready yet (model not installed), the work `defer`s and
   the worker's 30-minute re-drive cadence retries it once `local-llm`
   finishes its auto-download.
4. **Sources not yet ported** — google-docs, ms365, onedrive, browser
   history; the WhatsApp bundled extension depends on the extension runtime.
5. **Search parity** — DONE (2026-07-11, spec
   `docs/superpowers/specs/2026-07-11-search-parity-design.md`): snowball
   stemming via per-document detected languages (stem columns on
   `documents_fts`) and a trigram substring-recall fallback
   (`documents_tri`, RRF k=60) fused inside `store.read.search`. Legacy
   trigram/stemming behavior is restored with greenfield semantics kept
   (raw exact match, phrases, snippets, boolean grammar). Legacy's
   per-paragraph weighted language scores were NOT ported (single-code
   `detectLanguages` remains). Deliberate deviations from legacy, decided
   during implementation: trigram fallback terms are AND-joined (legacy
   OR'd them) so fuzzy can never violate the boolean grammar's
   implicit-AND, and queries the flat term extraction cannot faithfully
   represent (sub-3-char positive terms, grouped negation) skip the fuzzy
   pass entirely.
6. **Data migration from legacy installs** — new data root is
   `userData/data/` (one root). Legacy `userData/alpha-cent/` is neither
   read nor migrated. The extension platform's `extDir` IS
   `userData/extensions/`, so that directory is now scanned — but only for
   the new manifest shape; legacy-format extension dirs fail validation
   and surface as discovery errors (logged, skipped), never migrated. An
   existing install otherwise starts empty.
7. **needsReauth flow** — half landed: an auth-classed sync error now
   transitions the account to `needsReauth`
   (`core/engine/engine.ts`, covered by
   `core/engine/__tests__/needs-reauth.test.ts`) and the Sources UI shows a
   "Reconnect" label (`Sources/ErrorCard.tsx`). Still open: the action only
   fires `accounts:sync-now` (a retry) — it does not re-open the
   connect/OAuth flow, so a genuinely revoked token has no in-app recovery
   path yet.
8. **Converter pool isolation** — conversion (pdf/docx/xlsx/csv/html/text)
   runs in-process. `converter/worker.ts` is reserved for the crash-isolated,
   backpressured pool.
9. **Store off the main thread** — DONE (2026-07-11): `db/worker-entry.ts`
   is a real DB worker owning the one writable better-sqlite3 connection; it
   hosts the full `commit` procedure and `rebuildSearchIndex`, and is the
   default path (`core/boot.ts` `openDbInWorker`, wired in `main.ts`). The
   whole store write path runs off the main thread, not just FTS commits.
10. **Tray icon/menu, app menu, launch-at-login side effect** — tray is
    DONE (`src/main/tray.ts` + `tray-menu.ts`, created at boot). Still
    open: launch-at-login (pref exists in `core/prefs.ts`, no
    `setLoginItemSettings` call anywhere) and a custom app menu
    (`setApplicationMenu` never called — default menu remains).
11. **Auto-updater** — DONE: `src/main/updater/` is fully implemented on
    electron-updater (check, download events, quit-and-install); the
    `update:*` IPC channels are real (`updater/ipc.ts`) and `main.ts` sets
    the feed URL.
12. **`query_sql` / `get_schema` MCP tools** — DONE (2026-07-13, spec
    `docs/superpowers/specs/2026-07-13-query-sql-get-schema-design.md`): both
    ship on the HTTP and stdio transports (`tools/raw-sql.ts`), `tier:
    'powerful'` with no consent gate. `query_sql` is read-only (SELECT/WITH
    textual gate + readonly driver, 500-row cap); `get_schema` returns a
    freshly-written greenfield schema doc kept honest by a drift test. The
    'powerful' tier tag is the hook a future per-transport/consent filter
    would key off.
13. **Retention policy** — `purgeArchived` exists as a commit arm but no
    scheduled maintenance job invokes it yet.
14. **SDK republication** — `packages/connector-sdk` + `extension-sdk` were
    removed with the legacy surface; the greenfield contract is the new SDK,
    to be packaged when the extension runtime lands.
15. **Suggestions engine** — legacy `src/main/suggestions` dropped; planned
    as app-layer logic over `Query`, not platform.
16. **OIDC provider + app sign-in gate** — legacy `oidc/` and the RP OAuth
    boot gate are not ported; the SignIn screen stores `Identity` locally.

## Behavioral changes (by design — the blueprint's wins)

- **IPC**: 85 channels → 27. All live state rides ONE projection push
  (`push:app-state`); screens no longer own bespoke fetch+subscribe loops.
- **Ids**: UUIDv7 strings end-to-end; the bigint↔string wire codec is gone.
- **Deletion is first-class**: upstream deletions archive (soft) then purge
  (hard) with tombstones in the feed; account removal is one cascade that
  also deletes the credential blob (legacy leaked it).
- **Credentials**: one encrypted vault scheme (safeStorage). OAuth client
  id/secret ride the vault per account — never plaintext in account config
  (legacy stored them in `accounts.config_json`).
- **Sync state**: `progress`/`lastSyncAt`/`lastError` live on Account and
  survive restart; status transitions are engine-owned.
- **Scheduling**: cadence-as-data in one durable scheduler; connectors no
  longer own timers. Sync-now = `scheduler:trigger`.
- **Processing**: the InferenceJob queue table is gone; work outcomes
  (done/skip/defer/failed) live in the per-consumer ledger, poison documents
  can't stall a cursor.

## Per-source porting deviations

- **IMAP**: one `email.message` document per message — legacy rebuilt RFC-5322
  threads into one `email_thread` doc with attachment sub-docs. Threading and
  attachment extraction are deferred. Live phase polls (60s) on a held
  connection instead of IMAP IDLE. Reply-quote stripping now applies
  per-message (legacy IMAP didn't strip). A latent legacy bug in DSN header
  stringification was fixed in the port.
- **Gmail**: whole thread = one `email.thread` doc (matches legacy);
  attachments ARE now emitted as child documents (type `attachment`, one per
  attachment part) with `parent: { externalId: <threadId>, type:
  'email.thread' }` and metadata keys `mime`, `filename`, `sizeBytes`,
  `messageId`, `partId`, `attachmentId` (`attachmentId` rotates between API
  sessions — `fetchBytes` re-resolves it via the stable `partId`). Attachment
  docs are born `markdown: null` (text-poor by construction), landing them
  straight in the vision worker's defer pool for OCR/VLM enrichment.
  Tiny inline images (< 8 KiB, likely signature pixels) are dropped. Historical
  threads only get their attachment child docs backfilled the next time that
  thread changes — a `delta` sync only re-fetches (and re-derives
  attachments for) threads present in the Gmail history changelog; a thread
  untouched since before this pass shipped keeps its old attachment-less
  state until its next message/label change. `createdAt` = LAST message date
  (legacy used first); mailer-daemon/automated-thread filtering not ported;
  OAuth flow carries no CSRF `state` param (stateless OAuthProfile
  interface); invalid history cursor falls back to FULL backfill (legacy did
  a bounded 14-day re-list).
- **local-folder**: identity = relative path (legacy content-addressed by
  SHA-256, surviving renames/moves — restoring that needs content-hash
  identity in the engine, a Tier-2 gap); new read-time size caps (2 MiB
  inline text / 20 MiB binary) replace legacy's converter-level caps.
  Legacy's per-root `TrackedRoot` entity is gone (Tier-2 gap #10), but this
  is no longer single-root: one `this-machine` account now tracks N roots in
  `config.paths`, normalized to a minimal covering set (`coveringRoots` in
  `@shared/folder-paths`) so no tracked root can be a descendant of
  another — the overlap-prevention legacy had per-root is preserved without
  the entity. Add/remove is picker-first (`accounts:add` skips straight to
  a multi-select folder tree for this source) with per-root management
  (add more / remove a root, live recursive file counts) on the source
  detail screen's Tracked folders section; dropping a root archives that
  folder's documents on the next sync. Per-root include/exclude globs and a
  persisted ancestor path index are still not ported.
- **UI shell**: legacy "use KIA locally"/skip-sign-in flow dropped (no
  localMode in AppState); log viewer has 3 levels (no `debug` tier); MCP
  client "disconnect" has no backend verb yet.

## Deviations from the blueprint (decide later)

- **`CommitBatch` has no account-creation arm** — `createAccount` /
  `getOrCreateAccount` are CoreStore internals used by the engine. Either add
  an arm to the blueprint or bless the internal.
- **AppState composition** — `appProjection` owns the feed-derived slice;
  `main.ts` refreshes prefs/processing/mcp slices on their own clock (prefs
  onChange + 5s poll). The blueprint's "derived fields live in init/apply
  only" is therefore true per-slice, not for the whole object.
- **Projection counts are drift-tolerant** — `apply()` uses the
  ingestedAt===updatedAt heuristic for increments; exact counts recompute on
  every `init()` (reconnect/boot). Unarchive transitions may briefly
  undercount.
- **Binary payloads are not persisted** — `DocumentInput.binary` is consumed
  by conversion and dropped; re-access goes through `Source.fetchBytes`.
  Legacy cached some attachment bytes on disk.
