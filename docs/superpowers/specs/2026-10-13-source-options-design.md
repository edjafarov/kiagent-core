# Source options + "Skip subagent sessions" — design

Rev 4 · 2026-10-13 · SATISFIED (fable r3, codex astra r3) · core `feat/source-options` (off origin/dev v0.110.2) + `kia-plugins/agent-sessions-kia-connector`

## 1. Problem

Subagent sessions are most of the Agent Sessions corpus:

| | main sessions | subagent sessions |
|---|---|---|
| Claude Code | 2,667 docs, 57 M chars | **8,528 docs, 98 M chars** (from 326 parents, up to 478 each) |
| Codex | 1,030 docs, 13 M chars | 560 docs, 21 M chars |

They are mostly near-identical review transcripts ("Spec review Task 1", "Final whole-branch review", …) that crowd main sessions out of search.

The founder wants **a checkbox in the connector account's settings that skips subagent sessions entirely**, without folding them into the parent. Checking it removes the indexed subagents; unchecking it indexes them again.

Today the checkbox can't be built. `SourceDescriptor` (`src/shared/contracts.ts:471`) has no option schema, and the account page shows config only as a read-only JSON dump (`ConnectorConfig.tsx`). The only connector-declared setting is the folder picker.

## 2. Goals / non-goals

- **G1:** A connector can declare boolean per-account options. Core renders them as toggles on the account page and stores them in `accounts.config`, and the connector reads them in `pull`.
- **G2:** Agent Sessions declares `skipSubagents`. While it is on, no subagent session is indexed and already-indexed ones are archived. When it is turned off, they are re-indexed.
- **G3:** Other connectors and older Marketplace builds are unaffected (`options` is optional).
- **Non-goals:**
  - non-boolean option types;
  - options at connect time (the wizard is unchanged);
  - folding subagents into their parent;
  - removing subagent docs whose source file is already gone from disk (§5.4).

## 3. Core

### 3.1 Contract and where options are stored

```ts
// src/shared/contracts.ts (SourceDescriptor is at :471)
export interface SourceOption {
  key: string;          // /^[a-z][A-Za-z0-9]{0,39}$/
  label: string;        // ≤ 60 chars
  description?: string; // ≤ 200 chars
  type: 'boolean';
  default: boolean;
}
export interface SourceDescriptor { …; options?: SourceOption[] }   // ≤ 8 entries, unique keys
```

**Storage:** values live in their own namespace, `accounts.config.options.<key>`. They never sit next to `outbound`, `folderRoots`, `roots`, `paths` or a connector's own fields, so no option key can collide with a field core or a connector already uses. Only `setAccountOption` writes the namespace, and every other config write keeps it in-transaction (§3.3).

**Effective value:** `optionValue(descriptor, config, key)`. It returns `config.options[key]` when that is a boolean, otherwise `option.default`. It lives in `src/shared/` for the renderer and is exported from the SDK for connectors.

**Versioning:**
- `PLATFORM_API_VERSION` goes 2.11.0 → **2.12.0** (`shared/extension-rpc.ts:29`).
- The SDK regenerates its contracts and adds `optionValue` (sdk-v1.9.0).
- The descriptor already flows wholesale into `sources:list` (`boot.ts:143`).
- `options` sits on the **runtime** descriptor. Manifest `contributes.sources` is unchanged, because the manifest validator rejects unknown fields (`platform/manifest.ts:75`).

### 3.2 Validation

Core validates no runtime descriptor today: `extension-platform.ts:756-775` registers `c.sources` with two gates, "declared in the manifest" and "not already registered". This adds a **third gate in that loop**:
- `validateSourceOptions(s.descriptor)` checks the shape and limits in §3.1;
- on failure it logs a warning and runs `continue`, mirroring the "not declared in the manifest" branch;
- so the source is not registered.

Bundled in-process sources don't declare options, so they need no gate.

### 3.3 One store rule owns `options`

