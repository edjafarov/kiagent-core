# Assistant sessions: one source per account, not per device

2026-11-15. Founder: "can we kinda retain account level assistant sessions, not
device level?" Sources today lists ten "Assistant sessions" rows
(`local#0533dbda` … `local#e954e8a6`); one has 173 documents, nine have none.

## 1. Why there are ten

- `assistant` is in core's `DEVICE_OWNED_SOURCES` (`src/main/core/sync/sources.ts`).
  Every device that ever led seeds its own `assistant` account, renamed
  `local#<device8>` and owned by that device (`service.ts` `setDeviceId`,
  `write-tx.ts` `ownedName`). The accounts table is copied, so every device
  sees every other device's row, and nothing removes the row of a wiped device.
- The sessions themselves are already account-level: `sessions`, `turns`,
  `presentation`, `settings` are synced plugin tables, and a follower's chat
  turn is forwarded to the leader (`turn-append` → `rawStore.appendTurn`).
  So every session write happens on the leader, and only the leader's
  account ever got documents.
- What can't move is the ChatGPT/Codex login in the dispatcher. It is not the
  corpus source and is not affected here.

## 2. Goal

One `assistant` account per KIAgent account, identifier `local`, no owner
device. It runs on whichever device leads, like any account-level source with
no login. Existing installs collapse to that one account and keep their
documents. Meetings, local folders, WhatsApp, claude-code and codex stay
device-owned: they read this machine's audio, folders or keys.

## 3. Core changes (kiagent-core)

### 3.1 Take `assistant` off the device-owned list

Remove `'assistant'` from `DEVICE_OWNED_SOURCES` and update the audit comment.
Every reader of the list follows (adoption suffixing, `ownedName`, the export
offer, `ownsSource`, `notMineToRun`, the secrets export). An `assistant`
account then:
- runs on the leader only: followers are read-only, so the generic gate holds;
- is never offered on join: it has no vault login, so `exportSources` skips it;
- is never suffixed again.

### 3.2 Collapse the leftovers: `FORMERLY_DEVICE_OWNED`

A new list in `sources.ts`, `FORMERLY_DEVICE_OWNED = ['assistant']`, with the
date and the reason. A new module `src/main/core/sync/collapse.ts` holds two
parts.

**`planCollapse(rows)`** is pure. Its input is
`{ id, source, identifier, ownerDeviceId, createdAt, docs }[]`. For each
source S in the list:

1. Group S's rows by base identifier. The base is the identifier with a
   trailing `#` plus 8 lowercase hex characters removed. A group is already
   clean when it has one row, that row's identifier equals the base, and its
   `ownerDeviceId` is null. Skip a clean group.
2. Pick the keeper:
   - the row whose identifier equals the base, if one exists;
   - otherwise the row with the most docs;
   - then the earliest `createdAt`;
   - then the smallest id.
3. The output is `{ remove: id[], rename: { id, identifier }[] }`:
   - every non-keeper row goes in `remove`;
   - the keeper goes in `rename` unless it is already clean.

**`collapseFormerlyOwned(platform)`** does the work:

1. Reads the rows (accounts plus a per-account document count, one query).
2. Plans.
3. Removes each row in `remove` the way the user's Remove does
   (`main.ts` `accounts:remove`):
   - `engine.remove(id)` stops a running loop and commits `removeAccount`,
     which drops the documents, FTS, trigram, vault and the account;
   - then it unregisters the account's scheduler jobs.
   That shared body moves into one exported helper, `removeAccountFully`,
   that both call.
4. Then commits the new batch `{ renameAccount: { id, identifier } }` for each
   keeper. The batch sets `identifier` and clears `owner_device_id`, then
   `appendChange('account', id)`. It refuses (no-op) if another row already
   holds `(source, identifier)`.
   - Status, config, cadence and cursor stay as they are.
   - The keeper keeps its documents.
   - If the keeper is running, it keeps running; its identifier is display only.

The steps are not one transaction. Each step is idempotent, and a run cut
short is finished by the next one. A removed row that had documents held the
same sessions (`externalId = assistant-session:<id>`), and the keeper's next
sweep (§4) re-creates any that are missing.

