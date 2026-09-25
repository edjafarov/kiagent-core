# Simple bug batch (2026-09-25)

The ten smallest open `bug` issues after the 2026-09-25 triage, each fixed with a test. The GitHub issues are the spec. Each task names its issue, and the issue text is authoritative where this plan is silent.

## Global Constraints

- Repo root `/Users/edjafarov/work/kiagent-core`, branch `fix/simple-bugs-2026-09-25` (from `origin/dev`). Do not push, and do not switch branches.
- **TDD.** Write the failing test first, run it and see it fail for the right reason, then fix and see it pass.
- **One commit per task**, in the repo's conventional style (`fix(<scope>): <what>`). The body ends with `Fixes #<N>` and then the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Stage only the files the task touches, and never `git add -A`: `docs/issues/` is untracked and must stay out.
- **Verification for every task:**
  - `npx jest -c jest.config.dev.js <dirs>`, passing. `<dirs>` is every `__tests__` directory enclosing a module you touched, plus any other suite whose filename matches a touched module or that asserts the behavior you changed. Grep for the function or tool name.
  - `npm run typecheck`, passing.
  - `npx eslint <every file you touched>`, clean for those files. Baseline lint errors exist in 12 unrelated files on dev (see `base-lint-files.txt` in the SDD workspace); do not fix or touch those. Attribute lint by filename.
- **Known pre-existing failure, out of scope:** `src/main/core/mcp/__tests__/schema-doc-drift.test.ts` (the attention tables are undocumented). Leave it alone.
- Match the surrounding code: comment density, naming, idiom. Add no new dependencies, except in Task 5.

---

## Task 1: Outbox CHECK assertions stop matching on error identity (#119)

**Files:** `src/main/core/store/__tests__/outbox.test.ts` (test-only).

**Problem.** `outbox.test.ts:59` and `:85` use `.rejects.toThrow(/CHECK/)` on a native better-sqlite3 error. When another suite has loaded better-sqlite3 earlier in the same process, jest's `isError` check fails across module registries and reports "Received function did not throw". This already fails deterministically in the full `jest.config.dev.js` run on dev. The third assertion from the issue (ATTACH/VACUUM in host-surfaces) was already rewritten in 06f8dad6; leave it.

**Fix.** Match on the message, not the class: `.rejects.toMatchObject({ message: expect.stringMatching(/CHECK/) })`. Grep `src/main/core/store/__tests__/` for any other `.rejects.toThrow(` on a raw SQLite rejection and convert it the same way.

**Red/green evidence:**
1. Reproduce the failure before the change by running outbox.test.ts after a suite that loads better-sqlite3 in-process: `npx jest -c jest.config.dev.js --runInBand <other suite> src/main/core/store/__tests__/outbox.test.ts`. Find a pairing that fails; `src/main/core/store/__tests__/store.test.ts` is a good first candidate.
2. After the change, that same command passes.
3. Temporarily break the CHECK (for example, insert a valid status in the "rejects a status" test) and confirm the new assertion fails. Then revert.

**Commit:** `test(store): match outbox CHECK rejections on message, not error identity`

---

## Task 2: macOS `activate` reopens the main window regardless of auxiliary windows (#123)

**Files:** `src/main/main.ts`.

**Problem.** `main.ts` (about line 1308) runs `app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); })`. An auxiliary extension window keeps the count above zero, so a Dock click with the main window closed does nothing.

**Fix.** Call the existing `showMainWindow()` (`main.ts:396`) from the `activate` handler. It already creates the window when `mainWindow` is null (the `'closed'` handler at `:364` nulls it) and otherwise restores, shows and focuses it. Remove the `BrowserWindow` import only if nothing else uses it.

**Tests.** `main.ts` is the Electron composition root and has no unit-test seam. Don't build one for this. Say so in your report, and rely on typecheck and lint.

**Commit:** `fix(main): Dock activate reopens the main window even when extension windows exist`. Mention in the body that `showMainWindow` also restores a window hidden to the tray (9c8c027e).

---

