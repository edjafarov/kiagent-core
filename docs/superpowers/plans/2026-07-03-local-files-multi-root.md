# Local Files Multi-Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One local-folder account per machine tracking N folder roots (spec: `docs/superpowers/specs/2026-07-03-local-files-multi-root-design.md`).

**Architecture:** Generic additive platform pieces first (account upsert-on-connect, `setAccountConfig` + `accounts:update-config`, engine-wired reconcile), then the local-folder source goes multi-root (config.paths, per-root cursor map, absolute-path externalIds, shared covering-roots module), then the renderer collapses the batch add flow into one flow and gains a Tracked folders section.

**Tech Stack:** existing — better-sqlite3, chokidar, fast-glob, React, typed IPC.

## Global Constraints

- SECURITY: NEVER print, quote, or modify `src/main/sources/gmail/client-credentials.ts`.
- Any change to the `Store` interface or other types in `src/shared/contracts.ts` MUST be mirrored byte-identically in `concept/greenfield.ts`.
- IPC channels are declared in the `Invokes` interface AND the `INVOKE_CHANNELS` allowlist in `src/shared/ipc.ts`; handlers use the `handle()` helper in `src/main/main.ts`.
- `npx tsc --noEmit` must show zero NEW errors beyond the 4 pre-existing (tmp-promise ×2, MCP SDK, franc-min).
- Full `npm test` green once per task. Baseline at plan start: 38 suites / 278 tests.
- Machine-account identifier is the exact constant `this-machine`. The multi-folder prompt field format is the exact string `folder-paths`. The legacy-account error message is the exact string `Legacy single-folder account — remove this source and re-add its folder.`
- No reformatting of unrelated lines.

---

### Task 1: Account upsert-on-connect + setAccountConfig + accounts:update-config

**Files:**
- Modify: `src/main/core/store/store.ts` (createAccount → upsert; new setAccountConfig)
- Modify: `src/shared/contracts.ts` + MIRROR `concept/greenfield.ts` (only if the shared Store interface declares account mutators — check first; if account mutators are main-side `CoreStore` only, contracts stay untouched)
- Modify: `src/main/core/engine/engine.ts` (connect uses upsert result; new `updateConfig`)
- Modify: `src/shared/ipc.ts` (`accounts:update-config` channel + allowlist)
- Modify: `src/main/main.ts` (thin handler)
- Test: existing store/engine test files under `src/main/core/**/__tests__/`

