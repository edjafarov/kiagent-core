# Bounded Changes Log and a Quiet Idle Database (#59, #135, #139, #141) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ledger seqs resolve through `documents.seq`; account commits stop flooding `changes`; the idle app stops polling the ledger; new consumers seed from `documents`; and `changes` is pruned to a bounded tail.

**Architecture:** §0 makes "a ledger seq is the document's current seq" an invariant (feed materializer + `changesAt` through `documents`), repairs pre-upgrade ledger rows with a paged background job, and gates every re-drive on `meta.ledgerRekeyed`. §1 makes `commitTx` decide in JS whether an `account` change is worth publishing and report `{seq, logged}`. §2 adds an in-memory `ledgerGen` counter that gates the 5 s count tick and the 60 s waiting count, makes the deferred lookups use `work_ledger_active`, and sweeps retired consumers. §3a seeds a new consumer from `documents` on the read worker behind a `seed:<consumer>` progress row; §3b prunes `changes` below `min(active floor, 48 h cutoff, head)` after publishing `meta.changesFloor`.

**Tech Stack:** TypeScript, better-sqlite3 behind the DB worker (`AppDb`, `db.proc` procedures registered in `src/main/db/worker-entry.ts`), jest (ts-jest), the core scheduler (`src/main/core/scheduler.ts`).

**Spec:** `docs/superpowers/specs/2026-10-09-changes-log-and-idle-db-design.md` (APPROVED rev 7, binding). Read it before every task.

Repo/worktree: kiagent-core at `~/work/kcore-db`, branch `opt/db`, base `v0.106.0`. All source paths below are relative to `~/work/kcore-db` unless they start with `~/work/alpha-cent`. The spec's `store.ts`, `write-tx.ts`, `engine.ts`, `boot.ts`, `main.ts` are `src/main/core/store/store.ts`, `src/main/core/store/write-tx.ts`, `src/main/core/engine/engine.ts`, `src/main/core/boot.ts`, `src/main/main.ts`.

Shorthands used in commands:

```bash
SCRATCH=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt
HEAVY=$SCRATCH/heavy.sh
```

## Global Constraints

- Tests/builds run SEQUENTIALLY only; full jest suites, builds and packaging go through `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh <cmd>`. Targeted single jest files may run directly.
- Worktrees symlink node_modules/release/app deps to ~/work/kiagent-core; NEVER run `npm run build` or `npm ci` in a worktree (shared dist).
- The one sanctioned exception (coordinator ruling): inside alpha-cent's **staged** `build/.core` (Part A only), `npm ci --ignore-scripts` is the established overlay-gate procedure; `--ignore-scripts` exists precisely so the shared better-sqlite3 is not rebuilt. A plain `npm ci` there, or any `npm ci` in a core worktree (`~/work/kcore-db`, a base worktree), is never allowed.
- DB/better-sqlite3 suites may hit a pre-existing jest-worker SIGSEGV at teardown; compare against the base before calling a failure.
- Never git stash/amend/rebase/reset. Commit with `git commit -F <msgfile> -- <paths>`; no Co-Authored-By lines.
- `npm run lint` (or eslint on touched files) and `npx tsc --noEmit -p .` are gates.

Spec values every task must use verbatim:

- Re-key repair: keyset pages of `5 000` deferred rows by `(consumer, seq)`, one writer call per page, `setImmediate` between pages; progress in `meta.ledgerRekeyCursor`; done marker `meta.ledgerRekeyed`.
- `ACCOUNT_SYNC_TICK_MS = 60_000`.
- Retired-consumer sweep and prune deletes: windows of `50_000` (`PRUNE_BATCH = 50_000`).
- Seeding: pages of `500` live documents with `seq <= h0`, in `seq` order, on the read worker (`readsFor('other')`); progress row `seed:<consumer>`.
- Prune job `maintenance:prune-changes`, every `6h`, `lastRun` seeded to now on first registration, first-ever run via `setTimeout(10 min)` → `scheduler.trigger(id)` only while `meta.changesFloor` is absent; retention `48h`; `PRAGMA wal_checkpoint(PASSIVE)` after every 20 batches and at the end.
- No schema-version bump. New state lives in `meta` keys and `consumers` rows only; no new indexes.
- Running a single jest file: `cd ~/work/kcore-db && npx jest <path> --runInBand`. New suites start with `/** @jest-environment node */` (the default environment is jsdom).
- `no-await-in-loop` is enforced: every intentional sequential await in a loop carries `// eslint-disable-next-line no-await-in-loop`, as the existing code does.

## Cross-workstream note (sync workstream, `~/work/kcore-sync`)

The parallel sync plan (`~/work/kcore-sync/docs/superpowers/plans/2026-10-09-sync-yields.md`) makes the consumer `cursor` optional on commits (its Task 2: one `if (batch.cursor !== undefined)` around the consumers upsert in `commitTx`, and `cursor?: Seq` on the consumer variant of `CommitBatch`) and adds sub-commits/admission to `engine.ts` `attach`/`rerunDeferred` (its Task 10).

This plan keeps its `commitTx` changes in separate, clearly bounded hunks so the merge is mechanical:

- **Task 7** changes only `commitTx`'s return (`{seq, logged}`), the `appendChange` counter and `store.commit`'s nudge. It does not touch the consumers upsert.
- **Task 8** changes only the account branch (the tail of `commitTx`, after `if ('purgeArchived' in batch)`).
- **Task 14** adds `seedCursor?: Seq` on its **own line** of the consumer variant in `src/shared/contracts.ts`, and its own `UPDATE consumers … WHERE name = 'seed:' || consumer` hunk **after** the consumers upsert, never inside it.
- **Task 15** adds one call at the top of `attach`'s `try` and a separate `seedConsumer` function; it does not touch `attach`'s batch loop or `dropBatch`.
- Seed commits pass `cursor: h0` here. When the sync branch lands, whichever merge comes second switches them to an omitted cursor (spec §3a).
- **Task 3** adds two hunks to `rerunDeferred`: the gate as its first statement, and the terminal-skip loop right after `changesAt`. Both sit outside the flush code the sync plan rewrites.

## Rulings on spec ambiguities

These are binding for the executor. Each was ruled while reading the code.

1. **Fresh databases are born re-keyed.** `migrate()` writes `meta.ledgerRekeyed = '1'` when it creates a corpus from version 0. A corpus this build creates has no rows keyed by the old materializer. Factory reset (`resetCoreStoreTables`) re-inserts the key after its `meta` wipe, because an empty ledger is trivially re-keyed. Without this, every fresh test store and every reset profile would hold redrive gated until a repair ran.
2. **The re-drive gate arms nothing.** `rerunDeferred` (and the overlay's `rerunMissingVision`) return `{ skipped: 'rekey-pending' }` and arm no wake. Re-arming the lane wake there would make the 5 s publisher re-trigger every tick, and every trigger writes the `schedule` row. The wake "survives" because the repair's completion calls a new `requestLaneWake(platform)`. The convert worker's re-drive is not lane-woken today; it runs on its own cadence.
3. **The repair job is a `'manual'` scheduler job** (`maintenance:ledger-rekey`). It is registered in `bootCore` and triggered once from `main.ts` right after `p.scheduler.start()`. A `'manual'` job is never fired by the 30 s tick, so after it finishes it costs nothing. Each run starts by checking `ledgerRekeyed()` (cached once true).
4. **Repair row resolution.** For a `deferred` row whose seq no document carries, the repair looks up the `changes` row. If that row is missing or not `document`-kind, the ledger row is dropped, because nothing can re-drive it. In the **none** case the row is *moved*: its `attempts` are kept. Only the **anything else** case resets `attempts` to 0. The keyset walks one consumer per page, using `consumer = ? AND outcome = 'deferred' AND outcome IS NOT 'skip' AND seq > ?`, which seeks `work_ledger_active`. The next consumer comes from `SELECT MIN(consumer) FROM work_ledger WHERE consumer > ?`, a primary-key seek.
5. **`visualWaitingCount` keeps both SQL constants.** It picks the plan by `ledgerRekeyed()`. The deferred-branch plan test stays, because that query still runs on upgraded profiles until the repair ends. The spec's "drops one pinned plan" applies only after the deferred constant is deleted, which is a later cleanup and not in this plan.
6. **Task 1 is a recorded audit plus a regression test.** Every write of `documents.seq` takes its value from `appendChange('document', id)` in the same statement sequence:
   - `write-tx.ts`: `upsertDocument` (insert, update, and restore via `archived_at=NULL`), `reconcileParents`, `archiveByRef`, `archiveChildren`, both `enrich` forms, `archiveBatchTx` (reconcile) and `applyFolderScope`'s archive loop;
   - `schema.ts`: the v2 (`:662`/`:665`) and v3 (`:861`/`:880`) migrations.

   `FOLDER_SCOPE_REATTRIBUTE` and v3's `stamp` never touch `seq`. No new change kind needs materializing.
7. **`commitTx`'s account branch has no config.** The `CommitBatch` account variant carries no `config`, so "config differs" cannot happen there; config publishes through `setAccountConfig` and `applyFolderScope`. `last_sync_at` moves on every commit, so "progress or `last_sync_at` moved" is always true, and the coalesced rule reduces to at most one `account` row per account per `ACCOUNT_SYNC_TICK_MS`. The last-published map lives in the `createWriteTx` closure on the writer connection. It is marked by `markPublished(accountId, at)` in the same JS turn, immediately after a synchronous account-publishing transaction returns, and only if that transaction appended an `account` change. The publication paths are `commitTx`, `applyFolderScope`, and the new WriteTx `accountWrite` (ops `create`, `getOrCreate`, `cadence`, `config`, `status`), which absorbs `store.ts`'s former `db.batch` account writers so that each one runs as a synchronous transaction where the map lives. A rollback throws before the mark, so nothing is marked. A test case per writer fails if any writer stops marking. There is no trigger, no pending map and no depth counter.
8. **`Store.commit` keeps returning `Seq`.** Only `WriteTx.commit` (and the `commit` worker procedure) return `{ seq, logged }`. The public `Store` contract and the existing `const head = await store.commit(…)` callers stay unchanged.
9. **`ledgerGen` bumps on every commit** (consumer cursors move `pending`). The feed nudge fires only when `logged`. A change in the active consumer set is folded into the counter's key (`ledgerGen` + sorted active names), so the engine does not need to call the store on attach or stop.
10. **Seeding reads through a new engine-internal `Query.seedPage`.** `documentPage` cannot serve it: it is capped at 100, requires `types`, and its `afterSeq` branch includes archived rows. `seedPage` is optional on `Query`, added to `QUERY_METHODS` (so the read worker serves it), and **not** wired into `host-surfaces.ts` or `extension-host-entry.ts`. Extensions never see it, so there is no PLATFORM_API bump. The engine gets a new optional dep, `reads?: Query`, wired to `readPlane.readsFor('other')` in `bootCore`.
11. **Re-seed test for an existing row.** `cursor < (meta.changesFloor ?? 0)` re-seeds, as the spec says. An existing row with no floor published (a never-pruned profile) keeps today's replay from its cursor.
12. **Prune with no active consumers is skipped** (logged as `no-consumers`), never treated as "no floor". The 10-minute first trigger can no-op while the repair is still running; the 6 h cadence (and the next boot's 10-minute trigger, since `changesFloor` stays absent) covers it.
13. **The idle acceptance window starts after the boot one-shots** the spec names: `initialLedger` (now `ledgerCounter.count()`), `processingStatus.start()`'s first `refreshWaiting`, the projection's `processing()` init, and the scheduler's 2 s catch-up. "Zero `work_ledger` statements at boot" applies to the retired-consumer sweep.

## Review Focus

1. **The app quits in the middle of the re-key repair, and the next start is a newer build.** Expected: the repair resumes from `meta.ledgerRekeyCursor`, re-drive stays gated until it finishes, and no deferred document loses its retry. Pinned by Task 4 (resume across a store reopen) and Task 5 (gate held, then the wake).
2. **Factory reset ("Reset all") on an upgraded profile.** Expected: `meta.ledgerRekeyed` survives the reset, so re-drive is not gated forever on an empty ledger. Pinned by Task 3.
3. **No worker attached when the prune job fires** (all workers failed to attach, or a stripped host). Expected: the prune skips and deletes nothing. It never treats "no consumers" as "no floor". Pinned by Task 17.
4. **A document is purged or archived between two seed pages.** Expected: seeding finishes, the vanished document is never worked, and nothing throws. Pinned by Task 15.
5. **A cursor-only consumer commit at idle.** Expected: parked feeds are not woken (`logged: false`), but `ledgerGen` moves so `pending` is recounted once. Pinned by Task 7 and Task 10.

---

## File map

Create:
- `src/main/core/store/maintenance-keys.ts`: `meta` keys, `seed:` prefix, `seedConsumerName()`. No imports.
- `src/main/core/changes-maintenance.ts`: `registerLedgerRekey`, `registerChangesPrune`, `pruneChangesOnce`, and the job ids and constants.
- `src/main/core/processing-counter.ts`: `createLedgerCounter` (the gated 5 s count).
- Tests:
  - `src/main/core/store/__tests__/`: `seq-invariant`, `feed-current-seq`, `ledger-rekey`, `commit-logged`, `account-change-coalescing`, `ledger-gen`, `ledger-deferred-plan`, `retired-consumers`, `seed-store` and `prune-store`, each `.test.ts`;
  - `src/main/core/engine/__tests__/`: `ledger-rekey-gate`, `seed-consumer` and `prune-reseed`, each `.test.ts`;
  - `src/main/core/__tests__/`: `ledger-rekey-job`, `processing-counter`, `idle-db` and `changes-prune-job`, each `.test.ts`.

Modify:
- `src/main/core/store/store.ts`: materializer invariant, `changesAt`, `ledgerRekeyed`, `ledgerRekeyPage`, `visualWaitingCount`, commit nudge, `setAccountCadence`/`Config`, `getOrCreateAccount`, `ledgerGen`/`markLedgerChanged`, the deferred lookups, `sweepRetiredConsumers`, the seeding primitives, the prune primitives, and `ledgerCountsAll` ignoring `seed:` rows.
- `src/main/core/store/write-tx.ts`: `CommitResult`, `appendChange` counter and account map, `accountWrite` (the store's account writers), account coalescing, `seedCursor`, and `rekeyLedgerPage`.
- `src/main/core/store/corpus-query.ts`: `seedPage`, `QUERY_METHODS`.
- `src/main/core/store/schema.ts`: fresh-DB `ledgerRekeyed` marker, `work_ledger_active` comment.
- `src/main/db/worker-entry.ts`: `rekeyLedgerPage` and `accountWrite` procedures.
- `src/main/db/repositories/core-maintenance.ts`: re-insert `ledgerRekeyed` after reset.
- `src/shared/contracts.ts`: `Query.seedPage?`, `CommitBatch` consumer `seedCursor?`.
- `src/main/core/engine/engine.ts`: `RedriveResult`, the `rerunDeferred` gate and terminal skip, `seedConsumer`, `EngineDeps.reads`/`seedPageSize`.
- `src/main/core/boot.ts`: `requestLaneWake`, register the rekey and prune jobs, `reads` dep.
- `src/main/core/processing-status.ts`: `gen` dep gating `refreshWaiting`.
- `src/main/main.ts`: ledger counter wiring, `gen` dep, retired sweep, rekey trigger.
- Existing tests touched: `src/main/db/__tests__/db-worker.test.ts`, `src/main/core/store/__tests__/visual-waiting-count.test.ts`, `src/main/core/__tests__/boot-lane.test.ts`, plus any assertion that pinned the old behaviours (named in the tasks).

---

# Part 0: Ledger seqs resolve through `documents.seq` (§0)

### Task 1: Every `documents.seq` move has its own `document` change

The audit result is ruling 6 above: every writer that moves `documents.seq` appends a `document` change with that seq, so no new change kind needs materializing. This task pins the audit as a regression test.

**Files:**
- Create: `src/main/core/store/__tests__/seq-invariant.test.ts`

**Interfaces:**
- Consumes: existing `store.commit`, `reconcileBegin/Stage/Diff/Archive`, `applyFolderScope`.
- Produces: nothing new (guard for Tasks 2–4).

- [ ] **Step 1: Write the test**

```ts
/** @jest-environment node */
/**
 * #59 §0: every writer that moves `documents.seq` appends a `document`-kind
 * change with that same seq (archive and restore included). The feed
 * materializer and `changesAt` rely on it — a ledger seq is always the
 * document's current seq.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const doc = (
  externalId: string,
  over: Partial<DocumentInput> = {},
): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('documents.seq always has its own document change (#59 §0)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-seqinv-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const orphans = () =>
    db.all(
      `SELECT d.id, d.seq FROM documents d
        WHERE d.seq > 0 AND NOT EXISTS (
          SELECT 1 FROM changes c
           WHERE c.seq = d.seq AND c.kind = 'document' AND c.ref_id = d.id)`,
    );

  const idOf = async (externalId: string): Promise<string> =>
    (
      (await db.all(`SELECT id FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ id: string }>
    )[0].id;

  it('insert, update, reparent, archive with children, restore', async () => {
    await store.commit({
      account: accountId,
      documents: [
        doc('parent'),
        doc('child', { parent: { externalId: 'parent', type: 'note' } }),
      ],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [doc('parent', { markdown: 'edited' })],
      cursor: 2,
    });
    // Child before its parent in one batch: reconcileParents re-stamps it.
    await store.commit({
      account: accountId,
      documents: [
        doc('orphan', { parent: { externalId: 'later', type: 'note' } }),
        doc('later'),
      ],
      cursor: 3,
    });
    // Upstream deletion archives the parent and its live child.
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'parent', type: 'note' }],
      cursor: 4,
    });
    // Same content again restores it (archived_at = NULL).
    await store.commit({
      account: accountId,
      documents: [doc('parent', { markdown: 'edited' })],
      cursor: 5,
    });
    expect(await orphans()).toEqual([]);
  });

  it('worker emissions and both enrich forms', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    await store.commit({
      consumer: 'worker:t:v1',
      cursor: 0,
      documents: [doc('emitted')],
      enrich: [
        { documentId: (await idOf('a')) as never, metadata: { tag: 'x' } },
        { documentId: (await idOf('b')) as never, markdown: 'new body' },
      ],
    });
    expect(await orphans()).toEqual([]);
  });

  it('reconcile archive and folder-scope archive', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('keep'), doc('gone')],
      cursor: 1,
    });
    const startSeq = await store.headSeq();
    await store.reconcileBegin(accountId);
    await store.reconcileStage(accountId, [{ externalId: 'keep', type: 'note' }]);
    await store.reconcileDiff(accountId, startSeq);
    expect(await store.reconcileArchive(accountId, startSeq)).toBe(1);

    const scoped = await store.createAccount({
      source: 'local-folder',
      identifier: '/tmp/x',
      config: { folderRoots: [{ id: 'X', name: 'X' }] },
    });
    await store.commit({
      account: scoped.id,
      documents: [doc('in-x', { type: 'file', scopeRootId: 'X' })],
      cursor: null,
    });
    const r = await store.applyFolderScope({
      accountId: scoped.id,
      config: { folderRoots: [] },
      cursor: null,
      archiveScopeRootIds: ['X'],
      reattributeScopeRoots: [],
      archiveRefs: [],
      expectedConfigJson: JSON.stringify(scoped.config),
    });
    expect(r.archived).toBe(1);
    expect(await orphans()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx jest src/main/core/store/__tests__/seq-invariant.test.ts --runInBand`
Expected: PASS. This test verifies an invariant the base already keeps. If a case fails, that writer needs an `appendChange('document', id)` whose seq it stores. Fix that before Task 2, and record it in the commit message.

- [ ] **Step 3: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/__tests__/seq-invariant.test.ts
printf 'test(store): pin that every documents.seq move has its own document change (#59)\n\nAudit for the ledger-seq invariant: upsert/restore, reparent, archive\n(by ref, children, reconcile, folder scope), enrich and both migrations\nalready append a document change with the stored seq.\n' > $SCRATCH/msg-db-t1.txt
git add src/main/core/store/__tests__/seq-invariant.test.ts
git commit -F $SCRATCH/msg-db-t1.txt -- src/main/core/store/__tests__/seq-invariant.test.ts
```

---

### Task 2: Feed a document only under its current seq; `changesAt` resolves through `documents`

**Files:**
- Modify: `src/main/core/store/store.ts` (`materializeRow`, ~line 380; `changesAt`, ~line 1171)
- Create: `src/main/core/store/__tests__/feed-current-seq.test.ts`
- Create: `src/main/core/engine/__tests__/ledger-rekey-gate.test.ts` (the engine duplicate case; Task 3 adds to it)

**Interfaces:**
- Consumes: nothing new.
- Produces: `store.changesAt(seqs)` returns `{seq, kind: 'document', document}` for each seq that is some document's **current** `seq`, in input order; unknown or stale seqs return nothing. `feed()` drops `document` changes whose seq is not the document's current seq.

- [ ] **Step 1: Write the failing store test**

`src/main/core/store/__tests__/feed-current-seq.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, Change, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string, markdown = `body ${externalId}`): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});

describe('ledger seqs are current document seqs (#59 §0)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-curseq-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seqsOf = async (externalId: string) => {
    const id = (
      (await db.all(`SELECT id, seq FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ id: string; seq: number }>
    )[0];
    const all = (
      (await db.all(
        `SELECT seq FROM changes WHERE kind = 'document' AND ref_id = ? ORDER BY seq`,
        [id.id],
      )) as Array<{ seq: number }>
    ).map((r) => r.seq);
    return { current: id.seq, all };
  };

  it('feed yields a twice-changed document once, under its current seq', async () => {
    await store.commit({ account: accountId, documents: [doc('a')], cursor: 1 });
    await store.commit({
      account: accountId,
      documents: [doc('a', 'edited')],
      cursor: 2,
    });
    const { current, all } = await seqsOf('a');
    expect(all).toHaveLength(2);

    const it = store.feed(0)[Symbol.asyncIterator]();
    const first = await it.next();
    const docs = (first.value as Change[]).filter(
      (c): c is Extract<Change, { kind: 'document' }> => c.kind === 'document',
    );
    expect(docs.map((c) => c.seq)).toEqual([current]);
    expect(docs[0].document.seq).toBe(current);
  });

  it('changesAt resolves through documents; a stale or unknown seq resolves to nothing', async () => {
    await store.commit({ account: accountId, documents: [doc('a'), doc('b')], cursor: 1 });
    await store.commit({
      account: accountId,
      documents: [doc('a', 'edited')],
      cursor: 2,
    });
    const a = await seqsOf('a');
    const b = await seqsOf('b');
    const got = await store.changesAt([b.current, a.all[0], a.current, 999_999]);
    expect(got.map((c) => c.seq)).toEqual([b.current, a.current]);
    expect(got.every((c) => c.kind === 'document')).toBe(true);
  });

  it('changesAt never reads the changes table', async () => {
    await store.commit({ account: accountId, documents: [doc('a')], cursor: 1 });
    const { current } = await seqsOf('a');
    const spy = jest.spyOn(db, 'all');
    await store.changesAt([current]);
    expect(
      spy.mock.calls.filter(([sql]) => /\bFROM changes\b/.test(sql as string)),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/feed-current-seq.test.ts --runInBand`
Expected: FAIL. The feed yields both seqs, `changesAt` returns the stale seq, and the spy sees `FROM changes`.

- [ ] **Step 3: Implement**

In `store.ts` `materializeRow`, replace the `document` branch's return:

```ts
    if (r.kind === 'document') {
      const doc = (
        await db.all(`SELECT * FROM documents WHERE id = ?`, [r.ref_id])
      )[0] as unknown as DocRow | undefined;
      // Row already purged — the tombstone further down the feed informs.
      // #59 §0: a document is fed only under its CURRENT seq. An older change
      // of the same document materializes to nothing: the newer change is
      // later in the log and feeds it, so every ledger row a feed consumer
      // writes is keyed on documents.seq.
      return doc && doc.seq === r.seq
        ? { seq: r.seq, kind: 'document', document: toDocument(doc) }
        : null;
    }
```

Add a module constant next to `const FEED_BATCH = 500;`:

```ts
/** `changesAt` resolves its seqs in IN-lists of this size (one statement per
 *  chunk; well under SQLite's bound-variable ceiling). */
const CHANGES_AT_CHUNK = 500;
```

Replace the whole `changesAt` method:

```ts
    async changesAt(seqs) {
      // #59 §0: a ledger seq is always its document's CURRENT seq, so it
      // resolves through `documents` (docs_seq), never through `changes`,
      // which pruning removes. A seq no document carries any more (changed
      // since and re-fed under its new seq, or purged) resolves to nothing.
      if (seqs.length === 0) return [];
      const bySeq = new Map<number, DocRow>();
      for (let i = 0; i < seqs.length; i += CHANGES_AT_CHUNK) {
        const slice = seqs.slice(i, i + CHANGES_AT_CHUNK);
        // eslint-disable-next-line no-await-in-loop
        const rows = (await db.all(
          `SELECT * FROM documents WHERE seq IN (${slice.map(() => '?').join(',')})`,
          slice,
        )) as unknown as DocRow[];
        for (const r of rows) bySeq.set(r.seq, r);
      }
      const out: Change[] = [];
      for (const seq of seqs) {
        const r = bySeq.get(seq);
        if (r) out.push({ seq, kind: 'document', document: toDocument(r) });
      }
      return out;
    },
```

Check `DocRow.seq` is `number` in `rows.ts` (it is `seq: number`).

- [ ] **Step 4: Write the engine duplicate-change test**

`src/main/core/engine/__tests__/ledger-rekey-gate.test.ts` (Task 3 appends to this file):

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Change, DocumentInput, Worker } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine } from '../engine';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => [],
};
const doc = (externalId: string, markdown = `body ${externalId}`): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: null,
});

export async function waitFor(
  pred: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  }
}

describe('re-drive works the current seq (#59 §0)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-rekeygate-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeEngine = () =>
    createEngine({
      store,
      sources: { get: () => undefined },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (d) => d,
      logs: { log: () => {} },
    });

  const currentSeq = async (externalId: string) =>
    (
      (await db.all(`SELECT seq FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ seq: number }>
    )[0].seq;

  it('two changes of one document are fed once at the current seq; defer, restart, re-drive works it', async () => {
    const account = await store.createAccount({ source: 'test', identifier: 't' });
    await store.commit({ account: account.id, documents: [doc('a')], cursor: 1 });
    await store.commit({
      account: account.id,
      documents: [doc('a', 'edited')],
      cursor: 2,
    });
    const current = await currentSeq('a');
    const seen: number[] = [];
    const worker: Worker = {
      name: 'dup',
      version: 1,
      matches: (c: Change) =>
        c.kind === 'document' && c.document.externalId === 'a',
      async work(c) {
        seen.push(c.seq);
        return seen.length === 1 ? 'defer' : 'done';
      },
    };
    const h1 = makeEngine().attach(worker);
    await waitFor(
      async () => (await store.ledgerCounts('worker:dup:v1')).deferred === 1,
    );
    await h1.stop();

    const e2 = makeEngine(); // restart
    const h2 = e2.attach(worker);
    await e2.rerunDeferred(worker);
    await h2.stop();

    expect(seen).toEqual([current, current]);
    expect(
      await db.all(
        `SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:dup:v1'`,
      ),
    ).toEqual([{ seq: current, outcome: 'done' }]);
  });
});
```

- [ ] **Step 5: Run both, then the neighbours that pin feed and redrive behaviour**

Run: `npx jest src/main/core/store/__tests__/feed-current-seq.test.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts --runInBand`
Expected: PASS.

Run: `npx jest src/main/core/store/__tests__/store.test.ts src/main/core/engine/__tests__/engine.test.ts src/main/core/engine/__tests__/feed-retry.test.ts --runInBand`
Expected: PASS. An assertion that expected `feed()` to yield an **older** seq of a since-updated document, or one that counted per-batch duplicate `skip` rows for such a document, pinned the bug. Update it to expect only the current seq. Re-run, and quote the changed assertion in the commit message.

- [ ] **Step 6: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/store.ts src/main/core/store/__tests__/feed-current-seq.test.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts
printf 'fix(feed): a document is fed only under its current seq; changesAt resolves through documents (#59)\n\nAn older change of a since-updated document materializes to nothing, so\nevery ledger write is keyed on documents.seq. changesAt reads documents\n(docs_seq) and never the changes log, which pruning will remove.\n' > $SCRATCH/msg-db-t2.txt
git add src/main/core/store/__tests__/feed-current-seq.test.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts
git commit -F $SCRATCH/msg-db-t2.txt -- src/main/core/store/store.ts src/main/core/store/__tests__/feed-current-seq.test.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts
```

(Add any existing test file you updated in Step 5 to the `--` path list.)

---

### Task 3: `meta.ledgerRekeyed`, the re-drive gate, and the terminal skip

**Files:**
- Create: `src/main/core/store/maintenance-keys.ts`
- Modify: `src/main/core/store/schema.ts` (`migrate`, ~line 1246)
- Modify: `src/main/db/repositories/core-maintenance.ts`
- Modify: `src/main/core/store/store.ts` (`CoreStore` interface; new `ledgerRekeyed` method)
- Modify: `src/main/core/engine/engine.ts` (`createEngine` return type ~line 405; `rerunDeferred` ~line 1900)
- Test: `src/main/core/engine/__tests__/ledger-rekey-gate.test.ts` (append)

**Interfaces:**
- Produces (`maintenance-keys.ts`): `META_LEDGER_REKEYED = 'ledgerRekeyed'`, `META_LEDGER_REKEY_CURSOR = 'ledgerRekeyCursor'`, `META_CHANGES_FLOOR = 'changesFloor'`, `SEED_CONSUMER_PREFIX = 'seed:'`, `seedConsumerName(consumer: string): string`.
- Produces (store): `ledgerRekeyed(): Promise<boolean>`. It is cached in memory once true and never flips back.
- Produces (engine): `export type RedriveResult = { skipped: 'rekey-pending' } | undefined;` and `rerunDeferred(worker: Worker): Promise<RedriveResult>`.

- [ ] **Step 1: Write the failing tests** (append inside the `describe` of `ledger-rekey-gate.test.ts`)