## Task 3: Manifest engine range is checked before schema validation (#42)

**Files:** `src/main/platform/manifest.ts`, `src/main/platform/__tests__/manifest.test.ts`.

**Problem.** `parseManifest` (`manifest.ts:204`) runs the zod schema, including the `caps` enum, before the engine check (`:223`). A manifest using a cap from a newer platform gets raw zod output (`caps.1 — Invalid enum value…`) instead of `requires platform <range>; this build is <version>`.

**Fix.** At the top of `parseManifest`, before `schema.safeParse`: if `raw` is an object whose `engine` is a string, `semver.validRange(engine)` is non-null, and `!semver.satisfies(PLATFORM_API_VERSION, engine)`, then throw `ManifestError` with exactly the existing message format: `` `requires platform ${engine}; this build is ${PLATFORM_API_VERSION}` ``. Keep the existing post-parse check. Invalid ranges still fall through to the schema's own error.

**Tests (red first):**
- A manifest with an unknown cap (for example `'futurecap'`) and an unsatisfiable engine (`'^99.0.0'`) throws `/requires platform/`. Today it throws the caps enum error.
- A manifest with an unknown cap and a satisfied engine still throws the schema error (`/invalid manifest/`).
- The existing engine tests (`manifest.test.ts:90-110`) still pass.

**Commit:** `fix(platform): check a manifest's engine range before its schema so old builds say "requires platform"`

---

## Task 4: `installCommit` reports an activation failure (#118)

**Files:** `src/main/platform/extension-platform.ts`, plus a platform test (and a fixture if needed).

**Problem.** `installCommit` (about `extension-platform.ts:1365-1380`) awaits `activate(e)` and returns `{ ok: true, id }`. `activate()` (`:806`) never throws on a failed activation: it calls `setStatus(e, 'errored', message)` (for example at `:1015`, or via `onStatus` when `host.start()` fails), so the caller is told the install succeeded while the extension is not running.

**Fix.** After the existing try/catch around `rearmPlugin`/`activate`/`clearRecoveryMarker`, check `e.status === 'errored'` and return `{ ok: false, error: `installed, but activation failed: ${e.error ?? 'unknown error'}` }`. Do not throw inside that try: its catch writes a recovery marker, which means "the commit itself needs recovery", and that's wrong here because the files are committed fine. `'needs-consent'` and other non-errored statuses are not failures. A successful install is unchanged.

**Tests (red first).** Install (preview, then commit) an extension whose `activate` throws. Reuse a fixture if one exists (look in `src/main/platform/__tests__/fixtures/`), otherwise add a minimal `ext-activate-throws` fixture modeled on `ext-basic`. Assert `installCommit` returns `ok: false` and the error contains the activation error text. Also assert a normal install still returns `{ ok: true }`. Put the test in a suite that `jest.config.dev.js` runs: check its heavy-suite exclusion list (`jest.config.dev.js:13-32`) before choosing a file.

**Commit:** `fix(platform): installCommit reports ok:false when the installed extension fails to activate`

---

## Task 5: Bump undici to 7.30.0 (#130)

**Files:** `package.json`, `package-lock.json`.

**Problem.** `package.json:154` pins `"undici": "7.27.2"`. It ships in main via `src/main/platform/net-guard.ts:29` (`Agent`), and `npm audit --omit=dev` flags it high: 12 advisories, fixed in 7.30.0, not a semver major.

**Fix.** `npm install undici@7.30.0 --save-exact --no-audit --no-fund`. Keep the exact-pin style. ERB's postinstall (`install-app-deps`, `build:dll`) runs and is slow. That's expected.

- `git diff --stat` must show exactly `package.json` and `package-lock.json`. Revert anything else npm touches, such as `release/app/package-lock.json`.
- The `package-lock.json` diff must be undici-only: the `node_modules/undici` entry and the root `packages[""].dependencies` pin. If npm reshuffled unrelated entries, restore the lockfile, retry, and inspect. Report the diff stat in your report.

