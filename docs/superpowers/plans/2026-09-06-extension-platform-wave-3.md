# Extension platform wave 3 — contributed views and scoped file access

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An extension can ship a screen that core renders in an isolated frame over a brokered, identity-bound transport, and can list, read, create and safely move files inside folders the user granted to it — both without a build-time patch of core's channel lists.

**Architecture:** Two independent features that happen to close the same gap: a feature can leave the bundled tier only when it has both a screen and a filesystem. #104 adds a `views` contribution, one `WebContentsView` per mounted view on its own session partition and scheme, and a main-side broker that stamps caller identity from `webContents.id`. #105 implements `ScopedFiles` against per-extension folder grants, with a move algorithm whose invariant is that at least one complete verified copy survives every step.

**Tech Stack:** TypeScript, Electron 42 (`WebContentsView`, `protocol.handle`, session partitions), better-sqlite3, Jest.

**Spec:** `docs/superpowers/specs/2026-09-06-extension-platform-track-design.md`

**Issues:** #104, #105. Both bodies are the requirements documents; #104's "Why not an extension-declared IPC allowlist" section and #105's five-step move algorithm are binding and are not restated here.

**Prerequisite:** wave 2 merged and released (v0.87.0).

## Granularity — read this first

This plan is written at **task granularity, not step granularity**: each task names its files, its interface, its acceptance and its gate, but does not carry the line-level test-then-code sequence waves 1 and 2 carry. That is deliberate and it is a scope decision, not an omission.

Two reasons. First, #104's broker is the only new security boundary in the whole track, and its shape should be settled against a live feed consumer — a real screen with real data — rather than designed in the abstract two waves early. Second, nothing in the first shipping increment of the downstream product needs either issue: both move existing, working capability out of the bundled tier.

**Before starting this wave**, expand each task below into step-level detail the way waves 1 and 2 are written, in this same file, and put that expansion through the same review as the code. A task here that reads as one paragraph is one or two days of work, not one commit.

## Global Constraints

- Base: `dev` after v0.87.0.
- **Extension code never runs in the shell renderer.** A contributed view has no `window.kiagent`; its only bridge is the broker. This is the point of the whole design — an extension-declared IPC allowlist was considered and rejected, for reasons #104 records.
- **Caller identity is never read from a payload.** The broker resolves `{ extensionId, viewId }` from a registry keyed by the sending `webContents.id`, and rejects an unknown sender outright.
- **`rename` is never used for a move.** It replaces silently. Publishing happens only through an atomic no-replace primitive; when the destination volume supports none, the call fails with `FILES_UNSUPPORTED_SAFE_MOVE` and the source is untouched.
- **No delete and no overwrite in v1**, except the source side of a verified move. Both are refused loudly rather than quietly allowed.
- Commit messages: conventional prefix, plain sentence, no trailers.
- Gates: `npm run typecheck && npm run lint && npm test`, plus the new Windows job from Task 9.

---

## Lane A — #104, contributed views

### Task 1: Manifest — the `views` contribution and the `views` cap

**Files:** `src/main/platform/manifest.ts:28-39,94-105,121-125,169-214`; `src/main/platform/__tests__/manifest.test.ts`; `src/renderer/components/cap-catalog.ts`; `src/main/platform/host-router.ts`; `src/main/platform/extension-host-entry.ts`.

**Produces:** `contributes.views: ViewContribution[]` with `id`, `title`, `icon`, `group`, `entry`, `viewApi`, `badge`, `methods[]`, `events[]`; exported `VIEW_API_VERSION = '1'`; cap `views` ("Add screens to the app").

**Acceptance:** views parse; a duplicate id, an `entry` escaping the extension directory, a `viewApi` mismatch, and non-empty `contributes.views` without the `views` cap each throw `ManifestError` at parse time. `cap-table-completeness.test.ts` green with the new namespace.

**Note:** `entry` containment reuses the existing check at `manifest.ts:169-214` — do not write a second path validator.

### Task 2: The broker

**Files:** create `src/main/platform/view-broker.ts`; test `src/main/platform/__tests__/view-broker.test.ts`; new main→child `ns: 'view'` in `src/shared/extension-rpc.ts`.

**Produces:** extension side `host.views.handle(method, fn)`, `host.views.emit(event, payload, viewId?)`, `host.views.badge(viewId, count | null)`.

