# Mail Folder Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Checkbox folder selection on running mail accounts. MS365 gets a tree of every Outlook folder; Gmail gets opt-in Trash and Spam. Both go through core's existing `folderScope` picker and Tracked folders card.

**Architecture:**
- Core gains five small, independent pieces:
  - exact `archiveRefs` in a scope save
  - a picker `note`
  - allowance kinds (`full` | `ratio`)
  - no reconcile for an account with no declared scope
  - reconcile staging continuity
- Gmail (a core source) gains one bucket per thread (`mail` | `TRASH` | `SPAM`), which is both its scope stamp and part of its hash, plus a task-queue cursor.
- The MS365 connector:
  - discovers the tracked folder tree each operation
  - enumerates via per-folder delta
  - gates emission on folder membership
  - lists membership in `reconcile()`
  - computes `archiveRefs` in `manageFolders`

**Tech Stack:** TypeScript, Jest, better-sqlite3 (core store), Electron main/renderer (core), esbuild (connector), Microsoft Graph v1.0, Gmail API v1.

**Spec:** `docs/superpowers/specs/2026-09-24-mail-folder-scope-design.md` (kiagent-core worktree `/Users/edjafarov/work/kiagent-core-agent-sessions`, approved 2026-09-24, head 83fa76e2)

## Global Constraints

- Core work happens on branch `feat/mail-folder-scope`, created from `spec/mail-folder-scope`, in `/Users/edjafarov/work/kiagent-core-agent-sessions`.
- Connector work happens on branch `feat/folder-scope` in `/Users/edjafarov/work/ms365-kia-connector`.
- `PLATFORM_API_VERSION` becomes `'2.4.0'` (additive: `archiveRefs`, `note`). SDK becomes 1.5.0. MS365 manifest engine is `^2.4.0` and its version 2.1.0.
- Commit messages: no `Co-Authored-By`, never `--no-verify`, never amend/rebase/reset/stash. Use `git commit -F <file>` when the message contains backticks.
- Shell: `/usr/bin/grep`, `/bin/ls`, `/bin/cat`, `/usr/bin/sed`. `diff` is a git function; use `cmp -s`. In zsh, pass command lists as arrays.
- Core test runs: `npx jest <path>` from the core worktree. Typecheck: `npm run typecheck`. Connector: `npm test`, `npm run typecheck`, `npm run build`.
- Copy strings, verbatim from the spec:
  - card default text: `Default folders — Manage to change`
  - MS365 note: `Mail outside the selected folders will be removed from the index`
  - Gmail bucket names: `All mail — Inbox, Sent, archived and labelled`, `Trash`, `Spam (may contain phishing)`
  - MS365 Junk label suffix: ` (may contain phishing)`
- User decision (spec §4): a Gmail thread whose bucket is not selected is **skipped**, neither emitted nor deleted.
- Release (tags, SDK release, marketplace release, core.lock bump) is **not** in this plan. It is gated on the user.

## Review Focus

1. **A Save while the DB worker restarts mid-reconcile:** nothing archives under any allowance kind (A1 test covers `full`, `ratio`, none).
2. **An MS365 legacy account (no `folderRoots`) after upgrade:** no reconcile runs, and nothing indexed disappears (B4 + A3 tests).
3. **A Gmail thread with an unchanged label union whose bucket flips:** it re-stamps (A7 hash test).
4. **An MS365 conversation queued in `pending` or `retry` whose messages all left the tracked set before fetch:** deletion, not resurrection (B4 emission-gate test).
5. **A picker note crossing child → proxy → broker → renderer:** visible before Save (A5 wire + modal tests).

## Execution notes

- Fable architecture review checkpoints (high level, no nitpicks, coherence + simplification pointers only):
  - Part A after A2 (15%), after A3 (25%), after A5 (50%)
  - Part B after B1 (15%), after B2 (25%), after B4 (50%)
- Final whole-branch review per executing-plans after each part.

---

# Part A — Core (kiagent-core)

### Task A0: Branch

- [ ] **Step 1:** `cd /Users/edjafarov/work/kiagent-core-agent-sessions && git switch -c feat/mail-folder-scope`. Expected: `Switched to a new branch`.

### Task A1: Reconcile staging continuity

**Files:**
- Modify: `src/main/core/store/write-tx.ts` (staging helpers ~643-660, `reconcileStage`/`reconcileDiff`/`reconcileArchive`/`reconcileEnd` ~891-940)
- Modify: `src/main/core/engine/engine.ts` (`reconcilePass`, ~221-335)
- Test: `src/main/core/store/__tests__/write-tx.test.ts`, `src/main/core/engine/__tests__/engine.test.ts`

**Interfaces:**
- Produces: `export class ReconcileStagingLost extends Error` (in `write-tx.ts`, message prefix `reconcile staging lost`).
  - `reconcileBegin` creates `temp.reconcile_pass(account_id TEXT PRIMARY KEY)` and inserts the account.
  - `reconcileStage`, `reconcileDiff` and `reconcileArchive` throw `ReconcileStagingLost` when the marker row is missing. They never recreate the table.
  - `reconcileEnd` and the end of `reconcileArchive` delete the marker.
- Worker RPC keeps the same procedure names and args. Errors cross as `Error.message`, so the engine matches on the message prefix.

- [ ] **Step 1: failing store test** (write-tx.test.ts, a new `describe('reconcile staging continuity')`). It uses the file's existing in-memory `conn` + `createWriteTx` setup:

```ts
it('stage after the TEMP tables vanish throws instead of recreating', () => {
  wt.reconcileBegin('acc');
  wt.reconcileStage('acc', [{ externalId: 'a', type: 'note' }]);
  // A DB-worker restart = a fresh connection: TEMP objects are gone.
  conn.exec('DROP TABLE temp.reconcile_listing');
  conn.exec('DROP TABLE IF EXISTS temp.reconcile_pass');
  expect(() => wt.reconcileStage('acc', [{ externalId: 'b', type: 'note' }]))
    .toThrow(/reconcile staging lost/);
  expect(() => wt.reconcileDiff('acc', 0)).toThrow(/reconcile staging lost/);
  expect(() => wt.reconcileArchive('acc', 0)).toThrow(/reconcile staging lost/);
});
it('a pass never begun cannot stage', () => {
  expect(() => wt.reconcileStage('other', [{ externalId: 'x', type: 'note' }]))
    .toThrow(/reconcile staging lost/);
});
it('begin → stage → diff → archive still works and ends the pass', () => {
  wt.reconcileBegin('acc');
  wt.reconcileStage('acc', [{ externalId: 'a', type: 'note' }]);
  expect(wt.reconcileDiff('acc', 1e9).listedCount).toBe(1);
  wt.reconcileArchive('acc', 1e9);
  expect(() => wt.reconcileDiff('acc', 1e9)).toThrow(/reconcile staging lost/);
});
```

