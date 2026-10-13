# Source options + "Skip subagent sessions" — design

Rev 1 · 2026-10-13 · core `feat/source-options` (off origin/dev v0.110.2) + `kia-plugins/agent-sessions-kia-connector`

## 1. Problem

Subagent sessions are most of the Agent Sessions corpus:

| | main sessions | subagent sessions |
|---|---|---|
| Claude Code | 2,667 docs, 57 M chars | **8,528 docs, 98 M chars** (from 326 parents, up to 478 each) |
| Codex | 1,030 docs, 13 M chars | 560 docs, 21 M chars |

They are mostly near-identical review transcripts ("Spec review Task 1", "Final whole-branch review", …) that crowd main sessions out of search.

The founder wants **a checkbox in the connector account's settings that skips subagent sessions entirely**, without folding them into the parent. Checking it removes the indexed subagents; unchecking it indexes them again.

Today the checkbox can't be built. `SourceDescriptor` (`src/shared/contracts.ts:411`) has no option schema, and the account page shows config only as a read-only JSON dump (`ConnectorConfig.tsx`). The only connector-declared setting is the folder picker.

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

### 3.1 Contract

```ts
// src/shared/contracts.ts
export interface SourceOption {
  key: string;          // /^[a-z][A-Za-z0-9]{0,39}$/, not 'folderRoots'
  label: string;        // ≤ 60 chars
  description?: string; // ≤ 200 chars
  type: 'boolean';
  default: boolean;
}
export interface SourceDescriptor { …; options?: SourceOption[] }   // ≤ 8 entries
```

- **Where it is declared:** the connector declares it on its **runtime** descriptor. Manifest `contributes.sources` is unchanged, because the manifest validator rejects unknown fields (`platform/manifest.ts:75`).
- **Validation:** core validates `options` when an extension's descriptor is registered, against the shape and limits above. Keys must be unique and must not be reserved (`folderRoots`, `__proto__`, `constructor`, `prototype`).
- **Invalid options:** the whole source is refused with a logged error, like any other invalid descriptor field.
- **Effective value:** `typeof config[key] === 'boolean' ? config[key] : option.default`. A helper `optionValue(descriptor, config, key)` lives in shared code, for the renderer, and is mirrored in the SDK for connectors.
- **Versioning:**
  - `PLATFORM_API_VERSION` goes 2.11.0 → **2.12.0** (`shared/extension-rpc.ts:29`);
  - the SDK regenerates its contracts and adds `optionValue`, as a minor bump;
  - the descriptor already flows wholesale into `sources:list` (`boot.ts:143`), so no new forwarding is needed.

### 3.2 Writing an option: `accounts:set-option`

`{accountId, key, value: boolean} → void` adds a new invoke channel. It goes into the `Invokes` type, `INVOKE_CHANNEL_MAP`, and the handler in `main.ts`. It sits beside `accounts:update-outbound`.

`engine.setOption(accountId, key, value)`:
1. **Validation:**
   - the account exists;
   - its source's descriptor declares `key`;
   - `value` is a boolean.

   Anything else throws `FolderScopeConfigError`-style errors (a new `OptionConfigError`).
2. **Busy check:** if a flow or transition is active, it throws `AccountFlowBusyError`, the same rule as `updateConfig` (`engine.ts:~1955`).
3. **Atomic merge in the store:** `store.setAccountOption(id, key, value)` runs `UPDATE accounts SET config = json_set(config, '$.' || ?, json(?)) WHERE id = ?`. This is one statement, so there is no read-merge-write race with other config writers (folder scope, outbound). It logs through the existing `accountWrite` path so a commit is emitted.
4. **No-op:** if the stored effective value already equals `value`, it returns without restarting.
5. **Otherwise:** it restarts the account's loop if it is running, exactly as `updateConfig` does. It does not resume a paused account. The new value reaches `pull` through `session.account.config` on the next loop start (`extension-host-entry.ts:463`).

### 3.3 Re-adding keeps options