**Where it runs.** At the top of `resumeAccounts` in `boot.ts`, before the
accounts are read, and only when `!platform.readOnly()`. That one function is
the start path:
- at boot: `main.ts` `resumeAll` and `resumeReady`;
- after a promotion: `promoteCore`;
- after a held writer resumes: `resumeHeld`.

A follower never runs it. The accounts table is copied, so the leader's
deletes and rename reach it by sync. A failure is logged with counts and the
source only, and the resume goes on; the next resume tries again.

### 3.3 Tests (core)

- `sources.test`: `assistant` is not device-owned; `FORMERLY_DEVICE_OWNED`
  contains it.
- `planCollapse`:
  - ten `local#…` rows, one with docs: that one is renamed `local`, the other
    nine are removed.
  - a bare `local` row plus suffixed rows: the bare one is kept.
  - two rows with docs: the one with more is kept; ties go to the oldest.
  - one clean row: an empty plan.
  - `meetings` `local#…` rows and an identifier like `a#xyz` (not 8 hex) are
    untouched.
- `renameAccount` (write-tx): renames and clears the owner; appends one
  `account` change; a no-op when `(source, identifier)` is taken.
- `collapseFormerlyOwned` on a real store: the removed accounts' documents and
  FTS rows are gone, and the keeper's are untouched. A second run commits
  nothing.
- `resumeAccounts`: collapses on a writer; does not on a read-only device.
- adoption (`setDeviceId`) no longer suffixes an `assistant` account;
  `ownedName` no longer suffixes a new one.

## 4. Extension changes (alpha-cent `extensions/assistant`)

### 4.1 A cursor that survives a leader change

Today the pull cursor is a seq in `change_log`, a per-device table (not in
`synced`). `accounts.cursor` is copied, so after a leader change the new
leader resumes from the old leader's seq in its own, unrelated log: it skips
or replays the wrong range, and misses sessions the old leader wrote.

New cursor, JSON: `{ "log": "<uuid>", "seq": <n> }`.
- **Log id.** The store's `init()` makes sure `change_log` holds one marker row
  `session_id = '__log:<uuid>'` (inserted if none exists). `logId()` returns
  that uuid. `readChanges` skips marker rows. No migration and no new table;
  the marker moves with the log itself, whatever a DB swap does to it.
- **Same log** (`cursor.log === logId()`): page from `cursor.seq`, as today.
- **Anything else** (null, a legacy number, another device's log): one sweep.
  1. `head = max seq` in the local `change_log`, read first.
  2. Every session id in `sessions`, in pages of 50 ordered by id: emit
     documents for the non-erased ones that have a ready turn, and deletions
     for erased ones (the same per-session body as the change path).
  3. Then continue from `{ log: logId(), seq: head }`. A write during the
     sweep has a seq above `head` and is emitted again; upserts by
     `externalId` make that harmless.
  Batch cursors during the sweep stay the old cursor, and only the last sweep
  batch carries the new one. So a sweep cut short starts over rather than
  resuming in a half-swept state.

The sweep is the cost of a leader change: about one document render per
session, today 173. A plain restart on the same leader does no sweep.

### 4.2 The seed gate

No change. `createSeedGate` already seeds `(assistant, 'local')` only on the
leader and only when no `local` account exists. After §3.2 one exists. On a
fresh install core no longer suffixes it.

### 4.3 Tests (extension)

- store: `init()` adds one marker and is idempotent; `logId()` is stable;
  `readChanges` never returns a marker row.
- source:
  - null cursor: sweeps every session once, then emits a later change.
  - legacy numeric cursor: sweeps.
  - a foreign log id: sweeps.
  - its own log id: no sweep, pages from seq.
  - an erased session in the sweep: a deletion.
  - a sweep aborted midway: no batch carried the new cursor.

## 5. Out of scope

- Meetings has the same nine dead-device rows. Meetings stays device-owned,
  because a recording's audio is on the device that captured it. Cleaning
  rows of devices that left the account needs the device list. It is a
  separate change.
- A device label in the Sources list.

## 6. Release

- Core first: the minor bump v0.127.0.
- Then alpha-cent: extension change plus the `core.lock` bump, merged
  together.
- The order between them does not matter for correctness:
  - New core with the old extension: one collapsed account whose cursor is a
    number from the leader's log. The old extension pages from it, which is
    right on this leader.
  - New extension with old core: the sweep runs once per account row.
  Both are harmless. They ship together anyway.