Five places write `accounts.config` wholesale:
- the `config` op behind `setAccountConfig`, used by `updateConfig` (`engine.ts:1999`) and `accounts:update-outbound` (`main.ts:633`);
- the connect upsert (`write-tx.ts:599`, `config = excluded.config`);
- `applyFolderScope` (`write-tx.ts:~1140`, from `manageFolders`' "complete canonical config", `engine.ts:1770`);
- and, after this change, the option write itself.

Each engine-side read-merge-write leaves a window in which a concurrent writer is lost. So **ownership lives in the store, inside each write's own transaction**:

- **`keepOptions(rowConfig, nextConfig)`:** in write-tx, every wholesale config write (the `config` op, the create upsert, `applyFolderScope`) replaces `nextConfig.options` with the row's current `options`. If the row's `options` is not a plain object (absent, null, an array, …), the result has no `options` key, so only "absent" or "object" is ever stored. This includes the fresh-insert arm of the upsert, so a connector's `connect` result can never seed `options`. It is one helper with three call sites. The value is read in the same transaction as the write, because the DB worker runs one transaction at a time. Connectors and engine callers therefore never set or reset options, and a connector's `connect`/`manageFolders` result cannot touch them either.
- **New op `option`:** `store.setAccountOption(id, key, value)` → `UPDATE accounts SET config = json_set(config, '$.options.' || ?, json(?)) WHERE id = ?`, with the value bound as `JSON.stringify(value)` so SQLite stores a JSON boolean, and with `AND config IS NOT json_set(…)` added to the `WHERE` (the file's existing idiom), so that `changes === 0` means `logged: false`. It is one statement, so two toggles on different keys cannot lose each other, and it is logged through `accountWrite` so a commit is emitted.
- **Re-add:** the upsert runs `keepOptions` against the existing row, so Add-source on an already-connected identifier keeps the options. No engine lookup is needed. Remove deletes the row (`write-tx.ts:813`), so a later Add starts from defaults.
- **`updateConfig`:** refuses an `options` key with `OptionConfigError`, the same way it refuses `folderRoots`, so an explicit attempt fails loudly instead of being silently dropped.

### 3.4 Writing an option: `accounts:set-option`

`{accountId, key, value: boolean} → void` is a new invoke channel. It goes into `Invokes` and `INVOKE_CHANNEL_MAP` (`shared/ipc.ts`) and gets a `main.ts` handler next to `accounts:update-config` (`:629`).

`engine.setOption(accountId, key, value)`:
1. **Validation:** the account exists, its source's descriptor declares `key`, and `value` is a boolean. Otherwise it throws `OptionConfigError`.
2. **Busy guards:** the same `activeByAccount` / `transitionIntents` guards as `updateConfig` (`engine.ts:1985-1988`) throw `AccountFlowBusyError`.
3. **No-op:** if the effective value already equals `value`, it returns.
4. **Write:** `store.setAccountOption(id, key, value)`.
5. **Restart:** the same `running.has` / not-paused / not-needsReauth restart gate as `updateConfig` (`engine.ts:2028-2031`). It grants **no** reconcile allowance.

A loop that isn't running picks up the value at its next cadence tick. Nothing promises immediacy.

### 3.5 UI: the Options card

`src/renderer/screens/Sources/sections/Options.tsx` mounts in `SourceDetail.tsx` next to `Cadence` (`:190`) when `descriptor.options?.length`.

- **Rows:** one `SettingsRow` (`@shared/web-ui/ui`, `settings.tsx:82`) + `Toggle` (`toggles.tsx:17`) per option. Each row shows the label, the description as sub-text, and the effective value.
- **Changing a value:**
  - the toggle is disabled while `accounts:set-option` is in flight;
  - on error it reverts and shows the message inline;
  - the busy error reads "Finishing the current sync step — try again in a moment".
- **Overlay:** none. `SourceDetail` and `sections/*` are not shadowed, and `INVOKE_CHANNELS` derives from `INVOKE_CHANNEL_MAP`.

## 4. Connector: Agent Sessions 1.1.0

### 4.1 Declaration

Both sources (`claude-code`, `codex`) declare:

```ts
options: [{ key: 'skipSubagents', type: 'boolean', default: true,
  label: 'Skip subagent sessions',
  description: 'Don't index sessions started by another agent (reviews, explorers). Your own sessions, plans, tasks, memory and prompts are still indexed.' }]
```

- `manifest.json` `engine` goes to `^2.12.0`, so an older core refuses the connector instead of running it with no checkbox.
- `pull` reads `skip = optionValue(descriptor, session.account.config, 'skipSubagents')` (stored at `config.options.skipSubagents`) and passes it through `makeSource` → `discover` → `runSync`.

**Default `true`.** This is the founder's stated intent: subagents are the noise being removed. Existing accounts therefore archive their subagent docs on their first pull after the upgrade. The checkbox shows that state, and unchecking it restores them (§4.4).

### 4.2 Classifying units

`Unit` gains `subagent?: ExternalRef`, the doc a subagent unit renders. Units without it are kept units.

- **Claude:** `projects/<p>/<sid>/subagents/agent-<aid>.jsonl` → `{externalId: 'session:<sid>/<aid>', type: 'agent.session'}`. Task units keep their `parentH` but carry no `subagent`, so they are not subagents.
- **Codex:**
  - a rollout whose header has a parent id → `{externalId: 'session:<id>', type: 'agent.session'}`, at any nesting depth;
  - a rollout whose header has not parsed yet (caught mid-write) is classified as today, as a main session;
  - if it later turns out to be a subagent, the next pull's cleanup removes it (§4.3), which costs one tick of visibility;
  - discovery and the `cursor.parents` cache are unchanged.

### 4.3 Sync when `skip` is on (`runSync`)

1. **Partition:** units with `subagent` are skipped; everything else goes through today's selection and render path unchanged. Skipped units are never rendered, so their files are never read beyond what discovery already does.
2. **Cleanup set:** the skipped units whose `fps[uh]` exists (indexed, or attempted and failed), sorted by key.
3. **Emit before any render,** in chunks of ≤ 500. For each chunk, in this order:
   1. delete **only that chunk's** `fps` entries from the working map;
   2. take the checkpoint;
   3. yield `{phase, items: [], deletions: chunk refs, cursor}`.

   Entries in chunks not yet yielded stay in `fps`. A crash between chunks therefore keeps them, and the next pull deletes them again.

**Why this is safe:**
- **Atomic:** core commits a deletion-only batch's deletions and cursor in one transaction (`engine.ts:1398-1415`, `write-tx.ts:888-932`).
- **Repeats are harmless:** a repeated deletion of a ref that isn't indexed is a no-op (`archiveByRef` returns null, `write-tx.ts:554`).
- **No guard to trip:** pull-path deletions do not touch the mass-archive breaker, which applies to reconcile only.
- **Always drains:** cleanup runs on every pull while `skip` is on, and there is no "mode applied" flag, so an unfinished drain always resumes.
- **No orphaned children:** subagent docs have no children of their own; tasks attach to the main session, and nested Codex subagents are enumerated themselves.

### 4.4 Sync when `skip` is off

- **Every unit is kept.** A subagent whose `fps` entry was removed by cleanup has no fingerprint, so selection picks it up and re-renders it, and core un-archives the re-upserted doc (`write-tx.ts:448`).
- **No new cursor fields,** and `RENDER_VERSION` stays 1.
- **Cost:** turning it off re-renders about 9k Claude and 560 Codex subagent sessions, which takes several minutes, about like the original backfill.

## 5. Edge cases

1. **Toggle while syncing:** `setOption` restarts a running loop. The in-flight pull aborts at its next signal check, the committed cursor is consistent (§4.3), and the next pull uses the new value.
2. **Toggle during a flow:** `AccountFlowBusyError`, shown inline, and nothing is written.
3. **A subagent file is rewritten while skip is on:** it is still skipped, and its `fps` entry is gone, so nothing is emitted.
4. **A subagent doc whose file is gone from disk:** it is not discovered, so it stays. Today 9,341 Claude subagent files are on disk against 8,528 indexed docs (`cleanupPeriodDays: 365`), so the gap is nil in practice. A doc-inventory migration is out of scope.
5. **Old core with the new connector:** blocked by `engine ^2.12.0`.
6. **New core with old connectors:** no `options`, no card, nothing changes.
7. **Main session that spawned subagents:** it keeps its `→ Task: <description>` lines. No main doc references a subagent externalId.

## 6. Tests

**Core:**
- **`validateSourceOptions`:** accepts a valid set; rejects a duplicate key, a bad key pattern, a non-boolean default, a too-long label, and more than 8 entries. An invalid extension source is not registered and a warning is logged.
- **`setOption`:**
  - writes `options.<key>` through `setAccountOption` and keeps every other config key;
  - an undeclared key throws, and so does a non-boolean;
  - busy throws;
  - a no-op neither writes nor restarts;
  - a change restarts a running loop and leaves a paused one paused;
  - no allowance is granted.
- **`updateConfig`:** refuses `options`.
- **write-tx `keepOptions`:**
  - the `config` op, the create upsert (re-add) and `applyFolderScope` each keep the row's `options`;
  - each drops an incoming `options` when the row has none.
- **`setAccountOption`:**
  - two keys written back to back are both present;
  - a whole-config write in between keeps both.
- **IPC map** includes `accounts:set-option`.
- **Options card:** shows the effective default, toggles, is disabled while pending, and reverts with a message on error.

**Connector:**
- **Skip on, previously indexed:** the deletion-only batches carry exactly the subagent refs, with no task or main refs, and a second pull emits nothing.
- **More than 500 deletions:** split into several batches. The first batch's cursor still holds the `fps` entries of the later chunks, so a crash after batch 1 is followed by a replay that deletes the remainder.
- **Skip on, fresh account:** no subagent with a parsed header is ever emitted.
- **Skip off after on:** subagents are re-emitted, and main sessions and tasks are not re-rendered.
- **Nested Codex subagent:** deleted.
- **Claude task unit** with `parentH`: not a subagent.

## 7. Release

1. Core: v0.111.0, platform API 2.12.0.
2. SDK: sdk-v1.9.0, with `optionValue` and the regenerated contracts.
3. Connector: 1.1.0, engine `^2.12.0`.
4. alpha-cent: `core.lock` bump, then an app release (owed per the usual cadence).

The founder updates the connector via Marketplace. The next pull, at the 15-minute cadence or the next restart, archives about 9.1k subagent docs.
