# Extension platform wave 2 — the durable change feed for extensions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An extension can consume the corpus change log as a durable, resumable, backpressured stream — a paged keyset snapshot of current documents with a recorded high-water mark, a completion signal, replay from that mark, purge tombstones, and pacing that never lets a slow consumer pin memory in main.

**Architecture:** The corpus already has the log (`changes`), the cursors (`consumers`) and a materializing reader (`Store.feed`). This wave adds the missing half — a snapshot phase — in the store, then exposes both phases through a new `feed` capability. Delivery rides host events, so batches arrive stamped `from: 'platform'` (wave 1, #112). The engine's own worker loop (`engine.ts:1485-1540`) is the working model for the replay loop: durable cursor, at-least-once delivery, commit-then-advance.

**Tech Stack:** TypeScript, better-sqlite3, Jest.

**Spec:** `docs/superpowers/specs/2026-09-06-extension-platform-track-design.md`

**Issue:** #106. Its body is the requirements document — read it in full before Task 1; the snapshot protocol table and the concurrency rules in it are binding.

**Prerequisite:** wave 1 merged and released (v0.86.0). #112 in particular: a `feed.batch` that a peer extension could forge is not a feed.

## Global Constraints

- Base: `dev` after v0.86.0.
- The migration is ladder step **v4**, appended. Existing steps v1/v2/v3 (`schema.ts:429,584,685`) are never renumbered, merged or collapsed. A migration entry is `type Migration = string | ((db: BetterSqlite3.Database) => void)` (`schema.ts:97`) — a SQL string or a bare function, **not** an object with an `up` member. `migrate()` wraps each step in its own transaction (`schema.ts:1143-1147`), and `ALTER TABLE … ADD COLUMN` is legal inside it.
- Consumer names are host-namespaced: `consumers.name = 'ext:<extensionId>:<name>'`. An extension-supplied name containing a colon is rejected, so no extension can address a core worker's cursor.
- Feed payloads are the wire `Document` **minus `markdown`**, plus `seq` and `updatedAt`. Markdown is fetched on demand through `host.query.document`. A batch that carried whole documents would let one slow consumer pin them in main.
- At most one batch in flight per consumer. An un-acked batch is re-sent after 60 s and never skipped.
- There is no "replay from 0" and no "start at now". `reset` drops the row; the next call must be a fresh `snapshot`.
- Commit messages: conventional prefix, plain sentence, no trailers.
- Gates: `npm run typecheck && npm run lint && npm test`.

---

### Task 1: Schema v4 — snapshot columns on `consumers`

**Files:**
- Modify: `src/main/core/store/schema.ts` (append a v4 entry to `MIGRATIONS`)
- Test: `src/main/core/store/__tests__/schema.test.ts` (or the existing migration test file)

**Interfaces:**
- Produces: `consumers.snapshot_cursor TEXT`, `consumers.snapshot_high_water INTEGER`, `consumers.snapshot_generation INTEGER`, all nullable.

- [ ] **Step 1: Write the failing migration test**

```ts
it('adds the snapshot columns as ladder step v4', () => {
  const db = openFreshCorpus();          // runs migrate()
  const cols = db.prepare(`PRAGMA table_info(consumers)`).all().map((c) => c.name);
  expect(cols).toEqual(expect.arrayContaining([
    'name', 'cursor', 'snapshot_cursor', 'snapshot_high_water', 'snapshot_generation',
  ]));
  expect(db.prepare(`SELECT value FROM meta WHERE key = 'schemaVersion'`).get().value).toBe('4');
});

it('upgrades a v3 corpus without touching its rows', () => {
  const db = openCorpusAtVersion(3);
  db.prepare(`INSERT INTO consumers (name, cursor) VALUES ('worker:x', 42)`).run();
  migrate(db);
  expect(db.prepare(`SELECT cursor FROM consumers WHERE name='worker:x'`).get().cursor).toBe(42);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/main/core/store/__tests__ -t 'v4'`
Expected: FAIL — no such columns; version is 3.

- [ ] **Step 3: Append the migration**

Append ONE entry to the end of `MIGRATIONS` — do not edit v1, v2 or v3:

```ts
// v4 — snapshot handoff for feed consumers. Three nullable columns; a
// consumer with all three NULL has never started a snapshot, which is
// exactly what every pre-existing row means.
`ALTER TABLE consumers ADD COLUMN snapshot_cursor TEXT;
 ALTER TABLE consumers ADD COLUMN snapshot_high_water INTEGER;
 ALTER TABLE consumers ADD COLUMN snapshot_generation INTEGER;`,
```

A plain string entry, appended to the array — `migrate()` runs `db.exec` on it inside the step's transaction (`schema.ts:1146`). An object with an `up` member is not a `Migration` and would fail at execution, not at typecheck, if it were cast.

- [ ] **Step 4: Run, then commit**

Run: `npx jest src/main/core/store`

```bash
git add src/main/core/store/schema.ts src/main/core/store/__tests__
git commit -m "feat(store): record snapshot handoff state per feed consumer"
```

### Task 2: Snapshot pages — stable keyset, recorded high-water and generation

**Files:**
- Modify: `src/main/core/store/store.ts` (beside the feed materialization block at `:488-540`)
- Modify: `src/main/core/store/write-tx.ts` (the procedural transaction body)
- Modify: `src/main/db/worker-entry.ts:42` (register the new procedure beside `commit`)
- Modify: `src/shared/contracts.ts` (`Store`)
- Create: `src/main/core/store/__tests__/feed-snapshot.test.ts`

**How the page runs atomically.** A first page reads `MAX(changes.seq)`, reads a page of documents and writes the snapshot columns — one transaction with read-your-own-writes. `AppDb` gives callers exactly one multi-statement primitive, `batch()`, and it returns only the FIRST row per reader step (`app-db.ts:24-30,118-122`); `_conn.transaction()` is explicitly off-limits to callers because the worker-backed DB has no raw handle (`app-db.ts:35-43`). So this is a **named procedure**, exactly like the corpus `commit`: implement `feedSnapshotPage(args)` in `write-tx.ts`, register it in the worker's procedure table (`worker-entry.ts:42`), and call it the way `store.commit` does — `writeTx ? writeTx.feedSnapshotPage(args) : await db.proc!('feedSnapshotPage', args)` (`store.ts:892-896` is the pattern). `snapshotAck` and `reset` are single statements and stay on `run`/`batch`.

**Interfaces:**
- Consumes: `documents` (TEXT primary key — the keyset), `changes.seq`, `toDocument`.
- Produces:
  ```ts
  snapshot(name: string, opts: { after?: DocumentId; limit?: number }):
    Promise<{ documents: FeedDocument[]; next: DocumentId | null; highWater: Seq; generation: number }>;
  ```
  `FeedDocument` = wire `Document` without `markdown`, with `seq` and `updatedAt`. `limit` clamps to ≤ 500.

- [ ] **Step 1: Write the failing page tests**

```ts
it('records highWater and generation once and echoes them on every page', async () => {
  await seedDocuments(5);
  const p1 = await store.snapshot('ext:a:labels', { limit: 2 });
  await store.snapshotAck('ext:a:labels', p1.next);
  await seedDocuments(1);                              // moves MAX(changes.seq)
  const p2 = await store.snapshot('ext:a:labels', { after: p1.next!, limit: 2 });
  expect(p2.highWater).toBe(p1.highWater);
  expect(p2.generation).toBe(p1.generation);
});

it('is stable across a concurrent insert, update and purge', async () => {
  const seeded = await seedDocuments(6);
  const p1 = await store.snapshot('ext:a:labels', { limit: 2 });
  await store.snapshotAck('ext:a:labels', p1.next);
  await insertDocument('zzz-new');                     // after the current page
  await updateDocument(seeded[4].id);
  await purgeDocument(seeded[5].id);
  const rest = await drainSnapshot('ext:a:labels', p1.next!);
  const ids = [...p1.documents, ...rest].map((d) => d.id);
  expect(new Set(ids).size).toBe(ids.length);          // no duplicate within the snapshot
  for (const s of seeded.slice(0, 5)) expect(ids).toContain(s.id); // no pre-existing id skipped
});

it('rejects a page whose cursor is neither the stored one nor the last next', async () => {
  const p1 = await store.snapshot('ext:a:labels', { limit: 2 });
  await expect(store.snapshot('ext:a:labels', { after: 'made-up' as DocumentId }))
    .rejects.toBeInstanceOf(CapError);
});

it('omits markdown and carries seq and updatedAt', async () => {
  const [doc] = (await store.snapshot('ext:a:labels', { limit: 1 })).documents;
  expect(doc).not.toHaveProperty('markdown');
  expect(typeof doc.seq).toBe('number');
  expect(typeof doc.updatedAt).toBe('string');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx jest src/main/core/store/__tests__/feed-snapshot.test.ts`
Expected: FAIL — `store.snapshot is not a function`.

- [ ] **Step 3: Implement the first page and the paging query**

In one read transaction on a first call (no `after`, no snapshot row):

```sql
SELECT COALESCE(MAX(seq), 0) AS high FROM changes;
SELECT * FROM documents
  WHERE archived_at IS NULL AND id > ?
  ORDER BY id LIMIT ?;
```

`generation = (previous generation ?? 0) + 1`, persisted with `snapshot_high_water` on the consumer row. Subsequent pages take `id > after` and **echo** the stored `highWater`/`generation` — never recompute them mid-snapshot. `after` must equal the persisted `snapshot_cursor` or the `next` of the last returned page; anything else is a `CapError`.

`next` is the id of the last row of the page, or `null` when the page was short.

- [ ] **Step 4: Run, then commit**

Run: `npx jest src/main/core/store`

```bash
git add src/main/core/store src/shared/contracts.ts
git commit -m "feat(store): page a keyset snapshot of current documents for feed consumers"
```

### Task 3: `snapshotAck`, completion, `position` and `reset`

**Files:**
- Modify: `src/main/core/store/store.ts`, `src/shared/contracts.ts`
- Test: `src/main/core/store/__tests__/feed-snapshot.test.ts`

**Interfaces:**
- Produces:
  ```ts
  snapshotAck(name: string, cursor: DocumentId | null): Promise<void>;
  feedPosition(name: string): Promise<{ seq: Seq | null;
    snapshot: { cursor: DocumentId | null; highWater: Seq; generation: number } | null }>;
  feedReset(name: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing completion tests**

```ts
it('completion sets the seq cursor to the recorded high water', async () => {
  const p1 = await store.snapshot('ext:a:labels', { limit: 500 });
  await store.snapshotAck('ext:a:labels', null);                 // completion
  const pos = await store.feedPosition('ext:a:labels');
  expect(pos.seq).toBe(p1.highWater);
  expect(pos.snapshot?.cursor ?? null).toBeNull();
});

it('is the only way the seq cursor is first set', async () => {
  await store.snapshot('ext:a:labels', { limit: 1 });
  await store.snapshotAck('ext:a:labels', 'doc-1' as DocumentId);  // page ack, not completion
  expect((await store.feedPosition('ext:a:labels')).seq).toBeNull();
});

it('reset then snapshot yields the next generation', async () => {
  const first = await store.snapshot('ext:a:labels', { limit: 1 });
  await store.feedReset('ext:a:labels');
  const second = await store.snapshot('ext:a:labels', { limit: 1 });
  expect(second.generation).toBe(first.generation + 1);
});
```

Note the third test's requirement: `reset` drops the consumer's cursor row but the generation counter must keep climbing, so a consumer that kept rows from an earlier snapshot can still reconcile. Persist the last generation separately from the row it resets, or read `MAX` of what was ever issued — the implementer picks, the test pins the behaviour.

- [ ] **Step 2: Run and watch them fail**, then implement, then run again.

Run: `npx jest src/main/core/store/__tests__/feed-snapshot.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/main/core/store src/shared/contracts.ts
git commit -m "feat(store): complete, report and reset a feed consumer's position"
```

### Task 4: The `feed` capability and its surface

**Files:**
- Modify: `src/shared/contracts.ts:797` (the `Cap` union — the authoritative one; `manifest.ts` only imports it) and `src/main/platform/manifest.ts:28-39` (`CAPS`, the advertised table), `src/main/platform/host-router.ts:14-23` (`NS_CAP`), `src/main/platform/extension-host-entry.ts:50-64` (`NS_METHODS`), `src/renderer/components/cap-catalog.ts`
- Modify: `src/main/platform/host-surfaces.ts`, `src/shared/contracts.ts` (`CapSurfaces`)
- Test: `src/main/platform/__tests__/host-surfaces.test.ts`, `.../cap-table-completeness.test.ts`, `src/main/platform/__tests__/manifest.test.ts`

**Interfaces:**
- Produces: `host.feed.{snapshot, snapshotAck, replay, ack, position, reset}`; cap `feed`, label "Follow changes to your documents", description "Is told about every document that is added, changed or removed, as it happens.", `risk: 'elevated'` — the same reasoning as `query`.

- [ ] **Step 1: Write the failing cap tests**

```ts
it('rejects host.feed without the cap', async () => {
  const router = createHostRouter({ extensionId: 'a', granted: new Set(['query']), … });
  await expect(router.dispatch('feed', 'position', ['labels']))
    .rejects.toThrow(/CAP_DENIED/);
});

it('namespaces the consumer name to the extension', async () => {
  const { surfaces } = buildSurfaces(makeDeps({ extensionId: 'kiagent.documents' }));
  await surfaces.feed.position('labels');
  expect(store.feedPosition).toHaveBeenCalledWith('ext:kiagent.documents:labels');
});

it('refuses a consumer name that tries to address another consumer', async () => {
  const { surfaces } = buildSurfaces(makeDeps({ extensionId: 'a' }));
  await expect(surfaces.feed.position('worker:vision')).rejects.toBeInstanceOf(CapError);
});
```

- [ ] **Step 2: Run and watch them fail**, then implement the namespace, the surface delegation and all four tables, then run `cap-table-completeness.test.ts`.

Run: `npx jest src/main/platform`

- [ ] **Step 3: Commit**

```bash
git add src/main/platform src/renderer/components/cap-catalog.ts src/shared/contracts.ts
git commit -m "feat(platform): a feed capability that follows the corpus as it changes"
```

### Task 5: Replay with one batch in flight

**Files:**
- Create: `src/main/platform/feed-subscription.ts` (the per-consumer loop)
- Modify: `src/main/platform/host-surfaces.ts` (`replay`, `ack`), the platform's teardown path
- Test: `src/main/platform/__tests__/host-surfaces.test.ts`

**Interfaces:**
- Consumes: `Store.feed(after, { kinds })` (`contracts.ts:285-288`), the store position methods from Task 3, `deps.deliverEvent`.
- Produces: host event `feed.batch` with payload `{ name, changes, last }`; `replay(name, opts?: { kinds?; batch? })`; `ack(name, seq)`.

- [ ] **Step 1: Write the failing backpressure tests**

```ts
it('does not deliver a second batch before the first is acked', async () => {
  await completeSnapshot('ext:a:labels');
  await seedChanges(4);
  await surfaces.feed.replay('labels', { batch: 2 });
  await flush();
  expect(delivered).toHaveLength(1);
  await surfaces.feed.ack('labels', delivered[0].last);
  await flush();
  expect(delivered).toHaveLength(2);
});

it('re-sends an un-acked batch after the timeout and never skips it', async () => {
  jest.useFakeTimers();
  await completeSnapshot('ext:a:labels');
  await seedChanges(2);
  await surfaces.feed.replay('labels', { batch: 2 });
  await flush();
  jest.advanceTimersByTime(60_000);
  await flush();
  expect(delivered).toHaveLength(2);
  expect(delivered[1].changes).toEqual(delivered[0].changes);
});

it('refuses replay before the snapshot completed', async () => {
  await store.snapshot('ext:a:labels', { limit: 1 });          // started, not completed
  await expect(surfaces.feed.replay('labels')).rejects.toThrow(/snapshot required/);
});

it('honours the kinds filter and strips markdown', async () => { /* … */ });
```

- [ ] **Step 2: Run and watch them fail**, then implement.

The loop is modelled on `engine.attach` (`engine.ts:1485-1540`): read the durable cursor, iterate `store.feed(cursor)`, deliver one batch, wait for the ack, advance. Differences from the engine: no `work_ledger` (defer/re-drive stays core-only), and errors inside the extension's handler are the extension's problem — the host only re-sends un-acked batches.

**Copying the engine loop does NOT give you the advertised memory bound.** `Store.feed` reads a fixed `FEED_BATCH = 500` (`store.ts:227`, `ORDER BY seq LIMIT ${FEED_BATCH}` at `:531`), materialises each row with `SELECT * FROM documents WHERE id = ?` (`:497`) and the mapper carries `markdown` (`:272`). A loop that holds that array while awaiting an ack pins up to 500 complete documents in main even when the extension asked for `{ batch: 2 }` — the exact failure this surface exists to prevent. So the subscription must strip `markdown` and slice to the requested `batch` **before** it awaits anything, and must not retain the source array across the await. Either read through a lighter store method that never materialises `markdown`, or map-and-release immediately; the memory test below is what decides whether you did.

Subscriptions live per host incarnation: deactivate or crash stops the loop and leaves the cursors; re-activation resumes from `snapshot_cursor` mid-snapshot or from the acked seq afterwards. The consumer is expected to ack only after ITS private transaction committed, so a crash between commit and ack re-delivers one batch and never loses one.

- [ ] **Step 3: Prove the memory bound**

```ts
it('holds at most one batch of references for a consumer that never acks', async () => {
  // Same pattern as abortable-leak.test.ts: weak refs to the delivered documents,
  // force GC between assertions, expect all but the in-flight batch collected.
});
```

- [ ] **Step 4: Run, then commit**

Run: `npx jest src/main/platform`

```bash
git add src/main/platform
git commit -m "feat(platform): stream corpus changes to an extension one acked batch at a time"
```

### Task 6: Child proxy and delivery across the process boundary

**Files:**
- Modify: `src/main/platform/extension-host-entry.ts` (`NS_METHODS.feed`, the `feed.batch` event path)
- Test: `src/main/platform/__tests__/extension-host-entry.test.ts`

- [ ] **Step 1: Write the failing proxy test** — a forked child's `host.feed.snapshot('labels', {…})` reaches the host with the namespaced name, and a `feed.batch` event arrives at a listener registered through `host.events.on` with `meta.from === 'platform'` (wave 1, #112).

- [ ] **Step 2: Run, implement, run.**

Run: `npx jest src/main/platform/__tests__/extension-host-entry.test.ts`

- [ ] **Step 3: Commit**

```bash
git add src/main/platform
git commit -m "feat(platform): reach the feed from a forked extension"
```

### Task 7: End-to-end — resume, coverage, purge

**Files:**
- Modify: `src/main/platform/__tests__/extension-e2e.test.ts`

- [ ] **Step 1: Write the failing lifecycle cases**

One fixture extension against a fixture Source:

1. Snapshots in pages of 2; deactivated after acking page 1; re-activated; resumes from `snapshot_cursor` with **no gap and no duplicate**; completes.
2. Receives live commits through replay; deactivated mid-replay; resumes from the acked seq with no gap and no duplicate beyond the single un-acked batch.
3. `purgeArchived` runs; the `purge` tombstone arrives.
4. **Coverage property.** Mutate the corpus throughout the snapshot, then assert: every live document id is either in a page or in replay, and every id that vanished is either absent from the completed generation or carries a tombstone. This is the property the whole protocol exists to guarantee — write it as one test that seeds, mutates and asserts, not as three.

- [ ] **Step 2: Run, fix what the property exposes, run again.**

Run: `npx jest src/main/platform/__tests__/extension-e2e.test.ts`

Expect this task to find real bugs in tasks 2–5. That is its job; fix them there, not with a special case here.

- [ ] **Step 3: Commit**

```bash
git add src/main/platform/__tests__
git commit -m "test(platform): pin snapshot resume, replay resume and feed coverage"
```

### Task 8: Docs and release v0.87.0

- [ ] **Step 1: Document the surface**

`docs/architecture/extension-platform.md:70-90`: a `feed` row in the capability table, and beneath it the four concurrency rules a consumer must implement against — at-least-once between snapshot and replay (dedupe by `(id, seq)`); a tombstone may arrive for an id never paged (must be a no-op); a document archived or purged before `highWater` is invisible to both phases, so consumers reconcile by `generation`; pages are not a transactionally consistent set across calls, only within one page.

- [ ] **Step 2: Full gate**

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

- [ ] **Step 3: Release**

`npm run release`. Release notes: an extension can now follow the corpus as it changes, with a snapshot handoff, durable positions, tombstones and backpressure.

---

## Self-review notes

- **Spec coverage.** Snapshot protocol → tasks 2–3. Surface and cap → task 4. Replay, backpressure, lifecycle → task 5. Child tier → task 6. Every acceptance criterion that names `extension-e2e.test.ts` → task 7. Migration → task 1.
- **The riskiest task is 7, not 5.** The coverage property is where a keyset snapshot interleaved with mutation actually gets judged; budget for it to send work back into tasks 2 and 5.
- **Not in this wave, on purpose:** an extension-contributed `Worker` with `emit`/`enrich` (corpus writes stay engine-only), renderer projections, historical counters, and any pruning or compaction of the change log.
