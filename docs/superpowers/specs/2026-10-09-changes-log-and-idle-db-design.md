# Bounded changes log and a quiet idle database (#59, #135, #139, #141)

Status: APPROVED rev 7 (2026-10-09). Astra r6 (rev 7) and fable r4 (rev 6, plus the rev 7 redrive gate) SATISFIED.

- Issues: kiagent-core #59, #135, #139 and #141. Tracking: #138.
- Base: core v0.106.0.

## Already done (verified on the base)

68cad333 (v0.97.0) landed:

- `work_ledger_active`;
- `ledgerCountsAll(activeConsumers)`;
- a conditional `setAccountStatus`;
- `docs_languages`.

Also on the base:

- `purgeArchived` is scheduled every 6 h with 30-day retention.
- All three bundled feed workers match `kind === 'document'` only. Nothing
  outside `boot.ts:attachWorker` / `workers/index.ts` attaches workers, so no
  extension workers exist.

**#141 is obsolete.** `home:activity` was deleted from alpha-cent (675149e0).
The only Home 24 h number left is `addedSince`, whose cost scales with 24 h of
changes, not with corpus size. This spec closes #141 with that note.

## Problems that remain

Numbers are from the founder profile: 343k docs, 13 GB, 13.7M `changes` rows.

1. **#135: every account commit appends an `account` change.**
   `write-tx.ts:643` appends a change on every commit. That is 5.8M of the
   rows, and each one nudges every feed. `setAccountCadence` and
   `setAccountConfig` also always log.
2. **#139: polling at idle.**
   - The 5 s tick runs `ledgerCountsAll` every time.
   - `processingStatus.refreshWaiting` runs `visualWaitingCount` every 60 s.
   - Retired consumer rows (`worker:audio:v1`, likely `worker:convert:v1`)
     linger.
   - `ledgerDeferred` / `ledgerHasDeferred` walk the vision consumer's 2.1M
     skip rows.
3. **#59: `changes` grows forever.** A new consumer replays from seq 0.

## Design

### 0. Ledger seqs resolve through `documents.seq`, not `changes`

This is the enabling change for pruning, and it also simplifies the code.
Today three readers turn a ledger seq back into a document *through
`changes`*:

- `rerunDeferred` → `store.changesAt`;
- alpha-cent's `rerunMissingVision`, which gets `d.seq` from `documents`,
  then calls `changesAt`;
- `VISUAL_WAITING_DEFERRED_SQL`, which joins `changes`.

After pruning, any of these can silently drop work forever.

The change:

- `store.changesAt(seqs)` resolves each seq against **`documents WHERE seq =
  ?`** (served by `docs_seq`). It returns the same `Change` shape that
  `materializeRow` produces for a document row: `{seq, kind: 'document',
  document}`. A seq with no document returns nothing. That happens when the
  document changed since (it was re-fed under its new seq) or was purged.