Connect upserts config wholesale (`store.ts:1344`), so re-adding an account would reset its options to default. Core already carries folder-scope keys over on re-add (`engine.ts:~1101`); options get the same treatment.

After `source.connect()`, for each declared option key the prior account (same source and identifier) has and `connected.config` lacks, core copies the prior value across. A connector that writes the key itself wins.

### 3.4 UI: the Options card

`src/renderer/screens/Sources/sections/Options.tsx` mounts in `SourceDetail.tsx` next to `Cadence` (`:190`) when `descriptor.options?.length`.

- **Rows:** one `SettingsRow` + `Toggle` per option (the primitives from `Settings/General.tsx:186`), with the label, the description as sub-text, and the effective value.
- **Changing a value:**
  - the toggle disables and shows a pending state while `accounts:set-option` is in flight;
  - on error it reverts and shows the message inline (unlike Outbound's fire-and-forget behaviour);
  - the busy error reads "Finishing the current sync step — try again in a moment".
- **Overlay:** not shadowed (`SourceDetail` and `sections/*` are core-only), so no `alpha-cent` overlay work beyond a `core.lock` bump.

## 4. Connector: Agent Sessions 1.1.0

### 4.1 Declaration

Both sources (`claude-code`, `codex`) declare:

```ts
options: [{ key: 'skipSubagents', type: 'boolean', default: true,
  label: 'Skip subagent sessions',
  description: 'Don't index sessions started by another agent (reviews, explorers). Your own sessions, plans, tasks, memory and prompts are still indexed.' }]
```

- `manifest.json` `engine` goes to `^2.12.0`, so an older core refuses the connector instead of running it with no checkbox.
- `pull` reads `skip = optionValue(descriptor, session.account.config, 'skipSubagents')` and passes it through `makeSource` → `discover` → `runSync`.

**Default `true`.** This is the founder's stated intent: subagents are the noise being removed. Existing accounts therefore archive their subagent docs on their first pull after the upgrade. The checkbox shows that state, and unchecking it restores them (§4.4).

### 4.2 Classifying units

`Unit` gains `role?: 'subagent' | 'pending'` and `ref?: ExternalRef`; `ref` is the doc the unit renders.

- **Claude:** units built from `projects/<p>/<sid>/subagents/agent-<aid>.jsonl` get `role: 'subagent'` and `ref = {externalId: 'session:<sid>/<aid>', type: 'agent.session'}`. Task units keep their `parentH` but have no role, so they are not subagents.
- **Codex:**
  - a rollout whose parsed header has a parent id gets `role: 'subagent'` and `ref = {externalId: 'session:<id>', type: 'agent.session'}`, at any nesting depth;
  - a rollout whose header did not parse yet (the existing `cache: false` case, a file caught mid-write) gets `role: 'pending'`;
  - discovery and the `cursor.parents` cache work exactly as today for every unit, skipped or not.

### 4.3 Sync when `skip` is on (`runSync`)

`runSync` partitions units into kept and skipped.
- **Skipped:** every unit with `role: 'subagent'`, plus every `role: 'pending'` unit. A pending unit is deferred: it is not rendered and not fingerprinted this tick. It is classified on a later tick once its header parses.
- **Kept:** everything else, which goes through today's selection and render path unchanged.

**Cleanup:** for each skipped `subagent` unit whose `fps[uh]` entry exists (indexed, or attempted and failed):
- add `unit.ref` to a pending deletion list;
- delete `fps[uh]` from the working map.

The cleanup is emitted **before** any render. It goes out as deletion-only batches of ≤ 500 refs (`items: []`), each carrying a checkpoint cursor that already has those `fps` entries removed.
- **Atomicity:** core applies a batch's deletions and its cursor in one transaction (`write-tx.ts:888`). A crash therefore either keeps the entry and retries the deletion, or drops both.
- **Retries are harmless:** deleting a ref that is not indexed is a no-op (`archiveByRef` returns null, `write-tx.ts:554`).
- **Draining:** cleanup runs on every pull while `skip` is on, so no persisted "mode applied" flag can suppress an unfinished drain.
- **Children:** subagent docs have no children of their own; tasks attach to the main session, and nested Codex subagents are enumerated themselves. One level of `archiveChildren` is enough.
- **Shrink guards** apply only to `reconcile()`; this connector has none, and the deletions are explicit.

Skipped units are never rendered, so their files are never read beyond what discovery already does: Codex reads the first line once, Claude does a listing.

### 4.4 Sync when `skip` is off

- **Everything is a kept unit:** pending Codex units behave as today, which means a main session.
- **Re-indexing:** a subagent whose `fps` entry was removed during cleanup has no fingerprint, so selection picks it up and re-renders it. Core un-archives a re-upserted doc (`write-tx.ts:424`).
- **No new cursor fields:** the presence or absence of the `fps` entry is the whole state.
- **Cost:** turning it off re-renders about 9k Claude and 560 Codex subagent sessions, which takes several minutes, about like the original backfill.
- **Turning it on again:** cleanup runs again.

### 4.5 Ordering inside a pull

1. Discover.
2. Classify.
3. Emit cleanup batches.
4. Run today's render loop over the kept units. Its first checkpoint already includes the cleanup's `fps` removals.
5. The final `done` checkpoint is unchanged.

`RENDER_VERSION` stays 1, because rendered content does not change.

## 5. Edge cases

1. **Toggle while syncing:** `setOption` restarts the loop, so the in-flight pull aborts at its next signal check. The committed cursor is consistent (§4.3), and the next pull uses the new value.
2. **Toggle during a flow** (reconnect or folder picker): `AccountFlowBusyError`, shown inline, nothing written.
3. **A subagent file is rewritten while skip is on:** it is still skipped, and its `fps` entry is already gone, so nothing is emitted.
4. **A subagent doc whose file is gone from disk:** it is not discovered, so the connector cannot name it, and the doc stays. Today 9,341 Claude subagent files are on disk against 8,528 indexed docs (`cleanupPeriodDays: 365`), so the practical gap is nil. A doc-inventory migration is out of scope.
5. **Old core with the new connector:** blocked by `engine ^2.12.0`.
6. **New core with old connectors:** no `options`, no card, nothing changes.
7. **Main session that spawned subagents:** it keeps its `→ Task: <description>` lines. No main doc references a subagent externalId, so nothing dangles.

## 6. Tests

**Core:**
- **Descriptor validation:** accepts a valid set; rejects a reserved key, a duplicate key, a non-boolean default, a too-long label, and more than 8 entries.
- **`setOption`:**
  - merges without touching other keys (`folderRoots`, `outbound`);
  - an undeclared key throws;
  - a non-boolean throws;
  - busy throws;
  - a no-op does not restart;
  - a change restarts a running loop and leaves a paused one paused.
- **Re-add:** carries a prior option value, and a connector-written value wins.
- **IPC allowlist** includes `accounts:set-option`.
- **Options card:** renders the effective default, toggles, reverts on error, and disables while pending.

**Connector:**
- **Skip on, previously indexed:** deletion-only batches carry exactly the subagent refs and no task or main refs. The cursor drops their `fps`, and a second pull emits nothing.
- **Crash between cleanup batches:** replaying from the last committed cursor deletes the remainder, with no duplicates beyond the harmless no-op.
- **Skip on, fresh account:** no subagent doc is ever emitted, and a Codex pending header is deferred, not emitted as main.
- **Skip off after on:** subagents are re-emitted, and main sessions and tasks are not re-rendered.
- **Nested Codex subagent:** deleted.
- **Claude task unit** with `parentH`: not treated as a subagent.
- **More than 500 deletions:** split into several batches.

## 7. Release

1. Core: v0.111.0, platform API 2.12.0.
2. SDK: sdk-v1.9.0, with `optionValue` and the regenerated contracts.
3. Connector: 1.1.0, engine `^2.12.0`.
4. alpha-cent: `core.lock` bump, then an app release (owed per the usual cadence).

The founder updates the connector via Marketplace, and the first pull archives about 9.1k subagent docs.