(Adapt `wt`/`conn`/account seeding to the file's existing helpers. The account must exist for FK-free TEMP tables; no FK is needed.)

- [ ] **Step 2:** `npx jest src/main/core/store/__tests__/write-tx.test.ts -t "staging continuity"`. Expected: FAIL. Stage recreates the table and does not throw.

- [ ] **Step 3: implement** in write-tx.ts:

```ts
export class ReconcileStagingLost extends Error {
  constructor(accountId: string) {
    super(`reconcile staging lost for ${accountId} — the DB connection restarted mid-pass; nothing archived`);
    this.name = 'ReconcileStagingLost';
  }
}
// inside createWriteTx:
const ensureStagingTables = (): void => {
  ensureListingTable();
  conn.exec(`CREATE TEMP TABLE IF NOT EXISTS reconcile_pass (account_id TEXT PRIMARY KEY) WITHOUT ROWID`);
};
const hasTempTable = (name: string): boolean =>
  !!conn.prepare(`SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name=?`).get(name);
const requirePass = (accountId: string): void => {
  if (!hasTempTable('reconcile_pass') || !hasTempTable('reconcile_listing') ||
      !conn.prepare(`SELECT 1 FROM reconcile_pass WHERE account_id = ?`).get(accountId))
    throw new ReconcileStagingLost(accountId);
};
const endPass = (accountId: string): void => {
  if (hasTempTable('reconcile_listing'))
    conn.prepare(`DELETE FROM reconcile_listing WHERE account_id = ?`).run(accountId);
  if (hasTempTable('reconcile_pass'))
    conn.prepare(`DELETE FROM reconcile_pass WHERE account_id = ?`).run(accountId);
};
```

Then:
- `reconcileBegin`: `ensureStagingTables(); clearListing(accountId); INSERT OR REPLACE INTO reconcile_pass VALUES(?)`.
- `reconcileStage`: `requirePass` first, **even for empty refs**; drop `ensureListingTable()`.
- `reconcileDiff`: `requirePass` instead of `ensureListingTable`.
- `reconcileArchive`: `requirePass`, loop as today, then `endPass`.
- `reconcileEnd`: `endPass`.

Keep the `clearListing` helper for Begin only.

- [ ] **Step 4:** run Step 2's command. Expected: PASS. Then run the whole file: `npx jest src/main/core/store/__tests__/write-tx.test.ts`. Expected: all green.

- [ ] **Step 5: failing engine test** (engine.test.ts `describe('reconcile')`): a real restart between two stage batches. The harness is in-process, so simulate the restart by dropping the TEMP tables through the store's raw connection between batches. If the test store exposes no raw connection, use the store's `db` test hook or `jest.spyOn(store,'reconcileStage')` to throw `new Error('reconcile staging lost for x')` on the second call.

```ts
it('staging lost mid-pass (restart between batches) archives nothing, even with an allowance', async () => {
  const source = hangingSource({
    async *reconcile() {
      yield Array.from({ length: RECONCILE_STAGE_BATCH }, (_, i) => ({ externalId: `x${i}`, type: 'note' }));
      yield [{ externalId: 'a', type: 'note' }];
    },
  });
  const engine = makeEngine(source);
  const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);
  const real = store.reconcileStage.bind(store);
  let n = 0;
  jest.spyOn(store, 'reconcileStage').mockImplementation(async (id, refs) => {
    n += 1;
    if (n === 2) throw new Error(`reconcile staging lost for ${id} — restarted`);
    return real(id, refs);
  });
  const archive = jest.spyOn(store, 'reconcileArchive');
  const handle = engine.run(account);
  await waitFor(async () => !!(await store.account(account.id))?.lastError);
  await handle.stop();
  expect((await store.account(account.id))?.lastError).toMatch(/reconcile staging lost/);
  expect(archive).not.toHaveBeenCalled();
  expect(await store.read.count({ account: account.id })).toBe(3);
});
```

- [ ] **Step 6:** `npx jest src/main/core/engine/__tests__/engine.test.ts -t "staging lost mid-pass"`. It may already PASS, because the drain loop's catch already refuses. If it does, record it in the ledger as a pinning test and do not claim red. Then add the diff-time variant: `reconcileDiff` rejects with the staging-lost message, and the expectation is lastError set, `reconcileArchive` not called, 3 docs live. Run it. Expected: FAIL today, because a diff rejection escapes `reconcilePass` to the `.catch` backstop, which logs "reconcile pass crashed" and writes no account error.

- [ ] **Step 7: implement** in `reconcilePass`: wrap `reconcileDiff` and `reconcileArchive` in a try/catch mirroring the drain catch. On error:
  - `reconcileEnd`, swallowing its own error
  - `logs.log(scope,'error',…)`
  - commit `error: 'reconcile: ' + msg`
  - return

- [ ] **Step 8:** `npx jest src/main/core/engine/__tests__/engine.test.ts src/main/core/store/__tests__/write-tx.test.ts src/main/db`. Expected: green.

- [ ] **Step 9: commit** `fix(store): reconcile staging never recreates — a pass that lost its TEMP staging archives nothing`.

### Task A2: Allowance kinds `full` | `ratio`

**Files:**
- Modify: `src/main/core/engine/engine.ts`: `reconcileAllowances` (484), grants (780, 1340, 1520), consumption (917), `reconcilePass` param
- Test: `src/main/core/engine/__tests__/account-flows.test.ts` (next to the C-35 tests ~970-1045)

**Interfaces:**
- Produces: `type AllowanceKind = 'full' | 'ratio'`. `reconcileAllowances: Map<AccountId, AllowanceKind>`. `reconcilePass(..., allowance: AllowanceKind | undefined)`.
- Rules:
  - `undefined` refuses both the empty listing and the ratio.
  - `'ratio'` refuses the empty listing only.
  - `'full'` refuses neither (today's `true`).
- Grants:
  - connect/updateConfig (780, 1520): `'full'`, unchanged semantics.
  - `applyScope`: `res.archived > 0` → `'full'`. Else if the prior config had no scope (no `folderRoots` array, no `roots`, no `paths`) → `'ratio'`. Else if the prior root-id set equals the new one → `'ratio'`. Else nothing.
- Helper `export function declaredScopeIds(config: Record<string, unknown>): string[] | null` in engine.ts:
  - returns `folderRoots[].id` if that is an array
  - else `roots[].rootFolderId` if an array
  - else `paths` if an array of strings
  - else `null`
- A merge never downgrades: `full` beats `ratio`.

- [ ] **Step 1: failing tests** (account-flows.test.ts, reusing `seededNoAllowance`, `emptyListingSource`, `reconcileSettled`, `CONFIG_AT_OPEN`). Add a `ratioListingSource()` whose reconcile yields `[{externalId:'d1',type:<doc type>}]` (listed 1 of 3 → 2 missing: over the ratio but below MASS_ARCHIVE_MIN_DOCS). Seed 150 docs instead so the ratio arm fires. Seeding helper: `docsN(150,'a')`.

```ts
it('an unchanged re-save grants a RATIO allowance: a complete >50% shrink archives', async () => {
  // 150 live docs, listing names 10 → 140 missing > MIN and > 50%
});
it('an unchanged re-save does NOT bypass the empty-listing refusal', async () => {
  // emptyListingSource + unchanged roots → lastError /listing came back empty/, count unchanged
});
it('a first scope declaration (prior config had no scope) grants a RATIO allowance', async () => {
  // account created with config {} (no folderRoots); applyScope with folderRoots [{a}]
  // expectedConfigJson = JSON.stringify({}); ratio source → archives
});
it('a first declaration still refuses an empty listing', async () => { /* emptyListingSource */ });
it('a pure widening still grants nothing (C-35 unchanged)', async () => { /* existing test stays green */ });
```

Write full bodies following the C-35 test at ~970: mock `store.applyFolderScope` to return `{archived:0,…}`, call `engine.applyScope(account.id, update, expectedConfigJson)`, then `await waitFor(reconcileSettled(account.id))` and `engine.stopAll()`.

- [ ] **Step 2:** `npx jest src/main/core/engine/__tests__/account-flows.test.ts -t "allowance"`. Expected: the re-save and first-declaration archive tests FAIL (refused: listing shrank suspiciously). The empty-listing ones pass (pinning).

- [ ] **Step 3: implement** per Interfaces. In `reconcilePass` replace `if (!allowMassArchive) { … }` with:

```ts
if (allowance !== 'full') {
  // refuse() as today
  if (listedCount === 0) { await refuse('the listing came back empty'); return; }
  if (allowance !== 'ratio' && deletionCount > MASS_ARCHIVE_MIN_DOCS && deletionCount > liveCount * MASS_ARCHIVE_RATIO) {
    await refuse('the listing shrank suspiciously'); return;
  }
}
```

In `applyScope` after `res`:

```ts
const priorIds = declaredScopeIds(JSON.parse(expectedConfigJson) as Record<string, unknown>);
const nextIds = update.config.folderRoots.map((r) => r.id);
const sameSet = priorIds !== null && priorIds.length === nextIds.length && priorIds.every((id) => nextIds.includes(id));
const kind: AllowanceKind | undefined =
  res.archived > 0 ? 'full' : priorIds === null || sameSet ? 'ratio' : undefined;
if (kind) grantAllowance(accountId, kind);
```

with `grantAllowance = (id, k) => { if (reconcileAllowances.get(id) !== 'full') reconcileAllowances.set(id, k); }`.

- [ ] **Step 4:** run the whole `account-flows.test.ts` and `engine.test.ts`. Expected: green, including the existing C-35 pair.

- [ ] **Step 5: commit** `feat(engine): allowance kinds — first scope declaration and unchanged re-save grant a ratio-only allowance`.

**➜ Fable review checkpoint (Part A 15%).**

### Task A3: No reconcile without declared scope

**Files:**
- Modify: `src/main/core/engine/engine.ts` (~905, the `if (src.reconcile)` gate)
- Test: `src/main/core/engine/__tests__/engine.test.ts`

- [ ] **Step 1: failing tests**:
  - A `folderScope: true` hanging source with a reconcile that yields `[]`, and an account created via `store.createAccount({config:{}})` with 3 docs → after one run cycle: `lastError` is falsy, and `reconcile` is **never called** (track with a jest.fn inside the generator).
  - Control: the same with `config:{roots:[{rootFolderId:'r',rootName:'R'}]}` → reconcile IS called (lastError `/listing came back empty/`).
  - Control: a non-folderScope source with `config:{}` → reconcile called.

  Waiting: `waitFor` on the reconcile spy or on a pull-started signal. For the skip case, wait on a pull spy, then `await new Promise(r=>setTimeout(r,50))`, then assert not called.

- [ ] **Step 2:** run. Expected: the skip test FAILS (reconcile called).

- [ ] **Step 3: implement** `if (src.reconcile && !(src.descriptor.folderScope === true && declaredScopeIds(fresh.config ?? {}) === null))`. Add a comment citing spec §5.3.

- [ ] **Step 4:** run engine + account-flows tests. Expected: green.

- [ ] **Step 5: commit** `feat(engine): no reconcile for a folder-scoped account that declares no scope`.

**➜ Fable review checkpoint (Part A 25%).**

### Task A4: `archiveRefs` in a scope save

**Files:**
- Modify: `src/shared/contracts.ts` (`FolderScopeUpdate`, ~481-543)
- Modify: `src/main/core/store/write-tx.ts` (`FolderScopeInput` ~70, `applyFolderScopeTx` ~790-885)
- Modify: `src/main/core/store/store.ts` doc (~244)
- Modify: `src/main/core/engine/engine.ts` (`applyScope` forwarding ~1297)
- Modify: `src/main/platform/source-proxy.ts` / `extension-host-entry.ts` only if manageFolders results are field-filtered. Check with `/usr/bin/grep -n "archiveScopeRootIds" src/main/platform/*.ts`; forward the new field alongside it.
- Test: `src/main/core/store/__tests__/write-tx.test.ts`, `src/main/platform/__tests__/source-proxy-manage-folders.test.ts`

**Interfaces:**
- Produces: `FolderScopeUpdate.archiveRefs?: ExternalRef[]` and `FolderScopeInput.archiveRefs: ExternalRef[]` (required in the store; the engine coerces `?? []`).
- Applied after reattribute, alongside the stamp archive, in the same transaction. `res.archived` counts distinct rows actually archived.

- [ ] **Step 1: failing store tests**:
  - Seed live docs `c1, c2, c3` (type `email.thread`, stamps null). `applyFolderScope({…, archiveScopeRootIds: [], reattributeScopeRoots: [], archiveRefs: [{externalId:'c1',type:'email.thread'},{externalId:'c1',type:'email.thread'},{externalId:'nope',type:'email.thread'}]})` → `archived === 1`, c1 archived, c2/c3 live, and one `changes` row for c1.
  - A ref overlapping a stamp-archived row counts once: seed d1 with stamp `r`, archive `['r']` plus a ref to d1 → `archived === 1`.
  - Stale CAS → nothing archived.

- [ ] **Step 2:** run write-tx tests. Expected: FAIL (TS error or archived 0). Note: ts-jest type errors count as red.

- [ ] **Step 3: implement.**
  - Contracts: doc block per spec §5.1, including the clause "a removed root must be covered by archiveScopeRootIds, reattributeScopeRoots, or refs listed in archiveRefs".
  - Store: after the stamp-archive loop, `for (const ref of input.archiveRefs) { if (archiveByRef(acc.id, ref) !== null) archived += 1; }`. `archiveByRef` already returns null for missing or already-archived rows. Do it inside the same `applyFolderScopeTx`.
  - Engine: `archiveRefs: update.archiveRefs ?? []`.

- [ ] **Step 4: failing proxy test**: in `source-proxy-manage-folders.test.ts`, a child manageFolders returning `archiveRefs:[{externalId:'x',type:'email.thread'}]` → the main-side result carries it. Run it. If it passes (the proxy forwards the whole object), ledger it as a pinning test.

- [ ] **Step 5:** run store, engine, account-flows and platform tests. Expected: green.

- [ ] **Step 6: commit** `feat(scope): FolderScopeUpdate.archiveRefs — exact per-document archival inside the scope transaction`.

### Task A5: `FolderPickerSpec.note`

**Files:**
- Modify: `src/shared/contracts.ts` (`FolderPickerSpec`)
- Modify: `src/main/platform/extension-host-entry.ts` (`toWirePickerSpec` ~415)
- Modify: `src/main/platform/source-proxy.ts` (`WirePickerSpec` ~70, rebuild ~226)
- Modify: `src/main/auth/connect-broker.ts` (both `folder-picker` emit sites ~116, ~333)
- Modify: `src/shared/ipc.ts` (`folder-picker` ConnectEvent ~61)
- Modify: `src/renderer/screens/Sources/connect-picker-adapter.ts` (`PickerRequest`)
- Modify: `src/renderer/screens/Sources/sections/TrackedFolders.tsx` and the connect-flow renderer that mounts `FolderPickerModal`. Find it with `/usr/bin/grep -rn "FolderPickerModal" src/renderer --include=*.tsx`.
- Modify: `src/renderer/components/folder-picker/FolderPickerModal.tsx` (prop `note?: string`, rendered above `<footer className="fp-footer">` as `<p className="fp-note t-meta">{note}</p>`)
- Test: `source-proxy-picker.test.ts` (extend the A-10 hops test), `FolderPickerModal.test.tsx`, `TrackedFolders.test.tsx`

**Interfaces:** `note?: string` everywhere. On the wire it is `note: string | null`, defaulted once in `toWirePickerSpec` (`spec.note ?? null`), and ConnectEvent carries `note: string | null`.

- [ ] **Step 1: failing wire test**: extend "A-10 hops 1-3" so the child spec has `note: 'Mail outside the selected folders will be removed from the index'` → the main-side spec received by the channel's `pickFolders` has the same `note`. Also assert the broker's ConnectEvent carries it: find the broker picker test with `/usr/bin/grep -rln "kind: 'folder-picker'" src/main --include=*.test.ts` and add the note there.

- [ ] **Step 2: failing modal test**: render `FolderPickerModal` with `note="N"`, `multiSelect`, `purpose="manage"` → `screen.getByText('N')` is present and sits before the Save button in document order (`compareDocumentPosition`).

- [ ] **Step 3: failing card test**: TrackedFolders receives a `folder-picker` event with a note → the modal shows it.

- [ ] **Step 4:** run the three test files. Expected: FAIL.

- [ ] **Step 5: implement** along the path above, plus a CSS rule `.fp-note { margin: 0 16px 8px; }` in the modal's stylesheet. Find it with `/usr/bin/grep -rln "fp-footer" src/renderer`.

- [ ] **Step 6:** run the tests plus `npm run typecheck`. Expected: green / exit 0.

- [ ] **Step 7: commit** `feat(picker): FolderPickerSpec.note — a source-supplied line shown above Save`.

**➜ Fable review checkpoint (Part A 50%).**

### Task A6: Card default text

**Files:** `src/renderer/screens/Sources/sections/TrackedFolders.tsx:319-320`, test `TrackedFolders.test.tsx`

- [ ] **Step 1: failing test:** an account with `config:{}` on a folderScope descriptor → text `Default folders — Manage to change`; the old `No folders selected yet.` is absent.
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3:** replace the empty-state text. It is only reachable for folderScope sources, since the card mounts only then (SourceDetail.tsx:133).
- [ ] **Step 4:** run. Expected: PASS.
- [ ] **Step 5: commit** `feat(sources): Tracked folders card shows default folders for a scope-less account`.

### Task A7: Gmail bucket, hashed `scopeBucket`, skip rule

**Files:**
- Create: `src/main/sources/gmail/bucket.ts`
- Modify: `src/main/sources/gmail/to-document.ts` (thread + attachment metadata, `scopeRootId`)
- Modify: `src/main/sources/gmail/gmail-source.ts` (emission gate in backfill + delta)
- Test: create `src/main/sources/gmail/__tests__/bucket.test.ts`; extend `to-document.test.ts`; create `src/main/sources/gmail/__tests__/pull-scope.test.ts`

**Interfaces:**
- Produces in `bucket.ts`:
  - `export type GmailBucket = 'mail' | 'TRASH' | 'SPAM'`
  - `export const GMAIL_BUCKETS: readonly GmailBucket[] = ['mail','TRASH','SPAM']`
  - `export function threadBucket(messages: Array<{ labelIds?: string[] }>): GmailBucket`
  - `export function selectedBuckets(config: Record<string, unknown>): Set<GmailBucket>` (no `folderRoots` → `{'mail'}`; unknown ids ignored; always includes `mail`)
- `toDocument(item)`: every emitted doc has `metadata.scopeBucket = threadBucket(item.messages)` and `scopeRootId = the same`.
- In pull: `if (!selected.has(threadBucket(raw.messages))) skip` — no item, no deletion.

- [ ] **Step 1: failing bucket tests**:

```ts
expect(threadBucket([{ labelIds: ['TRASH'] }, { labelIds: ['TRASH','IMPORTANT'] }])).toBe('TRASH');
expect(threadBucket([{ labelIds: ['TRASH'] }, { labelIds: [] }])).toBe('mail');
expect(threadBucket([{ labelIds: ['SPAM','TRASH'] }])).toBe('TRASH');
expect(threadBucket([{ labelIds: ['SPAM'] }])).toBe('SPAM');
expect(threadBucket([{ labelIds: ['DRAFT'] }])).toBe('mail');
expect(threadBucket([{ labelIds: ['CHAT'] }])).toBe('mail');
expect([...selectedBuckets({})]).toEqual(['mail']);
expect(selectedBuckets({ folderRoots: [{ id: 'TRASH', name: 'Trash' }] })).toEqual(new Set(['mail','TRASH']));
```

- [ ] **Step 2: failing to-document tests**:
  - Same label union, different bucket → different `metadata.scopeBucket`. Two messages: A `['TRASH','Label_1']` + B `['Label_1']` → mail; A + B both with TRASH → TRASH. Assert the thread doc's `scopeRootId` and `metadata.scopeBucket`, and that each attachment doc carries both.
- [ ] **Step 3: failing pull tests** (`pull-scope.test.ts`). Mock `gmail-api` with `jest.mock('../gmail-api')`, `fetchProfile`, `listThreadsPage`, `getThread`, `listHistoryPage`, following `cursor.test.ts`'s style if it mocks these; otherwise write the mocks here.
  - Default selection: a history sweep touching a fully trashed thread T → the final batch has no item T and no deletion for T.
  - `[mail,TRASH]` config: the same → item T emitted.
  - A 404 thread → deletion (unchanged).
- [ ] **Step 4:** run the three files. Expected: FAIL.
- [ ] **Step 5: implement.**
  - `bucket.ts` per Interfaces.
  - to-document: add `scopeBucket` to thread and attachment metadata, and `scopeRootId: bucket` on each.
  - gmail-source: compute `const selected = selectedBuckets(session.account.config ?? {})` once per pull. In `fetchThreadItems` and the delta chunk worker, drop threads whose bucket is not selected.
- [ ] **Step 6:** run all gmail tests: `npx jest src/main/sources/gmail`. Expected: green.
- [ ] **Step 7: commit** `feat(gmail): one scope bucket per thread, hashed and stamped; unselected buckets are skipped`.

### Task A8: Gmail task-queue cursor + query rule

**Files:**
- Modify: `src/main/sources/gmail/cursor.ts`
- Modify: `src/main/sources/gmail/gmail-api.ts` (`listThreadsPage` gains `q`, `includeSpamTrash`)
- Modify: `src/main/sources/gmail/gmail-source.ts` (`pull`)
- Test: `cursor.test.ts`, `gmail-api.test.ts`, `pull-scope.test.ts`

**Interfaces:**
- `export interface GmailTask { q: string | null; includeSpamTrash: boolean; pageToken: string | null }`
- `export interface GmailCursorV2 { v: 2; historyId: string; tasks: GmailTask[] }`
- `export type GmailCursor = GmailCursorV2`
- `export function migrateGmailCursor(c: unknown): GmailCursorV2 | null`:
  - `{mode:'backfill',pageToken,historyId}` → one task `{q:null,includeSpamTrash:false,pageToken}`
  - `{mode:'delta',historyId}` → `tasks: []`
  - v2 → as-is
  - `null` → `null`
- `export function fullScopeTask(selected: Set<GmailBucket>): GmailTask` → `{q:null, includeSpamTrash: selected.size > 1, pageToken:null}`
- `export function bucketTask(b: 'TRASH'|'SPAM'): GmailTask` → `{q: b==='TRASH'?'in:trash':'in:spam', includeSpamTrash:true, pageToken:null}`
- `listThreadsPage(session, pageToken, opts?: { q?: string|null; includeSpamTrash?: boolean })`

- [ ] **Step 1: failing tests**:
  - migrate mappings (3 cases)
  - `fullScopeTask` for default and for `[mail,TRASH]`
  - `listThreadsPage` URL carries `q` and `includeSpamTrash=true` only when set
  - pull with cursor `{v:2,historyId:'h',tasks:[task1(pageToken:'p'), task2]}` → pages task1 from `p`; its last page's batch has `tasks` without task1; then task2; then a history sweep from `h` (`listHistoryPage` called with `'h'`)
  - a null cursor → `historyId` captured once, `tasks:[fullScopeTask(selected)]`
  - a legacy backfill cursor resumes its page token
  - `estimateTotal` still reported on backfill batches
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3: implement.** Rewrite `pull`:
  - `let cur = migrateGmailCursor(cursor)`.
  - If null: fetch the profile → `{v:2, historyId, tasks:[fullScopeTask(selected)]}`.
  - While `cur.tasks.length`: page through `tasks[0]` with its `q`/flags, chunking 25 as today.
    - Intermediate chunks carry the unchanged page token.
    - The last chunk of a page carries the advanced token.
    - The last chunk of the last page carries `tasks.slice(1)`.
  - Then `runDeltaSweep` from `cur.historyId`, with its cursor output rewritten to v2 shape.
  - Expiry fallback: `{v:2, historyId: fresh, tasks:[fullScopeTask(selected)]}`.
  - Phase is `backfill` while tasks remain, else `live`.
- [ ] **Step 4:** run `npx jest src/main/sources/gmail`. Expected: green.
- [ ] **Step 5: commit** `feat(gmail): task-queue cursor — per-bucket backfill tasks share one history watermark`.

### Task A9: Gmail `folderScope` + connect config + `manageFolders`

**Files:**
- Modify: `src/main/sources/gmail/gmail-source.ts` (descriptor, `connect`, new `manageFolders`)
- Test: create `src/main/sources/gmail/__tests__/manage-folders.test.ts`

**Interfaces:**
- `descriptor.folderScope = true`
- `connect` returns `{identifier, config:{folderRoots:[{id:'mail',name:'All mail'}]}}`
- `manageFolders(session, channel)`:
  - picker: `modes:[{key:'mail',label:'Mail'}]`, `multiSelect:true`, `purpose:'manage'`
  - `roots()` → three nodes with the copy names, `hasChildren:false`
  - `children()` → `[]`
  - `selected` = current buckets as nodes
  - Reject (throw `Error('gmail: All mail must stay selected')`) when the picked set lacks `mail`.
  - Returns:
    - `config.folderRoots` in fixed order mail, TRASH, SPAM filtered to picked
    - `cursor` = the migrated current cursor, with `bucketTask` appended per added bucket and tasks for removed buckets dropped (a task is "for" bucket b when its `q === bucketTask(b).q`)
    - `archiveScopeRootIds` = removed buckets
    - `reattributeScopeRoots: []`
  - Reads the current cursor from `session.account.cursor`. Verify `Account` has `cursor`; if not, add `cursor` to the manage session (it is available engine-side at `makeSession`) and ledger a ruling.

- [ ] **Step 1: failing tests**:
  - widen `[mail]` → `[mail,TRASH]`: `archiveScopeRootIds:[]`, tasks gain `in:trash`, historyId unchanged, unfinished tasks kept
  - narrow `[mail,TRASH]` → `[mail]`: `archiveScopeRootIds:['TRASH']`, the queued `in:trash` task dropped
  - picked without mail → rejects
  - connect writes the folderRoots config
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** `npx jest src/main/sources/gmail src/main/core/engine` and `npm run typecheck`. Expected: green / 0.
- [ ] **Step 5: commit** `feat(gmail): Trash and Spam checkboxes via the Tracked folders picker`.

### Task A10: Platform 2.4.0 + SDK 1.5.0 contracts

**Files:**
- Modify: `src/shared/extension-rpc.ts` (`PLATFORM_API_VERSION = '2.4.0'`) and any test pinning `'2.3.0'` (`/usr/bin/grep -rn "2.3.0" src --include=*.ts`)
- Modify: `sdk/connector-sdk/package.json` (`version` 1.5.0, `kiagentCore` stays until release), then regenerate with `cd sdk/connector-sdk && npm run build`
- Modify: `docs/` platform changelog if one exists (`/usr/bin/grep -rln "2.3.0" docs | head`)

- [ ] **Step 1:** bump, regenerate, then `/usr/bin/grep -n "archiveRefs\|note?" sdk/connector-sdk/src/generated/contracts.ts`. Expected: both present.
- [ ] **Step 2:** `npm run typecheck` and `npx jest src/main/platform src/shared`. Expected: green.
- [ ] **Step 3: commit** `feat(platform): API 2.4.0 — archiveRefs + picker note; SDK 1.5.0 contracts`.
- [ ] **Step 4:** full core gates: `npx jest` (redirect to the workspace log, read the tail), `npm run typecheck`, `npm run lint`. Known-red suites must be named in the ledger.
- [ ] **Step 5:** build a local SDK tarball for Part B: `cd sdk/connector-sdk && npm pack` → `kiagent-connector-sdk-1.5.0.tgz`.

**➜ Final Part A review** (executing-plans final review).

---

# Part B — MS365 connector (`/Users/edjafarov/work/ms365-kia-connector`)

### Task B0: Branch + local SDK

- [ ] `git switch -c feat/folder-scope`. Then `npm install --no-save <core>/sdk/connector-sdk/kiagent-connector-sdk-1.5.0.tgz`. The package.json URL switches to the released tgz at release time, which is user-gated.
- [ ] `npm test` → green baseline.

### Task B1: Folder discovery

**Files:**
- Create: `src/folders.ts`
- Test: `src/__tests__/folders.test.ts`
- Modify: `src/testing/harness.ts` (GraphWorld gains `folders`)

**Interfaces:**
- `export interface MailFolderNode { id: string; displayName: string; parentFolderId?: string; childFolderCount: number; wellKnown?: string }`
- `export async function listTopFolders(client): Promise<MailFolderNode[]>`:
  - `GET /me/mailFolders?$top=100&$select=id,displayName,parentFolderId,childFolderCount`, paginated
  - excludes the `searchfolders` well-known folder (resolved once via `GET /me/mailFolders/searchfolders`, a 404 tolerated)
- `export async function listChildFolders(client, id): Promise<MailFolderNode[]>`: paginated `childFolders`
- `export async function discoverTracked(client, rootIds: string[]): Promise<Map<string /*folderId*/, string /*rootId*/>>`:
  - BFS from each root in order; the first root wins on overlap
  - no cap; any request error propagates (fail closed)
- `export async function resolveWellKnown(client, names: string[]): Promise<Record<string, MailFolderNode>>`: `GET /me/mailFolders/{name}`

- [ ] **Step 1: failing tests**. Extend the harness `GraphWorld` with `folders?: { top: MailFolderNode[]; children: Record<string, MailFolderNode[]>; wellKnown?: Record<string, MailFolderNode> }` and route:
  - `/v1.0/me/mailFolders` (top, with pagination via `pageToken` like conversations)
  - `/v1.0/me/mailFolders/{id}/childFolders`
  - `/v1.0/me/mailFolders/{wellKnownName}`

  Cases:
  - two-level tree discovered completely across 2 pages
  - overlapping roots (parent + child selected) → child maps to the parent (first in order)
  - a childFolders 500 after retries → `discoverTracked` rejects
  - searchfolders excluded from top
- [ ] **Step 2:** `npx jest src/__tests__/folders.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: implement.**
- [ ] **Step 4:** run. Expected: PASS.
- [ ] **Step 5: commit** `feat: mail folder discovery (paginated, fail-closed)`.

**➜ Fable review checkpoint (Part B 15%).**

### Task B2: Scope config + defaults + connect

**Files:**
- Create: `src/scope.ts`
- Modify: `src/source.ts` (`connect`, descriptor `folderScope: true`)
- Test: `src/__tests__/scope.test.ts`, `connect.test.ts`

**Interfaces:**
- `export function configuredRoots(config): FolderRootSelection[] | null`: `null` = legacy (no `folderRoots` array)
- `export const NEW_ACCOUNT_DEFAULTS = ['inbox','sentitems','archive'] as const`
- `export const LEGACY_ENUMERATION = ['inbox','sentitems'] as const`
- `export async function effectiveRoots(client, config): Promise<{ roots: FolderRootSelection[]; legacy: boolean }>`: legacy → the well-known Inbox + Sent resolved to ids
- `connect` returns `config: { tenantKind, folderRoots }`, with the ids resolved via `resolveWellKnown`. A missing `archive` (404) is simply omitted.

- [ ] **Step 1: failing tests:**
  - connect writes `folderRoots` for inbox/sent/archive
  - archive 404 → two roots
  - `configuredRoots({})` → null
  - `effectiveRoots` legacy → inbox+sent ids with `legacy:true`
- [ ] **Step 2:** run. Expected: FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** `npm test`. Expected: green.
- [ ] **Step 5: commit** `feat: folder-scope config — Inbox/Sent/Archive defaults for new accounts, legacy reads as Inbox+Sent`.

**➜ Fable review checkpoint (Part B 25%).**

### Task B3: Cursor v2 + legacy migration

**Files:**
- Modify: `src/cursor.ts`
- Test: `src/__tests__/cursor.test.ts` (new)

**Interfaces:**
```ts
export type FolderState = { next: string } | { delta: string };
export interface RetryEntry { id: string; n: number }
export type Ms365CursorV2 =
  | { v: 2; phase: 'enumerate'; folders: Record<string, FolderState>; pending: string[]; retry: RetryEntry[] }
  | { v: 2; phase: 'ingest'; folders: Record<string, FolderState>; pending: string[]; total: number; retry: RetryEntry[] }
  | { v: 2; phase: 'live'; folders: Record<string, FolderState>; pending: string[]; retry: RetryEntry[] };
export type Ms365Cursor = Ms365CursorV2;
export function migrateCursor(c: unknown, wellKnownIds: { inbox: string; sentitems: string }): Ms365CursorV2 | null;
```

Legacy keys `inbox`/`sentitems` map to ids with every link kept. `pending`/`total` are kept, and `retry` starts `[]`.

- [ ] **Step 1: failing tests:** each legacy phase (enumerate with `next`, ingest with pending+total, live with delta) → v2 with identical links; v2 passthrough; null → null.
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: commit** `feat: cursor v2 keyed by folder id, with lossless legacy migration`.

### Task B4: Pull — discovery, enumeration of new folders, emission gate, membership metadata, retry

**Files:**
- Modify: `src/graph-api.ts` (`accumulate` loses the exclusions and isDraft; `initialDeltaUrl(folderId)`; drop `resolveExcludedFolderIds` and `MAIL_FOLDERS`)
- Modify: `src/backfill.ts`, `src/delta.ts`, `src/source.ts` (pull wiring)
- Modify: `src/to-document.ts` (`metadata.folders`, `scopeRootId`)
- Create: `src/gate.ts` (`emitOrDelete`)
- Test: update `backfill.test.ts`, `delta.test.ts`; new `src/__tests__/scope-pull.test.ts`

**Interfaces:**
- `Ms365ThreadItem` gains `scopeRootId: string | null`.
- toDocument adds `metadata.folders = sorted unique parentFolderId` and `scopeRootId`.
- `emitOrDelete(conversationId, messages, tracked: Map<folderId, rootId> | 'legacy', tenantKind): { item?: Ms365ThreadItem; deletion?: ExternalRef }`:
  - `'legacy'` → emit when messages is non-empty (today's rule)
  - otherwise emit only when some message's `parentFolderId` is in `tracked`
  - stamp = the root of the first matching message in root config order
- Each pull:
  - `const { roots, legacy } = effectiveRoots(...)`
  - `tracked = await discoverTracked(client, roots.map(r=>r.id))`
  - migrate the cursor
  - drop folder states not in `tracked`
  - add `{next: initialDeltaUrl(id)}` for new tracked folders
  - in `live`, first enumerate any folder in `next` state, adding its conversationIds to `pending`
  - then drain `retry`, then `pending` (ingest), then run the delta sweep over folders in `delta` state
- A retry failure increments `n`; `n >= 5` logs `warn` each pull; entries are never removed except on success or a zero-message deletion.

- [ ] **Step 1: failing tests** (scope-pull.test.ts):
  - a new subfolder under Inbox appears → its initial delta is walked, and its conversation is ingested with `scopeRootId` = the inbox id
  - a pending id whose messages are all in untracked Deleted Items → deletion, not item
  - legacy config, messages all in Deleted Items → item (kept)
  - moving a message Inbox→Archive changes `metadata.folders` (toDocument unit)
  - a conversation fetch 500 → the id is in `retry` with `n:1` in the committed batch cursor; the next pull succeeds → item emitted and retry empty
  - 6 failures → a warn log, still in retry
  - a draft in a tracked folder is enumerated
  - a legacy v1 live cursor → the same delta links are used (the URL fixture is hit) and no initial delta is requested for inbox/sent
- [ ] **Step 2:** update the existing backfill/delta tests to the v2 cursor shape and folder-id keys. Run `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: implement.**
- [ ] **Step 4:** `npm test && npm run typecheck`. Expected: green.
- [ ] **Step 5: commit** `feat: pull over the tracked folder tree with a membership emission gate and durable retry`.

**➜ Fable review checkpoint (Part B 50%).**

### Task B5: `reconcile()`

**Files:**
- Modify: `src/source.ts`
- Create: `src/membership.ts` (`listConversationIds(client, folderIds, signal): AsyncIterable<string[]>`, using `GET /me/mailFolders/{id}/messages?$select=conversationId&$top=1000`, paginated, deduplicated across the pass)
- Test: `src/__tests__/reconcile.test.ts`

**Interfaces:**
- `reconcile(session)` runs discovery over the tracked set, then yields `ExternalRef[]` pages of `{externalId, type:'email.thread'}`.
- It never runs for legacy accounts; core skips it (A3). Defensively, when `configuredRoots` is null it throws `Error('ms365: reconcile without declared scope')`, which never happens in practice.
- It logs the request count at `info`.

- [ ] **Step 1: failing tests:**
  - an Inbox+Sent conversation is yielded once
  - a conversation only in untracked Deleted Items is not yielded
  - the same one IS yielded when Deleted Items is tracked
  - a discovery failure → the iterator rejects (no partial yield)
  - a legacy config throws
- [ ] **Step 2–4:** red, implement, green.
- [ ] **Step 5: commit** `feat: reconcile lists conversations with a message in the tracked folders`.

### Task B6: `manageFolders`

**Files:**
- Modify: `src/source.ts`
- Test: `src/__tests__/manage-folders.test.ts`

**Interfaces:**
- Picker:
  - `modes:[{key:'mail',label:'Mail folders'}]`, `multiSelect:true`, `purpose:'manage'`
  - `note: 'Mail outside the selected folders will be removed from the index'`
  - `roots()` = `listTopFolders` mapped to nodes; Junk's name gets the ` (may contain phishing)` suffix, with the junk id from `resolveWellKnown(['junkemail'])`
  - `children(id)` = `listChildFolders`; no `count`
  - `selected` = the effective roots; `expand` = the ancestor chain of the selected roots via `parentFolderId`
- After pick (empty → throw `ms365: no folders selected`), order = retained in prior order, then new.
- Returns `{ config: {...config, folderRoots}, cursor, archiveScopeRootIds: [], reattributeScopeRoots: [], archiveRefs }`:
  - **Legacy prior** (`configuredRoots` null): `archiveRefs: []`, because core grants a ratio allowance for a first declaration. The cursor is the migrated one, pruned to the new tracked set.
  - **Otherwise:** `priorTracked = discoverTracked(prior)`, `nextTracked = discoverTracked(next)`, `leavingFolders = priorTracked \ nextTracked`. If `leavingFolders` is empty → `archiveRefs: []` (no listing). Else `leaving = listConversationIds(leavingFolders)`, `staying = listConversationIds(nextTracked)`, `archiveRefs = leaving \ staying`.
  - The cursor drops states for folders outside `nextTracked`.

- [ ] **Step 1: failing tests:**
  - remove Inbox with an Inbox+Sent thread → not in `archiveRefs`
  - an Inbox-only thread → in `archiveRefs`
  - pure widening → no `messages?$select=conversationId` calls (assert on `calls`) and `archiveRefs` empty
  - legacy first Save → `archiveRefs` empty and `folderRoots` persisted
  - the note is set on the spec
  - Junk's name carries the suffix
  - an empty pick → rejects
  - removed folder states are dropped from the cursor
- [ ] **Step 2–4:** red, implement, green (`npm test && npm run typecheck && npm run build`).
- [ ] **Step 5: commit** `feat: manage Outlook folders from the Tracked folders card`.

### Task B7: Manifest, README, bundle smoke

- [ ] `manifest.json`: version `2.1.0`, engine `^2.4.0`. `package.json` version `2.1.0`.
- [ ] README: a "Choosing folders" section (defaults; subfolders included; Junk warning; legacy accounts keep everything until their first Save; the note's meaning). Remove any claim that only Inbox/Sent are indexed.
- [ ] `npm test && npm run typecheck && npm run build`. `bundle-load.test.ts` must stay green.
- [ ] Commit `chore: 2.1.0 — folder scope (engine ^2.4.0, SDK 1.5.0)`.

**➜ Final Part B review.** Then stop: the release (core minor, SDK 1.5.0, connector 2.1.0, core.lock bump) is the user's call.
