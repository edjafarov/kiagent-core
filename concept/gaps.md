# Gap analysis: `greenfield.ts` vs the real app (and earlier concepts)

*2026-07-02. Method: three parallel Sonnet 5 subagents — (1) `src/` ingest/sync sweep,
(2) `src/` platform sweep, (3) cross-read of `model.ts` / `pull-model.ts` /
`greenfield.ts`. Findings deduplicated and verified against `greenfield.ts`.*

**Verdict:** the core paradigm (Source→feed→Worker/Projection, one engine, one
inference plane, capability host) survives contact with the real app. But the
blueprint is missing an entire **data-lifecycle dimension** (deletion in every
form), all **persisted sync-state detail**, the **event channel**, **consent
records**, and it has one internal inconsistency (workers "come back as
documents" is promised but not typed). Everything below is actionable.

---

## Tier 1 — must fix before the blueprint is judged complete

> **STATUS: FOLDED INTO `greenfield.ts` 2026-07-02.** `ExternalRef`,
> `Batch.deletions`, `Source.reconcile?`, `Document.archivedAt`,
> `Change` 'purge'/'accountRemoved' tombstones, `Engine.remove` +
> `vault.delete` + `removeAccount`/`purgeArchived` commit arms,
> `WorkerSession.emit` (atomic with the worker cursor), `events` cap,
> `ConsentRecord` + `Store.consents`, `Account.progress/lastSyncAt/lastError`.

1. **Upstream document deletion has no signal.** Every real connector detects
   "gone upstream" — Gmail 404s (`gmail/delta.ts:150`), Graph/OneDrive
   `deleted`/`removed` flags (`onedrive/delta.ts:97`), IMAP UID-set reconcile
   (`imap/reconcile.ts:9`), Drive full-rescan diff. `Source.pull` can only
   upsert. → Add a deletion item kind to `Batch` (or `DocumentInput.deleted`)
   plus an optional `Source.reconcile?()` full-listing hook.
2. **No soft-delete/archive lifecycle.** Today: tombstones with
   `archived_at`/reason, hidden from default queries, purged later
   (`documents.ts:344`, `purgeArchivedDocuments`). → `Document.archivedAt`
   system field; `Query` excludes archived by default.
3. **No account removal.** `Engine` has connect/run but no
   `remove(account)`; `Store.vault` has no `delete`. Today's cascade is
   hand-written per call site — and **leaks the encrypted credential blob on
   disk** (`connector-lifecycle-handlers.ts:120` never unlinks it). → Engine
   owns a transactional account-removal cascade; `vault.delete`.
4. **Change feed has no tombstone kind** — so Workers/Projections can never
   learn about deletions either. Follows from 1–3.
5. **Worker→document path is promised but untyped.** The header says results
   "come back as documents" but `WorkerSession` has no emit verb. → Either a
   `session.emit(DocumentInput)` routed through the engine, or workers own a
   synthetic Source.
6. **No event channel for extensions.** Today: `EventBus` with
   `document.indexed`, `source.synced`, `extension.activated`,
   `inference.completed` + cross-extension `emit()` over RPC
   (`platform/events.ts`, `extension-host-router.ts:224`). Greenfield
   `BaseHost` has nothing — a tools-only or command-only extension can never
   be notified of anything. → `events` cap or declared mapping onto feed
   `Change` kinds.
7. **No persisted consent record.** `Manifest.caps` is a declaration, not a
   grant. Today at least persists `grantedPermissions` + `installedAt`
   (`installer.ts:283`), though with no history/re-consent diff. →
   `ConsentRecord {extensionId, caps, grantedAt, manifestVersion}` in Store.
8. **Persisted sync progress/error is gone.** `sync_state` today holds
   `backfill_done_count`, `backfill_total_estimate`, `last_sync_at`,
   `last_error` — the progress bar and error banner survive restart.
   Greenfield `Account` has only `status` + `cursor`. → engine-written system
   fields alongside every commit.

## Tier 2 — sync/connector expressiveness losses

9. **Pairing wizard > AuthChannel.** Real connectors ship declarative
   multi-step wizards: validated input fields, copyable secrets, live QR
   stream with timeout/abandon, **resource picker** (browse Drive/folders
   pre-connect), post-connect one-off *actions* (WhatsApp chat-export import),
   config panel (`connectors/manifest.ts:31-137`). → extend `AuthChannel`
   (at minimum `pick(tree)`) + an `actions` contribution.
10. **TrackedRoot missing.** One account tracks N roots with
    include/exclude globs, per-root scan time, ancestor path index, overlap
    prevention (`tracked-roots.ts`). `Account.identifier` is one string. →
    first-class `TrackedRoot` entity.

    > **Partially resolved 2026-07-03** (local-files multi-root initiative):
    > one local-folder account now tracks N roots via `config.paths`, added
    > and removed from the source detail screen's Tracked folders section;
    > `coveringRoots`/`isUnder` (`@shared/folder-paths`) give overlap
    > prevention by construction — no tracked root can be a descendant of
    > another, so nothing can be double-indexed. Still open: per-root
    > include/exclude globs, per-root scan time, and an ancestor path index —
    > `TrackedRoot` remains a plain string array, not a first-class entity.
11. **Content-hash identity.** Local-folder uses SHA-256 as `source_id` —
    multi-path consolidation + rename detection via unlink/add pairing
    (`local-folder/scanner.ts:124`, `watcher.ts:31`). `externalId` has no
    vocabulary for this. → engine-understood `dedupBy: 'contentHash'` mode.
12. **Aggregate parents.** Email threads are *rebuilt* from mutable child
    sets, and attachments link via `metadata.attachment_ids`, never
    `parent_id` (`imap/rebuild.ts`, `thread-builder.ts:88`). Static
    `parent?: {externalId,type}` can't express regenerate-on-child-change. →
    accept rebuild-as-upsert pattern + ordered grouping convention; document it.
13. **Reset-granularity verbs.** Today has four distinct resets (pause /
    resume-keep-cursor / retry-backfill-reset-counters / full-reset)
    (`accounts.ts:483-526`). `Handle.stop()` is the only verb. →
    `pause/resume/retry(resetProgress)/reconnect(resetCursor)` on Handle or Engine.
14. **Cursor-invalidation recovery.** Providers expire delta tokens; connectors
    fall back to bounded re-sync (`gmail/delta.ts:50`, Graph 410). Technically
    expressible but invisible. → `PullPhase: 'reconcile'`.
15. **Focus-tiered cadence + interactive yield.** 30s focused / 120s
    unfocused / 600s tray (`scheduler.ts:39`), plus live "user is active,
    slow down ingest" backpressure (`interaction.ts`, `yieldIfDue`). `Cadence`
    can't express either. → environment-tiered Cadence variant + engine-side
    yield policy.
16. **Retryable-error classification.** Retry is engine-owned but providers
    need custom predicates (Google 403-body regex vs Graph status-only,
    `bearer-fetch.ts:142`). → optional `Source.isRetryable?(error)`.
17. **fetchBytes failure taxonomy.** `gone` vs `transient` vs `unsupported`
    drive different engine reactions (`onedrive/byte-source.ts:78`). `null`
    collapses them. → small result union.
18. **Out-of-session credentials.** Folder pickers need a fresh token with no
    pull running (`account-token-worker.ts`). → narrow `Engine.clientFor(account)`.
19. **Provisional accounts + boot reaper.** Interrupted pairings are swept at
    boot (`pending-reaper.ts`). → `connect()` writes a provisional row; boot sweeps.

## Tier 3 — extension platform

20. **Extension entity + lifecycle.** Installed/enabled/origin
    (bundled|marketplace|dev), 5-state status machine, activation events
    (`platform/lifecycle.ts`, `registry.ts`). Nothing in greenfield; also
    real bugs today: bundled extensions resurrect after uninstall
    (`seed-bundled-extensions.ts:56`), `state.json` orphaned on uninstall. →
    `Extension` entity + `activationEvents` on Manifest + one owned
    `removeExtension` cascade. *Update (2026-07): the extension runtime,
    marketplace catalog, and consent UI (ConsentModal + persisted
    `ConsentRecord` grants) landed on `greenfield` — see spec
    `docs/superpowers/specs/2026-07-03-extension-marketplace-design.md`.*
21. **`secrets` cap dropped.** pull-model had it; PrivateDb is a plain
    SQLite file, not keychain-backed. An extension's own third-party API key
    has no secure home. → restore `secrets` cap (namespaced, safeStorage-backed).
22. **Sandbox honesty.** Caps are a cooperative API contract, not containment —
    extension processes can `require('fs')` today (`extension-host-entry.ts:63`).
    → state this explicitly in the blueprint.
23. **Process supervision policy** (512MB heap cap, 10-min idle park,
    crash-loop breaker, keep-awake refcount) — keep as documented engine
    behavior, not a type surface.
24. **Commands half-missing.** Registry today has namespacing + `execute` +
    `list`; greenfield only has `register`. Core menu/tray actions bypass the
    registry entirely — decide if they unify. → add `execute`/`list`.
25. **Cap vocabulary mapping.** Today's permission strings
    (`db:read/db:write/files:*/process/net/llm/secrets/clipboard`) don't map
    1:1 onto the 7 Caps. → publish the mapping table; decide `process`/`clipboard`.

## Tier 4 — inference & processing plane

> **STATUS: FOLDED INTO `greenfield.ts` 2026-07-02.** `WorkOutcome`
> (`done|skip|defer` — defer = two-pass park) + `Worker.maxAttempts` +
> engine ledger via `Handle.stats` (26, 27); commit-path pipeline doc on
> Engine — deterministic convert → detect languages → index, inside the
> commit tx (28, 31, 33); `SchedulerEnv` (battery/thermal/focus/idle) as
> the ONE throttle input (29 — also closes Tier-2 item 15's focus tiers);
> `ProviderStatus` on `InferenceProvider` (30); inference-cap decision:
> extensions get `complete`+`see`, enqueue/onResult DISSOLVES into Worker (32).

26. **Poison-document policy.** The InferenceJob queue has `attempts`,
    MAX=3, and a distinct terminal `skipped` state. A Worker with
    at-least-once + idempotency alone either retries a poison doc forever or
    stalls its cursor. → per-change failure policy in the Worker engine
    contract (max attempts, skip-and-log, result enum `done|skipped|defer`).
27. **Two-pass extraction.** Cheap OCR now → park at `ocr_done` → expensive
    VLM later only if text-poor. One `work()` call per change can't park. →
    the `defer` result above covers it.
28. **Converter stage ≠ inference.** Most conversion is deterministic
    (html/pdf/docx/xlsx via a crash-isolated worker pool with backpressure
    and size caps); only the text-poor minority goes to OCR/VLM
    (`converter/pool.ts`, `inference/classify.ts`). The blueprint collapsed
    the two. → model conversion as its own queue-bounded engine stage with a
    mime registry.
29. **Device-state throttling.** Concurrency 0/1/2 by battery/thermal +
    night/idle window (`inference/policy.ts:18-88`). Coarser `Lane` loses
    this. → thermal/battery as Scheduler throttle inputs.
30. **Model management.** Hardware-tiered curated models, checksummed
    resumable downloads, disk preflight, status machine
    (`runtime/models.ts`, `downloader.ts`, `manager.ts`). →
    `InferenceProvider` gains provisioning states (`not-ready|downloading|ready`);
    internals stay the local provider's business.
31. **Language detection** (franc, per-doc ISO-639-3, feeds stemming) has no
    home. → assign to the ingest/index stage explicitly.
32. **Extension-facing llm shape.** Today extensions `enqueue(documentId)` +
    `onResult(cb)`; greenfield offers `complete(prompt)`. Decide the boundary
    (doc-id-mediated vs raw prompt) and whether extensions get `see()`.

## Tier 5 — platform services the blueprint is silent on

> **STATUS: FOLDED INTO `greenfield.ts` 2026-07-02** (new §8 Platform
> Services). Search contract + `count` + `offset` + snippets on `Query`;
> indexing decided commit-owned (33, 34); migrations + app sign-in assigned
> to `boot()` (35, 40); `Prefs`/`AppPrefs` (36); `LogStore`/`LogRecord` —
> MCP call audit rides it as scope `'mcp.call'` (37, 38-audit); `Mcp`
> surface (transports, auth modes, client-config registration) +
> `McpTool.tier: 'powerful'` for query_sql-class tools (38); canonical
> `appProjection: Projection<AppState>` (39); `Identity.avatarUrl`,
> `Credentials.clientId/clientSecret` ride the vault (40, 42);
> `Store.maintenance` compact/export/resetAll (41-backup);
> `SourceDescriptor.auth/multiAccount` — supports* flags DISSOLVE under the
> pull model (43); net-cap fetch documented as shared-retry (44).
> Deliberately NOT typed: converter pool internals, log rotation sizes, MCP
> session eviction, preload allowlist (implementation notes); suggestions
> engine (app-layer over Query); updater (kept as OSS/proprietary seam,
> outside the blueprint).

33. **Search is a real engine**: FTS5 + trigram fallback + weighted bm25 +
    RRF merge + snippets + multilingual stemming; index built synchronously
    inside upsert. → define a `SearchIndex` contract behind `Query.search`;
    decide commit-owned vs feed-consumer indexing (lag tradeoff).
34. **Query gaps**: no `count` (doc_count badges), no pagination.
35. **Schema migrations**: no story at all in the blueprint; today is
    idempotent boot steps with no version tracking.
36. **PrefsStore**: app-level settings (theme, logLevel, launch-at-login,
    privacy toggles…) with its own push channel. `Account.config` is the only
    config concept in greenfield. → first-class `Prefs`.
37. **LogStore**: rotation (10MB×3), structured JSON-lines, live viewer,
    zip export. Blueprint has only `log(level,msg)`. → `LogStore` concept the
    ubiquitous `log()` writes into.
38. **MCP reality**: dual transports (HTTP :7421 + stdio), session
    lifecycle/idle eviction, auth modes (`none-loopback|bearer|oauth-remote`;
    bearer exists but is disabled today), outbound client-config registration
    (Claude Desktop/Cursor/VS Code), `query_sql`/`get_schema` escape-hatch
    tools (broader than `Query`!), `doc://` resources, activity pulse, no
    audit log. → type the server config; classify `query_sql` as its own
    consent tier; persist a call log.
39. **Renderer projection reality**: today is full-snapshot broadcast (no
    seq/diff anywhere); derived fields (ETA, counts) need a designated home;
    per-screen invalidate-and-refetch side channels exist. Also: specify a
    concrete `AppState` shape or the field-drift problem model.ts solved
    returns. → keep generic `Projection<S>` but ship a canonical
    `Projection<AppState>` in the blueprint.
40. **App sign-in ≠ connector OAuth.** A whole-app RP sign-in gate
    (Google/Microsoft) produces `Identity`; unverified JWT decode today.
    `Identity` also lost `avatarUrl`/`provider`. → scope sign-in as a boot
    concern feeding `Store.identity`.
41. **Updater extension point** (OSS/proprietary split), **preload
    allowlisted-IPC boundary**, **suggestions engine** (descope explicitly,
    it's app-layer over Query), **backup/export** (missing in BOTH — roadmap).
42. **Plaintext client secrets.** OAuth clientId/clientSecret sit unencrypted
    in `config_json` today; greenfield `Credentials` has no slot, so the
    plaintext path would silently carry over. → fold into vault.
43. **SourceDescriptor capability flags** (multiAccount, requiresAuth,
    supportsBackfill/Delta/Realtime) drive connect-flow UI today. → restore
    on `SourceDescriptor`.
44. **Shared HTTP client.** Engine-owned retry covers only the pull loop;
    Workers/tools making outbound calls get a bare `fetch` and reinvent
    backoff. → optional shared retrying client behind the `net` cap.

## Deliberate absences — validated, keep as-is

- **Annotations / embeddings / semantic search**: confirmed dormant in
  production (`document_embeddings` zero inserts; `annotations` "currently
  unused"). The YAGNI call was right; note the tables exist as legacy debt
  to drop.
- **KV** (PrivateDb subsumes), **telemetry** (none exists), **streaming
  inference / cost tracking** (none exists), **`from_address`** (metadata is
  acceptable; minor typed-contract loss).

## Bugs in the CURRENT app found in passing (worth fixing in src regardless)

1. Account removal never deletes the encrypted credential blob → orphaned
   secrets on disk (`connector-lifecycle-handlers.ts:120-169`).
2. Uninstalled bundled extensions resurrect on next boot
   (`seed-bundled-extensions.ts:56-72`).
3. Uninstall leaves stale `state.json` enabled flags (`installer.ts:324`).
4. OAuth client secrets stored plaintext in `accounts.config_json`
   (`account-persisters.ts:92`).
5. Third-party extension load failures are silently skipped — broken
   extensions show "Installed" with no diagnostic (`discover-extensions.ts:26`).

## Reverse gaps — blueprint features that are NET-NEW work (no analog today)

- Extension-contributed MCP tools (today's tool dict is static).
- Extension-contributed InferenceProviders (today: hardcoded platform switch).
- The feed/seq/Change/Projection machinery itself (today: full-snapshot broadcast).
- Durable Scheduler with lastRun/nextRun + boot catch-up (today: in-memory
  setIntervals, missed windows skipped).
- Working `ui.notify` (today: a literal no-op).
