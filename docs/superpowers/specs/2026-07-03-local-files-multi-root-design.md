# Local files: one source, many folders — design

**Approved by user 2026-07-03** (chose "one real multi-folder source" over visual grouping / status quo). Closes the presentation/model gap vs the original app (one "This Mac" entry with N folders) and resolves `concept/gaps.md` Tier-2 #10's overlap-prevention concern end-to-end (the picker already normalizes to covering roots; this makes the stored model match).

## Decision summary

ONE local-folder account per machine tracks N folder roots. `Account.identifier` becomes the constant `this-machine`; `config.paths: string[]` holds the covering roots (always normalized — no path nested under another). Per-root sync state lives in a source-owned cursor map, exactly the IMAP per-mailbox pattern. No platform/contract *shape* changes beyond two additive, generic pieces: account upsert-on-connect and `setAccountConfig`/`accounts:update-config`.

## What changes, by layer

### Store + engine (generic, additive)
- `createAccount` becomes an upsert: `ON CONFLICT(source, identifier) DO UPDATE SET config, status` (RETURNING the EXISTING id — documents keep their account). Fixes the latent bug where reconnecting any existing account (e.g. Gmail re-auth) throws a UNIQUE violation.
- New `setAccountConfig(accountId, config)` store method (+ change-feed entry) and generic `accounts:update-config` IPC → `engine.updateConfig` = set config + restart the account's sync.
- **Reconcile gets wired** (closing the unimplemented contract promise at `contracts.ts:320`): after each successful pull cycle, if the source implements `reconcile()`, the engine collects the listed `ExternalRef`s, diffs against the account's non-archived documents, and archives what is no longer listed (via the existing `deletions` commit path). This is how removing a folder sheds its documents — and it fixes offline deletions for every source.

### local-folder source (the substantive change)
- `connect()` prompts `paths: { type: 'array', items: { type: 'string' }, format: 'folder-paths' }`, validates every path is a directory, normalizes to covering roots, returns `{ identifier: 'this-machine', config: { paths } }`.
- Cursor: `{ roots: Record<absPath, { completedAt: string }> }` — per-root backfill/incremental exactly as today, root by root; a new root added later simply has no entry and backfills.
- `externalId` = **absolute** posix-style path (was root-relative) — collision-free across roots.
- Watch: one chokidar watcher covering all roots (chokidar accepts a path array).
- `reconcile()` enumerates all roots (documents under a removed root are absent → engine archives them).
- `fetchBytes` containment guard checks against ANY configured root.
- Overlap logic (`isUnder`, `coveringRoots`) moves from the renderer-only module to `src/shared/folder-paths.ts`, shared by the picker and the source.

### Migration: hard cutover (deliberate)
No data migration. Legacy accounts (`config.path` singular, identifier = folder path) get a clear sync error: "Legacy single-folder account — remove this source and re-add its folder." Rationale: pre-release app, single dev user, repo private, local data cheaply re-indexed. Auto-consolidation was considered and rejected (external-id scheme change makes in-place merge equivalent to re-indexing anyway).

### Renderer
- Add flow: the multi-folder schema (`format: 'folder-paths'`, single field) triggers the existing multiselect picker; confirm submits `{ paths }` as ONE prompt answer — the N-sequential-flows batch machinery from Task 22 is deleted (superseded). If a machine account already exists, the same flow works: connect-upsert merges (the picker pre-loads existing roots so the submitted set is the union, normalized).
- Picker gains `existingPaths`: already-tracked folders render with a `tracked` pill, inert (and their subtrees implied-tracked); the confirm set and the footer estimate exclude them.
- `SourceDetail` gains a **Tracked folders** section: each root with its live recursive count (`sources:count-files`), a per-folder Remove (confirm → `accounts:update-config` with the path dropped → restart → reconcile archives), and "Add folders…" re-entering the add flow. `FolderPickerField` (single `folder-path` format) stays as the generic fallback for other schemas.
- Sources list row shows "N folders" for the machine account.

## Non-goals (stay open in concept/gaps.md Tier 2)
Per-root include/exclude globs; carving subfolders OUT of a root; multiple machine accounts; Drive/OneDrive pickers (the `format`-keyed flow is ready for them).

## Testing
Store upsert + setAccountConfig unit tests; engine reconcile-wiring tests (fake source); local-folder multi-root suite (multi-root backfill/incremental, cross-root externalId uniqueness, root add/remove reconcile archiving, fetchBytes any-root guard, legacy-config error); shared folder-paths tests move with the module. Renderer remains typecheck + walkthrough (no harness).
