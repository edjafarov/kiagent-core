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
   plane. Deferred to Phase C: Windows WinRT OCR helper
   (`scripts/build-windows-ocr-helper.mjs`), a GLM-OCR WASM fallback for
   win/linux hosts without a native OCR helper, and Vulkan/accel probing for
   non-darwin `local-llm` hosts (today only darwin's Metal-implicit slug is
   resolved; `resolveLlamaBinary` doesn't yet do `--list-devices` probing).
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
5. **Search parity** — FTS5 (unicode61, diacritics-folded, bm25-weighted,
   snippets) only. Legacy trigram fuzzy fallback and snowball stemming fed by
   `Document.languages` are not ported. Languages ARE detected and stored.
6. **Data migration from legacy installs** — new data root is
   `userData/data/` (one root). Legacy `userData/alpha-cent/` is neither
   read nor migrated. The extension platform's `extDir` IS
   `userData/extensions/`, so that directory is now scanned — but only for
   the new manifest shape; legacy-format extension dirs fail validation
   and surface as discovery errors (logged, skipped), never migrated. An
   existing install otherwise starts empty.
7. **needsReauth flow** — platform-side token refresh exists
   (`EngineDeps.refreshers`), but a 401 does not yet transition the account
   to `needsReauth` nor re-open the connect flow.
8. **Converter pool isolation** — conversion (pdf/docx/xlsx/csv/html/text)
   runs in-process. `converter/worker.ts` is reserved for the crash-isolated,
   backpressured pool.
9. **Store off the main thread** — better-sqlite3 runs on the Electron main
   thread; `db/worker-entry.ts` is reserved for moving large FTS commits off
   the event loop.
10. **Tray icon/menu, app menu, launch-at-login side effect** — pref exists,
    effect not wired; no tray, default menu.
11. **Auto-updater** — `update:*` channels are stubs returning idle (About
    pane keeps rendering); electron-updater is the OSS/proprietary seam.
12. **`query_sql` / `get_schema` MCP tools** — omitted until the 'powerful'
    tool consent tier exists. The other five legacy tools are ported.
13. **Retention policy** — `purgeArchived` exists as a commit arm but no
    scheduled maintenance job invokes it yet.
14. **E2E tests** — `tests/e2e` still targets the legacy UI.
15. **SDK republication** — `packages/connector-sdk` + `extension-sdk` were
    removed with the legacy surface; the greenfield contract is the new SDK,
    to be packaged when the extension runtime lands.
16. **Suggestions engine** — legacy `src/main/suggestions` dropped; planned
    as app-layer logic over `Query`, not platform.
17. **OIDC provider + app sign-in gate** — legacy `oidc/` and the RP OAuth
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