- **Invariant: a ledger seq is always the document's current seq.** Today
  the feed materializer (`store.ts materializeRow`) pairs a historical
  document change seq with the *current* document. If a document changed at
  seqs 10 and 20, both rows feed document seq 20. The worker works the first
  occurrence (10), skips the duplicate, and a deferral is then keyed on 10,
  which no document carries. The fix has two parts:
  - **Feed:** `materializeRow` returns `null` for a `document` change whose
    `r.seq !== documents.seq`. The newer change is later in the log and gets
    fed under the current seq, so nothing is lost, and every ledger write
    from now on is keyed on `documents.seq`.
  - **Plan task 1 verifies** that every writer that moves `documents.seq`
    appends a `document`-kind change with that same seq, including archive
    and restore. If one does not, that change kind materializes the document
    too.
  - **No redrive until the repair is done.** Until `meta.ledgerRekeyed` is
    set, every redrive entry point is a no-op that returns `{ skipped:
    'rekey-pending' }` and keeps its pending wake. That covers
    `rerunDeferred` (scheduler job, lane wake, publisher) and the overlay's
    `rerunMissingVision`. No redrive write can then race the repair and
    recreate a stale row behind its cursor.
    - Boot is not blocked. The live feed (`attach`) runs normally, and only
      retries of earlier deferrals wait. The repair takes minutes on the
      founder profile.
    - When the repair finishes, it fires the existing lane wake, so redrive
      runs at once.
    - After that, every deferred seq is a current `documents.seq`, so
      `changesAt` needs no legacy fallback, and `rerunDeferred`'s terminal
      `skip` for an unresolvable seq covers only purged documents.
  - **Repair of existing rows: one-shot, in the background, paged.** The
    founder profile holds about 2.1M deferred rows, so the repair never runs
    as one transaction and never blocks boot. It runs as a scheduler job
    after boot, using keyset pages of 5 000 deferred rows by `(consumer,
    seq)`. Each page is one writer call, with a `setImmediate` between pages.

    For each `deferred` ledger row whose seq matches no `documents.seq`, it
    resolves `ref_id` through the `changes` row:
    - document gone → drop the row (it was purged);
    - otherwise, by the consumer's row at the document's current seq:
      - **none** → re-key the deferral to `documents.seq`;
      - **`done`** → drop the stale row (the current version was worked);
      - **anything else** (`skip`, `deferred` or `failed`) → set that row
        to `deferred`, with attempts reset, and drop the stale row.

      A `skip` is not evidence that the document was handled, because the
      old redrive coalescer writes duplicates as `skip` even when the first
      occurrence deferred again. So the document always keeps one retry.

    The keyset position is persisted in `meta.ledgerRekeyCursor` per page,
    so the repair resumes after a quit. `meta.ledgerRekeyed` is set when
    the last page is done.
  - **Pruning waits for the repair.** A prune run is a no-op until
    `meta.ledgerRekeyed` is set, because the repair needs the `changes`
    rows.
- `rerunDeferred` records a terminal **`skip`** for a deferred seq that
  resolves to nothing. With the invariant, the repair and the redrive gate
  above, that only happens to purged documents. Today such rows linger forever (pre-existing for purged
  docs).
- The DEFERRED branch of `visualWaitingCount` is deleted. It stays in
  place until `meta.ledgerRekeyed` is set, so the count has no transient
  undercount while the repair runs.
  `VISUAL_WAITING_CURRENT_SQL` already counts `l.seq = documents.seq AND
  outcome = 'deferred'`. Once stale deferred seqs become terminal `skip`, the
  deferred branch is a strict subset of the current branch.
  `visual-waiting-count.test.ts` drops one pinned plan.
- `rerunMissingVision` (alpha-cent patch) already passes `documents.seq`,
  but its `ledgerMissingVision` SQL **changes** (see 3a): while a
  `seed:<c>` row exists, the repair is bounded by the seed cursor, not by
  the real cursor `h0`.

After this, nothing needs old `changes` rows except consumers whose cursor is
below them. The pruned region is therefore a **contiguous prefix**.

### 1. Account changes only when something visible changed (#135)

`commitTx` already loads the old account row (`getAccountRow`). It decides in
JS:

- **Immediate change row** if any of these differ from the stored values:
  - `status`;
  - `last_error`, using the existing `lastErrorAssignment` semantics;
  - account config.
- **Coalesced change row**: `progress` or `last_sync_at` moved, *and* the
  last **published** `account` change for this account is older than
  `ACCOUNT_SYNC_TICK_MS = 60_000`.

  "Last published" comes from a per-account in-memory map in the DB worker,
  updated whenever an `account` change row is appended. A missing entry
  (after a cold start or a DB-worker respawn) counts as "long ago". So the
  first qualifying commit per account publishes, at a cost of one extra row
  per account per worker start. There is **no lookup in `changes`**: it has
  no `(kind, ref_id)` index, and a lookup would scan the whole log. Continuous
  commits every 10 s therefore still publish once a minute.