```ts
  const preUpgrade = async () => {
    // A profile written by an older build: no marker. Must run before the
    // store's first ledgerRekeyed() call (the flag is cached once true).
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`);
  };

  it('a fresh corpus is born re-keyed', async () => {
    expect(
      await db.all(`SELECT value FROM meta WHERE key = 'ledgerRekeyed'`),
    ).toEqual([{ value: '1' }]);
    expect(await store.ledgerRekeyed()).toBe(true);
  });

  it('before the repair, rerunDeferred is a no-op that reports rekey-pending', async () => {
    await preUpgrade();
    const account = await store.createAccount({ source: 'test', identifier: 't' });
    await store.commit({ account: account.id, documents: [doc('a')], cursor: 1 });
    const s = await currentSeq('a');
    await store.ledgerRecord('worker:gate:v1', s, 0, 'deferred');
    const work = jest.fn(async () => 'done' as const);
    const worker: Worker = {
      name: 'gate',
      version: 1,
      matches: () => true,
      work,
    };
    expect(await makeEngine().rerunDeferred(worker)).toEqual({
      skipped: 'rekey-pending',
    });
    expect(work).not.toHaveBeenCalled();
    expect(
      await db.all(`SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:gate:v1'`),
    ).toEqual([{ seq: s, outcome: 'deferred' }]);
  });

  it('Reset all keeps the marker: an empty ledger is trivially re-keyed', async () => {
    await store.maintenance.resetAll();
    expect(
      await db.all(`SELECT value FROM meta WHERE key = 'ledgerRekeyed'`),
    ).toEqual([{ value: '1' }]);
  });

  it('a deferred seq that resolves to nothing becomes a terminal skip', async () => {
    const account = await store.createAccount({ source: 'test', identifier: 't' });
    await store.commit({ account: account.id, documents: [doc('a')], cursor: 1 });
    const s = await currentSeq('a');
    await store.ledgerRecord('worker:gone:v1', s, 0, 'deferred');
    // Archive, then purge: the document is gone for good.
    await store.commit({
      account: account.id,
      documents: [],
      deletions: [{ externalId: 'a', type: 'note' }],
      cursor: 2,
    });
    await store.commit({ purgeArchived: { before: '9999-01-01T00:00:00Z' } });
    const worker: Worker = {
      name: 'gone',
      version: 1,
      matches: () => true,
      work: async () => 'done',
    };
    await makeEngine().rerunDeferred(worker);
    expect(
      await db.all(`SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:gone:v1'`),
    ).toEqual([{ seq: s, outcome: 'skip' }]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/engine/__tests__/ledger-rekey-gate.test.ts --runInBand`
Expected: FAIL. The marker is absent, `ledgerRekeyed` is not a function, `rerunDeferred` returns `undefined`, and the purged entry stays `deferred`.

- [ ] **Step 3: Implement**

Create `src/main/core/store/maintenance-keys.ts`:

```ts
/** `meta` keys and `consumers` row names owned by the changes-log
 *  maintenance (#59). No imports: schema.ts, write-tx.ts, store.ts, the
 *  engine and the reset repository all read these. */

/** Set when every `deferred` ledger row is keyed on its document's CURRENT
 *  seq (spec §0). Absent ⇒ every re-drive entry point is a no-op. */
export const META_LEDGER_REKEYED = 'ledgerRekeyed';
/** Keyset position `{consumer, seq}` of the paged re-key repair. */
export const META_LEDGER_REKEY_CURSOR = 'ledgerRekeyCursor';
/** Highest `limit` any prune run published; a consumer below it re-seeds. */
export const META_CHANGES_FLOOR = 'changesFloor';
/** Progress rows of a consumer being seeded from `documents` (spec §3a). */
export const SEED_CONSUMER_PREFIX = 'seed:';

export const seedConsumerName = (consumer: string): string =>
  `${SEED_CONSUMER_PREFIX}${consumer}`;
```

In `schema.ts`, add the import at the top with the other local imports:

```ts
import { META_LEDGER_REKEYED } from './maintenance-keys';
```

and in `migrate()` replace the tail, from `for (let i = version; …` through `ensureQueryIndexes(db);`:

```ts
  const fresh = version === 0;
  for (let i = version; i < MIGRATIONS.length; i += 1) {
    db.transaction(() => {
      const m = MIGRATIONS[i];
      if (typeof m === 'string') db.exec(m);
      else m(db);
      db.prepare(
        `INSERT INTO meta(key, value) VALUES('schemaVersion', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(String(i + 1));
    })();
  }
  // #59 §0: a corpus this build creates has no ledger rows keyed by the old
  // feed materializer, so the one-shot re-key repair has nothing to do.
  if (fresh)
    db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES(?, '1')`).run(
      META_LEDGER_REKEYED,
    );
  ensureQueryIndexes(db);
```

In `src/main/db/repositories/core-maintenance.ts` add the import and one step right after the `meta` wipe:

```ts
import { META_LEDGER_REKEYED } from '../../core/store/maintenance-keys';
```

```ts
    { sql: `DELETE FROM meta WHERE key != 'schemaVersion'` },
    // The wiped ledger is empty, so it is trivially re-keyed (#59 §0) —
    // without this, re-drive would stay gated until the next app start.
    { sql: `INSERT INTO meta(key, value) VALUES(?, '1')`, params: [META_LEDGER_REKEYED] },
```

In `store.ts`, import the keys:

```ts
import { META_LEDGER_REKEYED } from './maintenance-keys';
```

add to `CoreStore` (right after `changesAt(seqs: Seq[]): Promise<Change[]>;`):

```ts
  /** #59 §0: every deferred ledger row is keyed on its document's current
   *  seq. False on a profile upgraded from an older build until the paged
   *  re-key repair finishes; every re-drive entry point is a no-op until
   *  then. Cached in memory once true. */
  ledgerRekeyed(): Promise<boolean>;
```

add a closure variable next to `let closed = false;`:

```ts
  let rekeyed = false;
```

and the method (next to `changesAt`):

```ts
    async ledgerRekeyed() {
      if (rekeyed) return true;
      rekeyed =
        (await db.all(`SELECT 1 FROM meta WHERE key = ?`, [META_LEDGER_REKEYED]))
          .length > 0;
      return rekeyed;
    },
```

In `engine.ts`, add above `export function createEngine`:

```ts
/** What a deferred-work re-drive did. `{ skipped: 'rekey-pending' }`: the
 *  one-shot ledger re-key repair (#59 §0) has not finished, so nothing ran
 *  and nothing was recorded; the repair's completion wakes the re-drive. */
export type RedriveResult = { skipped: 'rekey-pending' } | undefined;
```

In the `createEngine` return type, replace

```ts
  rerunDeferred(worker: Worker): Promise<void>;
```

with

```ts
  rerunDeferred(worker: Worker): Promise<RedriveResult>;
```

In the implementation, replace the signature line and add the gate as the first statement:

```ts
    async rerunDeferred(worker: Worker): Promise<RedriveResult> {
      // #59 §0: until every deferred row is keyed on its document's current
      // seq, a re-drive could resolve a stale seq to nothing and skip it for
      // good, or race the repair. No-op; the repair's completion wakes us.
      if (!(await store.ledgerRekeyed())) return { skipped: 'rekey-pending' };
      const consumer = workerConsumerName(worker);
```

(Delete the original `const consumer = workerConsumerName(worker);` line it replaces. The rest of the method keeps its `return;` statements.)

Right after `const changes = await store.changesAt(seqs);` and before `const emitted`, insert:

```ts
        // #59 §0: a deferred seq no document carries any more resolves to
        // nothing. With the repair done that only means the document was
        // purged (or changed and was fed again under its new seq): resolve the
        // row terminally so it stops being re-selected forever.
        const resolved = new Set(changes.map((c) => c.seq));
        const unresolved: LedgerEntry[] = seqs
          .filter((s) => !resolved.has(s))
          .map((s) => ({ seq: s, attempts: 0, outcome: 'skip' }));
```

Then change `const ledger: LedgerEntry[] = [];` to:

```ts
        const ledger: LedgerEntry[] = [...unresolved];
```

The existing `if (ledger.length) await store.ledgerRecordMany(consumer, ledger);` after the page commit records them.

- [ ] **Step 4: Run to verify they pass, then the neighbours**

Run: `npx jest src/main/core/engine/__tests__/ledger-rekey-gate.test.ts --runInBand`
Expected: PASS.

Run: `npx jest src/main/core/engine/__tests__/engine.test.ts src/main/core/store/__tests__/store.test.ts src/main/core/store/__tests__/ingest-seq-migration.test.ts src/main/core/store/__tests__/folder-scope-migration.test.ts src/main/workers --runInBand`
Expected: PASS. A test that snapshots all `meta` rows now also sees `ledgerRekeyed`; update that expectation.

Run: `npx tsc --noEmit -p .`
Expected: no errors. `boot.ts attachWorker` and `workers/index.ts registerRedrive` `await` the result and ignore it.

- [ ] **Step 5: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/maintenance-keys.ts src/main/core/store/schema.ts src/main/db/repositories/core-maintenance.ts src/main/core/store/store.ts src/main/core/engine/engine.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts
printf 'feat(ledger): re-drive gated on meta.ledgerRekeyed; unresolvable deferred seqs end as skip (#59)\n\nA fresh corpus and a factory reset are born re-keyed. rerunDeferred\nreturns {skipped: rekey-pending} until the repair finishes, so no redrive\nwrite races it; afterwards a deferred seq no document carries is a\nterminal skip instead of lingering forever.\n' > $SCRATCH/msg-db-t3.txt
git add src/main/core/store/maintenance-keys.ts
git commit -F $SCRATCH/msg-db-t3.txt -- src/main/core/store/maintenance-keys.ts src/main/core/store/schema.ts src/main/db/repositories/core-maintenance.ts src/main/core/store/store.ts src/main/core/engine/engine.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts
```

---

### Task 4: The paged re-key repair (one page per writer call)

**Files:**
- Modify: `src/main/core/store/write-tx.ts` (`WriteTx` interface + a new `rekeyLedgerPage`)
- Modify: `src/main/db/worker-entry.ts` (procedure table, next to `applyFolderScope`)
- Modify: `src/main/core/store/store.ts` (`CoreStore.ledgerRekeyPage` + implementation)
- Create: `src/main/core/store/__tests__/ledger-rekey.test.ts`
- Modify: `src/main/db/__tests__/db-worker.test.ts` (one proc round-trip case)

**Interfaces:**
- Produces (write-tx): `export interface RekeyPageResult { done: boolean; scanned: number }`, `export const LEDGER_REKEY_PAGE = 5_000;`, and `WriteTx.rekeyLedgerPage(limit: number): RekeyPageResult`. One transaction per call; it persists `meta.ledgerRekeyCursor`; on the last page it sets `meta.ledgerRekeyed` and deletes the cursor.
- Produces (store): `ledgerRekeyPage(limit?: number): Promise<RekeyPageResult>`. The default limit is `LEDGER_REKEY_PAGE`. It bumps `ledgerGen` (Task 10 adds the bump) and sets the cached flag when `done`.

- [ ] **Step 1: Write the failing tests**

`src/main/core/store/__tests__/ledger-rekey.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string, markdown = `body ${externalId}`): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});
const V = 'worker:vision:v1';
const A = 'worker:audio:v2';

describe('paged re-key repair (#59 §0)', () => {
  let dir: string;
  let file: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  const open = async () => {
    db = await openDb(file);
    store = openStore(db, deps);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-rekey-'));
    file = path.join(dir, 'test.db');
    await open();
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`); // pre-upgrade
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Commit `externalId` twice; returns [old seq, current seq]. */
  const twice = async (externalId: string): Promise<[number, number]> => {
    await store.commit({ account: accountId, documents: [doc(externalId)], cursor: 1 });
    const old = await seqOf(externalId);
    await store.commit({
      account: accountId,
      documents: [doc(externalId, 'edited')],
      cursor: 2,
    });
    return [old, await seqOf(externalId)];
  };
  const seqOf = async (externalId: string) =>
    (
      (await db.all(`SELECT seq FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ seq: number }>
    )[0].seq;
  const ledger = (consumer: string) =>
    db.all(
      `SELECT seq, attempts, outcome FROM work_ledger WHERE consumer = ? ORDER BY seq`,
      [consumer],
    );
  const repairAll = async (limit?: number) => {
    let pages = 0;
    for (;;) {
      pages += 1;
      // eslint-disable-next-line no-await-in-loop
      if ((await store.ledgerRekeyPage(limit)).done) return pages;
    }
  };

  it('none at the current seq: the deferral moves there, attempts kept', async () => {
    const [old, cur] = await twice('a');
    await store.ledgerRecord(V, old, 2, 'deferred');
    await repairAll();
    expect(await ledger(V)).toEqual([{ seq: cur, attempts: 2, outcome: 'deferred' }]);
    expect(await store.ledgerRekeyed()).toBe(true);
  });

  it('done at the current seq: the stale deferral is dropped', async () => {
    const [old, cur] = await twice('a');
    await store.ledgerRecordMany(V, [
      { seq: old, attempts: 1, outcome: 'deferred' },
      { seq: cur, attempts: 1, outcome: 'done' },
    ]);
    await repairAll();
    expect(await ledger(V)).toEqual([{ seq: cur, attempts: 1, outcome: 'done' }]);
  });

  it('(old, deferred), (current, skip) becomes (current, deferred) with attempts reset', async () => {
    const [old, cur] = await twice('a');
    await store.ledgerRecordMany(V, [
      { seq: old, attempts: 3, outcome: 'deferred' },
      { seq: cur, attempts: 0, outcome: 'skip' },
    ]);
    await repairAll();
    expect(await ledger(V)).toEqual([{ seq: cur, attempts: 0, outcome: 'deferred' }]);
  });

  it('failed at the current seq also gets one more retry', async () => {
    const [old, cur] = await twice('a');
    await store.ledgerRecordMany(V, [
      { seq: old, attempts: 1, outcome: 'deferred' },
      { seq: cur, attempts: 4, outcome: 'failed' },
    ]);
    await repairAll();
    expect(await ledger(V)).toEqual([{ seq: cur, attempts: 0, outcome: 'deferred' }]);
  });

  it('a purged document: the stale row is dropped', async () => {
    await store.commit({ account: accountId, documents: [doc('p')], cursor: 1 });
    const s = await seqOf('p');
    await store.ledgerRecord(V, s, 0, 'deferred');
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'p', type: 'note' }],
      cursor: 2,
    });
    await store.commit({ purgeArchived: { before: '9999-01-01T00:00:00Z' } });
    await repairAll();
    expect(await ledger(V)).toEqual([]);
  });

  it('a current deferral (audio, model missing) is untouched', async () => {
    await store.commit({ account: accountId, documents: [doc('m')], cursor: 1 });
    const s = await seqOf('m');
    await store.ledgerRecord(A, s, 0, 'deferred');
    await repairAll();
    expect(await ledger(A)).toEqual([{ seq: s, attempts: 0, outcome: 'deferred' }]);
  });

  it('pages by (consumer, seq), persists its cursor, and resumes after a reopen', async () => {
    const stale: Array<[string, number, number]> = [];
    for (const id of ['a', 'b', 'c']) {
      // eslint-disable-next-line no-await-in-loop
      const [old, cur] = await twice(id);
      stale.push([id, old, cur]);
    }
    await store.ledgerRecordMany(
      V,
      stale.map(([, old]) => ({ seq: old, attempts: 0, outcome: 'deferred' as const })),
    );
    await store.ledgerRecord(A, stale[0][1], 0, 'deferred');

    // One page of 2 rows, then "quit".
    expect((await store.ledgerRekeyPage(2)).done).toBe(false);
    const cursor = (await db.all(
      `SELECT value FROM meta WHERE key = 'ledgerRekeyCursor'`,
    )) as Array<{ value: string }>;
    expect(cursor).toHaveLength(1);
    await store.close();

    await open(); // next start
    expect(await store.ledgerRekeyed()).toBe(false);
    await repairAll(2);
    expect(await ledger(V)).toEqual(
      stale.map(([, , cur]) => ({ seq: cur, attempts: 0, outcome: 'deferred' })),
    );
    expect(await ledger(A)).toEqual([
      { seq: stale[0][2], attempts: 0, outcome: 'deferred' },
    ]);
    expect(
      await db.all(`SELECT key FROM meta WHERE key LIKE 'ledgerRekey%' ORDER BY key`),
    ).toEqual([{ key: 'ledgerRekeyed' }]);
  });
});
```

Append to `src/main/db/__tests__/db-worker.test.ts`, inside the same `describe` as the commit round-trip test, using its `spawnAndReady()`/`client` harness:

```ts
  it('runs the re-key repair page procedure inside the worker', async () => {
    await spawnAndReady();
    const r = (await client!.proc!('rekeyLedgerPage', { limit: 10 })) as {
      done: boolean;
      scanned: number;
    };
    expect(r).toEqual({ done: true, scanned: 0 });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/store/__tests__/ledger-rekey.test.ts --runInBand`
Expected: FAIL, because `store.ledgerRekeyPage is not a function`.

- [ ] **Step 3: Implement the transaction in `write-tx.ts`**

Add the import:

```ts
import {
  META_LEDGER_REKEY_CURSOR,
  META_LEDGER_REKEYED,
} from './maintenance-keys';
```

Add above `export interface WriteTx`:

```ts
/** Spec §0: keyset pages of this many deferred rows, one writer call each. */
export const LEDGER_REKEY_PAGE = 5_000;

/** One page of the re-key repair. `done` ⇒ `meta.ledgerRekeyed` is set. */
export interface RekeyPageResult {
  done: boolean;
  scanned: number;
}
```

Add to `WriteTx`:

```ts
  /** #59 §0 — ONE page of the re-key repair, in ONE transaction: every
   *  `deferred` row of the current consumer past `meta.ledgerRekeyCursor`
   *  whose seq no document carries is re-keyed to the document's current
   *  seq (or dropped), then the cursor is persisted. The last page sets
   *  `meta.ledgerRekeyed`. */
  rekeyLedgerPage(limit: number): RekeyPageResult;
```

Add before `return {` at the end of `createWriteTx`:

```ts
  // ── #59 §0: the paged re-key repair ──────────────────────────────────────
  //
  // Before 0.10x the feed materializer paired a historical document change
  // seq with the CURRENT document, so a deferral could be keyed on a seq no
  // document carries. Each such row is resolved through its `changes` row:
  //  · document gone (or no document change)  → drop it;
  //  · consumer row at the current seq: none  → move the deferral there
  //    (attempts kept — it is the same deferral);
  //  · done                                    → drop the stale row;
  //  · anything else (skip/deferred/failed/NULL) → that row becomes
  //    'deferred' with attempts 0, the stale row goes. A 'skip' there is no
  //    evidence the document was handled: the old re-drive coalescer wrote
  //    duplicates as skip even when the first occurrence deferred again.
  // The page walks ONE consumer's deferred rows by seq through
  // work_ledger_active (the `IS NOT 'skip'` term lets the planner use it);
  // the next consumer is a primary-key seek.
  const rekeyLedgerPageTx = conn.transaction(
    (limit: number): RekeyPageResult => {
      const getMeta = conn.prepare(`SELECT value FROM meta WHERE key = ?`);
      const setMeta = conn.prepare(
        `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      );
      const nextConsumer = conn.prepare(
        `SELECT MIN(consumer) AS c FROM work_ledger WHERE consumer > ?`,
      );
      const finish = (scanned: number): RekeyPageResult => {
        setMeta.run(META_LEDGER_REKEYED, '1');
        conn.prepare(`DELETE FROM meta WHERE key = ?`).run(META_LEDGER_REKEY_CURSOR);
        return { done: true, scanned };
      };

      const raw = (getMeta.get(META_LEDGER_REKEY_CURSOR) as { value: string } | undefined)
        ?.value;
      let pos = raw
        ? (JSON.parse(raw) as { consumer: string; seq: number })
        : null;
      if (!pos) {
        const first = nextConsumer.get('') as { c: string | null };
        if (first.c === null) return finish(0);
        pos = { consumer: first.c, seq: 0 };
      }

      const rows = conn
        .prepare(
          `SELECT seq, attempts FROM work_ledger
            WHERE consumer = ? AND outcome = 'deferred' AND outcome IS NOT 'skip'
              AND seq > ?
            ORDER BY seq LIMIT ?`,
        )
        .all(pos.consumer, pos.seq, limit) as Array<{
        seq: number;
        attempts: number;
      }>;

      const isCurrent = conn.prepare(`SELECT 1 FROM documents WHERE seq = ?`);
      const changeAt = conn.prepare(`SELECT kind, ref_id FROM changes WHERE seq = ?`);
      const docSeq = conn.prepare(`SELECT seq FROM documents WHERE id = ?`);
      const rowAt = conn.prepare(
        `SELECT outcome FROM work_ledger WHERE consumer = ? AND seq = ?`,
      );
      const del = conn.prepare(`DELETE FROM work_ledger WHERE consumer = ? AND seq = ?`);
      const insert = conn.prepare(
        `INSERT INTO work_ledger(consumer, seq, attempts, outcome, updated_at)
         VALUES(?, ?, ?, 'deferred', ?)`,
      );
      const retry = conn.prepare(
        `UPDATE work_ledger SET outcome = 'deferred', attempts = 0, updated_at = ?
          WHERE consumer = ? AND seq = ?`,
      );

      const consumer = pos.consumer;
      for (const r of rows) {
        if (isCurrent.get(r.seq)) continue; // already keyed on a current seq
        const change = changeAt.get(r.seq) as
          | { kind: string; ref_id: string }
          | undefined;
        const current =
          change && change.kind === 'document'
            ? (docSeq.get(change.ref_id) as { seq: number } | undefined)
            : undefined;
        if (current) {
          const there = rowAt.get(consumer, current.seq) as
            | { outcome: string | null }
            | undefined;
          if (!there) insert.run(consumer, current.seq, r.attempts, deps.now());
          else if (there.outcome !== 'done')
            retry.run(deps.now(), consumer, current.seq);
        }
        del.run(consumer, r.seq);
      }

      if (rows.length === limit) {
        setMeta.run(
          META_LEDGER_REKEY_CURSOR,
          JSON.stringify({ consumer, seq: rows[rows.length - 1].seq }),
        );
        return { done: false, scanned: rows.length };
      }
      // This consumer is exhausted: move to the next one, or finish.
      const next = nextConsumer.get(consumer) as { c: string | null };
      if (next.c === null) return finish(rows.length);
      setMeta.run(
        META_LEDGER_REKEY_CURSOR,
        JSON.stringify({ consumer: next.c, seq: 0 }),
      );
      return { done: false, scanned: rows.length };
    },
  );
```

Add to the returned object (after `applyFolderScope`):

```ts
    rekeyLedgerPage: (limit) => rekeyLedgerPageTx(limit),
```

- [ ] **Step 4: Register the worker procedure**

In `src/main/db/worker-entry.ts`, inside the procedure table right after the `applyFolderScope` entry:

```ts
        // #59 §0: one page of the re-key repair = one transaction here.
        rekeyLedgerPage: (args) =>
          writeTx.rekeyLedgerPage((args as { limit: number }).limit),
```

- [ ] **Step 5: Store wrapper**

In `store.ts`, extend the `./write-tx` import with `LEDGER_REKEY_PAGE` and `type RekeyPageResult`. Add to `CoreStore` after `ledgerRekeyed`:

```ts
  /** ONE page of the re-key repair (one writer call). Callers loop until
   *  `done`, yielding between pages; progress survives a quit. */
  ledgerRekeyPage(limit?: number): Promise<RekeyPageResult>;
```

and the method after `ledgerRekeyed`:

```ts
    async ledgerRekeyPage(limit = LEDGER_REKEY_PAGE) {
      const r = writeTx
        ? writeTx.rekeyLedgerPage(limit)
        : ((await db.proc!('rekeyLedgerPage', { limit })) as RekeyPageResult);
      if (r.done) rekeyed = true;
      return r;
    },
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx jest src/main/core/store/__tests__/ledger-rekey.test.ts --runInBand`
Expected: PASS.

Run: `npx jest src/main/db/__tests__/db-worker.test.ts --runInBand`
Expected: PASS. If this suite needs a built worker bundle it cannot load in the worktree, compare against the base (Global Constraints) and note it in the commit message. Do not build in the worktree.

- [ ] **Step 7: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/write-tx.ts src/main/db/worker-entry.ts src/main/core/store/store.ts src/main/core/store/__tests__/ledger-rekey.test.ts src/main/db/__tests__/db-worker.test.ts
printf 'feat(ledger): paged re-key repair of pre-upgrade deferred rows (#59)\n\nOne writer transaction per 5000-row keyset page by (consumer, seq),\nprogress in meta.ledgerRekeyCursor, meta.ledgerRekeyed on the last page.\nnone -> move (attempts kept); done -> drop; anything else -> deferred,\nattempts 0. Purged documents drop their row.\n' > $SCRATCH/msg-db-t4.txt
git add src/main/core/store/__tests__/ledger-rekey.test.ts
git commit -F $SCRATCH/msg-db-t4.txt -- src/main/core/store/write-tx.ts src/main/db/worker-entry.ts src/main/core/store/store.ts src/main/core/store/__tests__/ledger-rekey.test.ts src/main/db/__tests__/db-worker.test.ts
```

---

### Task 5: The repair job, its lane wake, and the upgrade sequence

**Files:**
- Create: `src/main/core/changes-maintenance.ts`
- Modify: `src/main/core/boot.ts` (`requestLaneWake`, register the job in `bootCore`)
- Modify: `src/main/main.ts` (trigger once after `p.scheduler.start()`, ~line 1444)
- Create: `src/main/core/__tests__/ledger-rekey-job.test.ts`
- Modify: `src/main/core/__tests__/boot-lane.test.ts` (one case)
- Test: `src/main/core/engine/__tests__/ledger-rekey-gate.test.ts` (append the end-to-end upgrade case)

**Interfaces:**
- Consumes: `store.ledgerRekeyed()`, `store.ledgerRekeyPage()` (Tasks 3–4).
- Produces: `LEDGER_REKEY_JOB_ID = 'maintenance:ledger-rekey'`, and `registerLedgerRekey(deps: { store: Pick<CoreStore, 'ledgerRekeyed' | 'ledgerRekeyPage'>; scheduler: Pick<CoreScheduler, 'register'>; logs: LogSink; onDone: () => void; yieldTurn?: () => Promise<void> }): Promise<void>`. Also `requestLaneWake(platform: CorePlatform): void` in `boot.ts`.

- [ ] **Step 1: Write the failing tests**

`src/main/core/__tests__/ledger-rekey-job.test.ts`:

```ts
/** @jest-environment node */
import type { Cadence } from '@shared/contracts';

import {
  LEDGER_REKEY_JOB_ID,
  registerLedgerRekey,
} from '../changes-maintenance';

function harness(pages: boolean[]) {
  let job: { cadence: Cadence; run: () => Promise<void> } | null = null;
  let flag = false;
  const ledgerRekeyPage = jest.fn(async () => {
    const done = pages.shift() ?? true;
    if (done) flag = true;
    return { done, scanned: 1 };
  });
  const onDone = jest.fn();
  const yieldTurn = jest.fn(async () => {});
  const registered = registerLedgerRekey({
    store: { ledgerRekeyed: async () => flag, ledgerRekeyPage },
    scheduler: {
      register: async (id, cadence, run) => {
        if (id === LEDGER_REKEY_JOB_ID) job = { cadence, run };
      },
    },
    logs: { log: () => {} },
    onDone,
    yieldTurn,
  });
  return { registered, job: () => job!, ledgerRekeyPage, onDone, yieldTurn };
}

describe('ledger re-key job (#59 §0)', () => {
  it('is a manual job: the scheduler tick never fires it', async () => {
    const h = harness([]);
    await h.registered;
    expect(h.job().cadence).toBe('manual');
  });

  it('pages until done, yielding between pages, then fires the wake once', async () => {
    const h = harness([false, false, true]);
    await h.registered;
    await h.job().run();
    expect(h.ledgerRekeyPage).toHaveBeenCalledTimes(3);
    expect(h.yieldTurn).toHaveBeenCalledTimes(2);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it('runs once: a second run reads only the cached flag', async () => {
    const h = harness([true]);
    await h.registered;
    await h.job().run();
    await h.job().run();
    expect(h.ledgerRekeyPage).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });
});
```

Append to `src/main/core/__tests__/boot-lane.test.ts` (import `requestLaneWake` and `takeLaneWake` from `'../boot'` if they are not imported there yet):

```ts
it('requestLaneWake arms exactly one pending wake (#59 §0 repair completion)', () => {
  const platform = {} as Parameters<typeof requestLaneWake>[0];
  requestLaneWake(platform);
  expect(takeLaneWake(platform)).toBe(true);
  expect(takeLaneWake(platform)).toBe(false);
});
```

Append to `ledger-rekey-gate.test.ts` inside the `describe` (it uses `preUpgrade`, `currentSeq` and `makeEngine` from Tasks 2–3):

```ts
  it('upgrade: an overdue re-drive before the repair is a no-op; after it, (old, deferred), (cur, skip) is retried once at cur', async () => {
    await preUpgrade();
    const account = await store.createAccount({ source: 'test', identifier: 't' });
    await store.commit({ account: account.id, documents: [doc('a')], cursor: 1 });
    const old = await currentSeq('a');
    await store.commit({
      account: account.id,
      documents: [doc('a', 'edited')],
      cursor: 2,
    });
    const cur = await currentSeq('a');
    await store.ledgerRecordMany('worker:up:v1', [
      { seq: old, attempts: 1, outcome: 'deferred' },
      { seq: cur, attempts: 0, outcome: 'skip' },
    ]);
    const seen: number[] = [];
    const worker: Worker = {
      name: 'up',
      version: 1,
      matches: () => true,
      async work(c) {
        seen.push(c.seq);
        return 'done';
      },
    };
    const engine = makeEngine();
    // Scheduler catch-up at 2 s, before the repair has run:
    expect(await engine.rerunDeferred(worker)).toEqual({ skipped: 'rekey-pending' });
    expect(seen).toEqual([]);

    const { registerLedgerRekey, LEDGER_REKEY_JOB_ID } = await import(
      '../../changes-maintenance'
    );
    let run: (() => Promise<void>) | null = null;
    const onDone = jest.fn();
    await registerLedgerRekey({
      store,
      scheduler: {
        register: async (id, _c, r) => {
          if (id === LEDGER_REKEY_JOB_ID) run = r;
        },
      },
      logs: { log: () => {} },
      onDone,
    });
    await run!();
    expect(onDone).toHaveBeenCalledTimes(1); // → requestLaneWake in production

    expect(await engine.rerunDeferred(worker)).toBeUndefined();
    expect(seen).toEqual([cur]);
    expect(
      await db.all(`SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:up:v1'`),
    ).toEqual([{ seq: cur, outcome: 'done' }]);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/__tests__/ledger-rekey-job.test.ts src/main/core/__tests__/boot-lane.test.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts --runInBand`
Expected: FAIL. The module `../changes-maintenance` is missing, and so is `requestLaneWake`.

- [ ] **Step 3: Implement `src/main/core/changes-maintenance.ts`**

```ts
/**
 * Changes-log maintenance (#59): the one-shot ledger re-key repair (§0) and,
 * from Task 17, the `changes` prune job (§3b). Lifted out of `bootCore` (which
 * needs a real DB worker) so cadence, gating and paging are unit-testable —
 * the same shape as `registerArchiveSweep`.
 */
import { setImmediate as nextEventLoopTurn } from 'timers/promises';

import type { LogSink } from './engine/engine';
import type { CoreScheduler } from './scheduler';
import type { CoreStore } from './store/store';

export const LEDGER_REKEY_JOB_ID = 'maintenance:ledger-rekey';

/** Register the paged re-key repair as a MANUAL job (the 30 s tick never
 *  fires it; main.ts triggers it once after `scheduler.start()`). Each run
 *  is a no-op once `ledgerRekeyed()` is true, so a re-trigger is free. On
 *  completion `onDone` fires — production arms the lane wake, so the
 *  re-drive the gate held back runs on the next open publisher tick. */
export async function registerLedgerRekey(deps: {
  store: Pick<CoreStore, 'ledgerRekeyed' | 'ledgerRekeyPage'>;
  scheduler: Pick<CoreScheduler, 'register'>;
  logs: LogSink;
  onDone: () => void;
  /** Between pages; default one macrotask (`setImmediate`). */
  yieldTurn?: () => Promise<void>;
}): Promise<void> {
  const yieldTurn = deps.yieldTurn ?? (() => nextEventLoopTurn());
  await deps.scheduler.register(LEDGER_REKEY_JOB_ID, 'manual', async () => {
    if (await deps.store.ledgerRekeyed()) return;
    deps.logs.log('maintenance', 'info', 'ledger re-key repair started');
    let pages = 0;
    let scanned = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const r = await deps.store.ledgerRekeyPage();
      pages += 1;
      scanned += r.scanned;
      if (r.done) break;
      // eslint-disable-next-line no-await-in-loop
      await yieldTurn();
    }
    deps.logs.log(
      'maintenance',
      'info',
      `ledger re-key repair done: ${scanned} deferred rows in ${pages} pages`,
    );
    deps.onDone();
  });
}
```

- [ ] **Step 4: Wire boot and main**

In `boot.ts`, import:

```ts
import { registerLedgerRekey } from './changes-maintenance';
```

Add right after `takeLaneWake` at the end of the file:

```ts
/** Arm one lane wake from outside the lane check. The ledger re-key repair
 *  (#59 §0) calls this when it finishes, so the deferred re-drive it held
 *  back runs on the next open publisher tick instead of on its cadence. */
export function requestLaneWake(platform: CorePlatform): void {
  pendingWake.add(platform);
}
```

In `bootCore`, right after `inference.setLanePolicy(() => backgroundLaneOpen(platform));` and before `return platform;`:

```ts
  // #59 §0: registered here (needs `platform` for the wake), triggered once
  // by main.ts after scheduler.start() so it never competes with boot.
  void registerLedgerRekey({
    store,
    scheduler,
    logs: sink,
    onDone: () => requestLaneWake(platform),
  }).catch((err) =>
    sink.log('maintenance', 'error', `ledger re-key registration failed: ${String(err)}`),
  );
```

In `main.ts`, import `LEDGER_REKEY_JOB_ID` from `'./core/changes-maintenance'` and, right after `p.scheduler.start();`:

```ts
    // #59 §0: one-shot, paged, in the background. Re-drive stays gated until
    // it finishes; its completion arms the lane wake.
    void p.scheduler.trigger(LEDGER_REKEY_JOB_ID);
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx jest src/main/core/__tests__/ledger-rekey-job.test.ts src/main/core/__tests__/boot-lane.test.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts --runInBand`
Expected: PASS.

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/changes-maintenance.ts src/main/core/boot.ts src/main/main.ts src/main/core/__tests__/ledger-rekey-job.test.ts src/main/core/__tests__/boot-lane.test.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts
printf 'feat(ledger): background re-key repair job; completion wakes the re-drive (#59)\n\nmaintenance:ledger-rekey is a manual job triggered once after\nscheduler.start(); it pages with a setImmediate between pages and arms\nthe lane wake when done. Boot is never blocked.\n' > $SCRATCH/msg-db-t5.txt
git add src/main/core/changes-maintenance.ts src/main/core/__tests__/ledger-rekey-job.test.ts
git commit -F $SCRATCH/msg-db-t5.txt -- src/main/core/changes-maintenance.ts src/main/core/boot.ts src/main/main.ts src/main/core/__tests__/ledger-rekey-job.test.ts src/main/core/__tests__/boot-lane.test.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts
```

---

### Task 6: `visualWaitingCount` counts current seqs only, once re-keyed

**Files:**
- Modify: `src/main/core/store/store.ts` (`visualWaitingCount`, ~line 502)
- Modify: `src/main/core/store/__tests__/visual-waiting-count.test.ts`

**Interfaces:**
- Consumes: `store.ledgerRekeyed()`, `store.ledgerRekeyPage()`.
- Produces: unchanged signature. Before the repair it counts the UNION (today's behaviour); after it, `VISUAL_WAITING_CURRENT_SQL` alone. Both SQL constants stay exported (ruling 5).

- [ ] **Step 1: Rewrite the spec-§7 case and add the new cases**

In `visual-waiting-count.test.ts`, replace the test `'a later skip change never hides an earlier deferred change (spec §7)'` with:

```ts
  it('pre-repair: a later skip change never hides an earlier deferred change (UNION plan)', async () => {
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`);
    await seed([file('E', IMG(20 * 1024))]);
    const first = await seqOf('E');
    await store.ledgerRecordMany(C, [
      { seq: first, attempts: 1, outcome: 'deferred' },
    ]);
    await seed([file('E', IMG(20 * 1024), { title: 'Renamed E' })]);
    const second = await seqOf('E');
    expect(second).toBeGreaterThan(first);
    await store.ledgerRecordMany(C, [
      { seq: second, attempts: 0, outcome: 'skip' },
    ]);
    expect(await store.visualWaitingCount(C)).toBe(1);
    // The repair turns it into (second, deferred): still exactly 1, now
    // counted by the current-only plan.
    while (!(await store.ledgerRekeyPage()).done) {
      // page until done
    }
    expect(await store.visualWaitingCount(C)).toBe(1);
  });

  it('re-keyed: the count runs the current-seq plan only (no changes join)', async () => {
    await seed([file('A', IMG(20 * 1024))]);
    const spy = jest.spyOn(db, 'all');
    await store.visualWaitingCount(C);
    const counts = spy.mock.calls
      .map(([sql]) => sql as string)
      .filter((sql) => /COUNT\(\*\)/.test(sql));
    expect(counts).toHaveLength(1);
    expect(counts[0]).not.toMatch(/\bJOIN changes\b/);
  });

  it('on fixtures without stale rows both plans give the same total', async () => {
    await seed([
      file('A', IMG(20 * 1024)),
      file('B', IMG(4 * 1024)),
      file('C', { conversion: { status: 'needs-ocr' } }),
      file('D', { ...IMG(20 * 1024), extraction: { engine: 'x' } }),
    ]);
    await store.ledgerRecordMany(C, [
      { seq: await seqOf('A'), attempts: 1, outcome: 'deferred' },
      { seq: await seqOf('C'), attempts: 3, outcome: 'failed' },
    ]);
    const current = await store.visualWaitingCount(C);
    // A second store on the same file, pre-repair view (flag not cached yet).
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`);
    const legacy = openStore(db, deps);
    expect(await legacy.visualWaitingCount(C)).toBe(current);
  });
```

Leave the two pinned-plan tests as they are: the deferred-branch query still runs before the repair (ruling 5).

- [ ] **Step 2: Run to verify the new cases fail**

Run: `npx jest src/main/core/store/__tests__/visual-waiting-count.test.ts --runInBand`
Expected: FAIL on `re-keyed: … current-seq plan only`, because the UNION still joins `changes`.

- [ ] **Step 3: Implement**

Replace `visualWaitingCount` in `store.ts`:

```ts
    async visualWaitingCount(consumer) {
      // #59 §0: once every deferred row is keyed on its document's current
      // seq, the deferred branch is a strict subset of the current one (a
      // stale deferred seq becomes a terminal skip). Until the re-key repair
      // finishes it stays, so the count never dips while the repair runs.
      const rekeyedNow = await store.ledgerRekeyed();
      const sql = (pinned: boolean) => {
        const strip = (q: string) =>
          pinned
            ? q
            : q
                .replace(' INDEXED BY docs_pending_visual', '')
                .replace(' INDEXED BY work_ledger_active', '');
        return rekeyedNow
          ? `SELECT COUNT(*) AS c FROM (${strip(VISUAL_WAITING_CURRENT_SQL)})`
          : `SELECT COUNT(*) AS c FROM (${strip(VISUAL_WAITING_CURRENT_SQL)} UNION ${strip(VISUAL_WAITING_DEFERRED_SQL)})`;
      };
      const params = rekeyedNow ? [consumer] : [consumer, consumer];
      try {
        return ((await db.all(sql(true), params))[0] as { c: number }).c;
      } catch {
        return ((await db.all(sql(false), params))[0] as { c: number }).c;
      }
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/main/core/store/__tests__/visual-waiting-count.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/store.ts src/main/core/store/__tests__/visual-waiting-count.test.ts
printf 'perf(store): visualWaitingCount drops the deferred branch once the ledger is re-keyed (#59)\n\nThe UNION with the changes join stays until meta.ledgerRekeyed, so the\ncount has no transient undercount during the repair.\n' > $SCRATCH/msg-db-t6.txt
git commit -F $SCRATCH/msg-db-t6.txt -- src/main/core/store/store.ts src/main/core/store/__tests__/visual-waiting-count.test.ts
```

---

# Part 1: Account changes only when something visible changed (§1, #135)

### Task 7: `WriteTx.commit` reports `{seq, logged}`; the store nudges only when logged

This hunk is separate from the sync workstream's consumers-upsert `if`. It touches `appendChange`, the returned `commit` wrapper and `store.commit` only.

**Files:**
- Modify: `src/main/core/store/write-tx.ts` (`appendChange` ~line 232; `WriteTx.commit` type; returned `commit` ~line 1028)
- Modify: `src/main/core/store/store.ts` (`commit`, ~line 550)
- Modify: `src/main/db/__tests__/db-worker.test.ts` (the `proc('commit')` round-trip expects the object)
- Create: `src/main/core/store/__tests__/commit-logged.test.ts`

**Interfaces:**
- Produces: `export interface CommitResult { seq: Seq; logged: boolean }`, `WriteTx.commit(batch: CommitBatch): CommitResult`, and the worker procedure `commit` returns `CommitResult`. `Store.commit` still returns `Promise<Seq>` (ruling 8).

- [ ] **Step 1: Write the failing tests**

`src/main/core/store/__tests__/commit-logged.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';
import { createWriteTx } from '../write-tx';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});
const settle = () =>
  new Promise((r) => {
    setTimeout(r, 30);
  });

describe('commit reports whether it logged (#135)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-logged-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('WriteTx.commit returns {seq, logged} per batch kind', () => {
    const tx = createWriteTx(db._conn!, {
      detectLanguages: () => ['eng'],
      now: () => new Date().toISOString(),
    });
    const r = tx.commit({ account: accountId, documents: [doc('a')], cursor: 1 });
    expect(r.logged).toBe(true);
    expect(r.seq).toBeGreaterThan(0);
    expect(tx.commit({ consumer: 'worker:t:v1', cursor: r.seq }).logged).toBe(
      false,
    );
    expect(
      tx.commit({ purgeArchived: { before: '2000-01-01T00:00:00Z' } }).logged,
    ).toBe(false);
  });

  it('a parked feed is not woken by a cursor-only consumer commit, and is by a document commit', async () => {
    const it = store.feed(await store.headSeq())[Symbol.asyncIterator]();
    const next = it.next();
    await settle(); // the feed read once and parked on the nudge
    const spy = jest.spyOn(db, 'all');
    const feedReads = () =>
      spy.mock.calls.filter(([sql]) =>
        /FROM changes WHERE seq > \?/.test(sql as string),
      ).length;

    await store.commit({ consumer: 'worker:t:v1', cursor: 1 });
    await settle();
    expect(feedReads()).toBe(0);

    await store.commit({ account: accountId, documents: [doc('a')], cursor: 1 });
    const r = await next;
    expect(r.done).toBe(false);
    expect(feedReads()).toBeGreaterThan(0);
    await it.return?.();
  });
});
```

In `src/main/db/__tests__/db-worker.test.ts`, in `'runs the relocated commit procedure inside the worker (proc round-trip)'`, replace

```ts
    const seq = await client!.proc!('commit', {
```

and its two following assertions (`expect(typeof seq).toBe('number'); expect(seq as number).toBeGreaterThan(0);`) with:

```ts
    const result = (await client!.proc!('commit', {
```

keeping the batch literal, closing with `})) as { seq: number; logged: boolean };`, then:

```ts
    expect(result.logged).toBe(true);
    expect(result.seq).toBeGreaterThan(0);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/store/__tests__/commit-logged.test.ts --runInBand`
Expected: FAIL. `r.logged` is undefined, and the cursor-only commit wakes the feed.

- [ ] **Step 3: Implement in `write-tx.ts`**

Add above `export interface WriteTx`:

```ts
/** What one commit did. `logged`: the transaction appended at least one
 *  `changes` row (documents, archives, account, purge, accountRemoved). The
 *  store wakes feeds only then (#135). */
export interface CommitResult {
  seq: Seq;
  logged: boolean;
}
```

In `WriteTx`, change `commit(batch: CommitBatch): Seq;` to:

```ts
  commit(batch: CommitBatch): CommitResult;
```

Replace `appendChange`:

```ts
  // Rows appended by the commit in flight; reset by `commit` below (#135).
  let appended = 0;
  const appendChange = (kind: Change['kind'], refId: string): Seq => {
    const r = conn
      .prepare(`INSERT INTO changes(kind, ref_id, at) VALUES(?, ?, ?)`)
      .run(kind, refId, deps.now());
    appended += 1;
    return Number(r.lastInsertRowid);
  };
```

In the returned object, replace `commit: (batch: CommitBatch): Seq => commitTx(batch),` with:

```ts
    commit: (batch: CommitBatch): CommitResult => {
      appended = 0;
      const seq = commitTx(batch);
      return { seq, logged: appended > 0 };
    },
```

(`commitTx` itself is unchanged; the sync workstream's guarded upsert inside it is untouched.)

- [ ] **Step 4: Implement in `store.ts`**

Extend the `./write-tx` import with `type CommitResult`. Replace `commit`:

```ts
    async commit(batch) {
      const { seq, logged } = writeTx
        ? writeTx.commit(batch)
        : ((await db.proc!('commit', batch)) as CommitResult);
      // #135: wake feeds only when the commit appended a change row. A
      // cursor-only consumer commit, or an account commit inside its sync
      // tick, has nothing for a feed to read.
      if (logged) {
        corpus.invalidateLanguages();
        nudge.emit('commit');
      }
      // The cascade runs entirely in SQL (schema.ts:561's ON DELETE CASCADE)
      // and never calls outbox.ts, so it can't fire onChange itself — and
      // whether it actually took outbox rows with it isn't observable from
      // `seq` alone. Fire unconditionally: an extra "may have changed" signal
      // is harmless (consumers re-read list/count), a missed one is not.
      if ('removeAccount' in batch) outboxChanged.emit('change');
      return seq;
    },
```

- [ ] **Step 5: Run to verify they pass, then the commit neighbours**

Run: `npx jest src/main/core/store/__tests__/commit-logged.test.ts src/main/core/store/__tests__/write-tx.test.ts src/main/core/store/__tests__/store.test.ts src/main/db/__tests__/db-worker.test.ts --runInBand`
Expected: PASS. Run `grep -rn "createWriteTx(" src --include='*.test.ts'`. Any test that used `writeTx.commit(...)`'s return as a number now reads `.seq`; update those.

- [ ] **Step 6: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/write-tx.ts src/main/core/store/store.ts src/main/core/store/__tests__/commit-logged.test.ts src/main/db/__tests__/db-worker.test.ts
printf 'perf(store): commit reports {seq, logged}; feeds wake only on logged commits (#135)\n\nA cursor-only consumer commit appends nothing and no longer wakes every\nfeed. Store.commit still returns the seq.\n' > $SCRATCH/msg-db-t7.txt
git add src/main/core/store/__tests__/commit-logged.test.ts
git commit -F $SCRATCH/msg-db-t7.txt -- src/main/core/store/write-tx.ts src/main/core/store/store.ts src/main/core/store/__tests__/commit-logged.test.ts src/main/db/__tests__/db-worker.test.ts
```

---

### Task 8: Account commits publish on visible changes, sync progress once per minute

This task changes the account branch at the tail of `commitTx` and adds the last-published map in the `createWriteTx` closure. That map is marked by `markPublished(accountId, at)` in the same JS turn, immediately after a **synchronous** account-publishing transaction returns, and only if it appended an `account` change. A rollback throws before the mark, and with no `await` in between no other call can interleave. There is no trigger, no pending map and no depth counter (coordinator ruling, round 3). To make every publication path such a synchronous transaction on the writer connection, `store.ts`'s five `db.batch` account writers move into one WriteTx method, `accountWrite`.

**Files:**
- Modify: `src/main/core/store/write-tx.ts` (`AccountWriteOp`/`AccountWriteResult`, `accountWrite`, `publishing`, the map, the account branch)
- Modify: `src/main/core/store/store.ts` (the five account writers call `accountWrite`)
- Modify: `src/main/db/worker-entry.ts` (proc `accountWrite`)
- Create: `src/main/core/store/__tests__/account-change-coalescing.test.ts`

**Interfaces:**
- Produces: `export const ACCOUNT_SYNC_TICK_MS = 60_000;`, `export type AccountWriteOp`, `export interface AccountWriteResult { id: AccountId; logged: boolean }` and `WriteTx.accountWrite(op: AccountWriteOp): AccountWriteResult`, plus the worker proc `accountWrite` (all in write-tx.ts / worker-entry.ts).

- [ ] **Step 1: Write the failing tests**

`src/main/core/store/__tests__/account-change-coalescing.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, Change, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});
const settle = () =>
  new Promise((r) => {
    setTimeout(r, 30);
  });

describe('account change coalescing (#135)', () => {
  let dir: string;
  let file: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let clock = Date.parse('2026-10-09T10:00:00.000Z');
  const deps = {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
    now: () => new Date(clock).toISOString(),
  };
  const at = (sec: number) => {
    clock = Date.parse('2026-10-09T10:00:00.000Z') + sec * 1000;
  };

  beforeEach(async () => {
    at(0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-acc-'));
    file = path.join(dir, 'test.db');
    db = await openDb(file);
    store = openStore(db, deps);
    // Created two minutes earlier: createAccount's own row also moves the
    // last-published time, so the first commit at t = 0 is due.
    at(-120);
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
    at(0);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const accountRows = async () =>
    (
      (await db.all(
        `SELECT COUNT(*) AS c FROM changes WHERE kind = 'account' AND ref_id = ?`,
        [accountId],
      )) as Array<{ c: number }>
    )[0].c;
  const commitAt = (sec: number, extra: Record<string, unknown> = {}) => {
    at(sec);
    return store.commit({
      account: accountId,
      documents: [],
      cursor: sec,
      ...extra,
    } as never);
  };

  it('the first commit publishes; an unchanged commit inside the tick appends nothing and wakes no feed', async () => {
    await commitAt(0);
    const before = await accountRows();
    const it = store.feed(await store.headSeq())[Symbol.asyncIterator]();
    const next = it.next();
    await settle();
    const spy = jest.spyOn(db, 'all');
    await commitAt(10);
    await settle();
    expect(await accountRows()).toBe(before);
    expect(
      spy.mock.calls.filter(([sql]) => /FROM changes WHERE seq > \?/.test(sql as string)),
    ).toHaveLength(0);
    // The row itself still moved.
    expect((await store.account(accountId))?.cursor).toBe(10);
    await store.commit({ account: accountId, documents: [doc('wake')], cursor: 11 });
    await next;
    await it.return?.();
  });

  it('a doc-only commit inside the tick logs its document, not an account row', async () => {
    await commitAt(0);
    const before = await accountRows();
    at(10);
    await store.commit({ account: accountId, documents: [doc('a')], cursor: 10 });
    expect(await accountRows()).toBe(before);
    expect(
      await db.all(`SELECT COUNT(*) AS c FROM changes WHERE kind = 'document'`),
    ).toEqual([{ c: 1 }]);
  });

  it('a status change and a last_error change publish at once; a no-op scoped clear does not', async () => {
    await commitAt(0, { status: 'live' });
    const base = await accountRows();
    await commitAt(5, { status: 'backfilling' });
    expect(await accountRows()).toBe(base + 1);
    await commitAt(10, { error: 'boom' });
    expect(await accountRows()).toBe(base + 2);
    // 'boom' is not a reconcile error: a reconcile-scoped clear keeps it.
    await commitAt(15, { error: null, errorScope: 'reconcile' });
    expect(await accountRows()).toBe(base + 2);
    await commitAt(20, { error: null });
    expect(await accountRows()).toBe(base + 3);
    expect((await store.account(accountId))?.lastError ?? null).toBeNull();
  });

  it('continuous commits every 10 s publish exactly once per 60 s', async () => {
    const before = await accountRows();
    for (let s = 0; s <= 180; s += 10) {
      // eslint-disable-next-line no-await-in-loop
      await commitAt(s, { progress: { done: s } });
    }
    // t = 0, 60, 120, 180
    expect((await accountRows()) - before).toBe(4);
  });

  it('a feed sees the latest progress within 60 s of continuous commits', async () => {
    await commitAt(0, { progress: { done: 0 } });
    const it = store.feed(await store.headSeq())[Symbol.asyncIterator]();
    const next = it.next();
    for (let s = 10; s <= 60; s += 10) {
      // eslint-disable-next-line no-await-in-loop
      await commitAt(s, { progress: { done: s } });
    }
    const r = await next;
    const acc = (r.value as Change[]).find(
      (c): c is Extract<Change, { kind: 'account' }> => c.kind === 'account',
    );
    expect(acc?.account.progress?.done).toBe(60);
    await it.return?.();
  });

  it('the first qualifying commit after a DB-worker restart publishes, without a changes lookup', async () => {
    await commitAt(0);
    await store.close();
    db = await openDb(file); // a fresh writer connection = fresh map
    store = openStore(db, deps);
    const before = await accountRows(); // measured OUTSIDE the spy window
    const prepare = jest.spyOn(db._conn!, 'prepare');
    await commitAt(10);
    const seen = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore(); // the window is exactly the commit
    expect(seen.filter((sql) => /FROM changes\s+WHERE/i.test(sql))).toEqual([]);
    expect(await accountRows()).toBe(before + 1);
  });

  it('status and config publications from store.ts move the tick, interleaved with commits', async () => {
    await commitAt(0); // publishes (t = 0)
    const base = await accountRows();
    at(55);
    await store.setAccountConfig(accountId, { scoped: 1 });
    expect(await accountRows()).toBe(base + 1);
    await commitAt(60, { progress: { done: 1 } }); // 5 s after the config row
    expect(await accountRows()).toBe(base + 1);
    await commitAt(115, { progress: { done: 2 } }); // 60 s after it
    expect(await accountRows()).toBe(base + 2);
    at(150);
    await store.setAccountStatus(accountId, { status: 'backfilling' });
    expect(await accountRows()).toBe(base + 3);
    await commitAt(175, { progress: { done: 3 } }); // 25 s after the status row
    expect(await accountRows()).toBe(base + 3);
    await commitAt(210, { progress: { done: 4 } });
    expect(await accountRows()).toBe(base + 4);
  });

  // ── the write-tx.test.ts folder-scope failure fixture ───────────────────
  // Two docs under root X; `armScopeFailure` aborts the SECOND archive,
  // AFTER applyFolderScope already appended its `account` change in the same
  // transaction.
  const SCOPED_CURSOR = { page_token: 'p1', backfill_done: true, scope_roots: ['root', 'X'] };
  const scopedAccount = async (): Promise<AccountId> => {
    at(-120);
    const id = (
      await store.createAccount({
        source: 'google-docs',
        identifier: 'scoped@example.com',
        config: {
          folderRoots: [
            { id: 'root', name: 'My Drive' },
            { id: 'X', name: 'Reports' },
          ],
        },
      })
    ).id;
    const fileDoc = (externalId: string): DocumentInput => ({
      ...doc(externalId),
      type: 'file',
      scopeRootId: 'X',
    });
    at(0);
    await store.commit({
      account: id,
      documents: [fileDoc('b'), fileDoc('c')],
      cursor: SCOPED_CURSOR,
    }); // publishes at t = 0
    return id;
  };
  const scopedRows = async (id: AccountId) =>
    (
      (await db.all(
        `SELECT COUNT(*) AS c FROM changes WHERE kind = 'account' AND ref_id = ?`,
        [id],
      )) as Array<{ c: number }>
    )[0].c;
  const armScopeFailure = () =>
    db._conn!.exec(
      `CREATE TRIGGER folder_scope_boom
         BEFORE UPDATE OF archived_at ON documents
         WHEN (SELECT COUNT(*) FROM documents
                WHERE account_id = NEW.account_id
                  AND archived_at IS NOT NULL) >= 1
         BEGIN SELECT RAISE(ABORT, 'forced-archive-failure'); END`,
    );
  const failingScope = async (id: AccountId) =>
    store
      .applyFolderScope({
        accountId: id,
        config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
        cursor: { page_token: 'p2', backfill_done: false, scope_roots: ['root'] },
        archiveScopeRootIds: ['X'],
        reattributeScopeRoots: [],
        archiveRefs: [],
        expectedConfigJson: JSON.stringify((await store.account(id))!.config),
      })
      .then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
  const progressAt = (id: AccountId, sec: number) => {
    at(sec);
    return store.commit({
      account: id,
      documents: [],
      cursor: SCOPED_CURSOR,
      progress: { done: sec },
    } as never);
  };
  /** After a rolled-back append at t = 55 the deadline is still t = 60
   *  (from the t = 0 publication), not 115. */
  const expectDeadlineSixty = async (id: AccountId, base: number) => {
    expect(await scopedRows(id)).toBe(base); // rolled back
    await progressAt(id, 50);
    expect(await scopedRows(id)).toBe(base);
    await progressAt(id, 60);
    expect(await scopedRows(id)).toBe(base + 1);
  };

  it('a rolled-back account append (failed applyFolderScope) keeps the original deadline', async () => {
    const id = await scopedAccount();
    const base = await scopedRows(id);
    armScopeFailure();
    at(55);
    expect((await failingScope(id))?.message).toMatch(/forced-archive-failure/);
    db._conn!.exec(`DROP TRIGGER folder_scope_boom`);
    await expectDeadlineSixty(id, base);
  });

  it('a read in flight while a write fails and rolls back does not publish the failed append', async () => {
    const id = await scopedAccount();
    const base = await scopedRows(id);
    armScopeFailure();
    at(55);
    // 1. Everything the scope call needs is read BEFORE the competing read.
    const expectedConfigJson = JSON.stringify((await store.account(id))!.config);
    // Hold the in-process AppDb queue so the competing read is GUARANTEED
    // to stay pending across the transaction (no reliance on microtask order).
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = db.withExclusive!(() => gate);
    let readSettled = false;
    const read = db.all(`SELECT COUNT(*) AS c FROM documents`).then((rows) => {
      readSettled = true;
      return rows;
    });
    // 2. Next microtask, no await in between: the in-process applyFolderScope
    //    runs its synchronous transaction inside the call, which throws
    //    (rolls back) before the call returns its rejected promise.
    let pendingAtThrow: boolean | null = null;
    const failed = Promise.resolve().then(() => {
      const p = store.applyFolderScope({
        accountId: id,
        config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
        cursor: { page_token: 'p2', backfill_done: false, scope_roots: ['root'] },
        archiveScopeRootIds: ['X'],
        reattributeScopeRoots: [],
        archiveRefs: [],
        expectedConfigJson,
      });
      pendingAtThrow = !readSettled; // the transaction has already thrown here
      return p.then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
    });
    const err = await failed;
    // 3. The competing read was still pending when the transaction threw.
    expect(err?.message).toMatch(/forced-archive-failure/);
    expect(pendingAtThrow).toBe(true);
    expect(readSettled).toBe(false);
    release();
    await held;
    await read;
    expect(readSettled).toBe(true);
    db._conn!.exec(`DROP TRIGGER folder_scope_boom`);
    await expectDeadlineSixty(id, base);
  });

  // Every account-publication path must mark: if one stops, the t = 60
  // commit (5 s after that writer's row) publishes again and its case fails.
  // (commitTx itself is pinned by the tick tests above.)
  it.each([
    ['createAccount', async () => (await store.createAccount({ source: 'test', identifier: 'fresh' })).id],
    ['getOrCreateAccount (create)', async () => (await store.getOrCreateAccount('test', 'fresh2')).id],
    ['setAccountCadence', async () => {
      await store.setAccountCadence(accountId, { every: '15m' });
      return accountId;
    }],
    ['setAccountConfig', async () => {
      await store.setAccountConfig(accountId, { marks: 1 });
      return accountId;
    }],
    ['setAccountStatus', async () => {
      await store.setAccountStatus(accountId, { status: 'backfilling' });
      return accountId;
    }],
    ['applyFolderScope', async () => {
      const id = await scopedAccount();
      at(55);
      const r = await store.applyFolderScope({
        accountId: id,
        config: { folderRoots: [{ id: 'root', name: 'My Drive' }, { id: 'X', name: 'Reports' }], marks: 1 },
        cursor: SCOPED_CURSOR,
        archiveScopeRootIds: [],
        reattributeScopeRoots: [],
        archiveRefs: [],
        expectedConfigJson: JSON.stringify((await store.account(id))!.config),
      });
      expect(r.stale).toBe(false);
      return id;
    }],
  ] as Array<[string, () => Promise<AccountId>]>)(
    'marks: %s publishing at t = 55 holds the next progress row until t >= 115',
    async (_name, write) => {
      await commitAt(0); // accountId published at t = 0
      at(55);
      const id = await write();
      const afterWrite = await scopedRows(id);
      await progressAt(id, 60); // 5 s after the writer's own row
      expect(await scopedRows(id)).toBe(afterWrite);
      await progressAt(id, 115);
      expect(await scopedRows(id)).toBe(afterWrite + 1);
    },
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/store/__tests__/account-change-coalescing.test.ts --runInBand`
Expected: FAIL. Every commit appends an account row, so the counts are too high.

- [ ] **Step 3: Implement**

In `write-tx.ts`, add near the top-level constants (after `contentHash`):

```ts
/** #135: a sync-progress-only `account` change (progress / last_sync_at,
 *  which moves on every commit) is published at most once per this window
 *  per account. Status and last_error changes publish at once. */
export const ACCOUNT_SYNC_TICK_MS = 60_000;
```

**Account publication paths.** Every `account` change is appended by a **synchronous** better-sqlite3 transaction, so the last-published map is marked in the same JS turn as the COMMIT. A rollback throws before the mark, and nothing can interleave without an `await`. That only holds if the transaction runs where the map lives (the writer connection's `createWriteTx`), so this task moves `store.ts`'s five `db.batch` account writers into one WriteTx method, `accountWrite`. In-process it is called directly; in the worker it is the proc `accountWrite`. Each op keeps today's SQL and semantics (Task 9 then makes cadence and config conditional). The full list of publication paths is:
- `commitTx` (account branch);
- `applyFolderScope`;
- `accountWrite` ops `create` (`createAccount`), `getOrCreate` (`getOrCreateAccount`), `cadence`, `config` and `status`.

The `accountRemoved` change (`core-maintenance.ts` reset, `removeAccount`) is a different kind and needs no mark.

Add above `export interface WriteTx`:

```ts
/** #135: the store's account writers, run as ONE synchronous transaction on
 *  the writer connection so the last-published mark lands in the same JS
 *  turn as the COMMIT. */
export type AccountWriteOp =
  | {
      op: 'create';
      source: string;
      identifier: string;
      config?: Record<string, unknown>;
      status?: SyncStatus;
      cadence?: Cadence;
    }
  | { op: 'getOrCreate'; source: string; identifier: string }
  | { op: 'cadence'; id: AccountId; cadence: Cadence | null }
  | { op: 'config'; id: AccountId; config: Record<string, unknown> }
  | {
      op: 'status';
      id: AccountId;
      status?: SyncStatus;
      error?: string | null;
      errorScope?: ErrorScope;
    };

/** `logged`: the transaction appended an `account` change. */
export interface AccountWriteResult {
  id: AccountId;
  logged: boolean;
}
```

Add `accountWrite(op: AccountWriteOp): AccountWriteResult;` to `WriteTx`. Extend the `@shared/contracts` type import with `Cadence`, `ErrorScope` and `SyncStatus` if they are missing.

Replace the Task 7 `appendChange` block with:

```ts
  // #135: when each account's last `account` change COMMITTED (ms on the
  // deps.now() clock). In memory on purpose: `changes` has no (kind, ref_id)
  // index, so asking it would scan the whole log. A missing entry (cold
  // start, DB-worker respawn) reads as "long ago".
  const accountPublishedAt = new Map<string, number>();
  const markPublished = (accountId: string, at: string): void => {
    accountPublishedAt.set(accountId, Date.parse(at));
  };
  // `account` appends of the transaction in flight; marked only after it
  // returned (see `publishing`).
  const accountAppends: Array<[string, string]> = [];
  // Rows appended by the commit in flight; reset by `commit` below (#135).
  let appended = 0;
  const appendChange = (kind: Change['kind'], refId: string): Seq => {
    const at = deps.now();
    const r = conn
      .prepare(`INSERT INTO changes(kind, ref_id, at) VALUES(?, ?, ?)`)
      .run(kind, refId, at);
    appended += 1;
    if (kind === 'account') accountAppends.push([refId, at]);
    return Number(r.lastInsertRowid);
  };
  /** Wrap a SYNCHRONOUS transaction function: mark what it appended right
   *  after it returned, in the same JS turn as its COMMIT. A rollback throws
   *  first, so nothing is marked; with no await in between, no other call
   *  can interleave. */
  const publishing =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      accountAppends.length = 0;
      try {
        const r = fn(...args);
        for (const [id, at] of accountAppends) markPublished(id, at);
        return r;
      } finally {
        accountAppends.length = 0;
      }
    };
```

Add the transaction next to `commitTx`:

```ts
  // #135: the store's account writers (formerly db.batch in store.ts). Same
  // SQL as before; `appendChange` records the account append for `publishing`.
  const accountWriteTx = conn.transaction(
    (w: AccountWriteOp): AccountWriteResult => {
      switch (w.op) {
        case 'create': {
          const row = conn
            .prepare(
              `INSERT INTO accounts(id, source, identifier, config, status, cadence, created_at)
               VALUES(?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(source, identifier) DO UPDATE SET
                 config = excluded.config,
                 status = excluded.status
               RETURNING id`,
            )
            .get(
              newId<'account'>(),
              w.source,
              w.identifier,
              JSON.stringify(w.config ?? {}),
              w.status ?? 'connecting',
              w.cadence ? JSON.stringify(w.cadence) : null,
              deps.now(),
            ) as { id: AccountId };
          appendChange('account', row.id);
          return { id: row.id, logged: true };
        }
        case 'getOrCreate': {
          const found = conn
            .prepare(`SELECT id FROM accounts WHERE source = ? AND identifier = ?`)
            .get(w.source, w.identifier) as { id: AccountId } | undefined;
          if (found) return { id: found.id, logged: false };
          const id = newId<'account'>();
          conn
            .prepare(
              `INSERT INTO accounts(id, source, identifier, config, status, created_at)
               VALUES(?, ?, ?, '{}', 'live', ?)`,
            )
            .run(id, w.source, w.identifier, deps.now());
          appendChange('account', id);
          return { id, logged: true };
        }
        case 'cadence': {
          conn
            .prepare(`UPDATE accounts SET cadence = ? WHERE id = ?`)
            .run(w.cadence ? JSON.stringify(w.cadence) : null, w.id);
          appendChange('account', w.id);
          return { id: w.id, logged: true };
        }
        case 'config': {
          conn
            .prepare(`UPDATE accounts SET config = ? WHERE id = ?`)
            .run(JSON.stringify(w.config), w.id);
          appendChange('account', w.id);
          return { id: w.id, logged: true };
        }
        case 'status': {
          // Write and log only when status or last_error actually differs
          // (unchanged semantics of the former setAccountStatus batch).
          const lastError = lastErrorAssignment(w.error, w.errorScope);
          const status = w.status ?? null;
          const r = conn
            .prepare(
              `UPDATE accounts SET status = COALESCE(?, status),
                 ${lastError.sql}
               WHERE id = ?
                 AND (COALESCE(?, status) IS NOT status
                   OR (${lastError.expr}) IS NOT last_error)`,
            )
            .run(status, ...lastError.params, w.id, status, ...lastError.params);
          if (r.changes === 0) return { id: w.id, logged: false };
          appendChange('account', w.id);
          return { id: w.id, logged: true };
        }
        default:
          throw new Error(`unknown account write: ${String((w as { op: unknown }).op)}`);
      }
    },
  );
```

In the returned object, wrap the three publication paths with `publishing`:
- Task 7's `commit:` member becomes `commit: publishing((batch: CommitBatch): CommitResult => { appended = 0; const seq = commitTx(batch); return { seq, logged: appended > 0 }; }),`;
- the `applyFolderScope` member's function is wrapped the same way: `applyFolderScope: publishing(<existing function>),`;
- add `accountWrite: publishing((w: AccountWriteOp) => accountWriteTx(w)),`.

No other member appends an `account` change.

In `src/main/db/worker-entry.ts`, register the proc next to `commit`:

```ts
        accountWrite: (args) => writeTx.accountWrite(args as AccountWriteOp),
```

(import `type AccountWriteOp` from `@main/core/store/write-tx`).

In `store.ts`, extend the `./write-tx` import with `type AccountWriteOp, type AccountWriteResult`. Add a helper after `writeTx`:

```ts
  // #135: account writers run on the writer connection (see write-tx.ts
  // accountWrite) so the last-published mark is taken with the COMMIT.
  const accountWrite = async (w: AccountWriteOp): Promise<AccountWriteResult> =>
    writeTx
      ? writeTx.accountWrite(w)
      : ((await db.proc!('accountWrite', w)) as AccountWriteResult);
```

Replace the bodies of the five writers (same nudges as today; Task 9 narrows them):

```ts
    async createAccount(a) {
      const { id } = await accountWrite({ op: 'create', ...a });
      nudge.emit('commit');
      return toAccount((await getAccountRow(id))!);
    },

    async getOrCreateAccount(source, identifier) {
      const { id } = await accountWrite({ op: 'getOrCreate', source, identifier });
      nudge.emit('commit');
      return toAccount((await getAccountRow(id))!);
    },
```

```ts
    async setAccountCadence(id, cadence) {
      await accountWrite({ op: 'cadence', id, cadence });
      nudge.emit('commit');
    },

    async setAccountConfig(id, config) {
      await accountWrite({ op: 'config', id, config });
      nudge.emit('commit');
    },

    async setAccountStatus(id, patch) {
      const { logged } = await accountWrite({ op: 'status', id, ...patch });
      if (logged) nudge.emit('commit');
    },
```

Keep the existing doc comments above each method.

In the account branch of `commitTx`, replace from `last = appendChange('account', acc.id);` through `return last;` (the final statements of the transaction body) with:

```ts
    const lastError = lastErrorAssignment(batch.error, batch.errorScope);
    // #135: append an `account` change only when a feed reader can see
    // something new — status or last_error at once; sync progress (progress
    // and last_sync_at, which moves on every commit) at most once per
    // ACCOUNT_SYNC_TICK_MS. The account row itself is written below on every
    // commit. (This variant carries no config: config publishes through
    // setAccountConfig / applyFolderScope.)
    const nextError = (
      conn
        .prepare(`SELECT ${lastError.expr} AS e FROM accounts WHERE id = ?`)
        .get(...lastError.params, acc.id) as { e: string | null }
    ).e;
    const visible =
      (batch.status !== undefined && batch.status !== acc.status) ||
      nextError !== acc.last_error;
    const ts = deps.now();
    const publishedAt = accountPublishedAt.get(acc.id);
    const tickDue =
      publishedAt === undefined ||
      Date.parse(ts) - publishedAt >= ACCOUNT_SYNC_TICK_MS;
    if (visible || tickDue) last = appendChange('account', acc.id);
    conn
      .prepare(
        `UPDATE accounts SET cursor = ?, status = COALESCE(?, status),
         progress = COALESCE(?, progress),
         ${lastError.sql},
         last_sync_at = ?
       WHERE id = ?`,
      )
      .run(
        JSON.stringify(batch.cursor ?? null),
        batch.status ?? null,
        batch.progress ? JSON.stringify(batch.progress) : null,
        ...lastError.params,
        ts,
        acc.id,
      );
    return last;
```

- [ ] **Step 4: Run to verify they pass, then the account neighbours**

Run: `npx jest src/main/core/store/__tests__/account-change-coalescing.test.ts --runInBand`
Expected: PASS. If a `marks` case fails, that writer's transaction is not wrapped by `publishing`, or no longer appends through `appendChange`. If a rollback test publishes only at 115, a failed transaction was marked.

Run: `npx jest src/main/core/store/__tests__/store.test.ts src/main/core/store/__tests__/write-tx.test.ts src/main/core/engine/__tests__/account-flows.test.ts src/main/core/engine/__tests__/engine.test.ts src/main/core/__tests__/app-projection-store.test.ts src/main/core/__tests__/app-projection.test.ts --runInBand`
Expected: PASS. An assertion that counted one `account` change per commit within a minute on a frozen clock pinned the old flood. Update it to the coalesced count, and quote it in the commit message.

- [ ] **Step 5: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/write-tx.ts src/main/core/store/store.ts src/main/db/worker-entry.ts src/main/core/store/__tests__/account-change-coalescing.test.ts
printf 'perf(store): account commits publish status/error at once, sync progress once a minute (#135)\n\nDecided in JS from the loaded row; the last-published time is an\nin-memory map marked right after each synchronous account-publishing\ntransaction returns (commitTx, applyFolderScope, and the store account\nwriters, now one WriteTx accountWrite proc); a rollback marks nothing; no\nlookup in changes. cursor, progress and last_sync_at are still written\non every commit.\n' > $SCRATCH/msg-db-t8.txt
git add src/main/core/store/__tests__/account-change-coalescing.test.ts
git commit -F $SCRATCH/msg-db-t8.txt -- src/main/core/store/write-tx.ts src/main/core/store/store.ts src/main/db/worker-entry.ts src/main/core/store/__tests__/account-change-coalescing.test.ts
```

(Add any neighbour test you updated to the path list.)

---

### Task 9: Cadence and config no-ops write nothing; `getOrCreateAccount` nudges only on create

**Files:**
- Modify: `src/main/core/store/write-tx.ts` (`accountWriteTx`'s `cadence` and `config` cases, from Task 8)
- Modify: `src/main/core/store/store.ts` (`getOrCreateAccount`, `setAccountCadence`, `setAccountConfig`: nudge only when logged)
- Test: `src/main/core/store/__tests__/account-change-coalescing.test.ts` (append a `describe`)

- [ ] **Step 1: Write the failing tests** (append at the end of the file)

```ts
describe('cadence, config and getOrCreateAccount log only real changes (#135)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  const deps = {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-acc2-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rows = async () =>
    (
      (await db.all(`SELECT COUNT(*) AS c FROM changes WHERE kind = 'account'`)) as Array<{
        c: number;
      }>
    )[0].c;

  it('setAccountCadence: a change logs once, the same value again logs nothing', async () => {
    const r0 = await rows();
    await store.setAccountCadence(accountId, { every: '15m' });
    expect(await rows()).toBe(r0 + 1);
    await store.setAccountCadence(accountId, { every: '15m' });
    expect(await rows()).toBe(r0 + 1);
    await store.setAccountCadence(accountId, null);
    await store.setAccountCadence(accountId, null);
    expect(await rows()).toBe(r0 + 2);
  });

  it('setAccountConfig: a change logs once, the same config again logs nothing', async () => {
    const r0 = await rows();
    await store.setAccountConfig(accountId, { a: 1 });
    await store.setAccountConfig(accountId, { a: 1 });
    expect(await rows()).toBe(r0 + 1);
    expect((await store.account(accountId))?.config).toEqual({ a: 1 });
  });

  it('getOrCreateAccount: found appends nothing and wakes no feed; created appends one', async () => {
    const r0 = await rows();
    const it = store.feed(await store.headSeq())[Symbol.asyncIterator]();
    const next = it.next();
    await settle();
    const spy = jest.spyOn(db, 'all');
    await store.getOrCreateAccount('test', 'me');
    await settle();
    expect(await rows()).toBe(r0);
    expect(
      spy.mock.calls.filter(([sql]) => /FROM changes WHERE seq > \?/.test(sql as string)),
    ).toHaveLength(0);
    await store.getOrCreateAccount('test', 'new');
    expect(await rows()).toBe(r0 + 1);
    await next;
    await it.return?.();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/store/__tests__/account-change-coalescing.test.ts --runInBand`
Expected: FAIL. The repeated cadence and config writes log, and the found branch wakes the feed.

- [ ] **Step 3: Implement**

In `write-tx.ts` `accountWriteTx` (Task 8), replace the `cadence` and `config` cases. The spec's "UPDATE … WHERE value differs, append only when it changed a row" idiom becomes, inside the synchronous transaction, the UPDATE's own `changes` count:

```ts
        case 'cadence': {
          // #135: log only when the stored value changes; the UPDATE has no
          // unconditional column, so `changes` is exact.
          const value = w.cadence ? JSON.stringify(w.cadence) : null;
          const r = conn
            .prepare(`UPDATE accounts SET cadence = ? WHERE id = ? AND cadence IS NOT ?`)
            .run(value, w.id, value);
          if (r.changes === 0) return { id: w.id, logged: false };
          appendChange('account', w.id);
          return { id: w.id, logged: true };
        }
        case 'config': {
          // #135: same idiom as cadence.
          const value = JSON.stringify(w.config);
          const r = conn
            .prepare(`UPDATE accounts SET config = ? WHERE id = ? AND config IS NOT ?`)
            .run(value, w.id, value);
          if (r.changes === 0) return { id: w.id, logged: false };
          appendChange('account', w.id);
          return { id: w.id, logged: true };
        }
```

In `store.ts`, nudge only when the write logged:

```ts
    async getOrCreateAccount(source, identifier) {
      const { id, logged } = await accountWrite({ op: 'getOrCreate', source, identifier });
      if (logged) nudge.emit('commit');
      return toAccount((await getAccountRow(id))!);
    },
```

```ts
    async setAccountCadence(id, cadence) {
      const { logged } = await accountWrite({ op: 'cadence', id, cadence });
      if (logged) nudge.emit('commit');
    },

    async setAccountConfig(id, config) {
      const { logged } = await accountWrite({ op: 'config', id, config });
      if (logged) nudge.emit('commit');
    },
```

(A no-op write appends nothing, so `publishing` marks nothing for it. That is correct, because nothing was published.)

- [ ] **Step 4: Run to verify they pass, then the neighbours**

Run: `npx jest src/main/core/store/__tests__/account-change-coalescing.test.ts src/main/core/store/__tests__/store.test.ts src/main/core/engine/__tests__/account-flows.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/write-tx.ts src/main/core/store/store.ts src/main/core/store/__tests__/account-change-coalescing.test.ts
printf 'perf(store): cadence/config no-ops write nothing; getOrCreateAccount nudges only on create (#135)\n' > $SCRATCH/msg-db-t9.txt
git commit -F $SCRATCH/msg-db-t9.txt -- src/main/core/store/write-tx.ts src/main/core/store/store.ts src/main/core/store/__tests__/account-change-coalescing.test.ts
```

---

# Part 2: A quiet idle database (§2, #139)

### Task 10: The `ledgerGen` generation counter

**Files:**
- Modify: `src/main/core/store/store.ts`
- Create: `src/main/core/store/__tests__/ledger-gen.test.ts`

**Interfaces:**
- Produces: `CoreStore.ledgerGen(): number` (sync, in memory) and `CoreStore.markLedgerChanged(): void`. The generation bumps on every `commit`, every feed nudge, every `ledgerRecord`/`ledgerRecordMany`/`ledgerRekeyPage` call, and `markLedgerChanged`. Tasks 13 and 14 add their own bumps (`sweepRetiredConsumers`, `beginSeed`, `endSeed`).

- [ ] **Step 1: Write the failing test**

`src/main/core/store/__tests__/ledger-gen.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});

describe('ledgerGen (#139)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-gen-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const moves = async (f: () => unknown) => {
    const g = store.ledgerGen();
    await f();
    return store.ledgerGen() > g;
  };

  it('every mutation source moves it; readers do not', async () => {
    expect(
      await moves(() =>
        store.commit({ account: accountId, documents: [doc('a')], cursor: 1 }),
      ),
    ).toBe(true);
    // A cursor-only consumer commit wakes no feed but moves `pending`.
    expect(await moves(() => store.commit({ consumer: 'worker:t:v1', cursor: 1 }))).toBe(
      true,
    );
    expect(await moves(() => store.ledgerRecord('worker:t:v1', 1, 0, 'done'))).toBe(
      true,
    );
    expect(
      await moves(() =>
        store.ledgerRecordMany('worker:t:v1', [
          { seq: 2, attempts: 0, outcome: 'skip' },
        ]),
      ),
    ).toBe(true);
    expect(await moves(() => store.markLedgerChanged())).toBe(true);
    expect(await moves(() => store.setAccountStatus(accountId, { status: 'paused' }))).toBe(
      true,
    );
    expect(await moves(() => store.setAccountStatus(accountId, { status: 'paused' }))).toBe(
      false,
    );
    expect(
      await moves(() => store.createAccount({ source: 'x', identifier: 'y' })),
    ).toBe(true);
    expect(await moves(() => store.ledgerRekeyPage())).toBe(true);
    expect(await moves(() => store.ledgerCountsAll(['worker:t:v1']))).toBe(false);
    expect(await moves(() => store.visualWaitingCount('worker:t:v1'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/ledger-gen.test.ts --runInBand`
Expected: FAIL, because `store.ledgerGen is not a function`.

- [ ] **Step 3: Implement**

Add to `CoreStore` (after `ledgerCountsAll`):

```ts
  /** #139: in-memory generation, bumped by every write that can move
   *  `ledgerCountsAll` or `visualWaitingCount` — commits (consumer cursors
   *  move `pending`), feed nudges, ledger and consumers writes. Synchronous:
   *  never a DB call. The 5 s count tick and the 60 s waiting count skip
   *  their queries while it has not moved. */
  ledgerGen(): number;
  /** Bump `ledgerGen` for a ledger write made outside the store's own
   *  methods (alpha-cent's `ledgerRetry` patch calls this). */
  markLedgerChanged(): void;
```

In `openStore`, next to `let rekeyed = false;`:

```ts
  // #139: see CoreStore.ledgerGen.
  let gen = 0;
  const bumpGen = (): void => {
    gen += 1;
  };
  /** Every feed nudge also moves the generation. */
  const emitCommit = (): void => {
    bumpGen();
    nudge.emit('commit');
  };
```

Then:
- in `commit`, add `bumpGen();` right after the `const { seq, logged } = …` statement (every commit), and change `nudge.emit('commit');` inside `if (logged)` to `emitCommit();`;
- in `createAccount`, `getOrCreateAccount` (create path), `setAccountCadence`, `setAccountConfig`, `setAccountStatus`, `reconcileArchive`, `applyFolderScope` and `maintenance.resetAll`, replace `nudge.emit('commit')` with `emitCommit()`. Leave `close()`'s `nudge.emit('commit')` unchanged (it releases iterators and is not a write);
- at the end of `ledgerRecord` (after the `db.run`) and of `ledgerRecordMany` (after the loop), add `bumpGen();`;
- in `ledgerRekeyPage`, add `bumpGen();` before `if (r.done) rekeyed = true;`;
- add the two methods (next to `ledgerCountsAll`):

```ts
    ledgerGen() {
      return gen;
    },

    markLedgerChanged() {
      bumpGen();
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/main/core/store/__tests__/ledger-gen.test.ts src/main/core/store/__tests__/store.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/store.ts src/main/core/store/__tests__/ledger-gen.test.ts
printf 'feat(store): in-memory ledgerGen generation counter (#139)\n\nBumped by every commit, feed nudge and ledger write; markLedgerChanged\nfor ledger writes made outside the store (the overlay ledgerRetry).\n' > $SCRATCH/msg-db-t10.txt
git add src/main/core/store/__tests__/ledger-gen.test.ts
git commit -F $SCRATCH/msg-db-t10.txt -- src/main/core/store/store.ts src/main/core/store/__tests__/ledger-gen.test.ts
```

---

### Task 11: Gate the 5 s count and the 60 s waiting count on the generation; idle acceptance

**Files:**
- Create: `src/main/core/processing-counter.ts`
- Modify: `src/main/core/processing-status.ts` (`ProcessingStatusDeps.gen`, `refreshWaiting`)
- Modify: `src/main/main.ts` (~lines 1071, 1297–1312, 1376)
- Create: `src/main/core/__tests__/processing-counter.test.ts`
- Modify: `src/main/core/__tests__/processing-status.test.ts`
- Create: `src/main/core/__tests__/idle-db.test.ts`

**Interfaces:**
- Consumes: `CoreStore.ledgerGen`, `CoreStore.ledgerCountsAll`.
- Produces: `createLedgerCounter(deps: { store: Pick<CoreStore, 'ledgerGen' | 'ledgerCountsAll'>; activeConsumers: () => string[] }): { count(): Promise<LedgerTotals>; countIfChanged(): Promise<LedgerTotals | null> }`, where `export type LedgerTotals = LedgerCounts & { pending: number }`. Also `ProcessingStatusDeps.gen?: () => number`.

- [ ] **Step 1: Write the failing unit tests**

`src/main/core/__tests__/processing-counter.test.ts`:

```ts
/** @jest-environment node */
import { createLedgerCounter, type LedgerTotals } from '../processing-counter';

const ZERO: LedgerTotals = { done: 0, skip: 0, failed: 0, deferred: 0, pending: 0 };

function harness() {
  let gen = 0;
  let active = ['worker:a:v1'];
  let gate: Promise<void> | null = null;
  let fail = false;
  const ledgerCountsAll = jest.fn(async () => {
    if (gate) await gate;
    if (fail) throw new Error('db down');
    return ZERO;
  });
  const counter = createLedgerCounter({
    store: { ledgerGen: () => gen, ledgerCountsAll },
    activeConsumers: () => active,
  });
  return {
    counter,
    ledgerCountsAll,
    bump: () => {
      gen += 1;
    },
    setActive: (a: string[]) => {
      active = a;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        gate = null;
        release();
      };
    },
    setFail: (f: boolean) => {
      fail = f;
    },
  };
}

describe('ledger counter (#139)', () => {
  it('counts once, then skips until the generation moves', async () => {
    const h = harness();
    expect(await h.counter.count()).toEqual(ZERO);
    expect(await h.counter.countIfChanged()).toBeNull();
    h.bump();
    expect(await h.counter.countIfChanged()).toEqual(ZERO);
    expect(h.ledgerCountsAll).toHaveBeenCalledTimes(2);
  });

  it('a write landing during an in-flight count is counted on the next tick', async () => {
    const h = harness();
    const release = h.hold();
    const first = h.counter.countIfChanged();
    h.bump(); // mutation while the query runs
    release();
    await first;
    expect(await h.counter.countIfChanged()).not.toBeNull();
    expect(await h.counter.countIfChanged()).toBeNull();
    expect(h.ledgerCountsAll).toHaveBeenCalledTimes(2);
  });

  it('a change in the active consumer set recounts', async () => {
    const h = harness();
    await h.counter.count();
    h.setActive(['worker:a:v1', 'worker:b:v1']);
    expect(await h.counter.countIfChanged()).not.toBeNull();
  });

  it('a failed count is retried on the next tick', async () => {
    const h = harness();
    h.setFail(true);
    await expect(h.counter.countIfChanged()).rejects.toThrow('db down');
    h.setFail(false);
    expect(await h.counter.countIfChanged()).toEqual(ZERO);
  });
});
```

Append to `src/main/core/__tests__/processing-status.test.ts`:

```ts
describe('waiting count gated on the ledger generation (#139)', () => {
  it('skips the 60 s count while the generation has not moved', async () => {
    let g = 7;
    const s = setup({ gen: () => g, waitingEveryMs: 60_000 });
    s.status.start();
    await flush();
    expect(s.countWaiting).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(180_000);
    await flush();
    expect(s.countWaiting).toHaveBeenCalledTimes(1);
    g += 1;
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(s.countWaiting).toHaveBeenCalledTimes(2);
    s.status.stop();
  });

  it('a failed count is retried even when the generation did not move', async () => {
    const g = 1;
    let calls = 0;
    const countWaiting = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('x');
      return 3;
    });
    const s = setup({ gen: () => g, countWaiting, waitingEveryMs: 60_000 });
    s.status.start();
    await flush();
    jest.advanceTimersByTime(60_000);
    await flush();
    expect(countWaiting).toHaveBeenCalledTimes(2);
    s.status.stop();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/__tests__/processing-counter.test.ts src/main/core/__tests__/processing-status.test.ts --runInBand`
Expected: FAIL. The module is missing, and the waiting count runs every interval.

- [ ] **Step 3: Implement `src/main/core/processing-counter.ts`**

```ts
/**
 * The processing panel's ledger totals, counted only when something that can
 * move them happened (#139). The 5 s publisher used to run ledgerCountsAll
 * (three statements, one an O(ledger) walk) on every tick, idle or not.
 */
import type { CoreStore, LedgerCounts } from './store/store';

export type LedgerTotals = LedgerCounts & { pending: number };

export function createLedgerCounter(deps: {
  store: Pick<CoreStore, 'ledgerGen' | 'ledgerCountsAll'>;
  activeConsumers: () => string[];
}): {
  /** Count now (boot's one-shot) and remember the generation it saw. */
  count(): Promise<LedgerTotals>;
  /** Count only if the generation or the active consumer set moved since
   *  the last successful count; null otherwise. */
  countIfChanged(): Promise<LedgerTotals | null>;
} {
  let lastKey: string | null = null;
  const keyNow = (): string =>
    `${deps.store.ledgerGen()}|${[...deps.activeConsumers()].sort().join(',')}`;
  const count = async (): Promise<LedgerTotals> => {
    // Read BEFORE the query: a write landing during it is counted next tick.
    const key = keyNow();
    const all = await deps.store.ledgerCountsAll(deps.activeConsumers());
    lastKey = key;
    return all;
  };
  return {
    count,
    async countIfChanged() {
      if (keyNow() === lastKey) return null;
      return count();
    },
  };
}
```

- [ ] **Step 4: Gate `refreshWaiting` in `processing-status.ts`**

Add to `ProcessingStatusDeps` (after `countWaiting`):

```ts
  /** #139: `CoreStore.ledgerGen`. When given, `refreshWaiting` skips the
   *  count while the generation has not moved since the last successful one. */
  gen?: () => number;
```

Replace `refreshWaiting` (keep the surrounding `let`s and add `lastWaitingGen` next to `lastWaiting`):

```ts
  let lastWaitingGen: number | null = null;

  const refreshWaiting = (): Promise<void> => {
    if (inFlight) return inFlight;
    // Read BEFORE the query: a write landing during it is counted next time.
    const gen = deps.gen?.() ?? null;
    if (gen !== null && gen === lastWaitingGen) return Promise.resolve();
    inFlight = deps
      .countWaiting()
      .then((n) => {
        lastWaitingGen = gen;
        if (n !== lastWaiting) {
          lastWaiting = n;
          deps.patch({ waiting: n });
        }
      })
      .catch((e) => deps.warn(`waiting count failed: ${String(e)}`))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
```

- [ ] **Step 5: Wire `main.ts`**

Import:

```ts
import { createLedgerCounter } from './core/processing-counter';
```

Replace

```ts
    const initialLedger = await p.store.ledgerCountsAll(
      p.engine.activeConsumers(),
    );
```

with

```ts
    // #139: the 5 s tick below counts only when the ledger generation (or
    // the active consumer set) moved; this boot read primes it.
    const ledgerCounter = createLedgerCounter({
      store: p.store,
      activeConsumers: () => p.engine.activeConsumers(),
    });
    const initialLedger = await ledgerCounter.count();
```

In `createProcessingStatus({ … })`, add after `countWaiting: …,`:

```ts
      gen: () => p.store.ledgerGen(),
```

In the 5 s `setInterval`, replace

```ts
        const all = await p.store.ledgerCountsAll(p.engine.activeConsumers());
```

with

```ts
        // #139: no ledger read at idle — only after something moved it.
        const all = await ledgerCounter.countIfChanged();
        if (!all) return;
```

(The projection's `processing()` callback keeps calling `ledgerCountsAll` directly. It runs only at projection init.)

- [ ] **Step 6: Write the idle acceptance test**

`src/main/core/__tests__/idle-db.test.ts`:

```ts
/** @jest-environment node */
/**
 * #139 acceptance: over 61 s of fake time with no mutations — after boot's
 * one-shots (the primed ledger count, processingStatus.start()'s first
 * waiting count, the scheduler's 2 s catch-up incl. the re-drive probe) —
 * nothing reads work_ledger or changes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../db/app-db';
import { createLedgerCounter } from '../processing-counter';
import { createProcessingStatus } from '../processing-status';
import { createScheduler } from '../scheduler';
import { ensureQueryIndexes } from '../store/schema';
import { openStore, type CoreStore } from '../store/store';

const C = 'worker:vision:v1';
const READERS = [
  'ledgerCountsAll',
  'ledgerCounts',
  'visualWaitingCount',
  'ledgerDeferred',
  'ledgerHasDeferred',
  'changesAt',
  'headSeq',
  'addedSince',
  'consumerCursor',
] as const;

describe('idle database (#139)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-idle-'));
    db = await openDb(path.join(dir, 'test.db'));
    ensureQueryIndexes(db._conn!);
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const account = await store.createAccount({ source: 'test', identifier: 'me' });
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'img',
          type: 'file',
          title: 'img.png',
          markdown: '',
          metadata: { mime: 'image/png', sizeBytes: 50_000 },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cursor: 1,
    });
    await store.commit({ consumer: C, cursor: await store.headSeq() });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('zero ledger/changes reads over 61 idle seconds after the boot one-shots', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const scheduler = createScheduler(
      store,
      () => ({
        onBattery: false,
        thermal: 'nominal',
        appFocus: 'hidden',
        userActive: false,
      }),
      { log: () => {} },
    );
    // The redrive cadence probe (workers/index.ts registerRedrive shape).
    await scheduler.register('worker:vision', { every: '5m' }, async () => {
      await store.ledgerHasDeferred(C);
    });
    const counter = createLedgerCounter({ store, activeConsumers: () => [C] });
    const status = createProcessingStatus({
      countWaiting: () => store.visualWaitingCount(C),
      gen: () => store.ledgerGen(),
      providers: () => [],
      activeCalls: { list: () => [], onChange: () => () => {} },
      wakeWorkers: async () => {},
      patch: () => {},
      warn: () => {},
    });

    // Boot one-shots.
    await counter.count();
    status.start();
    scheduler.start();
    const tick = setInterval(() => {
      void counter.countIfChanged();
    }, 5_000);
    await jest.advanceTimersByTimeAsync(3_000); // 2 s catch-up ran the probe

    const spies = READERS.map((m) => jest.spyOn(store, m));
    const sql: string[] = [];
    for (const m of ['all', 'run', 'batch', 'exec'] as const) {
      const orig = (db[m] as (...a: unknown[]) => Promise<unknown>).bind(db);
      jest.spyOn(db, m).mockImplementation(((...a: unknown[]) => {
        const first = a[0];
        if (typeof first === 'string') sql.push(first);
        else if (Array.isArray(first))
          for (const s of first as Array<{ sql: string }>) sql.push(s.sql);
        return orig(...a);
      }) as never);
    }

    await jest.advanceTimersByTimeAsync(61_000);
    clearInterval(tick);
    status.stop();
    scheduler.stop();

    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(sql.filter((s) => /\bwork_ledger\b|\bchanges\b/.test(s))).toEqual([]);
  });
});
```

- [ ] **Step 7: Run all three**

Run: `npx jest src/main/core/__tests__/processing-counter.test.ts src/main/core/__tests__/processing-status.test.ts src/main/core/__tests__/idle-db.test.ts --runInBand`
Expected: PASS. If `idle-db` fails because the scheduler's 30 s tick fires the probe again, check that `scheduler.register` stored a `nextRun` 5 minutes ahead after the catch-up. That is the scheduler's existing contract. If it does fire again, stop and report rather than loosening the assertion.

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/processing-counter.ts src/main/core/processing-status.ts src/main/main.ts src/main/core/__tests__/processing-counter.test.ts src/main/core/__tests__/processing-status.test.ts src/main/core/__tests__/idle-db.test.ts
printf 'perf(processing): count the ledger and the waiting set only after a write (#139)\n\nThe 5 s tick and the 60 s waiting count compare ledgerGen (plus the\nactive consumer set) to the generation read before their last count.\nAcceptance: zero work_ledger/changes reads over 61 idle seconds.\n' > $SCRATCH/msg-db-t11.txt
git add src/main/core/processing-counter.ts src/main/core/__tests__/processing-counter.test.ts src/main/core/__tests__/idle-db.test.ts
git commit -F $SCRATCH/msg-db-t11.txt -- src/main/core/processing-counter.ts src/main/core/processing-status.ts src/main/main.ts src/main/core/__tests__/processing-counter.test.ts src/main/core/__tests__/processing-status.test.ts src/main/core/__tests__/idle-db.test.ts
```

---

### Task 12: `ledgerDeferred` / `ledgerHasDeferred` seek `work_ledger_active`

**Files:**
- Modify: `src/main/core/store/store.ts` (`ledgerDeferred` ~line 1128, `ledgerHasDeferred` ~line 1138)
- Modify: `src/main/core/store/schema.ts` (comment above `work_ledger_active`, ~lines 84–89)
- Create: `src/main/core/store/__tests__/ledger-deferred-plan.test.ts`

**Interfaces:**
- The SQL text below is load-bearing: the alpha-cent overlay (Part A) re-anchors on it byte for byte.

- [ ] **Step 1: Write the failing planner test**

`src/main/core/store/__tests__/ledger-deferred-plan.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { ensureQueryIndexes } from '../schema';
import { openStore, type CoreStore } from '../store';

const C = 'worker:vision:v1';

describe('deferred lookups seek work_ledger_active (#139)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-defplan-'));
    db = await openDb(path.join(dir, 'test.db'));
    ensureQueryIndexes(db._conn!);
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const planOfCall = async (call: () => Promise<unknown>) => {
    const spy = jest.spyOn(db, 'all');
    await call();
    const [sql, params] = spy.mock.calls.find(([s]) =>
      /FROM work_ledger/.test(s as string),
    )!;
    spy.mockRestore();
    return (
      (await db.all(`EXPLAIN QUERY PLAN ${sql as string}`, params)) as Array<{
        detail: string;
      }>
    ).map((r) => r.detail);
  };

  it('ledgerDeferred range-seeks the partial index', async () => {
    const plan = await planOfCall(() => store.ledgerDeferred(C, 0, 500));
    expect(plan.some((d) => /work_ledger_active/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN /.test(d))).toBe(false);
  });

  it('ledgerHasDeferred range-seeks the partial index', async () => {
    const plan = await planOfCall(() => store.ledgerHasDeferred(C));
    expect(plan.some((d) => /work_ledger_active/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN /.test(d))).toBe(false);
  });

  it('both still ignore skip rows and find deferred ones', async () => {
    await store.ledgerRecordMany(C, [
      { seq: 1, attempts: 0, outcome: 'skip' },
      { seq: 2, attempts: 0, outcome: 'deferred' },
    ]);
    expect(await store.ledgerDeferred(C, 0, 10)).toEqual([2]);
    expect(await store.ledgerHasDeferred(C)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/ledger-deferred-plan.test.ts --runInBand`
Expected: FAIL. The plan uses `sqlite_autoindex_work_ledger_1`, not `work_ledger_active`.

- [ ] **Step 3: Implement**

Replace the two methods in `store.ts`:

```ts
    async ledgerDeferred(consumer, after, limit) {
      // #139: the redundant `IS NOT 'skip'` lets the planner range-seek the
      // partial work_ledger_active index instead of walking the consumer's
      // millions of skip rows. alpha-cent's vision patch anchors on this text.
      const rows = (await db.all(
        `SELECT seq FROM work_ledger
          WHERE consumer = ? AND outcome = 'deferred' AND seq > ?
            AND outcome IS NOT 'skip'
          ORDER BY seq LIMIT ?`,
        [consumer, after, limit],
      )) as Array<{ seq: number }>;
      return rows.map((r) => r.seq);
    },

    async ledgerHasDeferred(consumer) {
      const rows = await db.all(
        `SELECT 1 FROM work_ledger WHERE consumer = ? AND outcome = 'deferred'
          AND outcome IS NOT 'skip' LIMIT 1`,
        [consumer],
      );
      return rows.length > 0;
    },
```

In `schema.ts`, replace the comment lines

```ts
  // partial WHERE). ledgerDeferred/ledgerHasDeferred don't yet: alpha-cent's
  // vision patch anchors on their exact SQL and adds the term itself.
```

with

```ts
  // partial WHERE). ledgerDeferred/ledgerHasDeferred repeat it too (#139);
  // alpha-cent's vision patch anchors on their exact SQL text.
```

(The `CREATE INDEX` text is unchanged, so `ensureQueryIndexes` does not rebuild.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/main/core/store/__tests__/ledger-deferred-plan.test.ts src/main/core/store/__tests__/schema-stats-indexes.test.ts src/main/workers --runInBand`
Expected: PASS. If the planner still picks the primary key, stop and report. Do not add `INDEXED BY` here: the overlay anchors on this text, and pinning needs the `countDocs`-style fallback, which is a spec change.

- [ ] **Step 5: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/store.ts src/main/core/store/schema.ts src/main/core/store/__tests__/ledger-deferred-plan.test.ts
printf "perf(store): deferred lookups restate outcome IS NOT 'skip' to seek work_ledger_active (#139)\n" > $SCRATCH/msg-db-t12.txt
git add src/main/core/store/__tests__/ledger-deferred-plan.test.ts
git commit -F $SCRATCH/msg-db-t12.txt -- src/main/core/store/store.ts src/main/core/store/schema.ts src/main/core/store/__tests__/ledger-deferred-plan.test.ts
```

---

### Task 13: Sweep retired consumers (ledger rows, then the consumers row)

**Files:**
- Modify: `src/main/core/store/store.ts` (new `sweepRetiredConsumers`, next to `pruneAttempts`)
- Modify: `src/main/main.ts` (right after `p.store.pruneAttempts(…)`, ~line 959)
- Create: `src/main/core/store/__tests__/retired-consumers.test.ts`

**Interfaces:**
- Produces: `CoreStore.sweepRetiredConsumers(active: readonly string[]): Promise<{ consumers: number; rows: number }>`.

- [ ] **Step 1: Write the failing tests**

`src/main/core/store/__tests__/retired-consumers.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const LIVE = 'worker:vision:v1';
const OLD = 'worker:audio:v1';

describe('retired consumer sweep (#139)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-retired-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    await db.run(
      `INSERT INTO consumers(name, cursor) VALUES(?, 10), (?, 5), ('seed:worker:x:v1', 3)`,
      [LIVE, OLD],
    );
    // Seqs far apart: three 50k windows for the retired consumer.
    await store.ledgerRecordMany(OLD, [
      { seq: 1, attempts: 0, outcome: 'skip' },
      { seq: 60_000, attempts: 0, outcome: 'deferred' },
      { seq: 120_001, attempts: 1, outcome: 'done' },
    ]);
    await store.ledgerRecordMany(LIVE, [
      { seq: 1, attempts: 0, outcome: 'skip' },
      { seq: 2, attempts: 0, outcome: 'deferred' },
    ]);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes only inactive names (ledger rows, then the row); keeps seed rows and live skip rows', async () => {
    expect(await store.sweepRetiredConsumers([LIVE])).toEqual({
      consumers: 1,
      rows: 3,
    });
    expect(
      await db.all(`SELECT name FROM consumers ORDER BY name`),
    ).toEqual([{ name: 'seed:worker:x:v1' }, { name: LIVE }]);
    expect(
      await db.all(`SELECT consumer, seq FROM work_ledger ORDER BY consumer, seq`),
    ).toEqual([
      { consumer: LIVE, seq: 1 },
      { consumer: LIVE, seq: 2 },
    ]);
  });

  it('with no retired names it issues no work_ledger statement', async () => {
    await store.sweepRetiredConsumers([LIVE, OLD]);
    const seen: string[] = [];
    for (const m of ['all', 'run', 'batch'] as const) {
      const orig = (db[m] as (...a: unknown[]) => Promise<unknown>).bind(db);
      jest.spyOn(db, m).mockImplementation(((...a: unknown[]) => {
        const first = a[0];
        if (typeof first === 'string') seen.push(first);
        else for (const s of first as Array<{ sql: string }>) seen.push(s.sql);
        return orig(...a);
      }) as never);
    }
    expect(await store.sweepRetiredConsumers([LIVE, OLD])).toEqual({
      consumers: 0,
      rows: 0,
    });
    expect(seen.filter((s) => /work_ledger/.test(s))).toEqual([]);
  });

  it('is a no-op with no active consumers (boot before workers attach)', async () => {
    expect(await store.sweepRetiredConsumers([])).toEqual({ consumers: 0, rows: 0 });
    expect(await db.all(`SELECT COUNT(*) AS c FROM consumers`)).toEqual([{ c: 3 }]);
  });

  it('moves ledgerGen when it deletes', async () => {
    const g = store.ledgerGen();
    await store.sweepRetiredConsumers([LIVE]);
    expect(store.ledgerGen()).toBeGreaterThan(g);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/retired-consumers.test.ts --runInBand`
Expected: FAIL, because `store.sweepRetiredConsumers is not a function`.

- [ ] **Step 3: Implement**

In `store.ts`, extend the `./maintenance-keys` import with `SEED_CONSUMER_PREFIX`. Add a module constant next to `FEED_BATCH`:

```ts
/** #139: a retired consumer's ledger rows go in primary-key windows of this
 *  many seqs, one writer call each. */
const RETIRED_SWEEP_WINDOW = 50_000;
```

Add to `CoreStore` after `pruneAttempts`:

```ts
  /** #139: `pruneAttempts`' contract applied to `consumers` + `work_ledger`.
   *  Every consumers row that is neither active nor a `seed:` progress row is
   *  retired: its ledger rows go in (consumer, seq) windows, then the row
   *  itself (last, so an interrupted sweep resumes). No-op when `active` is
   *  empty; with nothing retired it issues no work_ledger statement. */
  sweepRetiredConsumers(
    active: readonly string[],
  ): Promise<{ consumers: number; rows: number }>;
```

and the method after `pruneAttempts`:

```ts
    async sweepRetiredConsumers(active) {
      if (active.length === 0) return { consumers: 0, rows: 0 };
      const names = (await db.all(
        `SELECT name FROM consumers
          WHERE name NOT IN (${active.map(() => '?').join(', ')})
            AND name NOT LIKE '${SEED_CONSUMER_PREFIX}%'`,
        [...active],
      )) as Array<{ name: string }>;
      let rows = 0;
      for (const { name } of names) {
        // eslint-disable-next-line no-await-in-loop
        const span = (
          await db.all(
            `SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM work_ledger WHERE consumer = ?`,
            [name],
          )
        )[0] as { lo: number | null; hi: number | null };
        if (span.lo !== null && span.hi !== null) {
          for (let lo = span.lo; lo <= span.hi; lo += RETIRED_SWEEP_WINDOW) {
            // eslint-disable-next-line no-await-in-loop
            const [r] = await db.batch([
              {
                sql: `DELETE FROM work_ledger WHERE consumer = ? AND seq >= ? AND seq < ?`,
                params: [name, lo, lo + RETIRED_SWEEP_WINDOW],
              },
            ]);
            rows += r.changes;
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await db.run(`DELETE FROM consumers WHERE name = ?`, [name]);
      }
      if (names.length > 0) bumpGen();
      return { consumers: names.length, rows };
    },
```

In `main.ts`, right after `p.store.pruneAttempts(p.engine.activeConsumers()).catch(() => {});`:

```ts
    // #139: the same contract for consumers + work_ledger (retired worker
    // versions such as worker:audio:v1). No work_ledger statement when
    // nothing is retired.
    p.store
      .sweepRetiredConsumers(p.engine.activeConsumers())
      .catch((err) =>
        p.logSink.log('store', 'warn', `retired consumer sweep failed: ${String(err)}`),
      );
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/main/core/store/__tests__/retired-consumers.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/store.ts src/main/main.ts src/main/core/store/__tests__/retired-consumers.test.ts
printf 'perf(store): sweep retired consumers ledger rows and cursors at boot (#139)\n\nNames come from the tiny consumers table (seed: rows kept); ledger rows\ngo in 50k primary-key windows, the consumers row last.\n' > $SCRATCH/msg-db-t13.txt
git add src/main/core/store/__tests__/retired-consumers.test.ts
git commit -F $SCRATCH/msg-db-t13.txt -- src/main/core/store/store.ts src/main/main.ts src/main/core/store/__tests__/retired-consumers.test.ts
```

---

# Part 3a: Seeding a new consumer from `documents` (§3a, #59)

### Task 14: Seeding primitives (store, query, commit)

**Files:**
- Modify: `src/shared/contracts.ts` (`Query.seedPage?` after `documentPage?`; `seedCursor?` on its own line in the consumer variant of `CommitBatch`)
- Modify: `src/main/core/store/corpus-query.ts` (`QUERY_METHODS`, `seedPage`)
- Modify: `src/main/core/store/write-tx.ts` (one `seedCursor` hunk after the consumers upsert)
- Modify: `src/main/core/store/store.ts` (`consumerRow`, `beginSeed`, `endSeed`, `changesFloor`; `ledgerCountsAll` ignores `seed:` rows)
- Create: `src/main/core/store/__tests__/seed-store.test.ts`

**Interfaces:**
- Produces (contracts): `Query.seedPage?(input: { afterSeq: number; throughSeq: number; limit: number }): Promise<Document[]>`. It returns live documents with `afterSeq < seq <= throughSeq`, oldest first, at most 500. The consumer variant gains `seedCursor?: Seq` and `ledger?: Array<{ seq: Seq; attempts: number; outcome: 'done' | 'skip' | 'failed' | 'deferred' | null }>`. Both are written in the commit's own transaction.
- Produces (store): `consumerRow(name: string): Promise<Seq | null>`, `beginSeed(consumer: string, h0: Seq): Promise<void>`, `endSeed(consumer: string): Promise<void>` and `changesFloor(): Promise<Seq | null>`.

- [ ] **Step 1: Write the failing tests**

`src/main/core/store/__tests__/seed-store.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { QUERY_METHODS } from '../corpus-query';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});
const W = 'worker:s:v1';

describe('seeding primitives (#59 §3a)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-seedstore-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seqOf = async (externalId: string) =>
    (
      (await db.all(`SELECT seq FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ seq: number }>
    )[0].seq;

  it('seedPage: live documents in (afterSeq, throughSeq], oldest first, bounded', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'b', type: 'note' }],
      cursor: 2,
    });
    const h0 = await store.headSeq();
    await store.commit({ account: accountId, documents: [doc('late')], cursor: 3 });

    const all = await store.read.seedPage!({ afterSeq: 0, throughSeq: h0, limit: 10 });
    expect(all.map((d) => d.externalId)).toEqual(['a', 'c']);
    const rest = await store.read.seedPage!({
      afterSeq: await seqOf('a'),
      throughSeq: h0,
      limit: 10,
    });
    expect(rest.map((d) => d.externalId)).toEqual(['c']);
    expect(
      await store.read.seedPage!({ afterSeq: 0, throughSeq: h0, limit: 1 }),
    ).toHaveLength(1);
  });

  it('the read worker serves seedPage', () => {
    expect(QUERY_METHODS).toContain('seedPage');
  });

  it('beginSeed writes the real row at h0 and seed:<c> at 0 together; endSeed drops only the seed row', async () => {
    expect(await store.consumerRow(W)).toBeNull();
    const g = store.ledgerGen();
    await store.beginSeed(W, 42);
    expect(store.ledgerGen()).toBeGreaterThan(g);
    expect(await store.consumerRow(W)).toBe(42);
    expect(await store.consumerRow(`seed:${W}`)).toBe(0);
    await store.endSeed(W);
    expect(await store.consumerRow(`seed:${W}`)).toBeNull();
    expect(await store.consumerRow(W)).toBe(42);
  });

  it('a seed commit moves seed:<c> only; after endSeed a late seedCursor revives nothing', async () => {
    await store.beginSeed(W, 7);
    await store.commit({ consumer: W, cursor: 7, seedCursor: 5 });
    expect(await store.consumerRow(`seed:${W}`)).toBe(5);
    expect(await store.consumerRow(W)).toBe(7);
    await store.endSeed(W);
    await store.commit({ consumer: W, cursor: 7, seedCursor: 6 });
    expect(await store.consumerRow(`seed:${W}`)).toBeNull();
  });

  it('a seed commit writes its ledger outcomes in the same transaction as seedCursor', async () => {
    await store.beginSeed(W, 7);
    await store.commit({
      consumer: W,
      cursor: 7,
      seedCursor: 5,
      ledger: [
        { seq: 4, attempts: 0, outcome: 'deferred' },
        { seq: 5, attempts: 1, outcome: 'done' },
      ],
    });
    expect(await store.consumerRow(`seed:${W}`)).toBe(5);
    expect(
      await db.all(
        `SELECT seq, attempts, outcome FROM work_ledger WHERE consumer = ? ORDER BY seq`,
        [W],
      ),
    ).toEqual([
      { seq: 4, attempts: 0, outcome: 'deferred' },
      { seq: 5, attempts: 1, outcome: 'done' },
    ]);
    expect(await store.ledgerHasDeferred(W)).toBe(true);
  });

  it('ledgerCountsAll without a list ignores seed: rows (pending = head − h0)', async () => {
    await store.commit({ account: accountId, documents: [doc('a')], cursor: 1 });
    const head = await store.headSeq();
    await store.beginSeed(W, head);
    expect((await store.ledgerCountsAll()).pending).toBe(0);
    expect((await store.ledgerCountsAll([W])).pending).toBe(0);
  });

  it('changesFloor is null until a prune publishes one', async () => {
    expect(await store.changesFloor()).toBeNull();
    await db.run(`INSERT INTO meta(key, value) VALUES('changesFloor', '17')`);
    expect(await store.changesFloor()).toBe(17);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/seed-store.test.ts --runInBand`
Expected: FAIL. `seedPage` is undefined, and `consumerRow` is not a function.

- [ ] **Step 3: Contracts**

In `src/shared/contracts.ts` `Query`, directly after the `documentPage?(…)` member:

```ts
  /** Engine-internal (#59 §3a seeding); never exposed to extensions (not in
   *  host-surfaces / extension-host-entry). Live documents with
   *  `afterSeq < seq <= throughSeq`, oldest first, at most `limit` (≤ 500). */
  seedPage?(input: {
    afterSeq: number;
    throughSeq: number;
    limit: number;
  }): Promise<Document[]>;
```

In the consumer variant of `CommitBatch`, after `clearAttempts?: string[];`, add on its own lines:

```ts
      /** #59 §3a seeding only: `seed:<consumer>` is set to this seq in the
       *  same transaction (UPDATE only — a finished seed row stays gone). */
      seedCursor?: Seq;
      /** #59 §3a seeding only: this page's ledger outcomes, upserted in the
       *  SAME transaction as its outputs and `seedCursor`. A crash can then
       *  never leave a deferral behind the seed cursor without its retry
       *  row (feed(h0) would never see it again). */
      ledger?: Array<{
        seq: Seq;
        attempts: number;
        outcome: 'done' | 'skip' | 'failed' | 'deferred' | null;
      }>;
```

- [ ] **Step 4: `corpus-query.ts`**

Add `'seedPage',` to `QUERY_METHODS` right after `'documentPage',`. Add a module constant after `RECENCY_HEAD_CHARS`:

```ts
/** #59 §3a: largest seed page the reader serves in one call. */
const SEED_PAGE_MAX = 500;
```

and the method right after `documentPage` in the `query` object:

```ts
    async seedPage(input) {
      const limit = Math.max(0, Math.min(SEED_PAGE_MAX, Math.floor(input.limit)));
      if (limit === 0) return [];
      // docs_seq range; archived rows are filtered, not indexed.
      const rows = (await db.all(
        `SELECT * FROM documents
          WHERE seq > ? AND seq <= ? AND archived_at IS NULL
          ORDER BY seq LIMIT ?`,
        [input.afterSeq, input.throughSeq, limit],
      )) as unknown as DocRow[];
      return rows.map(toDocument);
    },
```

- [ ] **Step 5: `write-tx.ts`, two separate hunks**

Extend the `./maintenance-keys` import with `seedConsumerName`. In `commitTx`'s consumer branch, directly **after** the consumers upsert statement (`.run(batch.consumer, batch.cursor);`) and before `if (batch.clearAttempts?.length)`:

```ts
      // #59 §3a: seeding progress, atomically with the page's outputs. Its own
      // statement on its own row — never the consumer cursor upsert above.
      // UPDATE only: a finished (deleted) seed row is never revived.
      if (batch.seedCursor !== undefined)
        conn
          .prepare(`UPDATE consumers SET cursor = ? WHERE name = ?`)
          .run(batch.seedCursor, seedConsumerName(batch.consumer));
      // #59 §3a: the page's ledger outcomes, in the same transaction as its
      // outputs and seed progress (same upsert as store.ledgerRecordMany).
      if (batch.ledger?.length) {
        const ts = deps.now();
        const upsert = conn.prepare(
          `INSERT INTO work_ledger(consumer, seq, attempts, outcome, updated_at)
           VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(consumer, seq) DO UPDATE
             SET attempts = excluded.attempts, outcome = excluded.outcome,
                 updated_at = excluded.updated_at`,
        );
        for (const e of batch.ledger)
          upsert.run(batch.consumer, e.seq, e.attempts, e.outcome, ts);
      }
```

Both hunks sit apart from the consumer cursor upsert, which the sync workstream makes optional.

- [ ] **Step 6: `store.ts`**

Extend the `./maintenance-keys` import with `META_CHANGES_FLOOR` and `seedConsumerName` (`SEED_CONSUMER_PREFIX` is already imported by Task 13). Add to `CoreStore` after `consumerCursor`:

```ts
  /** The consumer's cursor, or null when it has no row (`consumerCursor`
   *  reads a missing row as 0). */
  consumerRow(name: string): Promise<Seq | null>;
  /** #59 §3a, ONE transaction: the real row at `h0` (head at seed start) and
   *  the `seed:<consumer>` progress row at 0. */
  beginSeed(consumer: string, h0: Seq): Promise<void>;
  /** Seeding finished: drop `seed:<consumer>`. */
  endSeed(consumer: string): Promise<void>;
  /** `meta.changesFloor`, or null when no prune ever published one. */
  changesFloor(): Promise<Seq | null>;
```

Implementations, after `consumerCursor`:

```ts
    async consumerRow(name) {
      const r = (
        await db.all(`SELECT cursor FROM consumers WHERE name = ?`, [name])
      )[0] as { cursor: number } | undefined;
      return r ? r.cursor : null;
    },

    async beginSeed(consumer, h0) {
      await db.batch([
        {
          sql: `INSERT INTO consumers(name, cursor) VALUES(?, ?)
                ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor`,
          params: [consumer, h0],
        },
        {
          sql: `INSERT INTO consumers(name, cursor) VALUES(?, 0)
                ON CONFLICT(name) DO UPDATE SET cursor = 0`,
          params: [seedConsumerName(consumer)],
        },
      ]);
      bumpGen();
    },

    async endSeed(consumer) {
      await db.run(`DELETE FROM consumers WHERE name = ?`, [
        seedConsumerName(consumer),
      ]);
      bumpGen();
    },

    async changesFloor() {
      const r = (
        await db.all(`SELECT value FROM meta WHERE key = ?`, [META_CHANGES_FLOOR])
      )[0] as { value: string } | undefined;
      return r ? Number(r.value) : null;
    },
```

In `ledgerCountsAll`, change the consumers read to:

```ts
      const lags = (await db.all(
        `SELECT name, cursor FROM consumers WHERE name NOT LIKE '${SEED_CONSUMER_PREFIX}%'`,
      )) as Array<{
```

- [ ] **Step 7: Run to verify it passes, then the neighbours**

Run: `npx jest src/main/core/store/__tests__/seed-store.test.ts src/main/core/store/__tests__/read-proxy.test.ts src/main/core/__tests__/reads.test.ts src/main/core/store/__tests__/store.test.ts --runInBand`
Expected: PASS. A test that pinned the exact `QUERY_METHODS` list gains `'seedPage'`; update it.

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/shared/contracts.ts src/main/core/store/corpus-query.ts src/main/core/store/write-tx.ts src/main/core/store/store.ts src/main/core/store/__tests__/seed-store.test.ts
printf 'feat(store): seeding primitives: seedPage on the read plane, seed:<consumer> rows, seedCursor + ledger on the commit (#59)\n\nseedCursor and the page ledger are their own statements after the consumer\ncursor upsert (kept apart from the sync workstream hunk), in the same\ntransaction. ledgerCountsAll ignores seed: rows.\n' > $SCRATCH/msg-db-t14.txt
git add src/main/core/store/__tests__/seed-store.test.ts
git commit -F $SCRATCH/msg-db-t14.txt -- src/shared/contracts.ts src/main/core/store/corpus-query.ts src/main/core/store/write-tx.ts src/main/core/store/store.ts src/main/core/store/__tests__/seed-store.test.ts
```

(Add any neighbour test you updated.)

---

### Task 15: The engine seeds a new consumer instead of replaying `changes`

**Files:**
- Modify: `src/main/core/engine/engine.ts` (`EngineDeps`; `SEED_PAGE`; `seedConsumer` after `workOne`, ~line 811; one call at the top of `attach`'s `try`, ~line 1736)
- Modify: `src/main/core/boot.ts` (`createEngine({ …, reads: readPlane.readsFor('other') })`)
- Create: `src/main/core/engine/__tests__/seed-consumer.test.ts`

**Interfaces:**
- Consumes: `consumerRow`, `beginSeed`, `endSeed`, `changesFloor`, `Query.seedPage`, `CommitBatch.seedCursor` and `CommitBatch.ledger` (Task 14).
- Produces: `export const SEED_PAGE = 500;`, `EngineDeps.reads?: Query` and `EngineDeps.seedPageSize?: number` (tests only).

- [ ] **Step 1: Write the failing tests**

`src/main/core/engine/__tests__/seed-consumer.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  Change,
  DocumentInput,
  Handle,
  Worker,
} from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine, type EngineDeps } from '../engine';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => [],
};
const doc = (externalId: string, markdown = `body ${externalId}`): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: null,
});

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 8_000) {
  const until = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  }
}

describe('seeding a new consumer from documents (#59 §3a)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-seed-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeEngine = (over: Partial<EngineDeps> = {}) =>
    createEngine({
      store,
      sources: { get: () => undefined },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (d) => d,
      logs: { log: () => {} },
      ...over,
    });
  const seedRow = (name: string) => store.consumerRow(`seed:worker:${name}:v1`);
  const caughtUp = async (name: string) =>
    (await seedRow(name)) === null &&
    (await store.consumerRow(`worker:${name}:v1`)) === (await store.headSeq());
  /** Seeding FINISHED: beginSeed created the real row and endSeed dropped
   *  the progress row. (A bare "no seed row" is also true before seeding
   *  starts.) Only for consumers with no pre-existing row. */
  const seedDone = async (name: string) =>
    (await store.consumerRow(`worker:${name}:v1`)) !== null &&
    (await seedRow(name)) === null;
  /** externalId -> seq, captured BEFORE any enrichment moves documents.seq. */
  const seqsNow = async () =>
    Object.fromEntries(
      (
        (await db.all(`SELECT external_id, seq FROM documents`)) as Array<{
          external_id: string;
          seq: number;
        }>
      ).map((r) => [r.external_id, r.seq]),
    ) as Record<string, number>;
  /** Works live notes once: its enrich marks metadata[name], which un-matches. */
  const marker = (
    name: string,
    worked: string[],
    onWork?: (c: Change) => unknown,
  ): Worker => ({
    name,
    version: 1,
    matches: (c) =>
      c.kind === 'document' &&
      c.document.type === 'note' &&
      !c.document.archivedAt &&
      !(name in c.document.metadata),
    async work(c, session) {
      if (c.kind !== 'document') return 'skip';
      await onWork?.(c);
      worked.push(c.document.externalId);
      session.enrich({ documentId: c.document.id, metadata: { [name]: true } });
      return 'done';
    },
  });
  const archive = (externalId: string, cursor: number) =>
    store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId, type: 'note' }],
      cursor,
    });
  const purgeAll = () =>
    store.commit({ purgeArchived: { before: '9999-01-01T00:00:00Z' } });

  it('works the same documents and enrich set as a full replay', async () => {
    await store.commit({
      account: accountId,
      documents: ['a', 'b', 'c', 'd', 'e'].map((x) => doc(x)),
      cursor: 1,
    });
    await store.commit({ account: accountId, documents: [doc('b', 'edited')], cursor: 2 });
    await archive('c', 3);
    await purgeAll(); // c is gone
    await archive('e', 4); // e is archived, not purged

    const replayed: string[] = [];
    // A row at 0 and no published floor: today's replay from seq 0.
    await store.commit({ consumer: 'worker:replay:v1', cursor: 0 });
    const h1 = makeEngine().attach(marker('replay', replayed));
    await waitFor(() => caughtUp('replay'));
    await h1.stop();

    const seeded: string[] = [];
    const h2 = makeEngine().attach(marker('seed', seeded));
    await waitFor(() => caughtUp('seed'));
    await h2.stop();

    expect([...seeded].sort()).toEqual(['a', 'b', 'd']);
    expect([...seeded].sort()).toEqual([...replayed].sort());
    const enriched = async (key: string) =>
      (
        (await db.all(
          `SELECT external_id FROM documents
            WHERE json_extract(metadata, '$.' || ?) = 1 ORDER BY external_id`,
          [key],
        )) as Array<{ external_id: string }>
      ).map((r) => r.external_id);
    expect(await enriched('seed')).toEqual(await enriched('replay'));
  });

  it('pending is head − h0 from the first moment of a seed', async () => {
    await store.commit({ account: accountId, documents: [doc('a'), doc('b')], cursor: 1 });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const h = makeEngine().attach(marker('slow', [], () => held));
    await waitFor(async () => (await seedRow('slow')) !== null);
    expect((await store.ledgerCountsAll(['worker:slow:v1'])).pending).toBe(0);
    await store.commit({ account: accountId, documents: [doc('c')], cursor: 2 });
    const pending = (await store.ledgerCountsAll(['worker:slow:v1'])).pending;
    expect(pending).toBeGreaterThan(0);
    expect(pending).toBe(
      (await store.headSeq()) - (await store.consumerCursor('worker:slow:v1')),
    );
    release();
    await waitFor(() => seedDone('slow'));
    await h.stop();
  });

  it('seed outputs land under the real worker account', async () => {
    await store.commit({ account: accountId, documents: [doc('a')], cursor: 1 });
    const worker: Worker = {
      name: 'out',
      version: 1,
      matches: (c) => c.kind === 'document' && c.document.type === 'note',
      async work(c, session) {
        if (c.kind !== 'document') return 'skip';
        session.emit({
          externalId: `sum:${c.document.externalId}`,
          type: 'summary',
          title: null,
          markdown: 'x',
          metadata: {},
          createdAt: null,
        });
        return 'done';
      },
    };
    const h = makeEngine().attach(worker);
    await waitFor(
      async () =>
        (await seedDone('out')) &&
        (await db.all(`SELECT 1 FROM documents WHERE type = 'summary'`)).length === 1,
    );
    await h.stop();
    expect(
      await db.all(
        `SELECT a.source, a.identifier FROM documents d
           JOIN accounts a ON a.id = d.account_id WHERE d.type = 'summary'`,
      ),
    ).toEqual([{ source: 'worker', identifier: 'worker:out:v1' }]);
  });

  it('resumes from the seed cursor after a stop mid-seed', async () => {
    await store.commit({
      account: accountId,
      documents: ['a', 'b', 'c', 'd', 'e'].map((x) => doc(x)),
      cursor: 1,
    });
    const seqs = await seqsNow(); // seed progress stores ORIGINAL page seqs
    const worked: string[] = [];
    let handle: Handle | null = null;
    let stopping: Promise<void> | null = null;
    handle = makeEngine({ seedPageSize: 2 }).attach(
      marker('resume', worked, (c) => {
        if (c.kind === 'document' && c.document.externalId === 'c')
          stopping = handle!.stop();
      }),
    );
    await waitFor(async () => stopping !== null);
    await stopping;
    expect(await seedRow('resume')).toBe(seqs.b); // page [a, b] committed
    const before = worked.length;
    const h2 = makeEngine({ seedPageSize: 2 }).attach(marker('resume', worked));
    await waitFor(async () => (await seedDone('resume')) && worked.includes('e'));
    await h2.stop();
    expect(worked.slice(0, 2)).toEqual(['a', 'b']);
    expect(worked.slice(before)).toEqual(['c', 'd', 'e']);
  });

  it('a cursor below the published changes floor re-seeds instead of skipping forward', async () => {
    await store.commit({ account: accountId, documents: [doc('a'), doc('b')], cursor: 1 });
    await store.commit({ consumer: 'worker:back:v1', cursor: 1 });
    const floor = await store.headSeq();
    await db.run(`INSERT INTO meta(key, value) VALUES('changesFloor', ?)`, [
      String(floor),
    ]);
    const worked: string[] = [];
    const h = makeEngine().attach(marker('back', worked));
    // The real row pre-exists, so wait on the work AND the seed row's end.
    await waitFor(async () => worked.length === 2 && (await seedRow('back')) === null);
    await h.stop();
    expect([...worked].sort()).toEqual(['a', 'b']);
    expect(await store.consumerCursor('worker:back:v1')).toBeGreaterThanOrEqual(floor);
  });

  it('a document purged between seed pages is never worked, and seeding finishes', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: 1,
    });
    const worked: string[] = [];
    const h = makeEngine({ seedPageSize: 1 }).attach(
      marker('vanish', worked, async (c) => {
        if (c.kind === 'document' && c.document.externalId === 'a') {
          await archive('b', 2);
          await purgeAll();
        }
      }),
    );
    await waitFor(async () => (await seedDone('vanish')) && worked.includes('c'));
    await h.stop();
    expect(worked).toEqual(['a', 'c']);
  });

  it('a crash at the page-commit boundary never strands a deferral behind the seed cursor (audio-style)', async () => {
    await store.commit({
      account: accountId,
      documents: ['a', 'b', 'c', 'd'].map((x) => doc(x)),
      cursor: 1,
    });
    const seqs = await seqsNow();
    // Audio-style: 'b' defers (no model yet); everything else is done.
    const audio = (deferB: boolean, worked: string[]): Worker => ({
      name: 'hear',
      version: 1,
      matches: (c) =>
        c.kind === 'document' &&
        c.document.type === 'note' &&
        !c.document.archivedAt &&
        !('hear' in c.document.metadata),
      async work(c, session) {
        if (c.kind !== 'document') return 'skip';
        worked.push(c.document.externalId);
        if (deferB && c.document.externalId === 'b') return 'defer';
        session.enrich({ documentId: c.document.id, metadata: { hear: true } });
        return 'done';
      },
    });
    // The process dies IMMEDIATELY AFTER page 1's ([a, b]) underlying commit
    // succeeded, before control returns to the seeder. A two-call design
    // (commit, then a separate ledger write) loses b's deferral right here;
    // the atomic page commit cannot. From then on nothing reaches the DB
    // (the process is gone), so the engine's retry cannot repair it either.
    let crashed = false;
    const crashing = {
      ...store,
      commit: async (batch: Parameters<CoreStore['commit']>[0]) => {
        if (crashed) throw new Error('process is dead');
        const r = await store.commit(batch);
        if ('seedCursor' in batch && batch.seedCursor !== undefined) {
          crashed = true;
          throw new Error('process died after the page commit');
        }
        return r;
      },
      ledgerRecord: async (...a: Parameters<CoreStore['ledgerRecord']>) => {
        if (crashed) throw new Error('process is dead');
        return store.ledgerRecord(...a);
      },
      ledgerRecordMany: async (...a: Parameters<CoreStore['ledgerRecordMany']>) => {
        if (crashed) throw new Error('process is dead');
        return store.ledgerRecordMany(...a);
      },
    } as CoreStore;
    const h = makeEngine({ store: crashing, seedPageSize: 2 }).attach(audio(true, []));
    await waitFor(async () => crashed);
    await h.stop();

    // Reopen the database as a restarted app would.
    await store.close();
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    // BOTH must be there: the seed cursor past page 1 AND b's deferred row.
    expect(await store.consumerRow('seed:worker:hear:v1')).toBe(seqs.b);
    // Everything at/behind the seed cursor has its ledger row, the deferral too.
    expect(
      await db.all(
        `SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:hear:v1' ORDER BY seq`,
      ),
    ).toEqual([
      { seq: seqs.a, outcome: 'done' },
      { seq: seqs.b, outcome: 'deferred' },
    ]);

    // Resume re-works only the lost page; the deferral then re-drives.
    const worked: string[] = [];
    const h2 = makeEngine({ seedPageSize: 2 }).attach(audio(false, worked));
    await waitFor(
      async () =>
        worked.includes('d') && (await store.consumerRow('seed:worker:hear:v1')) === null,
    );
    await h2.stop();
    expect(worked).toEqual(['c', 'd']);
    await makeEngine().rerunDeferred(audio(false, worked));
    expect(
      await db.all(
        `SELECT outcome FROM work_ledger WHERE consumer = 'worker:hear:v1' AND seq = ?`,
        [seqs.b],
      ),
    ).toEqual([{ outcome: 'done' }]);
  });

  it('a half-done seed whose h0 fell below the published floor restarts at the current head', async () => {
    await store.commit({ account: accountId, documents: [doc('a'), doc('b')], cursor: 1 });
    const seqs = await seqsNow();
    // Left by an earlier run: h0 = a's seq, page [a] committed.
    await store.beginSeed('worker:stale:v1', seqs.a);
    await store.commit({ consumer: 'worker:stale:v1', cursor: seqs.a, seedCursor: seqs.a });
    await store.commit({ account: accountId, documents: [doc('c')], cursor: 2 });
    // Pruning passed h0 while the consumer was away.
    const head = await store.headSeq();
    await db.run(`INSERT INTO meta(key, value) VALUES('changesFloor', ?)`, [String(head)]);
    await db.run(`DELETE FROM changes WHERE seq < ?`, [head]);
    const worked: string[] = [];
    const h = makeEngine().attach(marker('stale', worked));
    await waitFor(async () => worked.length === 3 && (await seedRow('stale')) === null);
    await h.stop();
    expect([...worked].sort()).toEqual(['a', 'b', 'c']);
    expect(await store.consumerCursor('worker:stale:v1')).toBeGreaterThanOrEqual(head);
  });

  it('a seed row whose real row is gone restarts at the current head', async () => {
    await store.commit({ account: accountId, documents: [doc('a'), doc('b')], cursor: 1 });
    const seqs = await seqsNow();
    // Only the progress row is left (e.g. the real row was swept).
    await db.run(`INSERT INTO consumers(name, cursor) VALUES('seed:worker:orphan:v1', ?)`, [
      seqs.a,
    ]);
    const head = await store.headSeq();
    await db.run(`DELETE FROM changes WHERE seq < ?`, [head]);
    const worked: string[] = [];
    const h = makeEngine().attach(marker('orphan', worked));
    await waitFor(async () => worked.length === 2 && (await seedDone('orphan')));
    await h.stop();
    expect([...worked].sort()).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/engine/__tests__/seed-consumer.test.ts --runInBand`
Expected: FAIL. No `seed:` row is ever written, so the waits time out.

- [ ] **Step 3: Implement in `engine.ts`**

Add `Query` to the type import from `'@shared/contracts'` if it is not there yet, and import the seed name:

```ts
import { seedConsumerName } from '../store/maintenance-keys';
```

Add to `EngineDeps`:

```ts
  /** #59 §3a: where a new consumer's seed pages are read. Production passes
   *  the read worker (`readsFor('other')`) so paging never queues behind
   *  ingest; defaults to `store.read`. */
  reads?: Query;
  /** Seed page size — tests only (default SEED_PAGE). */
  seedPageSize?: number;
```

Next to `REDRIVE_PAGE`:

```ts
/** #59 §3a: live documents per seed page (one read-worker call each). */
export const SEED_PAGE = 500;
```

Insert this between the end of `workOne` (`  };` right after `return { docs: [], enrich: [], attempts: 0, outcome: 'failed' };`) and `const engine = {`. It is kept separate from `attach`'s batch loop on purpose: the sync workstream rewrites that loop's flushes.

```ts
  /** #59 §3a: seed `consumer` from `documents` instead of replaying the whole
   *  change log. Runs when the consumer has no row, a half-done seed
   *  (`seed:<consumer>` exists), or a cursor below the published prune
   *  floor. The real row sits at `h0` (head at seed start) from the first
   *  moment, so `pending` and the prune floor are right while seeding; a
   *  document that changes meanwhile comes again through feed(h0), which is
   *  idempotent (emissions key on (consumer, seq)). Returns false when
   *  stopped mid-seed — the seed row keeps the last committed page.
   *  A half-done seed resumes ONLY while its snapshot is still feedable: the
   *  real row exists and h0 >= the published floor. Otherwise (the retired
   *  sweep dropped the real row, or pruning passed h0 while the consumer was
   *  away) feed(h0) would start inside a deleted interval, so the seed
   *  restarts at the current head. */
  const seedConsumer = async (
    worker: Worker,
    consumer: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const cursor = await store.consumerRow(consumer);
    const floor = (await store.changesFloor()) ?? 0;
    const seed = await store.consumerRow(seedConsumerName(consumer));
    const feedable = cursor !== null && cursor >= floor;
    if (feedable && seed === null) return true; // nothing to seed
    let after: Seq = seed ?? 0;
    if (!feedable) {
      // beginSeed resets seed:<consumer> to 0 with the new h0.
      await store.beginSeed(consumer, await store.headSeq());
      after = 0;
    }
    const h0 = await store.consumerCursor(consumer);
    const reads = deps.reads ?? store.read;
    const pageSize = deps.seedPageSize ?? SEED_PAGE;
    for (;;) {
      if (signal.aborted) return false;
      // eslint-disable-next-line no-await-in-loop
      const page = await reads.seedPage!({
        afterSeq: after,
        throughSeq: h0,
        limit: pageSize,
      });
      if (page.length === 0) break;
      const emitted: DocumentInput[] = [];
      const enrich: EnrichInput[] = [];
      const clear: string[] = [];
      const worked: string[] = [];
      const ledger: LedgerEntry[] = [];
      for (const document of page) {
        if (signal.aborted) {
          // As attach's dropBatch: nothing crashed, so clear the session.bump
          // counters of what returned. The seed cursor stays put and the
          // page's ledger entries are discarded with its outputs.
          if (worked.length)
            // eslint-disable-next-line no-await-in-loop
            await store
              .commit({ consumer, cursor: h0, clearAttempts: worked })
              .catch(() => {});
          return false;
        }
        const change: Change = { seq: document.seq, kind: 'document', document };
        let matched = false;
        try {
          matched = worker.matches(change);
        } catch (err) {
          logs.log(
            `worker:${worker.name}`,
            'warn',
            `matches() threw on seq ${change.seq} — treated as non-match: ${String(err)}`,
          );
        }
        if (!matched) continue;
        // eslint-disable-next-line no-await-in-loop
        const r = await workOne(worker, change, signal);
        worked.push(document.id);
        ledger.push({ seq: change.seq, attempts: r.attempts, outcome: r.outcome });
        emitted.push(...r.docs);
        enrich.push(...r.enrich);
        if (r.outcome === 'done') clear.push(document.id);
      }
      after = page[page.length - 1].seq;
      // ONE transaction per page: outputs under the REAL consumer (its
      // synthetic worker account), the page's ledger outcomes, and the seed
      // progress. The consumer cursor stays at h0. A crash before it loses
      // the whole page (re-worked on resume); after it, every deferral
      // behind the seed cursor already has its retry row. When the sync
      // workstream makes `cursor` optional on consumer commits, this call
      // omits it.
      // eslint-disable-next-line no-await-in-loop
      await store.commit({
        consumer,
        cursor: h0,
        seedCursor: after,
        ledger: ledger.length ? ledger : undefined,
        documents: emitted.length ? emitted : undefined,
        enrich: enrich.length ? enrich : undefined,
        clearAttempts: clear.length ? clear : undefined,
      });
    }
    await store.endSeed(consumer);
    return true;
  };
```

In `attach`, inside `for (;;) { try {`, replace

```ts
            const start = await store.consumerCursor(consumer);
```

with

```ts
            // #59 §3a: a consumer with no row, a half-done seed, or a cursor
            // below the pruned floor is seeded from `documents` first.
            if (!(await seedConsumer(worker, consumer, abort.signal))) return;
            const start = await store.consumerCursor(consumer);
```

(It sits inside the existing retry `try`, so a DB-worker crash mid-seed backs off and resumes from the seed row.)

- [ ] **Step 4: Wire `boot.ts`**

In `bootCore`, change the `createEngine({ … })` call to also pass:

```ts
    // #59 §3a: seed pages run on the read worker, never behind ingest.
    reads: readPlane.readsFor('other'),
```

- [ ] **Step 5: Run to verify they pass, then the engine suites**

Run: `npx jest src/main/core/engine/__tests__/seed-consumer.test.ts src/main/core/engine/__tests__/ledger-rekey-gate.test.ts --runInBand`
Expected: PASS.

Run: `npx jest src/main/core/engine/__tests__/engine.test.ts src/main/core/engine/__tests__/feed-retry.test.ts src/main/core/engine/__tests__/abortable-leak.test.ts src/main/workers --runInBand`
Expected: PASS. A test that committed documents **before** attaching a fresh worker now has them delivered by the seed, in `documents.seq` order, without account or purge changes. An assertion that counted `matches()` calls on non-document changes from a replay from 0 pinned the replay; update it to the seeded set. A test that pre-wrote `consumers` at 0 keeps today's replay (ruling 11).

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/engine/engine.ts src/main/core/boot.ts src/main/core/engine/__tests__/seed-consumer.test.ts
printf 'feat(engine): seed a new or below-floor consumer from documents instead of replaying changes (#59)\n\nReal row at h0 + seed:<consumer> progress row in one transaction; pages\nof 500 live documents on the read worker; each page commits its outputs,\nledger outcomes and seedCursor in one transaction under the real worker\naccount; resumes after a quit only while h0 is still at/above the floor.\n' > $SCRATCH/msg-db-t15.txt
git add src/main/core/engine/__tests__/seed-consumer.test.ts
git commit -F $SCRATCH/msg-db-t15.txt -- src/main/core/engine/engine.ts src/main/core/boot.ts src/main/core/engine/__tests__/seed-consumer.test.ts
```

---

# Part 3b: Pruning (§3b, #59), gated on `ledgerRekeyed`

### Task 16: Prune primitives in the store (and `addedSince` shares the bisection)

**Files:**
- Modify: `src/main/core/store/store.ts` (`addedSince` ~line 467 → shared `firstSeqAtOrAfter`; six new methods)
- Create: `src/main/core/store/__tests__/prune-store.test.ts`

**Interfaces:**
- Produces: `firstChangeSeqAt(since: string): Promise<Seq>`, which returns `MAX(seq) + 1` when every change is older; `consumerFloor(consumers: readonly string[]): Promise<Seq | null>`; `minChangeSeq(): Promise<Seq | null>`; `publishChangesFloor(limit: Seq): Promise<void>`, which is monotonic; `deleteChangesRange(from: Seq, to: Seq): Promise<number>`; and `walCheckpoint(): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`src/main/core/store/__tests__/prune-store.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});
const T = Date.parse('2026-10-09T12:00:00.000Z');

describe('prune primitives (#59 §3b)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let clock = T;

  beforeEach(async () => {
    clock = T - 72 * 3_600_000;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prunestore-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
      now: () => new Date(clock).toISOString(),
    });
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const firstAt = async (iso: string) =>
    (
      (await db.all(`SELECT MIN(seq) AS s FROM changes WHERE at >= ?`, [iso])) as Array<{
        s: number | null;
      }>
    )[0].s;

  it('firstChangeSeqAt bisects to the first change at/after an instant, also after a prefix is gone', async () => {
    await store.commit({ account: accountId, documents: [doc('old')], cursor: 1 });
    clock = T - 3_600_000;
    await store.commit({ account: accountId, documents: [doc('new')], cursor: 2 });
    const since = new Date(T - 48 * 3_600_000).toISOString();
    const expected = await firstAt(since);
    expect(await store.firstChangeSeqAt(since)).toBe(expected);
    expect(await store.firstChangeSeqAt(new Date(T).toISOString())).toBe(
      (await store.headSeq()) + 1,
    );
    expect(await store.deleteChangesRange(1, expected!)).toBeGreaterThan(0);
    expect(await store.firstChangeSeqAt(since)).toBe(expected);
    expect(await store.minChangeSeq()).toBe(expected);
    // Every retained row qualifies: the answer is the retained MIN(seq), an
    // existing row, never a deleted number below it.
    expect(await store.firstChangeSeqAt('2000-01-01T00:00:00.000Z')).toBe(expected);
    expect(
      await db.all(`SELECT 1 FROM changes WHERE seq = ?`, [
        await store.firstChangeSeqAt('2000-01-01T00:00:00.000Z'),
      ]),
    ).toEqual([{ 1: 1 }]);
  });

  it("the bisection's queries never SCAN changes (endpoint and primary-key seeks only)", async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: 1,
    });
    const spy = jest.spyOn(db, 'all');
    await store.firstChangeSeqAt(new Date(T).toISOString());
    const sqls = [...new Set(spy.mock.calls.map(([sql]) => sql as string))];
    spy.mockRestore();
    // MIN, MAX, the bisection probe and the final resolve.
    expect(sqls.length).toBeGreaterThanOrEqual(3);
    for (const sql of sqls) {
      const params = Array((sql.match(/\?/g) ?? []).length).fill(1);
      // eslint-disable-next-line no-await-in-loop
      const plan = (await db.all(`EXPLAIN QUERY PLAN ${sql}`, params)) as Array<{
        detail: string;
      }>;
      expect(plan.map((p) => p.detail).filter((x) => /\bSCAN changes\b/.test(x))).toEqual(
        [],
      );
    }
  });

  it('firstChangeSeqAt is 1 on an empty log', async () => {
    await db.run(`DELETE FROM changes`);
    expect(await store.firstChangeSeqAt('2000-01-01T00:00:00.000Z')).toBe(1);
  });

  it('deleteChangesRange is a half-open primary-key range', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: 1,
    });
    const head = await store.headSeq();
    expect(await store.deleteChangesRange(1, head)).toBe(head - 1);
    expect(await db.all(`SELECT seq FROM changes`)).toEqual([{ seq: head }]);
    expect(await store.deleteChangesRange(5, 5)).toBe(0);
  });

  it('publishChangesFloor never lowers the floor', async () => {
    await store.publishChangesFloor(10);
    await store.publishChangesFloor(4);
    expect(await store.changesFloor()).toBe(10);
    await store.publishChangesFloor(12);
    expect(await store.changesFloor()).toBe(12);
  });

  it('consumerFloor is MIN(cursor) over the given rows, null when none', async () => {
    await db.run(`INSERT INTO consumers(name, cursor) VALUES('w:a', 7), ('w:b', 3), ('seed:w:a', 0)`);
    expect(await store.consumerFloor(['w:a', 'w:b'])).toBe(3);
    expect(await store.consumerFloor(['w:a'])).toBe(7);
    expect(await store.consumerFloor(['w:none'])).toBeNull();
    expect(await store.consumerFloor([])).toBeNull();
  });

  it('walCheckpoint runs', async () => {
    await expect(store.walCheckpoint()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/prune-store.test.ts --runInBand`
Expected: FAIL, because `store.firstChangeSeqAt is not a function`.

- [ ] **Step 3: Implement**

Add to `CoreStore` (after `changesFloor`):

```ts
  /** First change seq whose `at` is at/after `since` (ISO), by bisecting
   *  the primary key; `MAX(seq) + 1` when every change is older. */
  firstChangeSeqAt(since: string): Promise<Seq>;
  /** MIN(cursor) over these consumers' rows; null when none has a row. */
  consumerFloor(consumers: readonly string[]): Promise<Seq | null>;
  /** Oldest retained change seq; null when the log is empty. */
  minChangeSeq(): Promise<Seq | null>;
  /** Raise `meta.changesFloor` to `limit` (never lowers it). */
  publishChangesFloor(limit: Seq): Promise<void>;
  /** Delete `changes` rows with `from <= seq < to` — one primary-key range,
   *  one writer call. Returns the number deleted. */
  deleteChangesRange(from: Seq, to: Seq): Promise<number>;
  /** `PRAGMA wal_checkpoint(PASSIVE)`. */
  walCheckpoint(): Promise<void>;
```

Add a helper inside `openStore` (after `getAccountRow`):

```ts
  /** First change at/after `since`. The log is append-only and stamped as it
   *  is written, so `at` rises with `seq`: bisect the primary key (no index
   *  on `at`) over the RETAINED range [MIN(seq), MAX(seq)] — pruning removes
   *  a prefix, so a search from 1 could land on a deleted number. The answer
   *  is always an existing qualifying row, or the `MAX(seq) + 1` sentinel
   *  when every change is older (1 on an empty log). */
  const firstSeqAtOrAfter = async (since: string): Promise<Seq> => {
    // Two SEPARATE single-aggregate statements: SQLite's min/max endpoint
    // optimization applies only to a query with exactly one MIN or MAX — a
    // combined `SELECT MIN(seq), MAX(seq)` scans the whole log.
    const min = (
      (await db.all(`SELECT MIN(seq) AS m FROM changes`))[0] as {
        m: number | null;
      }
    ).m;
    if (min === null) return 1;
    const max = (
      (await db.all(`SELECT MAX(seq) AS m FROM changes`))[0] as { m: number }
    ).m;
    // Invariant: every retained row below `lo` is older than `since`; the
    // first retained row at/after `hi` (if any) is not.
    let lo = min;
    let hi = max + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      // eslint-disable-next-line no-await-in-loop
      const row = (
        await db.all(
          `SELECT seq, at FROM changes WHERE seq >= ? ORDER BY seq LIMIT 1`,
          [mid],
        )
      )[0] as { seq: number; at: string } | undefined;
      if (!row || row.at >= since) hi = mid;
      else lo = row.seq + 1;
    }
    // Resolve the numeric bound to the existing row it stands for.
    const hit = (await db.all(
      `SELECT seq FROM changes WHERE seq >= ? ORDER BY seq LIMIT 1`,
      [lo],
    ))[0] as { seq: number } | undefined;
    return hit ? hit.seq : max + 1;
  };
```

Replace `addedSince` with:

```ts
    async addedSince(since) {
      // Join the document changes from the first change at/after `since` to
      // the documents they inserted (none when every change is older).
      const lo = await firstSeqAtOrAfter(since);
      return (await db.all(
        `SELECT d.account_id AS accountId, COUNT(*) AS count
           FROM changes c
           JOIN documents d ON d.id = c.ref_id AND d.ingest_seq = c.seq
          WHERE c.seq >= ? AND c.kind = 'document' AND d.archived_at IS NULL
          GROUP BY d.account_id`,
        [lo],
      )) as Array<{ accountId: AccountId; count: number }>;
    },
```

Add the methods (after `changesFloor`):

```ts
    firstChangeSeqAt: (since) => firstSeqAtOrAfter(since),

    async consumerFloor(consumers) {
      if (consumers.length === 0) return null;
      return (
        (
          await db.all(
            `SELECT MIN(cursor) AS m FROM consumers
              WHERE name IN (${consumers.map(() => '?').join(', ')})`,
            [...consumers],
          )
        )[0] as { m: number | null }
      ).m;
    },

    async minChangeSeq() {
      return (
        (await db.all(`SELECT MIN(seq) AS m FROM changes`))[0] as {
          m: number | null;
        }
      ).m;
    },

    async publishChangesFloor(limit) {
      await db.run(
        `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value =
           CAST(MAX(CAST(value AS INTEGER), CAST(excluded.value AS INTEGER)) AS TEXT)`,
        [META_CHANGES_FLOOR, String(limit)],
      );
    },

    async deleteChangesRange(from, to) {
      if (to <= from) return 0;
      const [r] = await db.batch([
        { sql: `DELETE FROM changes WHERE seq >= ? AND seq < ?`, params: [from, to] },
      ]);
      return r.changes;
    },

    async walCheckpoint() {
      await db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);
    },
```

- [ ] **Step 4: Run to verify it passes, plus `addedSince`'s own suite**

Run: `npx jest src/main/core/store/__tests__/prune-store.test.ts src/main/core/store/__tests__/added-since.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/store/store.ts src/main/core/store/__tests__/prune-store.test.ts
printf 'feat(store): changes prune primitives; addedSince shares the seq bisection (#59)\n' > $SCRATCH/msg-db-t16.txt
git add src/main/core/store/__tests__/prune-store.test.ts
git commit -F $SCRATCH/msg-db-t16.txt -- src/main/core/store/store.ts src/main/core/store/__tests__/prune-store.test.ts
```

---

### Task 17: The `maintenance:prune-changes` job

**Files:**
- Modify: `src/main/core/changes-maintenance.ts` (append)
- Modify: `src/main/core/boot.ts` (register next to `registerArchiveSweep`)
- Create: `src/main/core/__tests__/changes-prune-job.test.ts`
- Create: `src/main/core/engine/__tests__/prune-reseed.test.ts`

**Interfaces:**
- Consumes: Task 16 primitives, `ledgerRekeyed`, `changesFloor`, `scheduleAll`, `scheduleUpsert`, and `nextRun` from `./engine/cadence`.
- Produces: `CHANGES_PRUNE_JOB_ID = 'maintenance:prune-changes'`, `CHANGES_PRUNE_CADENCE = { every: '6h' }`, `CHANGES_RETENTION_MS = 48 h`, `PRUNE_BATCH = 50_000`, `PRUNE_CHECKPOINT_EVERY = 20` and `FIRST_PRUNE_DELAY_MS = 600_000`; `pruneChangesOnce(deps): Promise<PruneResult>`; and `registerChangesPrune(deps): Promise<void>`.

- [ ] **Step 1: Write the failing unit tests**

`src/main/core/__tests__/changes-prune-job.test.ts`:

```ts
/** @jest-environment node */
import type { Cadence } from '@shared/contracts';

import {
  CHANGES_PRUNE_CADENCE,
  CHANGES_PRUNE_JOB_ID,
  FIRST_PRUNE_DELAY_MS,
  pruneChangesOnce,
  registerChangesPrune,
} from '../changes-maintenance';
import type { ScheduleRow } from '../store/store';

const NOW = new Date('2026-10-09T12:00:00.000Z');

function fakeStore(over: Partial<ReturnType<typeof baseStore>> = {}) {
  const calls: string[] = [];
  return { store: { ...baseStore(calls), ...over }, calls };
}

function baseStore(calls: string[]) {
  return {
    ledgerRekeyed: async () => true,
    consumerFloor: async (): Promise<number | null> => 100,
    firstChangeSeqAt: async () => 1_000,
    headSeq: async () => 2_000,
    publishChangesFloor: async (n: number) => {
      calls.push(`floor:${n}`);
    },
    minChangeSeq: async () => 1,
    deleteChangesRange: async (a: number, b: number) => {
      calls.push(`del:${a}-${b}`);
      return b - a;
    },
    walCheckpoint: async () => {
      calls.push('ckpt');
    },
    scheduleAll: async (): Promise<ScheduleRow[]> => [],
    scheduleUpsert: async (r: ScheduleRow) => {
      calls.push(`upsert:${r.lastRun}:${r.nextRun}`);
    },
    changesFloor: async (): Promise<number | null> => null,
  };
}

describe('changes prune (#59 §3b)', () => {
  it('publishes the floor before any delete, deletes windows below limit, checkpoints every 20 and at the end', async () => {
    const { store, calls } = fakeStore();
    const r = await pruneChangesOnce({
      store,
      activeConsumers: () => ['w'],
      now: () => NOW,
      batch: 2,
      yieldTurn: async () => {},
    });
    // limit = min(floor 100, cutoff 1000, head 2000)
    expect(r).toEqual({ limit: 100, deleted: 99, batches: 50 });
    expect(calls[0]).toBe('floor:100');
    expect(calls[1]).toBe('del:1-3');
    expect(calls.filter((c) => c === 'ckpt')).toHaveLength(3); // 20, 40, end
    expect(calls).toContain('del:99-100');
  });

  it('is a no-op until the re-key repair is done', async () => {
    const { store, calls } = fakeStore({ ledgerRekeyed: async () => false });
    expect(
      await pruneChangesOnce({ store, activeConsumers: () => ['w'], now: () => NOW }),
    ).toEqual({ skipped: 'rekey-pending' });
    expect(calls).toEqual([]);
  });

  it('skips when no attached consumer has a row — never "no floor"', async () => {
    const { store, calls } = fakeStore({ consumerFloor: async () => null });
    expect(
      await pruneChangesOnce({ store, activeConsumers: () => [], now: () => NOW }),
    ).toEqual({ skipped: 'no-consumers' });
    expect(calls).toEqual([]);
  });

  it('the head row survives: limit never exceeds MAX(seq)', async () => {
    const { store, calls } = fakeStore({
      consumerFloor: async () => 50,
      firstChangeSeqAt: async () => 51,
      headSeq: async () => 50,
    });
    const r = await pruneChangesOnce({
      store,
      activeConsumers: () => ['w'],
      now: () => NOW,
      yieldTurn: async () => {},
    });
    expect(r).toMatchObject({ limit: 50 });
    expect(calls).toContain('del:1-50');
  });

  it('first registration seeds lastRun = now (no run at boot); an existing row is kept', async () => {
    const order: string[] = [];
    let job: { cadence: Cadence } | null = null;
    const { store, calls } = fakeStore();
    await registerChangesPrune({
      store,
      scheduler: {
        register: async (id, cadence) => {
          order.push(`register:${id}`);
          job = { cadence };
        },
        trigger: async () => {},
      },
      logs: { log: () => {} },
      activeConsumers: () => ['w'],
      now: () => NOW,
      setTimer: () => {},
    });
    expect(calls[0]).toBe(
      `upsert:${NOW.toISOString()}:${new Date(NOW.getTime() + 6 * 3_600_000).toISOString()}`,
    );
    expect(order).toEqual([`register:${CHANGES_PRUNE_JOB_ID}`]);
    expect(job!.cadence).toEqual(CHANGES_PRUNE_CADENCE);

    const existing = fakeStore({
      scheduleAll: async () => [
        { jobId: CHANGES_PRUNE_JOB_ID, cadence: CHANGES_PRUNE_CADENCE, lastRun: 'x', nextRun: 'y' },
      ],
    });
    await registerChangesPrune({
      store: existing.store,
      scheduler: { register: async () => {}, trigger: async () => {} },
      logs: { log: () => {} },
      activeConsumers: () => ['w'],
      now: () => NOW,
      setTimer: () => {},
    });
    expect(existing.calls.filter((c) => c.startsWith('upsert'))).toEqual([]);
  });

  it('the first-ever run is triggered once, 10 minutes in, only while changesFloor is absent', async () => {
    const timers: number[] = [];
    const triggered: string[] = [];
    let fire: (() => void) | null = null;
    const { store } = fakeStore();
    await registerChangesPrune({
      store,
      scheduler: {
        register: async () => {},
        trigger: async (id) => {
          triggered.push(id);
        },
      },
      logs: { log: () => {} },
      activeConsumers: () => ['w'],
      now: () => NOW,
      setTimer: (fn, ms) => {
        timers.push(ms);
        fire = fn;
      },
    });
    expect(timers).toEqual([FIRST_PRUNE_DELAY_MS]);
    fire!();
    expect(triggered).toEqual([CHANGES_PRUNE_JOB_ID]);

    const pruned = fakeStore({ changesFloor: async () => 5 });
    const t2: number[] = [];
    await registerChangesPrune({
      store: pruned.store,
      scheduler: { register: async () => {}, trigger: async () => {} },
      logs: { log: () => {} },
      activeConsumers: () => ['w'],
      now: () => NOW,
      setTimer: (_fn, ms) => {
        t2.push(ms);
      },
    });
    expect(t2).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing real-store tests**

`src/main/core/engine/__tests__/prune-reseed.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, Change, DocumentInput, Worker } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { pruneChangesOnce, registerChangesPrune } from '../../changes-maintenance';
import { createScheduler } from '../../scheduler';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine } from '../engine';

const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: null,
});
const T = Date.parse('2026-10-09T12:00:00.000Z');

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 8_000) {
  const until = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  }
}

describe('pruning the changes log (#59 §3b)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let clock = T;

  beforeEach(async () => {
    clock = T - 72 * 3_600_000;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prune-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
      now: () => new Date(clock).toISOString(),
    });
    accountId = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
    // Old history: eight documents, each updated once (≥ 16 document changes).
    for (const x of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      // eslint-disable-next-line no-await-in-loop
      await store.commit({ account: accountId, documents: [doc(x)], cursor: x });
      // eslint-disable-next-line no-await-in-loop
      await store.commit({
        account: accountId,
        documents: [{ ...doc(x), markdown: `v2 ${x}` }],
        cursor: x,
      });
    }
    clock = T - 3_600_000; // recent history
    await store.commit({ account: accountId, documents: [doc('recent')], cursor: 'r' });
    clock = T;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeEngine = () =>
    createEngine({
      store,
      sources: { get: () => undefined },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (d) => d,
      logs: { log: () => {} },
    });
  const minSeq = async () => store.minChangeSeq();
  const prune = (over: Partial<Parameters<typeof pruneChangesOnce>[0]> = {}) =>
    pruneChangesOnce({
      store,
      activeConsumers: () => ['worker:live:v1'],
      now: () => new Date(T),
      yieldTurn: async () => {},
      ...over,
    });
  const notes = (name: string, worked: string[]): Worker => ({
    name,
    version: 1,
    matches: (c: Change) =>
      c.kind === 'document' && !c.document.archivedAt && !(name in c.document.metadata),
    async work(c, session) {
      if (c.kind !== 'document') return 'skip';
      worked.push(c.document.externalId);
      session.enrich({ documentId: c.document.id, metadata: { [name]: true } });
      return 'done';
    },
  });

  it('deletes a contiguous prefix below min(floor, 48 h cutoff, head) and keeps the rest', async () => {
    await store.commit({ consumer: 'worker:live:v1', cursor: await store.headSeq() });
    const cutoff = await store.firstChangeSeqAt(new Date(T - 48 * 3_600_000).toISOString());
    const keptBefore = await db.all(`SELECT seq FROM changes WHERE seq >= ? ORDER BY seq`, [cutoff]);
    const r = await prune();
    expect(r).toMatchObject({ limit: cutoff });
    expect(await minSeq()).toBe(cutoff);
    expect(await db.all(`SELECT seq FROM changes ORDER BY seq`)).toEqual(keptBefore);
    expect(await store.changesFloor()).toBe(cutoff);
  });

  it('keeps the head row when everything is older than 48 h', async () => {
    clock = T + 72 * 3_600_000;
    const head = await store.headSeq();
    await store.commit({ consumer: 'worker:live:v1', cursor: head });
    await prune({ now: () => new Date(clock) });
    expect(await db.all(`SELECT seq FROM changes`)).toEqual([{ seq: head }]);
    expect(await store.headSeq()).toBe(head);
  });

  it('interrupted after batch 1: the floor is already published, a returning consumer re-seeds, the next run finishes', async () => {
    await store.commit({ consumer: 'worker:live:v1', cursor: await store.headSeq() });
    await store.commit({ consumer: 'worker:back:v1', cursor: 2 });
    let n = 0;
    const killing = {
      ...store,
      deleteChangesRange: async (a: number, b: number) => {
        n += 1;
        if (n === 2) throw new Error('killed');
        return store.deleteChangesRange(a, b);
      },
    };
    await expect(prune({ store: killing, batch: 4 })).rejects.toThrow('killed');
    const limit = (await store.changesFloor())!;
    expect(limit).toBeGreaterThan(5);
    expect(await minSeq()).toBeLessThan(limit); // garbage below the floor

    const worked: string[] = [];
    const h = makeEngine().attach(notes('back', worked));
    await waitFor(async () => (await store.consumerRow('seed:worker:back:v1')) === null && worked.length === 9);
    await h.stop();
    expect([...worked].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'recent']);

    await prune({ batch: 4 });
    expect(await minSeq()).toBeGreaterThanOrEqual(limit);
  });

  it('an attach between the floor publish and the deletes re-seeds', async () => {
    await store.commit({ consumer: 'worker:mid:v1', cursor: 3 });
    await store.publishChangesFloor(10); // deletes not yet run
    const worked: string[] = [];
    const h = makeEngine().attach(notes('mid', worked));
    await waitFor(async () => (await store.consumerRow('seed:worker:mid:v1')) === null && worked.length === 9);
    await h.stop();
    expect(worked).toHaveLength(9);
  });

  it('a returning cursor inside the deleted range re-seeds', async () => {
    await store.commit({ consumer: 'worker:live:v1', cursor: await store.headSeq() });
    await store.commit({ consumer: 'worker:gone:v1', cursor: 2 });
    await prune();
    const worked: string[] = [];
    const h = makeEngine().attach(notes('gone', worked));
    await waitFor(async () => (await store.consumerRow('seed:worker:gone:v1')) === null && worked.length === 9);
    await h.stop();
    expect(worked).toHaveLength(9);
  });

  it('re-drive (and an audio-style deferral) survive the repair and a prune', async () => {
    const m = (
      (await db.all(`SELECT seq FROM documents WHERE external_id = 'a'`)) as Array<{ seq: number }>
    )[0].seq;
    await store.ledgerRecord('worker:hear:v2', m, 0, 'deferred');
    while (!(await store.ledgerRekeyPage()).done) {
      // already re-keyed on a fresh corpus; pages to the marker anyway
    }
    await store.commit({ consumer: 'worker:live:v1', cursor: await store.headSeq() });
    await prune({ now: () => new Date(T + 72 * 3_600_000) });
    expect(await db.all(`SELECT 1 FROM changes WHERE seq = ?`, [m])).toEqual([]);
    const worker: Worker = {
      name: 'hear',
      version: 2,
      matches: () => true,
      work: async () => 'done',
    };
    await makeEngine().rerunDeferred(worker);
    expect(
      await db.all(`SELECT outcome FROM work_ledger WHERE consumer = 'worker:hear:v2' AND seq = ?`, [m]),
    ).toEqual([{ outcome: 'done' }]);
  });

  it('addedSince keeps its 24 h answer across a prune', async () => {
    await store.commit({ consumer: 'worker:live:v1', cursor: await store.headSeq() });
    const since = new Date(T - 24 * 3_600_000).toISOString();
    const before = await store.addedSince(since);
    await prune();
    expect(await store.addedSince(since)).toEqual(before);
    expect(before).toEqual([{ accountId, count: 1 }]);
  });

  it('pruning does not run at boot (durable row says it just ran)', async () => {
    const scheduler = createScheduler(
      store,
      () => ({ onBattery: false, thermal: 'nominal', appFocus: 'hidden', userActive: false }),
      { log: () => {} },
    );
    await registerChangesPrune({
      store,
      scheduler,
      logs: { log: () => {} },
      activeConsumers: () => ['worker:live:v1'],
      now: () => new Date(T),
      setTimer: () => {},
    });
    const row = (await store.scheduleAll()).find((r) => r.jobId === 'maintenance:prune-changes')!;
    expect(Date.parse(row.nextRun!)).toBeGreaterThanOrEqual(T + 6 * 3_600_000 - 1_000);
  });
});
```

- [ ] **Step 3: Run to verify both fail**

Run: `npx jest src/main/core/__tests__/changes-prune-job.test.ts src/main/core/engine/__tests__/prune-reseed.test.ts --runInBand`
Expected: FAIL, because `pruneChangesOnce`/`registerChangesPrune` are not exported.

- [ ] **Step 4: Implement (append to `src/main/core/changes-maintenance.ts`)**

Extend the imports at the top:

```ts
import type { Cadence, Seq } from '@shared/contracts';

import { nextRun } from './engine/cadence';
```

Append:

```ts
export const CHANGES_PRUNE_JOB_ID = 'maintenance:prune-changes';
export const CHANGES_PRUNE_CADENCE: Cadence = { every: '6h' };
/** Changes newer than this stay (addedSince reads 24 h of them). */
export const CHANGES_RETENTION_MS = 48 * 3_600_000;
/** Delete window, in seqs — one primary-key range per writer call. */
export const PRUNE_BATCH = 50_000;
/** `PRAGMA wal_checkpoint(PASSIVE)` after this many windows (and at the end). */
export const PRUNE_CHECKPOINT_EVERY = 20;
/** The first-ever run, once, this long after a boot that never pruned. */
export const FIRST_PRUNE_DELAY_MS = 10 * 60_000;

export type PruneStore = Pick<
  CoreStore,
  | 'ledgerRekeyed'
  | 'consumerFloor'
  | 'firstChangeSeqAt'
  | 'headSeq'
  | 'publishChangesFloor'
  | 'minChangeSeq'
  | 'deleteChangesRange'
  | 'walCheckpoint'
>;

export type PruneResult =
  | { skipped: 'rekey-pending' | 'no-consumers' }
  | { limit: Seq; deleted: number; batches: number };

/** One prune run (spec §3b). The deleted region is always a contiguous
 *  prefix below `limit = min(active floor, 48 h cutoff, MAX(seq))`. */
export async function pruneChangesOnce(deps: {
  store: PruneStore;
  activeConsumers: () => string[];
  now?: () => Date;
  batch?: number;
  yieldTurn?: () => Promise<void>;
}): Promise<PruneResult> {
  const now = deps.now ?? (() => new Date());
  const batch = deps.batch ?? PRUNE_BATCH;
  const yieldTurn = deps.yieldTurn ?? (() => nextEventLoopTurn());
  // The re-key repair resolves stale ledger rows through `changes`.
  if (!(await deps.store.ledgerRekeyed())) return { skipped: 'rekey-pending' };
  // With 3a every attached consumer has a real row. No attached worker (or
  // none with a row) is never read as "no floor".
  const floor = await deps.store.consumerFloor(deps.activeConsumers());
  if (floor === null) return { skipped: 'no-consumers' };
  const cutoffSeq = await deps.store.firstChangeSeqAt(
    new Date(now().getTime() - CHANGES_RETENTION_MS).toISOString(),
  );
  const head = await deps.store.headSeq();
  // `seq < limit` is deleted, so the head row (MAX(seq)) always survives and
  // headSeq() never regresses.
  const limit = Math.min(floor, cutoffSeq, head);
  // Publish the floor FIRST: from here on a consumer that attaches or
  // returns below it re-seeds, and a crash between windows leaves only
  // garbage below the floor, which the next run deletes.
  await deps.store.publishChangesFloor(limit);
  const min = await deps.store.minChangeSeq();
  let deleted = 0;
  let batches = 0;
  if (min !== null) {
    for (let lo = min; lo < limit; lo += batch) {
      // eslint-disable-next-line no-await-in-loop
      deleted += await deps.store.deleteChangesRange(lo, Math.min(lo + batch, limit));
      batches += 1;
      if (batches % PRUNE_CHECKPOINT_EVERY === 0)
        // eslint-disable-next-line no-await-in-loop
        await deps.store.walCheckpoint();
      // eslint-disable-next-line no-await-in-loop
      await yieldTurn();
    }
  }
  await deps.store.walCheckpoint();
  return { limit, deleted, batches };
}

/** Register `maintenance:prune-changes` (every 6 h). Never at boot: on first
 *  registration the durable row is seeded as "just ran" BEFORE `register`
 *  (which keeps an existing row's lastRun/nextRun). The first-ever run is
 *  triggered once, 10 minutes in, while `meta.changesFloor` is absent. */
export async function registerChangesPrune(deps: {
  store: PruneStore & Pick<CoreStore, 'scheduleAll' | 'scheduleUpsert' | 'changesFloor'>;
  scheduler: Pick<CoreScheduler, 'register' | 'trigger'>;
  logs: LogSink;
  activeConsumers: () => string[];
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => void;
}): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref?.();
    });
  const existing = (await deps.store.scheduleAll()).find(
    (r) => r.jobId === CHANGES_PRUNE_JOB_ID,
  );
  if (!existing) {
    const t = now();
    await deps.store.scheduleUpsert({
      jobId: CHANGES_PRUNE_JOB_ID,
      cadence: CHANGES_PRUNE_CADENCE,
      lastRun: t.toISOString(),
      nextRun:
        nextRun(CHANGES_PRUNE_CADENCE, t.toISOString(), t)?.toISOString() ?? null,
    });
  }
  await deps.scheduler.register(
    CHANGES_PRUNE_JOB_ID,
    CHANGES_PRUNE_CADENCE,
    async () => {
      const r = await pruneChangesOnce({
        store: deps.store,
        activeConsumers: deps.activeConsumers,
        now,
      });
      deps.logs.log(
        'maintenance',
        'info',
        'skipped' in r
          ? `changes prune skipped: ${r.skipped}`
          : `changes pruned below seq ${r.limit}: ${r.deleted} rows in ${r.batches} windows`,
      );
    },
  );
  if ((await deps.store.changesFloor()) === null)
    setTimer(() => {
      void deps.scheduler.trigger(CHANGES_PRUNE_JOB_ID);
    }, FIRST_PRUNE_DELAY_MS);
}
```

- [ ] **Step 5: Wire `boot.ts`**

Extend the `./changes-maintenance` import with `registerChangesPrune`. Right after `registerArchiveSweep({ store, scheduler, logs: sink });`:

```ts
  // #59 §3b: prune `changes` to a bounded tail. Never at boot; first-ever
  // run 10 minutes in; a no-op until the ledger re-key repair is done.
  void registerChangesPrune({
    store,
    scheduler,
    logs: sink,
    activeConsumers: () => engine.activeConsumers(),
  }).catch((err) =>
    sink.log('maintenance', 'error', `changes prune registration failed: ${String(err)}`),
  );
```

- [ ] **Step 6: Run to verify both pass**

Run: `npx jest src/main/core/__tests__/changes-prune-job.test.ts src/main/core/engine/__tests__/prune-reseed.test.ts src/main/core/__tests__/archive-sweep.test.ts --runInBand`
Expected: PASS.

Run: `npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd ~/work/kcore-db
npx eslint src/main/core/changes-maintenance.ts src/main/core/boot.ts src/main/core/__tests__/changes-prune-job.test.ts src/main/core/engine/__tests__/prune-reseed.test.ts
printf 'feat(maintenance): prune the changes log below min(active floor, 48h, head) every 6h (#59)\n\nFloor published before any delete; 50k primary-key windows with a\nsetImmediate between them and a PASSIVE checkpoint every 20 windows;\nnever at boot (lastRun seeded), first-ever run 10 minutes in; no-op until\nthe ledger re-key repair is done.\n' > $SCRATCH/msg-db-t17.txt
git add src/main/core/__tests__/changes-prune-job.test.ts src/main/core/engine/__tests__/prune-reseed.test.ts
git commit -F $SCRATCH/msg-db-t17.txt -- src/main/core/changes-maintenance.ts src/main/core/boot.ts src/main/core/__tests__/changes-prune-job.test.ts src/main/core/engine/__tests__/prune-reseed.test.ts
```

---

### Task 18: Branch gates

**Files:** none new.

- [ ] **Step 1: Typecheck**

Run: `cd ~/work/kcore-db && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `cd ~/work/kcore-db && $HEAVY npm run lint`
Expected: no errors. A warning is acceptable only if the same warning exists on `v0.106.0`: compare by running `git diff --name-only v0.106.0 -- '*.ts'` and checking that no reported warning sits in a file or line this branch changed. Never use `git stash` to get a base tree.

- [ ] **Step 3: Full jest, sequentially, through the heavy lock**

Run: `cd ~/work/kcore-db && $HEAVY npx jest 2>&1 | tee $SCRATCH/db-full-jest.txt | tail -60`
Expected: all suites pass. If a DB/better-sqlite3 suite dies with a jest-worker SIGSEGV at teardown, rerun that one file with `--runInBand`. Compare it against the same file on the base before calling it a failure (Global Constraints).

- [ ] **Step 4: Record**

Record in `$SCRATCH/db-gates.txt`: the tsc and lint results, the jest summary line, and any base comparison you made. Nothing to commit.

---

### Task 19: CONTROLLER — measured before/after on a copy of the founder profile

**CONTROLLER step: an implementer subagent never runs this.** It reads the founder's real profile. Every number in the PR's **Measured** block comes from running real code against a copy of that profile:
- **before** is base `v0.106.0`, run in a base worktree;
- **after** is this branch.

Anything derived from code or reasoning goes in a separate **Estimates** block. There is no unconditional "≤ 60 rows/hour" claim. Status and error rows publish at once, so they are reported separately.

The copy is never opened by an app. Running a copy of a live profile as an app would share its device identity, tunnel and OAuth refresh tokens with the founder's real app.

- [ ] **Step 1: Copy the profile database safely (twice: one per run)**

```bash
ls ~/Library/Application\ Support/*/data/kiagent.db   # pick the PACKAGED (not -dev) profile
SRC="$HOME/Library/Application Support/<Product>/data/kiagent.db"   # <userData>/data/kiagent.db (main.ts + boot.ts)
mkdir -p $SCRATCH/founder-copy
sqlite3 "$SRC" ".backup '$SCRATCH/founder-copy/before.db'"   # consistent even while the app runs
cp $SCRATCH/founder-copy/before.db $SCRATCH/founder-copy/after.db
```

Each run mutates its copy (the branch run re-keys and prunes), so they never share a file.

- [ ] **Step 2: A base worktree with symlinked deps (no npm ci, no build)**

```bash
cd ~/work/kiagent-core && git worktree add $SCRATCH/kcore-base v0.106.0
ln -s ~/work/kiagent-core/node_modules $SCRATCH/kcore-base/node_modules
[ -d ~/work/kiagent-core/release/app/node_modules ] && \
  ln -s ~/work/kiagent-core/release/app/node_modules $SCRATCH/kcore-base/release/app/node_modules
```

Mirror whatever other symlinks `~/work/kcore-db` has (`ls -la ~/work/kcore-db | grep -- '->'`). Teardown happens in Step 7: unlink each link by path **before** `git worktree remove`.

- [ ] **Step 3: The measurement file (uncommitted, identical in both trees)**

Write `src/main/core/__tests__/zz-founder-measure.test.ts` into **both** `$SCRATCH/kcore-base` and `~/work/kcore-db`. Never commit or `git add` it. The file detects the build it runs in:
- the 5 s tick body is copied from each version's `src/main/main.ts` publisher: base calls `ledgerCountsAll` every tick, and the branch calls `createLedgerCounter(…).countIfChanged()`;
- `createProcessingStatus` is the real module of that tree, with the `countWaiting` that `main.ts` passes.

```ts
/** @jest-environment node */
// CONTROLLER-ONLY (#59/#135/#139): measures a COPY of the founder DB with the
// code of the tree it runs in. Never commit.
import fs from 'fs';

import { openDb, type AppDb } from '../../db/app-db';
import { createProcessingStatus } from '../processing-status';
import { openStore } from '../store/store';

const DB = process.env.KIA_MEASURE_DB;
const OUT = process.env.KIA_MEASURE_OUT;
const ACTIVE = (process.env.KIA_MEASURE_ACTIVE ?? '').split(',').filter(Boolean);
const VISION = ACTIVE.find((c) => c.startsWith('worker:vision:')) ?? 'worker:vision:v1';
const MIN = 60_000;

function countCalls(db: AppDb) {
  const calls: string[] = [];
  for (const m of ['all', 'run', 'batch', 'exec'] as const) {
    const orig = (db as any)[m].bind(db);
    (db as any)[m] = (...args: unknown[]) => {
      calls.push(m === 'batch' ? 'batch' : String(args[0]).slice(0, 60));
      return orig(...args);
    };
  }
  return calls;
}

(DB ? it : it.skip)(
  'founder DB copy: processing-counter (ledger/changes) calls per minute, maintenance cost (branch)',
  async () => {
    const out: Record<string, unknown> = { build: '' };
    const db = await openDb(DB!);
    const store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s),
      decrypt: (b: Buffer) => b.toString(),
      detectLanguages: () => [],
    });
    const branch = typeof (store as any).ledgerGen === 'function';
    out.build = branch ? 'branch' : 'base v0.106.0';
    out.changesBefore = await db.all(`SELECT kind, COUNT(*) AS c FROM changes GROUP BY kind`);

    // ── branch only: the one-time maintenance, measured (it must finish
    // before the idle window, as in the app: ruling 13).
    if (branch) {
      let t = Date.now();
      let pages = 0;
      // eslint-disable-next-line no-await-in-loop
      while (!(await (store as any).ledgerRekeyPage()).done) pages += 1;
      out.rekey = { ms: Date.now() - t, pages };
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const { pruneChangesOnce } = require('../changes-maintenance');
      let walPeak = 0;
      t = Date.now();
      out.prune = await pruneChangesOnce({
        store,
        activeConsumers: () => ACTIVE,
        yieldTurn: async () => {
          try {
            walPeak = Math.max(walPeak, fs.statSync(`${DB}-wal`).size);
          } catch {
            // no WAL yet
          }
        },
      });
      out.pruneMs = Date.now() - t;
      out.walPeakBytes = walPeak;
      out.changesAfter = await db.all(`SELECT kind, COUNT(*) AS c FROM changes GROUP BY kind`);
    }

    // ── idle: the processing publisher exactly as main.ts wires it.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    const status = createProcessingStatus({
      countWaiting: () => store.visualWaitingCount(VISION),
      providers: () => [],
      activeCalls: { list: () => [], onChange: () => () => {} } as any,
      wakeWorkers: async () => {},
      patch: () => {},
      warn: () => {},
      ...(branch ? { gen: () => (store as any).ledgerGen() } : {}),
    } as any);
    let tick: () => Promise<unknown>;
    const countMs: number[] = [];
    if (branch) {
      // eslint-disable-next-line global-require, @typescript-eslint/no-var-requires
      const { createLedgerCounter } = require('../processing-counter');
      const counter = createLedgerCounter({ store, activeConsumers: () => ACTIVE });
      await counter.count(); // main.ts: initialLedger
      tick = async () => {
        const t = Date.now();
        await counter.countIfChanged();
        countMs.push(Date.now() - t);
      };
    } else {
      await store.ledgerCountsAll(ACTIVE); // main.ts: initialLedger
      tick = async () => {
        const t = Date.now();
        await store.ledgerCountsAll(ACTIVE);
        countMs.push(Date.now() - t);
      };
    }
    status.start();
    const timer = setInterval(() => {
      status.tick('open', false);
      void tick();
    }, 5_000);
    // Warm-up minute (boot one-shots), then 10 measured minutes.
    await jest.advanceTimersByTimeAsync(MIN);
    const calls = countCalls(db);
    await jest.advanceTimersByTimeAsync(10 * MIN);
    clearInterval(timer);
    status.stop();
    jest.useRealTimers();
    // SCOPE: only the processing publisher (5 s counter + 60 s waiting count),
    // i.e. the spec's "ledger and changes reads at the store boundary". The
    // scheduler, probes and every other idle reader are NOT running here; the
    // application-wide number comes from Task A3 Step 5.
    const ledgerOrChanges = calls.filter((c) =>
      /work_ledger|\bchanges\b|consumers|documents d INDEXED BY docs_pending_visual/i.test(c),
    );
    out.processingCounterLedgerChangesCallsPerMinute = ledgerOrChanges.length / 10;
    out.processingPublisherCallsPerMinute = calls.length / 10;
    out.processingCallSample = [...new Set(calls)].slice(0, 20);
    out.countMs = {
      n: countMs.length,
      median: [...countMs].sort((a, b) => a - b)[Math.floor(countMs.length / 2)] ?? null,
    };

    fs.writeFileSync(OUT!, JSON.stringify(out, null, 2));
    await store.close();
  },
  3_600_000,
);
```

`KIA_MEASURE_ACTIVE` is the consumer names the current workers attach. Read the versions from `src/main/workers/{vision/identity.ts,audio/audio-worker.ts,convert/convert-worker.ts}`, e.g. `worker:vision:v1,worker:audio:v2,worker:convert:v1`. Exclude retired rows such as `worker:audio:v1`. Use the same list in both runs.

- [ ] **Step 4: Run before (base) and after (branch), sequentially**

```bash
ACTIVE=<names>
cd $SCRATCH/kcore-base && KIA_MEASURE_DB=$SCRATCH/founder-copy/before.db KIA_MEASURE_ACTIVE=$ACTIVE \
  KIA_MEASURE_OUT=$SCRATCH/founder-before.json $HEAVY npx jest src/main/core/__tests__/zz-founder-measure.test.ts --runInBand
cd ~/work/kcore-db && KIA_MEASURE_DB=$SCRATCH/founder-copy/after.db KIA_MEASURE_ACTIVE=$ACTIVE \
  KIA_MEASURE_OUT=$SCRATCH/founder-after.json $HEAVY npx jest src/main/core/__tests__/zz-founder-measure.test.ts --runInBand
cat $SCRATCH/founder-before.json $SCRATCH/founder-after.json
```

If better-sqlite3 refuses to load (ABI), use the same workaround the base DB suites need on this machine. Never run `npm ci` or a rebuild in either worktree.

- [ ] **Step 5: Account rows per backfill hour, measured (before: real rows; after: real code on the real timeline)**

**Before.** These are the rows base actually wrote. Base appended one `account` row per account commit, plus one per `setAccountStatus` change, so the base rows *are* the commit timeline:

```bash
sqlite3 $SCRATCH/founder-copy/before.db \
  "SELECT ref_id, substr(at,1,13) AS hour, COUNT(*) AS c FROM changes
    WHERE kind='account' GROUP BY 1,2 ORDER BY c DESC LIMIT 5;" | tee $SCRATCH/founder-acct-before.txt
```

Pick the busiest `(ref_id, hour)` H. Export its timestamps:

```bash
sqlite3 $SCRATCH/founder-copy/before.db \
  "SELECT at FROM changes WHERE kind='account' AND ref_id='<H.ref_id>' AND substr(at,1,13)='<H.hour>' ORDER BY seq;" \
  > $SCRATCH/founder-acct-H.txt
```

**After.** Replay that exact timeline through the branch's real `commitTx`. Each timestamp becomes one progress-only commit (no status or error) on a scratch DB, with the store clock set to that timestamp. Then count the `account` rows the branch appends. Append this second test to the same uncommitted `zz-founder-measure.test.ts` in `~/work/kcore-db` only:

```ts
const TIMELINE = process.env.KIA_MEASURE_TIMELINE;
(TIMELINE ? it : it.skip)('account rows for the busiest backfill hour, replayed on the branch', async () => {
  const stamps = fs.readFileSync(TIMELINE!, 'utf8').split('\n').filter(Boolean);
  const dir = fs.mkdtempSync(`${process.env.TMPDIR ?? '/tmp'}/kia-replay-`);
  let clock = stamps[0];
  const db = await openDb(`${dir}/replay.db`);
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => [],
    now: () => clock,
  });
  clock = new Date(Date.parse(stamps[0]) - 3_600_000).toISOString(); // created an hour earlier
  const acc = await store.createAccount({ source: 'replay', identifier: 'H' });
  const before = ((await db.all(`SELECT COUNT(*) AS c FROM changes WHERE kind='account'`)) as any)[0].c;
  for (const [i, at] of stamps.entries()) {
    clock = at;
    // eslint-disable-next-line no-await-in-loop
    await store.commit({ account: acc.id, documents: [], cursor: i, progress: { done: i } } as any);
  }
  const after = ((await db.all(`SELECT COUNT(*) AS c FROM changes WHERE kind='account'`)) as any)[0].c;
  fs.writeFileSync(
    process.env.KIA_MEASURE_OUT!,
    JSON.stringify({ commitsInHour: stamps.length, progressRowsAfter: after - before }, null, 2),
  );
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
```

```bash
cd ~/work/kcore-db && KIA_MEASURE_TIMELINE=$SCRATCH/founder-acct-H.txt KIA_MEASURE_OUT=$SCRATCH/founder-acct-after.json \
  $HEAVY npx jest src/main/core/__tests__/zz-founder-measure.test.ts --runInBand -t 'replayed on the branch'
```

`progressRowsAfter` is the measured sync-progress count for that hour. **Status and error rows** cannot be separated in the base data, because the base `changes` row carries no payload. Report them separately: the branch publishes each status or error change at once, so its total for H is `progressRowsAfter` plus the number of status/error transitions in H. That second number goes in **Estimates**, unless the live check below measures it.

**Live confirmation (after the A3 hand-off, real data).** After the dev app runs the new core through a real backfill, run the same `GROUP BY ref_id, hour` query on the **dev** profile, limited to `at >` the switch time. Record it as "after, live" next to the replay.

- [ ] **Step 6: Write the PR blocks**

**Measured** (copied founder profile; before = base v0.106.0 code, after = branch code):
- **processing-counter (ledger/changes) calls per minute** at idle: `processingCounterLedgerChangesCallsPerMinute` before and after, plus `processingPublisherCallsPerMinute` and the median count-query ms (`countMs.median`). Label it exactly so. This harness runs only the processing publisher, which is the spec's acceptance scope ("zero ledger and changes reads at the store boundary over 61 idle seconds"). It is **not** the application's idle number;
- **application-wide idle DB statements per minute** (scheduler, probes and every other reader included): before and after, from Task A3 Step 5. It is reported, not a gate;
- account rows in the busiest backfill hour H: the before count from Step 5, and `progressRowsAfter` after (sync progress only). Status and error rows are listed on their own line;
- `changes` rows before and after the first prune (`changesBefore` and `changesAfter` by kind);
- first-prune duration (`pruneMs`) and WAL peak (`walPeakBytes`);
- re-key repair duration and pages (`rekey`).

**Estimates** (not measured, kept apart):
- processing-publisher statements per minute derived from base code: 12 ticks × 3 + 1 = 37;
- status/error rows in H, unless the live check measured them;
- the design ceiling for progress rows: one per account per `ACCOUNT_SYNC_TICK_MS`, excluding status and error rows.

- [ ] **Step 7: Clean up**

```bash
rm ~/work/kcore-db/src/main/core/__tests__/zz-founder-measure.test.ts
cd ~/work/kcore-db && git status --short          # must not list the measure file
rm $SCRATCH/kcore-base/node_modules               # unlink EVERY symlink by path first
[ -L $SCRATCH/kcore-base/release/app/node_modules ] && rm $SCRATCH/kcore-base/release/app/node_modules
ls ~/work/kiagent-core/node_modules | head -1     # the real tree is intact
cd ~/work/kiagent-core && git worktree remove --force $SCRATCH/kcore-base
rm -f $SCRATCH/founder-copy/*.db*                 # the founder copies hold private data
```

---

# Part A (alpha-cent): overlay follow-up, after the core release

Run this part **only after** Tasks 1–19 are merged and released as a core tag, and after the sync workstream merge if that lands first (seed commits then omit `cursor`; nothing in this part depends on it). The overlay patch `build/patch-vision-processing.mjs` rewrites the pinned core's `store.ts`, `engine.ts` and `workers/index.ts` on every fetch. Its `replaceOnce` throws on a missing anchor, so the first product start on the new core fails until A2 lands. A1 and A2 must land in **one** alpha-cent commit range, and nobody may start the app between them.

In this part, `TAG` is the core tag released in A1 (expected `v0.107.0`). Substitute the real one everywhere.

### Task A1: CONTROLLER — release core, bump `core.lock` in a dedicated worktree

**CONTROLLER step.** It releases, pushes and touches the shared checkout.

- [ ] **Step 1: Release core**

Follow the core release runbook. Merge `opt/db` to core `dev`, bump `package.json` to `$TAG`'s version, tag `$TAG`, and push branch and tag. Commit with `-F`, and never amend.

- [ ] **Step 2: Work in a dedicated alpha-cent worktree**

The dev app runs from `~/work/alpha-cent`, and a `core.lock` change or `fetch-core` there restarts it (electronmon), which can kill a live recording.

```bash
cd ~/work/alpha-cent
git worktree add ~/work/ac-db -b chore/core-$TAG-changes-log dev
cd ~/work/ac-db
# symlink deps per the worktree-gates recipe (node_modules, release/app/node_modules); never npm ci here
```

- [ ] **Step 3: Pin the PEELED tag commit**

```bash
cd ~/work/kiagent-core && git fetch --tags && git rev-parse "$TAG^{}"
```

Edit `~/work/ac-db/core.lock`: set `"tag": "$TAG"` and `"commit": "<peeled sha>"`. **Do not commit yet.** A2 lands in the same series.

- [ ] **Step 4: Stage the core**

```bash
cd ~/work/ac-db && node build/fetch-core.mjs
```

If the staged `build/.core` needs its dependencies installed, run `cd build/.core && npm ci --ignore-scripts`. This is the established overlay-gate procedure and the one sanctioned exception in Global Constraints: `--ignore-scripts` keeps the shared better-sqlite3 from being rebuilt. Never run a plain `npm ci` there, and never any `npm ci` in a core worktree. If a re-clone fails with ENOTEMPTY, run `rm -rf build/.core` and re-run. The expected result is that fetch-core **throws** `vision processing overlay: missing due deferred page anchor` (or `engine contract`). That is the signal for A2.

### Task A2: Re-anchor `patch-vision-processing.mjs` to the new core

**Files:**
- Modify: `build/patch-vision-processing.mjs` (`patchVisionStore`, `patchVisionEngine`)
- Create: `build/__fixtures__/core-$TAG-store.ts.txt`, `build/__fixtures__/core-$TAG-engine.ts.txt`, `build/__fixtures__/core-$TAG-workers-index.ts.txt`
- Modify: `build/patch-vision-processing.test.mjs`
- Modify: `src/__tests__/vision-processing.test.ts` (3 tests)

**Interfaces:**
- Consumes (core `$TAG`):
  - `RedriveResult`, and `rerunDeferred(worker: Worker): Promise<RedriveResult>`;
  - `store.ledgerRekeyed()`, `store.markLedgerChanged()`, `store.beginSeed`/`endSeed`, and `consumers` rows named `seed:<consumer>`;
  - the new deferred SQL texts (Task 12);
  - `pruneChangesOnce` from `@main/core/changes-maintenance`.
- Produces (overlay):
  - `rerunMissingVision(worker: Worker): Promise<RedriveResult>`, gated on `ledgerRekeyed`;
  - `ledgerMissingVision`, bounded by the seed cursor while a seed runs;
  - `ledgerRetry`, which moves `ledgerGen`.

- [ ] **Step 1: Snapshot the new core files as fixtures**

```bash
cd ~/work/kiagent-core
git show "$TAG:src/main/core/store/store.ts"   > ~/work/ac-db/build/__fixtures__/core-$TAG-store.ts.txt
git show "$TAG:src/main/core/engine/engine.ts" > ~/work/ac-db/build/__fixtures__/core-$TAG-engine.ts.txt
git show "$TAG:src/main/workers/index.ts"      > ~/work/ac-db/build/__fixtures__/core-$TAG-workers-index.ts.txt
```

Check that `.gitattributes` treats `build/__fixtures__/*.txt` as text, not binary. These are plain text, so no change is expected.

- [ ] **Step 2: Write the failing harness test**

Append to `build/patch-vision-processing.test.mjs`. Extend its import to `import { patchVisionEngine, patchVisionRedrive, patchVisionStore, patchVisionWorker } from './patch-vision-processing.mjs';`, and replace `vX.Y.Z` below with `$TAG`:

```js
const TAG = 'vX.Y.Z';
const fixture = (name) =>
  readFileSync(new URL(`./__fixtures__/core-${TAG}-${name}.ts.txt`, import.meta.url), 'utf8');

test(`the store patch applies to core ${TAG} (seek-friendly deferred SQL, seed-bounded repair, ledgerGen)`, () => {
  const out = patchVisionStore(fixture('store'));
  // The due-retry gate rides on core's own `outcome IS NOT 'skip'` term.
  assert.match(out, /AND outcome IS NOT 'skip'\n\s+AND \(attempts=0/);
  assert.match(out, /AND outcome = 'deferred'\n\s+AND outcome IS NOT 'skip'\n\s+AND \(attempts=0/);
  // While a seed runs, the repair never reaches past the seed cursor.
  assert.match(out, /SELECT cursor FROM consumers WHERE name = 'seed:' \|\| \?/);
  assert.match(out, /\[after, consumer, consumer, consumer, Math\.max\(1, Math\.min\(limit, 100\)\)\]/);
  // The overlay's ledger write moves the idle counter's generation.
  assert.match(out, /store\.markLedgerChanged\(\);/);
  // The index fallback is part of the inserted method (core's own
  // visualWaitingCount carries a separate `.replace(...)` fallback, so scope it).
  assert.match(
    out,
    /async ledgerMissingVision[\s\S]*?\} catch \{\n\s+rows = \(await db\.all\(sql\.replace\(' INDEXED BY docs_pending_visual', ''\), params\)\)/,
  );
  assert.equal(patchVisionStore(out), out);
});

test(`the engine and redrive patches apply to core ${TAG} (repair gated on the re-key)`, () => {
  const engine = patchVisionEngine(fixture('engine'));
  assert.match(engine, /rerunMissingVision\(worker: Worker\): Promise<RedriveResult>;/);
  assert.match(
    engine,
    /async rerunMissingVision\(worker: Worker\): Promise<RedriveResult> \{\n\s+if \(!\(await store\.ledgerRekeyed\(\)\)\) return \{ skipped: 'rekey-pending' \};/,
  );
  assert.equal(patchVisionEngine(engine), engine);
  const redrive = patchVisionRedrive(fixture('workers-index'));
  assert.match(redrive, /await platform\.engine\.rerunMissingVision\(worker\);/);
  assert.equal(patchVisionRedrive(redrive), redrive);
});
```

Run: `cd ~/work/ac-db && node --test build/patch-vision-processing.test.mjs`
Expected: FAIL with `vision processing overlay: missing due deferred page anchor`.

- [ ] **Step 3: Re-anchor `patchVisionStore`**

**(a)** Replace the whole `'retry and repair store methods'` `replaceOnce` call, including its `if (!out.includes('    async ledgerRetry(consumer, seq) {'))` guard, with:

```js
  if (!out.includes('    async ledgerRetry(consumer, seq) {'))
    out = replaceOnce(
      out,
      `    async ledgerCounts(consumer) {`,
      `    async ledgerRetry(consumer, seq) {
      const ts = now();
      await db.run(
        \`INSERT INTO work_ledger(consumer,seq,attempts,outcome,updated_at)
         VALUES(?,?,1,'deferred',?)
         ON CONFLICT(consumer,seq) DO UPDATE SET
           attempts=CASE WHEN work_ledger.outcome='deferred'
             THEN work_ledger.attempts+1 ELSE 1 END,
           outcome=CASE WHEN work_ledger.outcome='deferred'
             AND work_ledger.attempts>=3 THEN 'failed' ELSE 'deferred' END,
           updated_at=excluded.updated_at\`,
        [consumer, seq, ts],
      );
      // core #139: the idle queue counter re-reads only when ledgerGen moves.
      store.markLedgerChanged();
      return (await db.all(
        'SELECT attempts, outcome FROM work_ledger WHERE consumer=? AND seq=?',
        [consumer, seq],
      ))[0] as { attempts: number; outcome: 'deferred' | 'failed' };
    },

    async ledgerMissingVision(consumer, after, limit) {
      // core #59: while seed:<consumer> exists the real cursor sits at h0 and
      // documents past the seed cursor are not missed, just not reached yet.
      const sql = \`SELECT d.seq FROM documents d INDEXED BY docs_pending_visual
         WHERE \${PENDING_VISUAL_WHERE} AND \${ACTIONABLE_VISUAL_SIZE_WHERE}
           AND d.seq > ? AND d.seq <= COALESCE(
             (SELECT cursor FROM consumers WHERE name = 'seed:' || ?),
             (SELECT cursor FROM consumers WHERE name = ?),
             0)
           AND NOT EXISTS (
             SELECT 1 FROM work_ledger l WHERE l.consumer=? AND l.seq=d.seq)
         ORDER BY d.seq LIMIT ?\`;
      const params = [after, consumer, consumer, consumer, Math.max(1, Math.min(limit, 100))];
      let rows: Array<{ seq: number }>;
      try {
        rows = (await db.all(sql, params)) as Array<{ seq: number }>;
      } catch {
        rows = (await db.all(sql.replace(' INDEXED BY docs_pending_visual', ''), params)) as Array<{ seq: number }>;
      }
      return rows.map((row) => row.seq);
    },

    async ledgerCounts(consumer) {`,
      'retry and repair store methods',
    );
```

**(b)** Delete the whole `'repair index fallback'` `replaceOnce` call. Its fallback is now part of (a).

**(c)** Re-anchor `'due deferred page'`. Core now carries the `skip` term itself:

```js
  out = replaceOnce(
    out,
    `          WHERE consumer = ? AND outcome = 'deferred' AND seq > ?
            AND outcome IS NOT 'skip'
          ORDER BY seq LIMIT ?\`,`,
    `          WHERE consumer = ? AND outcome = 'deferred' AND seq > ?
            AND outcome IS NOT 'skip'
            AND (attempts=0
              OR (attempts=1 AND julianday(updated_at) <= julianday('now','-5 minutes'))
              OR (attempts=2 AND julianday(updated_at) <= julianday('now','-30 minutes'))
              OR (attempts=3 AND julianday(updated_at) <= julianday('now','-120 minutes')))
          ORDER BY seq LIMIT ?\`,`,
    'due deferred page',
  );
```

Replace the comment above it (the one that starts "`outcome IS NOT 'skip'` restates core's partial …") with:

```js
  // Core (>= #139) already restates `outcome IS NOT 'skip'` so the planner
  // seeks work_ledger_active; the overlay only adds the due-retry backoff.
```

**(d)** Re-anchor `'due deferred probe'`:

```js
  out = replaceOnce(
    out,
    `        \`SELECT 1 FROM work_ledger WHERE consumer = ? AND outcome = 'deferred'
          AND outcome IS NOT 'skip' LIMIT 1\`,`,
    `        \`SELECT 1 FROM work_ledger WHERE consumer = ? AND outcome = 'deferred'
          AND outcome IS NOT 'skip'
          AND (attempts=0
            OR (attempts=1 AND julianday(updated_at) <= julianday('now','-5 minutes'))
            OR (attempts=2 AND julianday(updated_at) <= julianday('now','-30 minutes'))
            OR (attempts=3 AND julianday(updated_at) <= julianday('now','-120 minutes')))
          LIMIT 1\`,`,
    'due deferred probe',
  );
```

The `'store contract'` anchor (`ledgerCounts(consumer: string): Promise<LedgerCounts>;`) is unchanged.

- [ ] **Step 4: Re-anchor `patchVisionEngine`**

**(a)** `'engine contract'`:

```js
  let out = replaceOnce(
    source,
    '  rerunDeferred(worker: Worker): Promise<RedriveResult>;',
    '  rerunDeferred(worker: Worker): Promise<RedriveResult>;\n  rerunMissingVision(worker: Worker): Promise<RedriveResult>;',
    'engine contract',
  );
```

**(b)** `'vision repair'`: change the before-anchor to `` `    async rerunDeferred(worker: Worker): Promise<RedriveResult> {` ``. The inserted text becomes:

```js
    `    async rerunMissingVision(worker: Worker): Promise<RedriveResult> {
      if (!(await store.ledgerRekeyed())) return { skipped: 'rekey-pending' };
      const consumer = workerConsumerName(worker);
      let after: Seq = 0;
      for (;;) {
        const seqs = await store.ledgerMissingVision(consumer, after, REDRIVE_PAGE);
        if (seqs.length === 0) return undefined;
        after = seqs[seqs.length - 1];
        const changes = await store.changesAt(seqs);
        const enrich: EnrichInput[] = [];
        const docs: DocumentInput[] = [];
        const ledger: LedgerEntry[] = [];
        for (const change of changes) {
          if (!worker.matches(change)) {
            ledger.push({ seq: change.seq, attempts: 0, outcome: 'skip' });
            continue;
          }
          const result = await workOne(worker, change, new AbortController().signal);
          enrich.push(...result.enrich);
          docs.push(...result.docs);
          ledger.push({ seq: change.seq, attempts: result.attempts, outcome: result.outcome });
        }
        if (enrich.length || docs.length)
          await store.commit({
            consumer,
            cursor: await store.consumerCursor(consumer),
            documents: docs.length ? docs : undefined,
            enrich: enrich.length ? enrich : undefined,
          });
        // Like rerunDeferred: the ledger row is this repair's only driver, so
        // it lands only after the page's output is committed.
        if (ledger.length) await store.ledgerRecordMany(consumer, ledger);
      }
    },

    async rerunDeferred(worker: Worker): Promise<RedriveResult> {`,
```

(`store.changesAt` reads `documents` since core #59, so the repair works after a prune.) The `'worker retry outcome'` anchor and `patchVisionRedrive` are unchanged. Step 2's redrive assertions confirm this against the fixture.

- [ ] **Step 5: Run the harness**

Run: `cd ~/work/ac-db && node --test build/patch-vision-processing.test.mjs`
Expected: PASS, including the existing v0.104.0 worker test.

Run: `cd ~/work/ac-db && node build/fetch-core.mjs`
Expected: no overlay error. `grep -n "seed:' ||" build/.core/src/main/core/store/store.ts` shows the patched method.

- [ ] **Step 6: Write the failing integration tests**

Add to `src/__tests__/vision-processing.test.ts`. Extend the imports with `import { pruneChangesOnce } from '@main/core/changes-maintenance';` and add these helpers after `session()`:

```ts
const scan = (externalId: string) => ({
  externalId,
  type: 'attachment',
  title: `${externalId}.pdf`,
  markdown: null,
  metadata: { mime: 'application/pdf', sizeBytes: 50_000, conversion: SCANNED },
  createdAt: '2026-01-01T00:00:00Z',
});

const recoverWorker = (worked: string[] = []) => ({
  name: 'vision',
  version: 1,
  matches: (change: Change) =>
    change.kind === 'document' && !change.document.metadata.extraction,
  work: async (change: Change, workerSession: WorkerSession) => {
    if (change.kind !== 'document') return 'skip' as const;
    worked.push(change.document.externalId);
    workerSession.enrich({
      documentId: change.document.id,
      markdown: 'Recovered text from scan',
      metadata: { extraction: { engine: 'local-ocr', at: '2026-01-01T00:00:00Z' } },
    });
    return 'done' as const;
  },
});

async function visionFixture(prep?: (db: Awaited<ReturnType<typeof openDb>>) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-vision-59-'));
  const db = await openDb(path.join(dir, 'test.db'));
  await prep?.(db);
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => ['eng'],
  });
  const engine = createEngine({
    store,
    sources: { get: () => undefined },
    inference: {
      complete: async () => '',
      see: async () => '',
      read: async () => '',
      hear: async () => '',
    },
    convert: async (input) => input,
    logs: { log: () => {} },
  });
  const account = await store.createAccount({ source: 'test', identifier: 'local' });
  const cleanup = async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, store, engine, account, cleanup };
}
```

Tests:

```ts
it('holds the missed-vision repair until the ledger re-key repair is done', async () => {
  // An upgraded profile: the re-key marker is absent until the repair runs.
  const f = await visionFixture(async (db) => {
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`);
  });
  try {
    await f.store.commit({ account: f.account.id, documents: [scan('missed')], cursor: 1 });
    await f.store.commit({ consumer: VISION_CONSUMER, cursor: await f.store.headSeq() });
    const worked: string[] = [];
    expect(await f.engine.rerunMissingVision(recoverWorker(worked))).toEqual({
      skipped: 'rekey-pending',
    });
    expect(worked).toEqual([]);
    while (!(await f.store.ledgerRekeyPage()).done) {
      // drain the repair
    }
    expect(await f.engine.rerunMissingVision(recoverWorker(worked))).toBeUndefined();
    expect(worked).toEqual(['missed']);
  } finally {
    await f.cleanup();
  }
});

it('never treats documents past the seed cursor as missed while a seed runs', async () => {
  const f = await visionFixture();
  try {
    await f.store.commit({
      account: f.account.id,
      documents: [scan('first'), scan('second')],
      cursor: 1,
    });
    const seqs = (
      (await f.db.all(
        `SELECT seq FROM documents WHERE type = 'attachment' ORDER BY seq`,
      )) as Array<{ seq: number }>
    ).map((r) => r.seq);
    await f.store.beginSeed(VISION_CONSUMER, await f.store.headSeq());
    expect(await f.store.ledgerMissingVision(VISION_CONSUMER, 0, 10)).toEqual([]);
    await f.store.commit({ consumer: VISION_CONSUMER, cursor: await f.store.headSeq(), seedCursor: seqs[0] });
    expect(await f.store.ledgerMissingVision(VISION_CONSUMER, 0, 10)).toEqual([seqs[0]]);
    await f.store.endSeed(VISION_CONSUMER);
    expect(await f.store.ledgerMissingVision(VISION_CONSUMER, 0, 10)).toEqual(seqs);
  } finally {
    await f.cleanup();
  }
});

it('repairs a missed visual document after its change row was pruned', async () => {
  const f = await visionFixture();
  try {
    await f.store.commit({ account: f.account.id, documents: [scan('old')], cursor: 1 });
    await f.store.commit({ account: f.account.id, documents: [scan('newer')], cursor: 2 });
    const [old] = (await f.db.all(
      `SELECT id, seq FROM documents WHERE external_id = 'old'`,
    )) as Array<{ id: string; seq: number }>;
    await f.store.commit({ consumer: VISION_CONSUMER, cursor: await f.store.headSeq() });
    // Mark 'newer' handled so only 'old' is missed.
    const [newer] = (await f.db.all(
      `SELECT seq FROM documents WHERE external_id = 'newer'`,
    )) as Array<{ seq: number }>;
    await f.store.ledgerRecord(VISION_CONSUMER, newer.seq, 1, 'done');
    const r = await pruneChangesOnce({
      store: f.store,
      activeConsumers: () => [VISION_CONSUMER],
      now: () => new Date(Date.now() + 72 * 3_600_000),
      yieldTurn: async () => {},
    });
    expect(r).toMatchObject({ limit: await f.store.headSeq() });
    expect(await f.db.all(`SELECT 1 FROM changes WHERE seq = ?`, [old.seq])).toEqual([]);
    await f.engine.rerunMissingVision(recoverWorker());
    expect((await f.store.read.document(old.id as never))?.markdown).toBe(
      'Recovered text from scan',
    );
  } finally {
    await f.cleanup();
  }
});
```

Run: `cd ~/work/ac-db && npx jest src/__tests__/vision-processing.test.ts --runInBand`
Expected before Steps 3–4 are applied to the staged core: compile errors or a FAIL. After them (Step 5 re-staged `build/.core`): PASS, all 8 tests. If `VISION_CONSUMER` is not `'worker:vision:v1'` on `$TAG`, the tests still hold because they use the constant.

- [ ] **Step 7: Commit (one series, lock and overlay together)**

```bash
cd ~/work/ac-db
printf 'chore(core): pin kiagent-core %s (changes-log prune, seeding, idle DB) + re-anchor vision overlay\n\nOverlay: due-retry terms ride on core'"'"'s outcome IS NOT '"'"'skip'"'"' SQL;\nrerunMissingVision gated on store.ledgerRekeyed(); ledgerMissingVision\nbounded by seed:<consumer> while a seed runs, index fallback inlined;\nledgerRetry calls store.markLedgerChanged().\n' "$TAG" > $SCRATCH/msg-ac-a2.txt
git add build/__fixtures__/core-$TAG-store.ts.txt build/__fixtures__/core-$TAG-engine.ts.txt build/__fixtures__/core-$TAG-workers-index.ts.txt
git commit -F $SCRATCH/msg-ac-a2.txt -- core.lock build/patch-vision-processing.mjs build/patch-vision-processing.test.mjs build/__fixtures__/core-$TAG-store.ts.txt build/__fixtures__/core-$TAG-engine.ts.txt build/__fixtures__/core-$TAG-workers-index.ts.txt src/__tests__/vision-processing.test.ts
```

### Task A3: alpha-cent gates

- [ ] **Step 1: Harness and targeted tests**

Run: `cd ~/work/ac-db && npm run test:harness`
Expected: PASS.

Run: `cd ~/work/ac-db && npx jest src/__tests__/vision-processing.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 2: Typecheck (overlay included)**

Run: `cd ~/work/ac-db && $HEAVY npm run typecheck && $HEAVY npm run typecheck:overlay`
Expected: no errors. `typecheck:overlay` re-clones `build/.core`. Never run it while a dev app runs from this worktree.

- [ ] **Step 3: Lint**

Run: `cd ~/work/ac-db && $HEAVY npm run lint`
Expected: no errors.

- [ ] **Step 4: Hand-off**

Report the commit SHA. The CONTROLLER merges it to alpha-cent `dev` and restarts the dev app. On that first start, the repair job runs (look for `ledger re-key` in the logs). The first prune follows 10 minutes later (`changes pruned below seq …`). The vision queue count must stay put through both.

- [ ] **Step 5: CONTROLLER — application-wide idle DB statements per minute, before/after (reported, not a gate)**

**CONTROLLER step, run by the coordinator.** It measures every statement the whole dev app runs at idle: the scheduler tick (`scheduleAll`), probes, the processing publisher and everything else. The run uses a copy of the founder profile, before (core `v0.106.0`) and after (core `$TAG` with A2's overlay).

Safety:
- Turn the network **off** (Wi-Fi off, no Ethernet) for both runs. An idle measurement needs no network, and a copied profile online would share the founder's device identity, remote tunnel and OAuth refresh tokens with the real app.
- Never run two dev apps at once.
- Use dedicated worktrees, never `~/work/alpha-cent` (its dev app restarts on core changes).

1. Copy the profile directory once per run, with a consistent DB. The app opens `<userData>/data/kiagent.db` (`main.ts` builds `<userData>/data`, and `boot.ts` opens `data/kiagent.db` in it), so the backup source, the destination and the WAL/SHM cleanup all use that path:

```bash
SRC_DIR="$HOME/Library/Application Support/<Product>"     # the packaged profile's userData
ls "$SRC_DIR/data/kiagent.db"                               # must exist; never <userData>/kiagent.db
for run in before after; do
  rm -rf $SCRATCH/profile-$run && cp -R "$SRC_DIR" $SCRATCH/profile-$run
  rm -f $SCRATCH/profile-$run/data/kiagent.db-wal $SCRATCH/profile-$run/data/kiagent.db-shm
  sqlite3 "$SRC_DIR/data/kiagent.db" ".backup '$SCRATCH/profile-$run/data/kiagent.db'"
done
```

2. Add a temporary statement trace (**never committed**) through a **temporary overlay hook** in the measurement worktree's `build/apply-overlay.mjs`. `fetch-core` restores every tracked core file on reuse (`git checkout -- .`) and then calls `applyOverlay`, and both `dev-product.mjs` and `start:prepare` run it before webpack compiles. A hand edit to `build/.core` is therefore always wiped, while a hook at the **end** of `applyOverlay` re-applies after the last fetch/overlay step and before compilation, on every start. At the end of `applyOverlay`, just before `return { shadows };`, add:

```js
  // TEMPORARY (Task A3 Step 5 measurement) — never commit.
  if (process.env.KIA_MEASURE_SQL) {
    const appDb = path.join(coreSrc, 'main', 'db', 'app-db.ts');
    patchFile(appDb, (src) => {
      if (src.includes('KIA_MEASURE_SQL')) return src;
      const trace = `const kiaTrace = process.env.KIA_MEASURE_SQL
  ? { verbose: (sql: unknown) => fs.appendFileSync(process.env.KIA_MEASURE_SQL!,
      \`\${Date.now()}\\t\${String(sql).replace(/\\s+/g, ' ').slice(0, 120)}\\n\`) }
  : {};
`;
      const out = src
        .replace('const conn = new Database(filePath);', 'const conn = new Database(filePath, { ...kiaTrace });')
        .replace(
          'const conn = new Database(filePath, { fileMustExist: true });',
          'const conn = new Database(filePath, { fileMustExist: true, ...kiaTrace });',
        )
        .replace("import Database from 'better-sqlite3';", `import Database from 'better-sqlite3';\n${trace}`);
      if ((out.match(/\.\.\.kiaTrace/g) ?? []).length !== 2)
        throw new Error('measurement trace hook: app-db.ts anchors moved');
      return out;
    });
  }
```

better-sqlite3's `verbose` hook fires once per executed statement on every connection: the writer worker and the read worker. Both `openDb` and `openCorpusReadConnection` live in that file.

3. **Before.** Use a throwaway alpha-cent worktree at `origin/dev` (pins `v0.106.0`), with deps symlinked per the worktree recipe (unlink `extensions/*/node_modules` links before starting a dev app there). Apply the step-2 hook there, then start:

```bash
cd $SCRATCH/ac-measure-before && KIAGENT_USER_DATA=$SCRATCH/profile-before \
  KIA_MEASURE_SQL=$SCRATCH/sql-before.log node build/dev-product.mjs
```

Check the hook landed: `grep -c kiaTrace build/.core/src/main/db/app-db.ts` must be ≥ 3. Do not touch the app. Note the boot time T0. The window is `[T0 + 15 min, T0 + 25 min]`; the 15-minute warm-up covers boot one-shots and the first-prune timer. Quit the app after T0 + 25 min.

4. **After.** Start from `~/work/ac-db` once A2 is committed there (core `$TAG` with the overlay). Apply the same step-2 hook there (uncommitted), then use the same commands with `profile-after` and `sql-after.log`. The first boot also runs the re-key repair and, 10 minutes in, the first prune. Before opening the window, confirm both finished in the logs (`ledger re-key` done, `changes pruned below seq`). If the prune finishes after T0 + 15 min, start the window when it finishes.

**Accept a run only if its trace is real.** The log must be non-empty, every minute of the window must contain lines, and it must hold the known scheduler statement, which the 30 s scheduler tick reads through `scheduleAll`:

```bash
for run in before after; do
  f=$SCRATCH/sql-$run.log
  test -s $f || { echo "$run: EMPTY trace — reject"; continue; }
  grep -c 'SELECT \* FROM schedule' $f    # must be > 0 (≈ 2 per minute of uptime)
done
```

Discard and redo any run that fails this check: the hook did not apply, or the app did not boot on the copied profile.

5. Count each window:

```bash
for run in before after; do
  awk -F'\t' -v a=<window start ms> -v b=<window end ms> '$1>=a && $1<b {n++; s[$2]++}
    END {printf "%s: %.1f statements/min\n", FILENAME, n/10;
         for (k in s) print s[k]"\t"k | "sort -rn | head -15"}' $SCRATCH/sql-$run.log
done | tee $SCRATCH/app-idle-sql.txt
```

6. Report in the PR (core and alpha-cent) as **Measured, application-wide idle DB statements per minute (reported, not a gate)**: before and after, with the top statement shapes of each. The ledger/changes lines among them should drop to zero, while scheduler reads such as `scheduleAll` remain.

7. Clean up. In both measurement worktrees, drop the temporary hook (`git checkout -- build/apply-overlay.mjs`, and check that `git status --short build/` is clean). Then re-stage the core with `rm -rf build/.core && node build/fetch-core.mjs` and confirm with `grep -c kiaTrace build/.core/src/main/db/app-db.ts`, which must print 0. Delete `$SCRATCH/profile-*` and `$SCRATCH/sql-*.log`, because they hold private data. Turn the network back on.
