# Account-level Assistant sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `assistant / local` account per KIAgent account. It runs on the leader, and existing `local#<dev8>` rows collapse into it.

**Architecture:**
- **Core (kiagent-core):**
  - take `assistant` off `DEVICE_OWNED_SOURCES`;
  - add the `renameAccount` commit batch;
  - add `sync/collapse.ts` (a pure plan plus a runner), called at the top of `resumeAccounts` on a writer.
- **Extension (alpha-cent `extensions/assistant`):**
  - a log marker in `change_log`;
  - a `{log, seq, sweep?}` cursor;
  - the sweep;
  - rotation on regaining the lead;
  - an `exists` predicate for the seed gate.

**Tech Stack:** TypeScript, better-sqlite3, jest.

**Spec:** `docs/superpowers/specs/2026-11-15-account-level-assistant-design.md` (core repo).

## Global Constraints

- Never log identifiers beyond source and counts in collapse logs.
- `FORMERLY_DEVICE_OWNED = ['assistant']`; suffix pattern `/#[0-9a-f]{8}$/`.
- The cursor JSON is `{ log: string, seq: number, sweep?: true }`; the marker `session_id` is `'__log:' + uuid`.
- The sweep page size is 50, the same `PAGE` as today.
- Descriptor objects are append-only: no new tables.
- Builds and tests run sequentially; no amend, rebase, reset or stash.

## Review Focus

1. A bare empty `local` seeded before the collapse must lose to the row with documents (planCollapse test).
2. A keeper paused `Owned by …` must run after the collapse (renameAccount test).
3. A→B→A: after `rotateLog()` an own-log cursor sweeps (source test).
4. A sweep cut short leaves `sweep: true` (source test: abort after the first page).
5. A follower never runs the collapse (resumeAccounts test with readOnly true).

---

### Task 1 (core): sources list, renameAccount batch

**Files:**
- `src/main/core/sync/sources.ts`
- `src/shared/contracts.ts`
- `src/main/core/store/write-tx.ts`
- tests: `src/main/core/sync/__tests__/sources.test.ts`, `src/main/core/sync/__tests__/device-owned.test.ts`, `src/main/core/store/__tests__/write-tx.test.ts` (or a new `rename-account.test.ts`)

**Produces:**
- `FORMERLY_DEVICE_OWNED: readonly string[]` and `baseIdentifier(id: string): string` (strips `/#[0-9a-f]{8}$/`) in `sources.ts`;
- the commit batch `{ renameAccount: { id: AccountId; identifier: string } }`.

- [ ] **Tests:**
  - sources: the device-owned list no longer includes `assistant`, and `FORMERLY_DEVICE_OWNED` is `['assistant']`;
  - `baseIdentifier('local#0533dbda') === 'local'`, `baseIdentifier('a#xyz') === 'a#xyz'`;
  - device-owned: `getOrCreateAccount('assistant','local')` stays `local` with no owner after `setDeviceId`;
  - renameAccount:
    - renames, nulls `owner_device_id` and `cursor`, and appends one `account` change;
    - an `Owned by 0533dbda` pause becomes `connecting` with `last_error` null;
    - a plain `paused` stays;
    - a taken `(source, identifier)` changes nothing.
- [ ] Run them and see them fail.
- [ ] **Implement:**
  - the list change, with the audit comment updated;
  - the batch branch next to `removeAccount`, one `UPDATE … WHERE id = ? AND NOT EXISTS (SELECT 1 FROM accounts WHERE source = ? AND identifier = ? AND id <> ?)`; `appendChange('account', id)` only when a row changed.
- [ ] Run the tests (plus all of `src/main/core/sync/__tests__`): they pass.
- [ ] Commit.

### Task 2 (core): collapse + resume hook

**Files:**
- create `src/main/core/sync/collapse.ts`
- modify `src/main/core/boot.ts` (`resumeAccounts`) and `src/main/main.ts` (`accounts:remove` uses the shared helper)
- test: `src/main/core/sync/__tests__/collapse.test.ts`