**Verification (no new test needed; this is a dependency bump):**
- `npm ls undici` shows the top-level `undici@7.30.0`.
- `npm audit --omit=dev --json | jq '.vulnerabilities.undici'` no longer lists the top-level 7.27.2 advisories. Report exactly what remains, if anything.
- `npx jest -c jest.config.dev.js` on the net-guard tests (`grep -rl net-guard src --include=*.test.ts`) passes.
- **`npm run build:main` succeeds.** It's the minified production build; b92ed6cc had to bump terser because undici 7's class-field syntax broke minification. Dev builds don't minify, so this is the only check that catches it.

**Commit:** `fix(deps): bump undici to 7.30.0 to clear 12 high advisories in shipped code`

---

## Task 6: MCP audit log redacts and caps tool arguments (#131)

**Files:** `src/main/core/mcp/registry.ts` (plus a small helper in the same directory if cleaner), `src/main/core/mcp/__tests__/registry.test.ts`.

**Problem.** `attachToolHandlers` logs `args` verbatim through `logSink.log('mcp.call', …)` on three paths (unknown tool at about `registry.ts:98`, success at about `:113`, error at about `:122`). That log is the JSONL file `logs:export` hands to bug reports, so draft email bodies, recipients, full SQL and queries end up in it.

**Fix.** Add a pure `redactArgsForLog(args)` and use it on all three `logSink.log` calls. Leave `emit`/`summarizeCall` (the in-app activity feed) unchanged. Rules, applied to top-level keys:
- Keys `body`, `body_markdown`, `markdown`, `text`, `content` holding a string → `"[redacted: <N> chars]"`.
- Keys `to`, `cc`, `bcc` → `"[<N> recipients]"` (an array's length, or 1 for a string).
- Any other string longer than 200 chars → its first 200 chars + `"…(+<M> chars)"`.
- Arrays and objects whose `JSON.stringify` exceeds 200 chars → `"[array: <N> chars]"` / `"[object: <N> chars]"`. Otherwise pass them through.
- Numbers, booleans and null pass through.

**Tests (red first), in registry.test.ts, with a capturing fake `logSink`:**
- A `draft_message`-shaped call (`body` long, `to: ['a@x', 'b@x']`, `subject`) logs no body text, and `to` becomes `'[2 recipients]'`.
- A 1,000-char `sql`/`query` string is truncated with the suffix.
- The unknown-tool and throwing-tool paths are redacted too.
- A unit test for `redactArgsForLog` edge cases.

**Commit:** `fix(mcp): redact bodies and recipients and cap argument size in the MCP call audit log`

---

## Task 7: The app log rotates at a size cap (#85)

**Files:** `src/main/core/logs.ts`, plus a test (`src/main/core/__tests__/logs.test.ts` if none exists).

**Problem.** `createLogs` (`logs.ts:17`) appends to `kiagent.log.jsonl` with `fs.appendFile` and no size check. Real installs have 800 MB files, and `export()` hands over the whole file.

**Fix.**
- Change the signature to `createLogs(dir, opts: { maxBytes?: number } = {})`, with default `maxBytes = 10 * 1024 * 1024`. Keep existing callers compiling.
- **Switch the append to `fs.appendFileSync`.** The current fire-and-forget `fs.appendFile` races any synchronous rotation: every append issued in a burst opens the path after the rename, so rotation would never take effect. A ~200-byte sync append costs microseconds, and electron-log does the same.
- Track `bytes`: start at the file's size (`statSync`, or 0 if absent) and add `Buffer.byteLength(line)` per append.
- After an append, if `bytes > maxBytes`, rotate: `fs.renameSync(file, file + '.1')` (this replaces any previous `.1`), then reset `bytes = 0`. Apply the same check once at startup, so an existing oversized file rotates immediately.
- Keep appends and rotation best-effort: try/catch, never throw out of `log()`. The ring buffer and live viewer must keep working if the disk write fails.
- `export()` still returns the current file.
- Don't read the file to rotate it (unlike `mcp/activity.ts:61`): files can be hundreds of MB.

**Tests (red first):**
- Choose `maxBytes` so exactly one rotation happens. Assert that `kiagent.log.jsonl.1` exists and that the two files together contain every record logged, in order, with none lost.
- With a small `maxBytes` and many rotations, assert that the current file never exceeds `maxBytes` plus one record's length.
- A pre-existing oversized file is moved to `.1` on `createLogs`.
- `export()` still returns the current file path.

**Commit:** `fix(logs): rotate kiagent.log.jsonl at 10 MB, keeping one previous generation`

---

## Task 8: Extension tools must be declared, and the MCP registry refuses overwrites (#14)

**Files:** `src/main/core/mcp/server.ts`, `src/main/platform/extension-platform.ts`, test fixtures under `src/main/platform/__tests__/fixtures/`, plus tests.

**Problem.**
- `registerTool` (`server.ts:507-511`) does `registry.set(tool.name, tool)` and its disposer does `registry.delete(tool.name)`. An extension tool named `search` shadows the builtin for every session, and its disposer then deletes the builtin until restart.
- The platform's tool loop (`extension-platform.ts` about `:754-763`) registers every tool the extension host reports, ignoring `manifest.contributes.tools`. Sources are already checked against their declaration (find the declared-source check with its warn log in the same file).

**Fix.**
1. **`server.ts` `registerTool`:** if `registry.has(tool.name)`, log a warn through the server's log sink (`tool '<name>' is already registered — refusing to overwrite`) and return a no-op disposer. The normal disposer deletes only if `registry.get(tool.name) === tool`, which fixes the latent A/B disposer bug. This also covers the second registration path, `main-api.ts` (bundled `unsafe.mainProcess` extensions).
2. **`extension-platform.ts` tool loop:** skip, with a warn log mirroring the declared-source check, any tool whose name isn't in the manifest's declared `contributes.tools`. Find the exact field path in `manifest.ts`/`contracts.ts`. Don't namespace tool names.
   **First read `fixtures/ext-bundled-shadow` and every test that uses it.** It's named for the exact behavior this task changes. If its test asserts that a bundled extension *can* shadow or overwrite a tool, that assertion must change to the new refusal behavior, deliberately, and your report must say so. If it already asserts refusal through some other mechanism, reconcile rather than duplicate.
   The overlay's bundled extensions (alpha-cent `extensions/{remote-mcp,meetings,documents}`, checked 2026-09-25) declare and return no tools, so the declaration check in step 2 applies to every origin, bundled included.
3. **Fixtures:** the issue notes that `fixtures/ext-basic/manifest.json` must declare `"tools": ["basic_echo"]`, because many `extension-platform.test.ts` assertions depend on it. Other fixtures whose `index.js` returns tools may also lack declarations (`ext-bundled-shadow`, `ext-oauth` are candidates). Run the platform suites and declare what each fixture actually contributes. Change a fixture only if it's missing a declaration; if a test deliberately exercises undeclared tools, keep it and assert the new behavior. (All 11 kia-plugins marketplace connectors were checked on 2026-09-25: none contribute tools, so the declaration check breaks no published extension.)

**Tests (red first):**
- A tool registered under a builtin's name (`search`) doesn't replace it, and calling its disposer leaves the builtin registered.
- Two registrations of the same non-builtin name: the second is refused, and the first's disposer still removes the first.
- A fixture extension that contributes an undeclared tool: it isn't registered and a warn is logged. Its declared tools still register.

**Commit:** `fix(platform): only register declared extension tools, and never let a registration overwrite an existing MCP tool`

---

## Task 9: `get_related` returns bounded summaries in the MCP wire shape (#76)

**Files:** `src/main/core/mcp/tools/get-related.ts`, `src/main/core/mcp/tools/index.ts` (if the schema or description wiring needs it), `src/main/core/mcp/instructions.ts` (only if it describes get_related's output), plus a new test `src/main/core/mcp/__tests__/get-related.test.ts`.

**Problem.** `get_related` returns raw internal `Document` rows: camelCase, full `markdown` bodies, no limit. A 200-message thread returns 200 full bodies, and the shape is inconsistent with `get`/`search`'s snake_case contract (`get.ts:28-55`).

**Fix.**
- **Inputs:** add optional `limit` (integer, default 50, clamped to 1–200) and `offset` (integer ≥ 0, default 0). Keep `document_id` and `relation` as they are.
- **Output:** an array of summaries with this shape:
  `{ id, source, type, title, source_url, parent_id, created_at, snippet }`
  - `source` comes from `query.accounts()`, mapped `accountId` → `source` exactly like `get.ts`.
  - `snippet` is `markdown` truncated to 280 chars, or null.
  - There is no `markdown`, `metadata` or `content_hash`.
- `children` = `(await query.children(id)).slice(offset, offset + limit)`. `parent` returns the same summary shape, a 0-or-1 array.
- **Description:** say it returns summaries, pages with `limit`/`offset`, and that callers use `get` for full bodies.
- Check that `summarizeCall` in `src/main/core/mcp/activity.ts` still handles `get_related` results (it may count them).

**Tests (red first):** use a fake `Query` whose `children` returns three docs with long markdown and camelCase fields. Assert:
- snake_case keys and no `markdown` key;
- `snippet` is at most 280 chars;
- `limit`/`offset` slice correctly;
- a `limit` of 1,000 clamps to 200;
- `parent` returns the summary shape, and `[]` when there's no parent.

**Commit:** `fix(mcp): get_related returns paged summaries in the snake_case wire shape instead of raw rows`

---

## Task 10: `rerunDeferred` writes the ledger only after the page's output is committed (#63)

**Files:** `src/main/core/engine/engine.ts`, plus a test in `src/main/core/engine/__tests__/engine.test.ts` or `src/main/workers/__tests__/redrive.test.ts` (whichever already drives `rerunDeferred` with a controllable store).

**Problem.** `workOne` (`engine.ts:641`) calls `store.ledgerRecord(consumer, seq, attempt, outcome)` right after `worker.work`, at `:701` for success and defer and at `:716` for final failure, before the caller commits the emitted docs. `rerunDeferred` (`:1744`) commits the page's `emitted`/`enrich` only at the end of the page (about `:1802-1812`). It has no cursor: the ledger row is its only driver. A quit, crash or update restart between those points marks up to `REDRIVE_PAGE` entries `done` while their OCR/ASR output was never committed, and nothing ever re-selects them. The live feed path (about `:1658`) is safe, because its cursor only advances inside the commit.

**Fix.**
- `workOne` stops writing the ledger. It returns `{ docs, enrich, attempts, outcome }`, where `outcome` is the ledger outcome it used to record (`'deferred'` for a `'defer'` result, `'failed'` after the final attempt, otherwise the worker's outcome). Use the existing ledger outcome type.
- **Live feed path:** record exactly as before, right after `workOne`: `await store.ledgerRecord(consumer, change.seq, r.attempts, r.outcome)`. Its behavior is unchanged.
- **`rerunDeferred`:** collect `{ seq, attempts, outcome }` for every worked change in the page. `ledgerRecordMany`'s entry type (`store.ts:297`) already accepts the full outcome union; no widening is needed. After the page's `store.commit(...)`, or when there's nothing to commit, write the page's skips and worked entries in one `store.ledgerRecordMany(consumer, entries)` call.
- If a crash happens between commit and ledger write, the entries stay `deferred` and are re-worked next time. That's at-least-once, which is intended; say so in a short comment.
- If `workOne` throws mid-page (abort), nothing for that page is recorded, so the entries stay `deferred`.

**Tests (red first):** drive `rerunDeferred` over a page of deferred entries whose worker now succeeds, with `store.commit` made to reject for that page. Assert the entries are still returned by `store.ledgerDeferred` (still deferred), not recorded `done`. Today they're `done`. Also assert the happy path still records `done` and commits the docs. Existing `engine.test.ts` and `redrive.test.ts` must pass.

**Commit:** `fix(engine): rerunDeferred records the ledger only after the page's output is committed`