**Interfaces:**
- Produces: `store.createAccount(a)` now upserts on `(source, identifier)` — config and status update, the EXISTING row id is returned (documents keep their account); a change-feed `account` entry is appended either way. `store.setAccountConfig(accountId, config: Record<string, unknown>): Promise<void>` (or sync, matching neighboring methods' style) — updates config + appends `account` change. `engine.updateConfig(accountId, config)` — setAccountConfig, then restart the account's sync loop if running (mirror the existing pause/resume/sync-now handle machinery). IPC: `'accounts:update-config': { req: { accountId: AccountId; config: Record<string, unknown> }; res: void }`.

- [ ] **Step 1 (TDD):** failing store tests: (a) createAccount twice with same `(source, identifier)` → same id back, one row, config replaced by the second call's config, status updated, a change appended; (b) different identifier → two rows; (c) setAccountConfig updates config and appends an `account` change. Run focused store suite — RED.
- [ ] **Step 2:** implement. Upsert SQL shape: `INSERT INTO accounts(...) VALUES(...) ON CONFLICT(source, identifier) DO UPDATE SET config = excluded.config, status = excluded.status RETURNING id` (keep the transaction + change-append structure the method already has; read the current body first — created_at must NOT be clobbered on conflict). Focused suite GREEN.
- [ ] **Step 3 (TDD):** failing engine test: connect the same fake source twice (same identifier, different config) → one account, merged/latest config, sync restarted not duplicated. Then implement `engine.updateConfig` + make `connect` tolerate the upsert (stop any existing running handle for that account before starting the new one). GREEN.
- [ ] **Step 4:** IPC channel + allowlist + `handle('accounts:update-config', ({ accountId, config }) => p.engine.updateConfig(accountId, config))`.
- [ ] **Step 5:** full `npm test` + `npx tsc --noEmit`; commit `feat(core): account upsert on connect, setAccountConfig + accounts:update-config`.

---

### Task 2: Wire reconcile into the engine

**Files:**
- Modify: `src/main/core/engine/engine.ts` (post-pull reconcile pass)
- Modify: `src/main/core/store/store.ts` ONLY if a "list live (externalId, type) refs for account" read is missing — prefer an existing query surface if one exists (check `Query`/store reads first)
- Modify: `src/shared/contracts.ts` + MIRROR `concept/greenfield.ts` (only if a new read method is added to the shared Store interface)
- Test: engine tests (fake source), store test for any new read

**Interfaces:**
- Consumes: `Source.reconcile(session): AsyncIterable<ExternalRef[]>` (already in the contract at `contracts.ts:320`, implemented by local-folder and imap, currently never called).
- Produces: after each SUCCESSFUL pull cycle, if the source implements `reconcile`, the engine drains it, collects the union of listed refs, diffs against the account's non-archived documents' `(externalId, type)`, and archives the unlisted ones through the existing `deletions` commit path (`archiveByRef`). Abort-safe: if the session signal fires mid-reconcile, do NOT archive based on a partial listing — skip the diff entirely.

- [ ] **Step 1 (TDD):** failing engine test: fake source with 3 committed docs whose reconcile lists only 2 → after a pull cycle, the third is archived (archived_at set, excluded from search), the two listed stay live; a second cycle is idempotent. Plus: reconcile that throws / aborts mid-stream → nothing archived, error surfaced like other sync errors (read how pull errors are recorded and match it).
- [ ] **Step 2:** implement the post-pull pass. The partial-listing guard is the correctness core: only diff when the reconcile iterator completed without abort/throw. GREEN.
- [ ] **Step 3:** full `npm test` + tsc; commit `feat(engine): archive documents no longer listed by source reconcile`.

---

### Task 3: local-folder goes multi-root

**Files:**
- Create: `src/shared/folder-paths.ts` (move `isUnder`, `coveringRoots` from `src/renderer/components/folder-picker/selection.ts`; selection.ts re-exports or imports from shared so the picker keeps working; move the corresponding unit tests or point them at the new module — no duplicated logic anywhere)
- Modify: `src/main/sources/local-folder/local-folder-source.ts`, `cursor.ts`, `scanner.ts`, `watch.ts`, `to-document.ts` (as needed)
- Test: `src/main/sources/local-folder/__tests__/` (extend existing suites)

**Interfaces:**
- Consumes: Task 1's upsert (second connect merges config) — but this task only changes the source; it must work under plain single-connect too.
- Produces:
  - `connect()` prompt schema: `{ type: 'object', required: ['paths'], properties: { paths: { type: 'array', items: { type: 'string' }, title: 'Folders', format: 'folder-paths' } } }`. Validates each entry resolves to an existing directory (error naming the offending path), normalizes with `coveringRoots(paths.map(p => path.resolve(p)))`, returns `{ identifier: 'this-machine', config: { paths } }`.
  - Config read: `getRootPaths(account): string[]` — `config.paths` when a non-empty string array. If config has legacy `path`/identifier-as-path shape instead, sync must fail fast with the exact error `Legacy single-folder account — remove this source and re-add its folder.` (surfaced like any sync error → visible on the account row).
  - Cursor: `type LocalFolderCursor = { roots: Record<string, { completedAt: string }> } | null` — per root: absent entry → backfill that root; present → incremental rescan by mtime, exactly today's logic per root. Batches stamp cursor snapshots non-destructively (spread existing roots, replace one key — mirror `imap/cursor.ts` advanceCursor). Roots removed from config are dropped from the cursor on next sync.
  - `externalId` = ABSOLUTE posix-style path (`absPath.split(path.sep).join('/')`) — collision-free across roots. `to-document.ts` and watch deletions must agree on this everywhere.
  - Watch: single chokidar watcher over `paths` (chokidar accepts an array); deletions yield the new absolute externalIds.
  - `reconcile()`: enumerate ALL configured roots, yield refs with absolute externalIds (Task 2's engine pass then archives docs under removed roots automatically).
  - `fetchBytes`: guard passes when `metadata.absPath` resolves inside ANY configured root (reuse `isUnder` from `src/shared/folder-paths.ts` on resolved paths).

- [ ] **Step 1:** move `isUnder`/`coveringRoots` to `src/shared/folder-paths.ts` (verbatim, doc comments included); update the renderer picker's imports; run the moved/pointed selection tests — GREEN before touching the source.
- [ ] **Step 2 (TDD):** extend local-folder tests RED-first: connect with 2 valid dirs (+1 nested → normalized out; +1 nonexistent → error names it); multi-root backfill commits docs from both roots with absolute externalIds (assert a same-named file in both roots yields two docs); per-root incremental (touch file in root B only → only it re-emits; root added later backfills only itself); reconcile lists both roots' files absolutely; fetchBytes serves a root-B file and still rejects outside-any-root paths; legacy `{ path }` config → sync error with the exact message.
- [ ] **Step 3:** implement to GREEN, root by root: cursor.ts type + advance, scanner root loop, to-document externalId, watch array + deletion ids, connect schema/validation, fetchBytes guard, legacy guard.
- [ ] **Step 4:** full `npm test` + tsc; commit `feat(sources): local-folder tracks multiple roots under one machine account`.

---

### Task 4: Renderer — one flow submits paths[], picker knows tracked folders

**Files:**
- Modify: `src/renderer/screens/Sources/AddSourcePanel.tsx`
- Modify: `src/renderer/components/folder-picker/FolderPickerModal.tsx`
- Modify: `src/renderer/components/FolderPickerField.tsx` (only if shared types shift)
- Modify: `src/renderer/screens/Sources/Sources.css` (tracked-pill style if no existing class fits)

**Interfaces:**
- Consumes: Task 3's schema (`paths` array field, `format: 'folder-paths'`), Task 1's upsert (connect on existing machine account merges).
- Produces:
  - Fast path now triggers on a single field with `format === 'folder-paths'` (array) → multiselect picker → confirm submits ONE prompt answer `{ [key]: paths }` where `paths` = union of confirmed covering roots and the already-tracked roots (so the upserted config never loses folders), normalized via shared `coveringRoots`. DELETE the N-sequential-flows machinery Task 22 added: `runBatch`, `runFolderFlow`, `awaitFlowOutcome`, `BatchState`, `FlowOutcome`, `basename`, the batch view block, and their state — the single-flow done/error views handle the rest. Keep `openFlow`.
  - The old single-`folder-path` fast path branch: keep detection for the format string `folder-path` working through `FolderPickerField` in the generic form (fallback), but the local-folder fast path is now the array form.
  - `FolderPickerModal` gains `existingPaths?: string[]`: rows whose path equals or is under an existing path render a `tracked` pill (copy exactly: `tracked`), are inert to selection clicks, and are excluded from chips/confirm/estimate; rows ABOVE an existing path (ancestors) remain selectable (confirm-time union+normalize absorbs the tracked descendant — one account, no double indexing, this is now safe by model). Existing paths come from the app-state projection: the local-folder account's `config.paths` (empty when no account).
- [ ] **Step 1:** implement modal `existingPaths` (derive per-row state alongside `checkState`; reuse `isUnder` from shared).
- [ ] **Step 2:** rewrite the fast path + delete batch machinery; walkthrough in the report: (a) fresh machine → pick 3 → one flow → one account with 3 roots; (b) machine account exists with 2 roots → picker shows them `tracked`, pick 1 more → submitted answer = 3 covering roots → same account updated; (c) cancel → existing Cancel semantics; (d) gmail/imap forms byte-identical.
- [ ] **Step 3:** full `npm test` + tsc (renderer has no harness — walkthrough + types are the gate); commit `feat(sources): single-flow multi-folder add, picker marks tracked folders`.

---

### Task 5: Tracked folders section + list polish + docs

**Files:**
- Create: `src/renderer/screens/Sources/sections/TrackedFolders.tsx`
- Modify: `src/renderer/screens/Sources/SourceDetail.tsx` (render it for accounts whose config has `paths`, above TrackedContent)
- Modify: `src/renderer/screens/Sources/SourcesList.tsx` or `SourceTable.tsx` (row subtitle "N folders" for the machine account — follow existing row-copy conventions)
- Modify: `src/renderer/screens/Sources/Sources.css` (as needed)
- Modify: `docs/rebuild/LEFTOVERS.md` and `concept/gaps.md` (Tier-2 #10: note overlap-prevention + multi-root resolved by this initiative; globs/excludes still open; do NOT add a STATUS banner to Tier 2 — only annotate item 10)

**Interfaces:**
- Consumes: `accounts:update-config` (Task 1), `sources:count-files`, the multiselect add flow (Task 4).
- Produces: a "Tracked folders" section: one row per `config.paths` entry — full path, live recursive count (same `counting…`/`N files`/`N+ files` copy via the shared `formatCount`), and a Remove button. Remove asks confirm (reuse the repo's confirm pattern — check how DangerZone/RemoveAccountModal confirm) with copy `Stop tracking this folder? Its files will be removed from search.`; on confirm → `accounts:update-config` with the path dropped (never drop the last one: when only one root remains, the Remove button is disabled with title `Remove the source instead` — the DangerZone handles full removal). An "Add folders…" button opens `FolderPickerModal` multiSelect with `existingPaths` = current roots; confirm → `accounts:update-config` with union+`coveringRoots`.

- [ ] **Step 1:** build the section + wire into SourceDetail; list-row "N folders" subtitle.
- [ ] **Step 2:** docs updates (LEFTOVERS + gaps.md annotation).
- [ ] **Step 3:** full `npm test` + tsc; walkthrough in report: remove middle of 3 roots → config shrinks, account restarts, next reconcile archives that root's docs; add via section merges; last-root Remove disabled. Commit `feat(sources): tracked folders management on source detail`.

---

## Final review

After Task 5: whole-initiative review over BASE (commit before Task 1) → HEAD via `scripts/review-package`, dispatched on the most capable model; consolidated fix wave if findings; re-review; then push.