**Acceptance:** identity comes from the sender registry and a payload claiming another extension is ignored; an unregistered sender is rejected; params, result and event payloads are validated against the declaring view's JSON Schemas in both directions; an event emitted by extension A never reaches extension B's view; the 30 s timeout, the 1 MiB payload cap and the per-view in-flight cap of 16 are enforced; teardown rejects every in-flight call with `VIEW_HOST_GONE`.

**This is the security task of the wave.** Review it on the most capable model available, and write the negative cases before the positive ones.

### Task 3: Isolated execution

**Files:** create `src/main/view-preload.ts`; modify `src/main/main.ts:303-310` and the window layout path; `src/shared/ipc.ts` (`views:mount`, `views:bounds`, `views:unmount`); **`.erb/configs/webpack.config.main.prod.ts:27-37` and its development counterpart** — both enumerate their entries explicitly (`preload: path.join(webpackPaths.srcMainPath, 'preload.ts')`, output `'[name].js'`), so a preload with no entry produces no artifact and the view loads with no bridge at all.

**Produces:** one `WebContentsView` per mounted view — `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, session partition `persist:ext:<extensionId>`, preload exposing only `window.kiaView = { call, on, route, theme }`; content served from `kia-view://<extensionId>/<path>` through `protocol.handle`, reading only inside the extension directory; navigation and `window.open` outside that origin refused; bounds follow a placeholder element in the shell; tokens from `src/shared/web-ui/tokens.css` injected with `insertCSS` and re-pushed on a prefs change.

**Acceptance:** `render-process-gone` and an unresponsive view degrade to a placeholder with Reload, leaving the shell renderer and main untouched. A dev-loaded (non-bundled) extension with a view runs with no build-time patch — this is the manual check that says the feature actually landed.

### Task 4: States, teardown and the sidebar

**Files:** `src/shared/contracts.ts` (`ExtensionSnapshot` gains `views: ViewContribution[]`), the renderer sidebar and its tests.

**Acceptance:** each extension status renders its row and its pane — `activated` (shown, badge live, view mounted), `activating` (dimmed, spinner), `needs-consent` (dimmed, "Review permissions"), `errored` (alert dot, error placeholder with Retry), `disabled` or uninstalled (removed; if it was current, fall back to the default view). Deactivate, disable, uninstall and crash all reject pending calls, unregister handlers and destroy the `WebContentsView`. An unknown deep link lands on the default view. Contributed items render after built-ins within their group.

### Task 5: End-to-end and the lane A PR

**Files:** `src/main/platform/__tests__/extension-e2e.test.ts`; `docs/architecture/extension-platform.md`.

**Acceptance:** a fixture extension with one view appears in the snapshot; disabling it removes the item and unregisters its handlers. Docs row added. Gates green. PR closes #104.

---

## Lane B — #105, scoped file access

### Task 6: Grants

**Files:** `src/main/core/store/schema.ts` (ladder step **v5**, appended — `file_grants(extension_id, root_id, root_name, granted_at, revoked_at)`); `src/shared/ipc.ts` (`extension:grant-folders`, `extension:revoke-folder`); the Marketplace detail screen.

**Produces:** `host.files.roots()` returning the granted `FolderRootSelection[]`; every other path is a `{ root, rel }` pair, never a bare absolute path.

**Acceptance:** the `files` cap alone grants nothing — with zero roots every call rejects `FILES_NO_ROOTS`. Granting reuses the existing folder picker and normalises the result with `coveringRoots` (`folder-paths.ts:56-58`). Granting a folder does **not** index it; indexing stays a separate explicit source action. `root_id` is the absolute normalised path, formed exactly as `toAbsPosix` forms one (`scanner.ts:162-168`).

### Task 6b: Migrate the `ScopedFiles` contract

**Files:** `src/shared/contracts.ts:896-901` (`ScopedFiles`) and `:907` (`CapSurfaces.files`); every declaration file an extension author compiles against.

Today the interface is path-string based and has four members: `list(rel)`, `read(rel)`, `write(rel, data)`, `move(from, to)`. This wave replaces `rel` strings with `{ root, rel }` pairs and adds `roots`, `stat`, `mkdir` and the `{ ifAbsent: true }` write option. Changing `NS_METHODS` and the implementation alone leaves a typed extension unable to call any of it, and leaves the published contract lying about the surface. Do this migration in one commit, before Task 7's implementation, so no intermediate state ships a half-typed capability.

**Acceptance:** the union of `NS_METHODS.files`, `ScopedFiles` and `buildSurfaces`'s `files` namespace is identical — which is what `cap-table-completeness.test.ts` checks — and a fixture extension compiles against the new shape.

### Task 7: Read-side surface