- **Otherwise** no change row. `cursor`, `progress` and `last_sync_at` are
  still written on every commit by one unconditional UPDATE.

`commit` reports `{seq, logged}`, where `logged` is true when any change row
was appended in the transaction (documents, archives, account).
`store.commit` emits the feed nudge only if `logged` is true. No caller uses
the old return value.

`setAccountCadence` and `setAccountConfig` use the
`UPDATE … WHERE value differs` plus `INSERT … WHERE changes() > 0` pattern.
That works here because those UPDATEs have no unconditional columns.
`getOrCreateAccount` nudges only on create.

### 2. A quiet idle database (#139)

**Generation counter.** This replaces the "dirty flag" idea.

- The store keeps `ledgerGen`, incremented whenever **any** of these happen:
  - a `nudge.emit('commit')` (every `changes` writer goes through the nudge
    or is made to);
  - every `work_ledger` write (`ledgerRecord`, `ledgerRecordMany`, and a
    `markLedgerChanged()` helper that the alpha-cent `ledgerRetry` patch
    calls);
  - every `consumers` write;
  - a change in the active consumer set.
- The 5 s tick reads `gen = ledgerGen` and returns if it equals `lastCountedGen`.
  Otherwise it runs `ledgerCountsAll` and then sets `lastCountedGen = gen`.
  This is the value read **before** the query, so a mutation that lands
  during the query is counted on the next tick.
- `processingStatus.refreshWaiting` (60 s) is gated on the same counter
  through its own `lastWaitingGen`.

**Redrive probe.** The `registerRedrive` cadence probe (`ledgerHasDeferred`,
every 5 to 30 minutes) stays. It is one cheap index seek (below), and the
issue's "60 s idle" window is met.

**Acceptance test.** Over 61 s of fake time with no mutations, a spy at the
**store method boundary** sees zero calls to:

- `ledgerCountsAll`;
- `visualWaitingCount`;
- any other `work_ledger` / `changes` reader.

**Deferred lookups.** Core's `ledgerDeferred` / `ledgerHasDeferred` gain
`AND outcome IS NOT 'skip'`, so they range-seek `work_ledger_active` (no new
index). The alpha-cent patch already adds that term to its copy. Its anchor
is updated in the same alpha-cent bump, because the patch throws on a missing
anchor, so this cannot slip.

**Retired consumers.** Right after `pruneAttempts(active)` (`main.ts:959`),
the same contract is applied to the other two tables, in 50k batches:

1. Enumerate the retired names from the tiny `consumers` table:

   ```sql
   SELECT name FROM consumers
   WHERE name NOT IN (active) AND name NOT LIKE 'seed:%'
   ```

   If there are none, stop. That is the steady state: **zero `work_ledger`
   statements at boot**.
2. For each retired name, delete its ledger rows in primary-key prefix
   windows, `DELETE FROM work_ledger WHERE consumer = ? AND seq >= ? AND
   seq < ?`, which the `(consumer, seq)` key serves. There is no `NOT IN`
   scan of `work_ledger`.
3. Delete the `consumers` row last, so an interrupted sweep resumes.

Skip rows of *live* consumers are never touched.

### 3. A bounded changes log (#59)

#### 3a. Seeding a new consumer

At `engine.attach`, when the consumer has no row:

1. In one transaction, write the **real** row `<consumer>` with
   `cursor = h0 = headSeq()`, and a progress row `seed:<consumer>` with
   `cursor = 0`. Because the real row now exists, `pending` (head − h0) and
   the prune floor are correct from the first moment.
2. Page live documents with `seq <= h0`, in `seq` order, 500 per page, **on
   the read worker** (`readsFor('other')`, a `documentPage`-shaped query).
   Paging does not queue behind ingest.
3. Feed each page to the worker as materialised document changes, with
   `seq = documents.seq`.
