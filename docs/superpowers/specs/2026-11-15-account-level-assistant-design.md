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
   - the row with the most docs;
   - then the row whose identifier equals the base;
   - then the earliest `createdAt`;
   - then the smallest id.

   Docs come first because a bare `local` can be brand new and empty. The
   seed gate can insert one before the collapse runs (the extension
   activates before `resumeAccounts`), and keeping it would throw away the
   documents and recreate them under new ids.
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
   keeper. The batch:
   - sets `identifier`;
   - clears `owner_device_id`;
   - sets `cursor = NULL`, which forces the extension's sweep (§4.1) so the
     keeper holds every session, whoever wrote it;
   - when `status = 'paused'` and `last_error LIKE 'Owned by %'` (an import
     paused it because another device owned it, `write-tx.ts` importSyncSources),
     sets `status = 'connecting'` and `last_error = NULL`; any other status,
     including a pause the user chose, stays;
   - then `appendChange('account', id)`.

   It refuses (no-op) when another row already holds `(source, identifier)`;
   the next resume removes that row first. Config and cadence stay. The
   keeper keeps its documents: the sweep upserts them by `externalId`, and
   their ids do not change.

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
deletes and rename reach it by sync. Deletes are applied before upserts, so
`UNIQUE(source, identifier)` holds on the follower.

At each of these sites no loop of that source runs yet. At boot nothing has
started. On a promotion the device was a follower. After a resume the writer
was held.

A failure is logged with counts and the source only. That resume then skips
every account of a `FORMERLY_DEVICE_OWNED` source that is not clean, so ten
rows don't each start a sweep. The next resume tries the collapse again.

### 3.3 Tests (core)

- `sources.test`: `assistant` is not device-owned; `FORMERLY_DEVICE_OWNED`
  contains it.
- `planCollapse`:
  - ten `local#…` rows, one with docs: that one is renamed `local`, the other
    nine are removed.
  - an empty bare `local` plus a `local#…` with docs: the one with docs is
    kept, the bare one is removed.
  - no docs anywhere, a bare `local` plus suffixed rows: the bare one is kept.
  - two rows with docs: the one with more is kept; ties go to the oldest.
  - one clean row: an empty plan.
  - `meetings` `local#…` rows and an identifier like `a#xyz` (not 8 hex) are
    untouched.
- `renameAccount` (write-tx):
  - renames, clears the owner and the cursor, and appends one `account`
    change;
  - an `Owned by …` pause becomes `connecting`; a plain pause stays paused;
  - a no-op when `(source, identifier)` is taken.
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

New cursor, JSON: `{ "log": "<uuid>", "seq": <n>, "sweep"?: true }`.

**Log id.**
- `change_log` holds marker rows with `session_id = '__log:<uuid>'`.
- `init()` inserts one if there is none.
- `logId()` is the uuid of the newest marker (highest seq).
- `rotateLog()` inserts a new marker.
- `readChanges` skips marker rows.
- No migration and no new table. `change_log` is a local table and the join
  swap keeps it (`swap.ts`), so the marker stays with this device's log.

**Rotation on regaining the lead.**
- When this process has seen itself as a follower (`roleGate.isFollower()`
  was true) and then gets the leader open edge (`roleGate.onOpen`), the
  extension calls `rotateLog()` before the seed gate and before the source's
  next pull. It runs on the leader, so no follower write guard is involved.
- A running pull handles a rotation too. Core may start the pull on
  promotion before the role event reaches the extension. So `rotateLog()`
  wakes the pull, as any change does. The pull checks `logId()` against the
  log it is paging on each pass, and on a mismatch it sweeps in place (the
  steps below). The order between the role event and the pull start
  therefore does not matter.
- A cursor written before that no longer matches. So A→B→A always sweeps,
  which it must: what B wrote is in the synced rows but not in A's log.
- A device that boots straight into the lead after following while it was
  off sees a cursor B claimed (§ claim below), so it also sweeps.
- A plain restart of a stable leader never saw itself follow, so it neither
  rotates nor sweeps.

**Same log, not sweeping** (`cursor.log === logId()` and no `sweep`): page
from `cursor.seq`, as today.

**Anything else** (null, a legacy number, another log, `sweep: true`): sweep.
1. `head` = the max seq in the local `change_log`, read first.
2. The pull's opening batch carries the claim
   `{ log: logId(), seq: head, sweep: true }`, so the copied cursor names
   this device at once:
   - if this device stops leading mid-sweep, the next leader sees a foreign
     log and sweeps;
   - if this device restarts mid-sweep, it sees `sweep: true` and sweeps
     again.
3. Every session id in `sessions`, in pages of 50 ordered by id:
   - documents for the non-erased ones that have a ready turn;
   - deletions for erased ones;
   - the same per-session body as the change path.

   These batches carry the claim cursor.
4. The last sweep batch carries `{ log: logId(), seq: head }` (no `sweep`),
   and paging goes on from there. A write during the sweep has a seq above
   `head` and is emitted again; upserts by `externalId` make that harmless.

**Accepted window.** B can accept a forwarded turn after it starts leading
but before its pull commits the claim. If A then takes the lead back in the
same process, A rotates and sweeps, so nothing is lost. A gap remains only if
A was shut down during B's whole lead, B wrote but never committed a claim,
and A then boots as leader. B's claim is the opening batch of its pull,
committed within seconds of the start, so the gap is that small. It is
accepted.

**Cost.** A sweep renders about one document per session, today 173. It runs
after a leader change or a collapse. A restart on the same leader does no
sweep.

### 4.2 The seed gate

`createSeedGate` gets an optional `exists(account)` predicate; the default
stays exact `identifier === 'local'`, so meetings is unchanged. The assistant
passes `local` or `local#<8 hex>`. A device with leftover rows then seeds
nothing, and the collapse renames the keeper. A fresh install seeds a bare
`local`, which core no longer suffixes.

### 4.3 Tests (extension)

- store: `init()` adds one marker and is idempotent; `logId()` is stable;
  `readChanges` never returns a marker row.
- source:
  - null cursor: sweeps every session once, then emits a later change.
  - legacy numeric cursor: sweeps.
  - a foreign log id: sweeps.
  - its own log id: no sweep, pages from seq.
  - `sweep: true` with its own log id: sweeps.
  - after `rotateLog()`, the old cursor sweeps (A→B→A).
  - `rotateLog()` while the pull is running: it wakes and sweeps in place.
  - the opening batch of a sweep carries the claim cursor; only the last
    sweep batch drops `sweep`.
  - an erased session in the sweep: a deletion.
  - a sweep aborted midway leaves the claim cursor, never a clean one.
- seed gate: with `exists` given, `local#0533dbda` counts as existing; the
  meetings default is unchanged.
- index: follower then leader-open calls `rotateLog()` once; a leader that never followed does not rotate.

## 5. Out of scope

- Meetings has the same nine dead-device rows. Meetings stays device-owned,
  because a recording's audio is on the device that captured it. Cleaning
  rows of devices that left the account needs the device list. It is a
  separate change.
- A device label in the Sources list.

## 6. Release

- Core goes first, as v0.127.0. It is not used on its own: the collapse
  resets the keeper's cursor, and only the new extension sweeps.
- alpha-cent then merges the extension change and the `core.lock` bump in
  one merge, so the product never runs the collapse without the sweep.