**Files:** create `src/main/platform/scoped-files.ts`; modify `host-surfaces.ts:204-209` and `NS_METHODS.files`; test `src/main/platform/__tests__/scoped-files.test.ts` against real temp directories.

**Produces:** `list`, `stat`, `read` (regular files only, 256 MiB cap), `mkdir`, `write(…, { ifAbsent: true })` (create-only, `wx`).

**Acceptance:** `..`, an absolute `rel`, empty segments and NUL are all rejected; a symlinked ancestor is rejected **even when the target resolves inside the root**; symlinks are reported as `kind: 'other'` and never followed; a root revoked mid-call is rejected. Replace the existing "files and commands throw CapError" test (`host-surfaces.test.ts:244`) with real cases; `commands` still throws.

### Task 8: The move algorithm

**Files:** `src/main/platform/scoped-files.ts`; `src/main/platform/__tests__/scoped-files.test.ts`.

**Acceptance — each of these is a test, and every one of them is a real failure mode, not a hypothetical:**

1. `move` onto an existing file fails `FILES_EXISTS` and leaves both files intact, including when a spawned writer creates the destination between the caller's `stat` and the move — a probe that saw the name free proves nothing at publish time.
2. When neither `link` nor exclusive create is available on the destination volume, the call returns `FILES_UNSUPPORTED_SAFE_MOVE` with the source untouched.
3. Cross-device (simulated by injecting a `link` failure): exclusive create, full content-hash verification before any unlink, metadata preserved, source-changed abort, failed-unlink recovery record.
4. A source replaced by a different inode during the copy unlinks nothing and returns `FILES_RECOVERY_REQUIRED`.
5. `rename` is never called — assert with an adapter spy, not by reading the code.
6. Containment of the resolved destination is re-validated immediately before the write syscall: a root can be revoked, or replaced by a symlink, mid-call.

### Task 9: Audit log, consent copy, Windows CI

**Files:** `schema.ts` (`files_audit`, appended as its own ladder step), `src/main/core/logs.ts` scope `extension:<id>.files`, `files:audit` invoke, `src/renderer/components/cap-catalog.ts:34-39`, `.github/workflows/kiagent-core-ci.yml`, `docs/architecture/extension-platform.md:78`.

**Acceptance:** every `write`/`move`/`mkdir` writes an intent row **before** the syscall and updates it with the outcome after — including on failure. Consent copy becomes "Access folders you approve" / "Can list, read, add and move files inside folders you pick for this extension — nothing outside them. It cannot delete files.", `risk: 'elevated'`; the "Not yet supported in this build" sentence is deleted.

**Windows CI** (spec D6): a second `windows-latest` job running typecheck plus the scoped-files suite only — not the full suite. Note the prerequisite: Jest's `setupFiles` runs `./.erb/scripts/check-build-exists.ts` (`package.json:96-97`), which throws unless the main and renderer bundles are already built — so the job either runs `npm run build` first or uses a dedicated Jest config that deliberately omits that setup file. Decide which in the task, and say why in the workflow file. It covers reserved names, trailing dot and space, and case-insensitive collision, each surfacing as `FILES_EXISTS` or `FILES_INVALID_NAME`. If the job is flaky across its first ten runs, mark it non-blocking and record the criteria as a documented manual check **in this file** — do not delete them.

### Task 10: End-to-end and the lane B PR

**Acceptance:** a fixture extension with `files` and one granted temp root lists, reads and moves; with no grant every call rejects `FILES_NO_ROOTS`. `cap-table-completeness.test.ts` green after `roots`, `stat` and `mkdir` join `NS_METHODS`. Gates green on both CI jobs. PR closes #105.

---

## Task 11: Release v0.88.0

Full gate on `dev`, then `npm run release`. Release notes: an extension can contribute a screen and can work inside folders the user granted it. Say plainly what is still refused — no delete, no overwrite, no folder watching (a consumer polls `list`/`stat` inside its root on a bounded interval; a watch service is a separate story).

---

## Self-review notes

- **Lane A and lane B are independent** except for `cap-catalog.ts`, `NS_METHODS` and `manifest.ts` — the shared-file rule from the spec applies, so their PRs serialize even though their work does not.
- **The two riskiest tasks are 2 and 8**, for the same reason: both are the only thing standing between an extension and something it must not be able to do. Both get the most capable reviewer available.
- **Not in this wave, on purpose:** a widget framework or slots inside core screens, `commands`, a marketplace redesign, menu bar and tray contributions, recursive delete, overwrite, trash, and folder watching as a host service.