4. Commit the outputs with `consumer: '<consumer>'` (the real name, so
   outputs land under the real synthetic worker account) and `cursor: h0`
   (non-advancing). The same transaction carries a new `seedCursor` field
   that updates `seed:<consumer>` to the page's last `seq`.
5. When paging finishes, delete `seed:<consumer>` and continue with
   `feed(h0)`.

Restart behaviour: if `seed:<c>` exists, seeding resumes from its cursor,
then the feed continues from `h0`.

**Repair paths must not race the seeder.** The overlay's
`ledgerMissingVision` bounds its repair with `d.seq <= COALESCE((SELECT
cursor FROM consumers WHERE name = ?), 0)`. With a real row at `h0`, it would
select every unseeded pending-visual document and OCR it a second time, in
parallel with the seeder. The bound becomes:

```sql
COALESCE((SELECT cursor FROM consumers WHERE name = 'seed:' || ?),
         (SELECT cursor FROM consumers WHERE name = ?), 0)
```

The bound ships in the alpha-cent patch with the same `core.lock` bump. Test:
with seeding paused midway, the repair selects nothing above the seed
cursor.

**Seed commits omit the consumer `cursor`.** This applies once the sync
workstream makes it optional. Until then they pass `cursor: h0`. Whichever
change lands second adopts the other's form.

A document changing during seeding arrives once more through `feed(h0)`. This
is idempotent, because emissions key on `(consumer, seq)`.

Comparison test: seeding produces the same **worked-document set and enrich
set** as a full replay over a fixture with updates, archives and purges.
Emission streams are not compared, because a replay also emits archived docs
and tombstones.

#### 3b. Pruning

Job `maintenance:prune-changes`:

- Registered next to `registerArchiveSweep`, with `lastRun` **seeded to
  now** on first registration, so it does not run at boot.
  `scheduler.register` takes no `lastRun`, so the seeding happens through
  `scheduleUpsert` before `register`, or through a small signature change.
  The plan picks one.
- Cadence: every 6 h.
- The first-ever run is triggered once by `setTimeout(10 min)` →
  `scheduler.trigger(id)`, only if `meta.changesFloor` is absent. Absence
  of that key is the definition of "never run".

Each run:

1. `floor = MIN(cursor)` over the **active** consumers' real rows. With 3a, an
   active consumer always has a row.
2. `cutoffSeq` = the first seq with `at >= now − 48h`, found by the same
   bisection `addedSince` uses, once per run.
3. `limit = min(floor, cutoffSeq, MAX(seq))`. `MAX(seq)` is excluded so the
   head row survives.
4. **Publish the floor first.** One writer transaction sets
   `meta.changesFloor = limit` before any deletion. From then on:
   - a consumer that attaches or returns with `cursor < limit` re-seeds;
   - a crash between batches leaves only garbage below the floor, which the
     next run deletes.

   Pruning that has been planned, but not yet carried out, is therefore never
   invisible to a reader.
5. `DELETE FROM changes WHERE seq >= ? AND seq < ?`, stepping in windows of
   `PRUNE_BATCH = 50_000` from `MIN(seq)` up to `limit`.
   - Each window is a pure primary-key range.
   - Windows are separate writer calls, with a `setImmediate` between them.
6. `PRAGMA wal_checkpoint(PASSIVE)` after every 20 batches and at the end.

**Returning consumer below the floor.** For example, a worker that was
disabled during pruning. At attach, `cursor < meta.changesFloor` triggers a
**re-seed** (3a, with `h0` = current head). The consumer is never silently
skipped forward.

**Unaffected readers:**

- `documentPage({afterSeq})` pages `documents`;
- `engine.project` starts at head;
- `addedSince` keeps its 24 h window within the 48 h retained.

### 4. No schema migration

Nothing here bumps the schema version:

- `seed:*` reuses `consumers`;
- `meta.changesFloor`, `meta.ledgerRekeyed` and `meta.ledgerRekeyCursor` are `meta` keys;
- no indexes are added.

So nothing is one-way.

## Testing