**Interfaces:**
- `planCollapse(rows: CollapseRow[]): { remove: string[]; rename: { id: string; identifier: string }[] }`, where `CollapseRow = { id; source; identifier; ownerDeviceId: string|null; createdAt: string; docs: number }`. The keeper order is docs desc, bare first, `createdAt` asc, id asc.
- `collapseFormerlyOwned(p: { db; store; engine; scheduler; logSink }): Promise<{ removed: number; renamed: number }>`.
- `removeAccountFully(p, id)` in `boot.ts`: `engine.remove(id)`, then it unregisters jobs ending in `:${id}`. `main.ts accounts:remove` calls it.

- [ ] **planCollapse tests:**
  - ten suffixed rows, one with docs;
  - an empty bare row plus a suffixed row with docs → the suffixed one is kept;
  - no docs, bare plus suffixed → the bare one is kept;
  - a docs tie → the oldest;
  - one clean row → an empty plan;
  - `meetings` rows and `a#xyz` → untouched.
- [ ] **Runner test on a real store** (the `device-owned.test.ts` harness):
  - removed accounts' documents and FTS rows are gone, and the keeper's are kept;
  - a second run commits nothing (the `changes` count is the same).
- [ ] **resumeAccounts tests:** a readOnly platform runs no collapse. When the collapse throws, unclean `assistant` rows are not started.
- [ ] Implement, then run the new tests and `src/main/core/__tests__/boot*`.
- [ ] Commit.

**Checkpoint A:** fable + astra review the core diff. Then `npm run typecheck`, the sync and store suites, and lint.

### Task 3 (extension): store log marker

**Files:**
- `extensions/assistant/src/db/store.ts`
- test: `extensions/assistant/src/__tests__/` (the store test file)

**Produces:** on `SessionStore`, `logId(): Promise<string>` and `rotateLog(): Promise<string>` (`rotateLog` notifies), plus `allSessionIds(afterId: string|null, limit): Promise<string[]>` and `headSeq(): Promise<number>`. `readChanges` filters `session_id LIKE '__log:%'`.

- [ ] Tests:
  - `init` twice leaves one marker;
  - `logId` is stable;
  - `rotateLog` changes `logId` and fires `onChange`;
  - `readChanges` never returns a marker;
  - `allSessionIds` pages by id;
  - `headSeq` returns the max seq.
- [ ] Implement, run, commit.

### Task 4 (extension): cursor + sweep in the source

**Files:**
- `extensions/assistant/src/source/assistant-source.ts`
- its test

The cursor type is `AssistantCursor = { log: string; seq: number; sweep?: true }`. The pull accepts `unknown`. A per-session body, `itemsFor(ids)`, is shared by the change path and the sweep.

- [ ] **Tests:**
  - null, numeric, foreign log and `sweep:true` each sweep: the opening batch carries `{log, seq: head, sweep: true}`, and the last sweep batch carries `{log, seq: head}`;
  - own log: no sweep;
  - `rotateLog` while live → sweeps in place;
  - erased → deletion;
  - an abort after the first page → no clean cursor was yielded;
  - a write during the sweep is emitted afterwards.
- [ ] Implement, run, commit.

### Task 5 (extension): rotation + seed gate predicate

**Files:**
- `extensions/assistant/src/index.ts`
- `extensions/meetings/src/source/meetings-source.ts` (`createSeedGate` gets `exists?`)
- tests: the seed-gate test, plus a small unit for the rotation helper (`createLeadRotation(roleGate, store)` in `extensions/assistant/src/source/lead-rotation.ts`)

- [ ] **Tests:**
  - the gate with `exists` treats `local#0533dbda` as present, and the meetings default is unchanged;
  - rotation: follower then open → one `rotateLog`; open without having followed → none.
- [ ] Implement: the rotation is registered before the seed gate's `onOpen`, so it runs first.
- [ ] Run, commit.

**Checkpoint B:**
- fable + astra review the whole branch (both repos);
- release core v0.127.0;
- bump the overlay `core.lock`;
- `typecheck:overlay`, the assistant + meetings suites, shadow baselines;
- merge both to dev.