- **§0:**
  - `changesAt` resolves through `documents`;
  - **duplicate changes:** two changes for one document in one feed batch
    are fed once, at the current seq. A defer, a restart and a re-drive then
    work it;
  - the re-key repair, against a pre-upgrade ledger:
    - it moves a stale deferral to the current seq;
    - it drops the stale deferral when the current row is `done`;
    - `(10, deferred), (20, skip)` becomes `(20, deferred)`;
    - it runs once;
  - **an overdue redrive immediately after upgrade** (scheduler catch-up at
    2 s, before the repair finishes) is a no-op, and its wake survives;
  - **interleaving:** a redrive page materialised before the repair passes
    it, then written after, cannot happen, because redrive is gated. A test
    asserts that every redrive entry point, including the overlay
    `rerunMissingVision`, returns `rekey-pending` while the marker is absent;
  - after the repair completes, the lane wake triggers redrive, and
    `(10, deferred), (20, skip)` ends as one retry at seq 20;
  - the repair is paged, resumes from `meta.ledgerRekeyCursor` after a
    kill, and pruning is a no-op until it finishes;
  - audio deferral with the model missing survives the repair and a prune;
  - an unresolvable deferred seq becomes a terminal `skip`;
  - `visualWaitingCount` totals are unchanged on fixtures (current-only plan);
  - redrive and missing-vision repair still work after a prune.
- **#135:**
  - an unchanged commit appends nothing and does not nudge;
  - a doc-only commit still nudges;
  - a status or error change publishes immediately;
  - continuous commits every 10 s publish exactly once per 60 s (fake clock);
  - the first qualifying commit after a worker restart publishes, with no
    `changes` read;
  - cadence and config no-ops write nothing;
  - the app projection still sees progress within 60 s.
- **#139:**
  - zero ledger and changes reads at the store boundary over 61 idle
    seconds. The window starts **after** boot's one-shots:
    `processingStatus.start()`'s first `refreshWaiting`, the
    `initialLedger` read, and the scheduler's 2 s catch-up tick for `every`
    jobs with no durable row, including the redrive probe;
  - a mutation injected *during* an in-flight count is picked up next tick;
  - each mutation source increments the generation;
  - the retired sweep deletes only inactive names and keeps `seed:*` rows;
  - with no retired names, there are zero `work_ledger` statements at boot;
  - planner tests: `ledgerDeferred` and `ledgerHasDeferred` use
    `work_ledger_active`.
- **#59:**
  - seeding: worked-document and enrich sets equal a full replay;
  - `pending` is correct mid-seed;
  - outputs are under the real worker account;
  - seeding resumes after a crash;
  - pruning:
    - the deleted region is a contiguous prefix below
      `min(floor, cutoff, head)`;
    - the head row is kept;
    - pruning does not run at boot;
    - a below-floor cursor re-seeds;
    - **interrupted prune:** a kill after batch 1 of 3 leaves the floor at
      `limit`, a returning consumer below it re-seeds, and the next run
      finishes the deletion;
    - an attach between the floor publish and the deletes re-seeds;
    - a returning cursor inside the deleted range re-seeds;
    - `addedSince` is unchanged.
- **Measured on a copy of the founder DB** (recorded in the PR):
  - first-prune duration and WAL peak;
  - `changes` rows before and after;
  - idle DB calls per minute before and after;
  - account rows per backfill hour before and after.

## Overlay impact

The alpha-cent `build/patch-vision-processing.mjs` gets two edits:
- `ledgerMissingVision` is bounded by the seed cursor (3a);
- `rerunMissingVision` returns early while `meta.ledgerRekeyed` is absent
  (§0), through a core store helper `store.ledgerRekeyed()`. Its anchors are
around:

- `ledgerDeferred`;
- `VISUAL_WAITING_*`;
- `changesAt`;
- `ledgerRetry`.

The plan re-anchors them against the edited `store.ts` and lists the
alpha-cent patch edits. Those ship in the same alpha-cent `core.lock` bump.
