# Large-File Indexing Implementation Plan (core)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every supported document gets a row at any size; PDFs ≤ 100 MiB get their text layer indexed, and scans are OCR'd up to 200 pages, without new OOM or crash loops.

**Architecture:**
- `decideFileIndexing` gains a `bytes` field (`eager` | `deferred` | `none`) that separates "row exists" from "bytes shipped now".
- Workers fetch deferred PDFs later, under a single `MAX_FETCH_BYTES`.
- A durable, change-free attempt counter (`session.bump`) fences parser crashes.
- The vision worker OCRs one 10-page window per run and keeps per-page progress in `ocrProgress`.
- A `FILE_POLICY_VERSION` drives a one-time local re-walk.
- A convert-worker version bump re-drives old `too-large` rows.

**Tech Stack:** TypeScript, better-sqlite3 (DB worker thread), jest + ts-jest, pdf-parse, @hyzyla/pdfium (wasm), Swift `kia-vision` helper.

**Spec:** `docs/superpowers/specs/2026-10-02-large-file-indexing-design.md` (r4)

## Global Constraints

- Eager caps are unchanged: local converter `MAX_LOCAL_BINARY_BYTES` = 20 MiB; cloud `MAX_CLOUD_BINARY_BYTES` = 25 MiB.
- `MAX_FETCH_BYTES = 100 * 1024 * 1024`; `MAX_OCR_PAGES = 200`; OCR window = 10 pages; markdown output cap = 2 MiB of characters (`2 * 1024 * 1024`).
- `FILE_POLICY_VERSION = 2` (cursors without a version are treated as version 1).
- `too-large` is removed from `PDF_OCR_AFTER_STATUSES`.
- The convert worker `version` goes from 1 to 2. **This is the only convert-worker bump in this release.** The `.msg` and garbled-PDF plans reuse it and must not bump again.
- `session.bump` writes immediately with **no** document change. Its rows are deleted inside the `store.commit` transaction that persists the doc's `done` outcome.
- Schema migrations are APPEND-only (new entry at the end of `MIGRATIONS`). Partial indexes in `QUERY_INDEXES` rebuild automatically when their SQL text changes.
- Commit messages: no `Co-Authored-By` line. Never `--no-verify`. Never amend.

## Setup (once)

```bash
cd ~/work/kcore-indexing-specs          # branch spec/indexing-gaps, off core origin/dev
git switch -c feat/large-file-indexing
npm ci                                   # also installs release/app deps via postinstall
npx jest src/shared/__tests__/file-indexability.test.ts   # baseline green
```

If `better-sqlite3` reports a NODE_MODULE_VERSION mismatch under jest, run `npm rebuild better-sqlite3`.

## Review Focus

1. **A 60 MiB scanned PDF in a local folder.** It must appear by name right after the scan, get parsed (text-poor), then be OCR'd in windows. It must never be read eagerly in `buildItem`. Owned by Tasks 1 and 9.
2. **A cloud source going offline while large PDFs are pending.** Repeated `FetchDeferredError` must never mark a doc `failed`. Owned by Task 5.
3. **App quit in the middle of a 200-page OCR.** On resume it continues at the next missing page; pages already OCR'd are never redone. Owned by Task 9.
4. **An upgrade with existing `too-large` rows and an old local cursor.** The rows are re-parsed, and only newly admitted local files are re-emitted. Owned by Tasks 3 and 5.
5. **A docx over 20 MiB.** It gets a row and `too-large`, and is never fetched. Owned by Tasks 1 and 5.

---

### Task 1: Policy: `bytes` field, `MAX_FETCH_BYTES`, `FILE_POLICY_VERSION`, `newlyAdmitted`

**Files:**
- Modify: `src/shared/file-indexability.ts`
- Test: `src/shared/__tests__/file-indexability.test.ts`

**Interfaces:**
- Produces:
  - `FileIndexDecision = { kind:'index'; pipeline: FilePipeline; bytes: 'eager'|'deferred'|'none' } | { kind:'ignore'; reason: FileIgnoreReason }`
  - `MAX_FETCH_BYTES: number`
  - `FILE_POLICY_VERSION: 2`
  - `newlyAdmitted(c: FileIndexCandidate, fromVersion: number): boolean`
  - `ADMITTED_SINCE: Record<number, ReadonlySet<string>>` (ext sets per version; empty for v2 here; the `.msg` plan adds `msg`)

- [ ] **Step 1: Update the existing table cases and add new ones (failing)**

Every existing `{ kind: 'index', pipeline: X }` expectation gains `bytes: 'eager'`. The one exception is the local 20–50 MiB PDF case, which becomes `{ kind:'index', pipeline:'converter', bytes:'deferred' }`. Any existing "cloud pdf over cap", "local pdf over 50 MiB" or "converter over cap" cases that expect `ignore: too-large` change to the rows below. Append:

```ts
import { MAX_FETCH_BYTES, newlyAdmitted, FILE_POLICY_VERSION } from '../file-indexability';

const more: Case[] = [
  ['cloud pdf just over eager cap', { profile: 'cloud-drive', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: MAX_CLOUD_BINARY_BYTES + 1 },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' }],
  ['cloud pdf at fetch cap', { profile: 'cloud-drive', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: MAX_FETCH_BYTES },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' }],
  ['cloud pdf over fetch cap', { profile: 'cloud-drive', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: MAX_FETCH_BYTES + 1 },
    { kind: 'index', pipeline: 'converter', bytes: 'none' }],
  ['local pdf 30 MiB', { profile: 'local-folder', filename: 'a.pdf', sizeBytes: 30 * 1024 * 1024 },
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' }],
  ['local pdf 150 MiB', { profile: 'local-folder', filename: 'a.pdf', sizeBytes: 150 * 1024 * 1024 },
    { kind: 'index', pipeline: 'converter', bytes: 'none' }],
  ['cloud docx over eager cap', { profile: 'cloud-drive', filename: 'a.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sizeBytes: MAX_CLOUD_BINARY_BYTES + 1 },
    { kind: 'index', pipeline: 'converter', bytes: 'none' }],
  ['local docx over eager cap', { profile: 'local-folder', filename: 'a.docx', sizeBytes: MAX_LOCAL_BINARY_BYTES + 1 },
    { kind: 'index', pipeline: 'converter', bytes: 'none' }],
  ['local text over inline cap', { profile: 'local-folder', filename: 'a.log', sizeBytes: MAX_LOCAL_TEXT_BYTES + 1 },
    { kind: 'index', pipeline: 'inline-text', bytes: 'none' }],
  ['cloud image over cap stays ignored', { profile: 'cloud-drive', filename: 'a.png', mime: 'image/png', sizeBytes: 30 * 1024 * 1024 },
    { kind: 'ignore', reason: 'too-large' }],
  ['local audio over cap stays ignored', { profile: 'local-folder', filename: 'a.mp3', sizeBytes: MAX_LOCAL_AUDIO_BYTES + 1 },
    { kind: 'ignore', reason: 'too-large' }],
];
it.each(more)('%s', (_n, c, want) => expect(decideFileIndexing(c)).toEqual(want));

describe('newlyAdmitted', () => {
  const local = (filename: string, sizeBytes: number) =>
    ({ profile: 'local-folder' as const, filename, sizeBytes, path: `/r/${filename}` });
  it('a version-1 cursor re-emits deferred and none rows', () => {
    expect(newlyAdmitted(local('a.pdf', 60 * 1024 * 1024), 1)).toBe(true);
    expect(newlyAdmitted(local('a.docx', 30 * 1024 * 1024), 1)).toBe(true);
  });
  it('a version-1 cursor does NOT re-emit eager files', () => {
    expect(newlyAdmitted(local('a.pdf', 1024), 1)).toBe(false);
    expect(newlyAdmitted(local('notes.txt', 10), 1)).toBe(false);
  });
  it('never re-emits ignored files', () => {
    expect(newlyAdmitted(local('a.zip', 10), 1)).toBe(false);
  });
  it('is false once the cursor is current', () => {
    expect(newlyAdmitted(local('a.pdf', 60 * 1024 * 1024), FILE_POLICY_VERSION)).toBe(false);
  });
});
```

- [ ] **Step 2: Run, and confirm it fails**

Run: `npx jest src/shared/__tests__/file-indexability.test.ts`
Expected: FAIL (`bytes` missing; `MAX_FETCH_BYTES` not exported).

- [ ] **Step 3: Implement**

In `src/shared/file-indexability.ts`:

```ts
export type FileBytes = 'eager' | 'deferred' | 'none';
export type FileIndexDecision =
  | { kind: 'index'; pipeline: FilePipeline; bytes: FileBytes }
  | { kind: 'ignore'; reason: FileIgnoreReason };

/** One later fetchBytes by a background worker (convert/vision), never a
 *  batch. Separate from the EAGER caps, which bound bytes shipped inside an
 *  ingest batch. */
export const MAX_FETCH_BYTES = 100 * 1024 * 1024;
/** Bumped whenever a policy change makes previously IGNORED files
 *  indexable; each file source re-enumerates once on a mismatch. */
export const FILE_POLICY_VERSION = 2;
/** Extensions first admitted at a given policy version (eager files the
 *  old policy ignored by TYPE, not size). */
export const ADMITTED_SINCE: Record<number, ReadonlySet<string>> = {
  2: new Set<string>(),
};
```

Replace `cap()` with a document-aware variant. **Media keep `ignore`**; documents over their eager cap become `none`:

```ts
const eager = (pipeline: FilePipeline): FileIndexDecision =>
  ({ kind: 'index', pipeline, bytes: 'eager' });
const mediaCap = (size: number | null, limit: number, pipeline: FilePipeline): FileIndexDecision =>
  over(size, limit) ? { kind: 'ignore', reason: 'too-large' } : eager(pipeline);
const docCap = (size: number | null, limit: number, pipeline: FilePipeline): FileIndexDecision =>
  over(size, limit) ? { kind: 'index', pipeline, bytes: 'none' } : eager(pipeline);
```

PDF branch (step 5):

```ts
if (mime === 'application/pdf' || ext === 'pdf') {
  const eagerCap = local ? MAX_LOCAL_BINARY_BYTES : MAX_CLOUD_BINARY_BYTES;
  if (!over(size, eagerCap)) return eager('converter');
  if (!over(size, MAX_FETCH_BYTES))
    return { kind: 'index', pipeline: 'converter', bytes: 'deferred' };
  return { kind: 'index', pipeline: 'converter', bytes: 'none' };
}
```

Then:
- Image branch → `mediaCap(...)`.
- Local inline text → `docCap(size, MAX_LOCAL_TEXT_BYTES, 'inline-text')`.
- Local audio → `mediaCap(size, MAX_LOCAL_AUDIO_BYTES, 'audio')`.
- Converter branch → `docCap(size, local ? MAX_LOCAL_BINARY_BYTES : MAX_CLOUD_BINARY_BYTES, 'converter')`.

Delete `MAX_LOCAL_PDF_BYTES` **only if** no other module imports it. `src/main/workers/vision/classify.ts` does; Task 8 switches it to `MAX_FETCH_BYTES`. Keep the export until then.

Add:

```ts
/** Would a source whose cursor was written under `fromVersion` have
 *  ignored this file? Pure, candidate-only (the local scanner has no
 *  store). Deferred/none rows are cheap to re-emit (no bytes are read), so
 *  every one is re-emitted; eager rows only when their extension is newly
 *  admitted since `fromVersion`. */
export function newlyAdmitted(c: FileIndexCandidate, fromVersion: number): boolean {
  if (fromVersion >= FILE_POLICY_VERSION) return false;
  const d = decideFileIndexing(c);
  if (d.kind === 'ignore') return false;
  if (d.bytes !== 'eager') return true;
  const ext = extension(typeof c.filename === 'string' ? c.filename : '');
  for (let v = fromVersion + 1; v <= FILE_POLICY_VERSION; v += 1) {
    if (ADMITTED_SINCE[v]?.has(ext)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Fix compile fallout**

Run: `npx tsc -p tsconfig.json --noEmit 2>&1 | head -40` (or `npm run typecheck`).

Any code constructing a `FileIndexDecision` literal, or exhaustively matching `pipeline`, needs `bytes`. Likely only tests. **Do not** change behaviour elsewhere in this task.

- [ ] **Step 5: Run the policy tests**

Run: `npx jest src/shared/__tests__/file-indexability.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/shared/file-indexability.ts src/shared/__tests__/file-indexability.test.ts
git commit -m "feat(policy): bytes field (eager/deferred/none), MAX_FETCH_BYTES, FILE_POLICY_VERSION"
```

---

### Task 2: Local source honours `bytes`

**Files:**
- Modify: `src/main/sources/local-folder/scanner.ts` (`buildItem`, ~l.315)
- Modify: `src/main/sources/local-folder/local-folder-source.ts` (`fetchBytes`, ~l.405)
- Test: `src/main/sources/local-folder/__tests__/scanner.test.ts` (create the describe block if the file has none for buildItem; follow the file's tmpdir pattern)

**Interfaces:**
- Consumes: `decideLocalFile(absPath, size)` → `FileIndexDecision` with `bytes` (Task 1).

- [ ] **Step 1: Failing tests**

```ts
describe('buildItem honours bytes', () => {
  it('a 30 MiB pdf is metadata-only (no eager read)', async () => {
    const p = path.join(dir, 'big.pdf');
    await fs.promises.writeFile(p, Buffer.alloc(30 * 1024 * 1024, 0x20));
    const item = await buildItem(p, await fs.promises.stat(p));
    expect(item).not.toBeNull();
    expect(item!.binary).toBeNull();
    expect(item!.markdownText).toBeNull();
    expect(item!.size).toBe(30 * 1024 * 1024);
  });
  it('a 150 MiB pdf still yields a row', async () => {
    const p = path.join(dir, 'huge.pdf');
    const fh = await fs.promises.open(p, 'w');
    await fh.truncate(150 * 1024 * 1024); // sparse file, no real disk use
    await fh.close();
    const item = await buildItem(p, await fs.promises.stat(p));
    expect(item).not.toBeNull();
    expect(item!.binary).toBeNull();
  });
});
```

In `local-folder-source` tests (`__tests__/local-folder-source.test.ts`, existing fetchBytes block):

```ts
it('fetchBytes refuses a bytes:none file', async () => {
  const p = path.join(root, 'huge.pdf');
  const fh = await fs.promises.open(p, 'w');
  await fh.truncate(150 * 1024 * 1024);
  await fh.close();
  const bytes = await fetchBytes(sessionFor([root]), docFor(p));
  expect(bytes).toBeNull();
});
```

Use the helpers already in that file for `sessionFor` / `docFor`. If they are named differently, adapt to the existing names. Don't add new helpers.

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/main/sources/local-folder`
Expected: the 30 MiB case FAILS; today it routes `vision`, which is metadata-only, so check it for `pipeline` drift. The 150 MiB case FAILS (null today). The fetchBytes case FAILS (bytes returned).

- [ ] **Step 3: Implement**

`buildItem`: read eagerly only when `decision.bytes === 'eager'`:

```ts
if (decision.bytes === 'eager' && decision.pipeline === 'inline-text') { /* existing NUL-sniff read */ }
else if (decision.bytes === 'eager' && decision.pipeline === 'converter') { /* existing binary read */ }
// deferred / none / vision / audio: metadata-only pending candidate, no eager read.
```

Update the doc comment's routing list:
- `deferred`/`none` → metadata-only;
- the convert worker fetches `deferred` later;
- nothing fetches `none`.

`fetchBytes`:

```ts
const d = decideLocalFile(absPath, stat.size);
if (d.kind === 'ignore' || d.bytes === 'none') return null;
```

- [ ] **Step 4: Run, and confirm they pass**

Run: `npx jest src/main/sources/local-folder`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/sources/local-folder
git commit -m "feat(local-folder): metadata-only rows for deferred/none files; fetchBytes refuses none"
```

---

### Task 3: Local policy re-walk (`policyVersion` in the cursor)

**Files:**
- Modify: `src/main/sources/local-folder/cursor.ts`
- Modify: `src/main/sources/local-folder/local-folder-source.ts` (`pruneToConfiguredRoots`, `pull`, new `policyRewalk`)
- Test: `src/main/sources/local-folder/__tests__/local-folder-source.test.ts`

**Interfaces:**
- Consumes: `newlyAdmitted`, `FILE_POLICY_VERSION` (Task 1); `decideLocalFile`'s candidate shape.
- Produces: `LocalFolderCursor = { roots: Record<string,{completedAt:string}>; policyVersion?: number } | null`.

- [ ] **Step 1: Failing test**

```ts
it('an old cursor re-walks once, emitting only newly admitted files', async () => {
  // 3 small pdfs already indexed + 1 sparse 60 MiB pdf the old policy dropped
  for (const n of ['a', 'b', 'c']) await fs.promises.writeFile(path.join(root, `${n}.pdf`), tinyPdf(n));
  const big = path.join(root, 'big.pdf');
  const fh = await fs.promises.open(big, 'w'); await fh.truncate(60 * 1024 * 1024); await fh.close();
  const old = { roots: { [root]: { completedAt: new Date(Date.now() + 60_000).toISOString() } } }; // watermark in the future: incremental finds nothing
  const batches = await collect(pull(sessionFor([root], { watch: false }), old));
  const emitted = batches.flatMap((b) => b.items.map((i) => path.basename(i.absPath)));
  expect(emitted).toEqual(['big.pdf']);
  const last = batches[batches.length - 1].cursor as { policyVersion?: number; roots: object };
  expect(last.policyVersion).toBe(FILE_POLICY_VERSION);
  expect(last.roots).toEqual(old.roots); // watermarks untouched
});
it('a current cursor does not re-walk', async () => {
  const cur = { roots: { [root]: { completedAt: new Date(Date.now() + 60_000).toISOString() } }, policyVersion: FILE_POLICY_VERSION };
  const batches = await collect(pull(sessionFor([root], { watch: false }), cur));
  expect(batches.flatMap((b) => b.items)).toEqual([]);
});
it('a fresh backfill stamps policyVersion', async () => {
  await fs.promises.writeFile(path.join(root, 'a.txt'), 'hi');
  const batches = await collect(pull(sessionFor([root], { watch: false }), null));
  expect((batches[batches.length - 1].cursor as any).policyVersion).toBe(FILE_POLICY_VERSION);
});
```

`collect`, `sessionFor` and `tinyPdf`: reuse the file's existing helpers. If `tinyPdf` doesn't exist there, copy the 20-line `tinyPdf` from `src/main/workers/convert/__tests__/convert-worker.test.ts` into this test file. If `sessionFor` has no watch option, use whatever config disables `watchLoop` in the existing tests (grep `isWatchEnabled`).

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/main/sources/local-folder/__tests__/local-folder-source.test.ts -t "re-walk|policyVersion"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`cursor.ts`:

```ts
export type LocalFolderCursor = {
  roots: Record<string, { completedAt: string }>;
  /** FILE_POLICY_VERSION the roots were last fully enumerated under;
   *  absent = 1 (pre-versioning). */
  policyVersion?: number;
} | null;

export function advanceCursor(cur: LocalFolderCursor, root: string, completedAt: string): LocalFolderCursor {
  return { ...(cur ?? {}), roots: { ...(cur?.roots ?? {}), [root]: { completedAt } } };
}
```

`pruneToConfiguredRoots` must carry `policyVersion`: `return { ...cursor, roots };`.

New generator in `local-folder-source.ts`:

```ts
/** One-time pass after a FILE_POLICY_VERSION bump: walk every root and emit
 *  ONLY files the previous policy ignored (`newlyAdmitted`). A separate pass
 *  on purpose: re-emitting everything would re-read and re-parse every
 *  local PDF/docx in main (buildItem reads eager bytes, and the engine
 *  converts before the content-hash short-circuit). Watermarks are left
 *  untouched; the final batch stamps policyVersion. */
async function* policyRewalk(
  rootPaths: string[],
  fromVersion: number,
  working: LocalFolderCursor,
): AsyncGenerator<Batch<LocalFolderCursor, LocalFolderItem>, LocalFolderCursor> {
  async function* admitted(root: string): AsyncGenerator<ScannedEntry> {
    for await (const e of walkRoot(root)) {
      if (newlyAdmitted({ profile: 'local-folder', filename: path.basename(e.absPath),
            mime: resolvePathMime(e.absPath), sizeBytes: e.stats.size, path: e.absPath }, fromVersion))
        yield e;
    }
  }
  for (const root of rootPaths) {
    for await (const { value: entries } of batchesOf(admitted(root))) {
      const { items, deletions } = await buildBatch(entries, root);
      yield { phase: 'live', items, deletions, cursor: working };
    }
  }
  const done: LocalFolderCursor = { ...(working ?? { roots: {} }), policyVersion: FILE_POLICY_VERSION };
  yield { phase: 'live', items: [], cursor: done };
  return done;
}
```

In `pull()`, after the per-root backfill/incremental loop and **before** the `didBackfill` cursor-only batch:

```ts
const fromVersion = working?.policyVersion ?? 1;
if (working !== null && fromVersion < FILE_POLICY_VERSION) {
  if (didBackfill && rootPaths.every((r) => working?.roots?.[r])) {
    // every root was JUST fully backfilled under the current policy
    working = { ...working, policyVersion: FILE_POLICY_VERSION };
  } else {
    working = yield* policyRewalk(rootPaths, fromVersion, working);
  }
}
```

**Edge.** A cursor that was `null` at entry, so every root backfilled this cycle, takes the first branch: no double walk.

**Edge.** A cursor that was mixed, with one root new and one old, takes the re-walk branch. The new root's files get re-emitted only if they are deferred/none (cheap). That is accepted.

Imports: `newlyAdmitted`, `FILE_POLICY_VERSION` from `@shared/file-indexability`; `resolvePathMime` from `./mime`.

- [ ] **Step 4: Run, and confirm they pass**

Run: `npx jest src/main/sources/local-folder`
Expected: PASS, including existing cursor tests. If an existing test asserts an exact cursor shape with `toEqual`, add `policyVersion: FILE_POLICY_VERSION` where a backfill completed.

- [ ] **Step 5: Commit**

```bash
git add src/main/sources/local-folder
git commit -m "feat(local-folder): one-time policy re-walk on FILE_POLICY_VERSION mismatch"
```

---

### Task 4: Durable attempt counter: `work_attempts`, `store.bumpAttempt`, `clearAttempts`, `session.bump`

**Files:**
- Modify: `src/main/core/store/schema.ts` (append migration)
- Modify: `src/main/core/store/store.ts` (`CoreStore` interface + impl)
- Modify: `src/main/core/store/write-tx.ts` (consumer branch of `commitTx`)
- Modify: `src/shared/contracts.ts` (`CommitBatch` consumer variant; `WorkerSession.bump`)
- Modify: `src/main/core/engine/engine.ts` (`workOne` session; both commit sites)
- Modify: worker test fakes that build a `WorkerSession` literal: `src/main/workers/{vision,audio,convert}/__tests__/*.test.ts`, `src/main/workers/__tests__/attach-bundled-workers.test.ts`. Add `bump: async () => 1`.
- Test: `src/main/core/store/__tests__/store.test.ts`, `src/main/core/engine/__tests__/engine.test.ts`

**Interfaces:**
- Produces:
  - `CoreStore.bumpAttempt(consumer: string, docId: string, key: string): Promise<number>`
  - `CommitBatch` consumer variant gains `clearAttempts?: string[]` (doc ids)
  - `WorkerSession.bump(key: string): Promise<number>`, the attempt count **including** this one
  - The engine deletes a doc's attempt rows (all keys, this consumer) in the commit that carries its `done` outcome

- [ ] **Step 1: Failing store test**

```ts
describe('work_attempts', () => {
  it('bumpAttempt increments durably and commit clears it', async () => {
    expect(await store.bumpAttempt('worker:convert:v2', 'doc1', 'parse')).toBe(1);
    expect(await store.bumpAttempt('worker:convert:v2', 'doc1', 'parse')).toBe(2);
    expect(await store.bumpAttempt('worker:convert:v2', 'doc1', 'vlm')).toBe(1);
    const before = await store.feedHead?.() ; // if no such helper, skip this line
    await store.commit({ consumer: 'worker:convert:v2', cursor: 0, clearAttempts: ['doc1'] });
    expect(await store.bumpAttempt('worker:convert:v2', 'doc1', 'parse')).toBe(1);
  });
  it('bumpAttempt appends no change to the feed', async () => {
    const a = await store.createAccount({ source: 't', identifier: 'x' });
    await store.commit({ account: a.id, documents: [doc('x')], cursor: 1 });
    const seqBefore = (await store.read.search({ limit: 1 }))[0]?.seq;
    await store.bumpAttempt('c', 'whatever', 'k');
    const seqAfter = (await store.read.search({ limit: 1 }))[0]?.seq;
    expect(seqAfter).toBe(seqBefore);
  });
});
```

Delete the `feedHead` line if the store has no such helper; it is not needed for the assertion. Use the file's existing `doc()` helper.

- [ ] **Step 2: Run, and confirm it fails**

Run: `npx jest src/main/core/store/__tests__/store.test.ts -t work_attempts`
Expected: FAIL (`bumpAttempt` is not a function).

- [ ] **Step 3: Implement the store side**

Append to `MIGRATIONS` in `schema.ts`, as the next version after v8:

```ts
  // v9 — work_attempts: a per-(consumer, doc, key) attempt counter written
  // OUTSIDE the batch commit and WITHOUT appending a change, so a worker can
  // fence a crash-prone step (session.bump) without re-feeding the doc. Rows
  // are deleted in the commit that persists the doc's `done` outcome.
  `CREATE TABLE work_attempts (
     consumer TEXT NOT NULL,
     doc_id TEXT NOT NULL,
     key TEXT NOT NULL,
     n INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (consumer, doc_id, key)
   );`,
```

(Match the surrounding entries' form: plain SQL string vs `{ up(conn) }`. Copy the v8 entry's shape.)

`store.ts`, `CoreStore` interface (next to `ledgerRecord`):

```ts
  /** Durable, change-free attempt counter (see work_attempts in schema.ts).
   *  Returns the count INCLUDING this attempt. */
  bumpAttempt(consumer: string, docId: string, key: string): Promise<number>;
```

Impl (next to `ledgerRecord`):

```ts
    async bumpAttempt(consumer, docId, key) {
      const rows = (await db.all(
        `INSERT INTO work_attempts(consumer, doc_id, key, n, updated_at)
         VALUES(?, ?, ?, 1, ?)
         ON CONFLICT(consumer, doc_id, key) DO UPDATE
           SET n = n + 1, updated_at = excluded.updated_at
         RETURNING n`,
        [consumer, docId, key, now()],
      )) as Array<{ n: number }>;
      return rows[0].n;
    },
```

If `db.all` refuses a write statement, check `app-db.ts` for a `get`/`run` returning rows. Fall back to `db.run(insert)` followed by `db.all('SELECT n …')`. That is still durable, since both are immediate statements.

`contracts.ts`, `CommitBatch` consumer variant:

```ts
  | {
      consumer: string;
      cursor: Seq;
      documents?: DocumentInput[];
      enrich?: EnrichInput[];
      /** Doc ids whose work_attempts rows (this consumer) are deleted in this
       *  same transaction — the commit that persists their `done` outcome. */
      clearAttempts?: string[];
    }
```

`write-tx.ts`, inside `if ('consumer' in batch) {` after the consumers upsert:

```ts
      if (batch.clearAttempts?.length) {
        const del = conn.prepare(`DELETE FROM work_attempts WHERE consumer = ? AND doc_id = ?`);
        for (const id of batch.clearAttempts) del.run(batch.consumer, id);
      }
```

- [ ] **Step 4: Run the store test**

Run: `npx jest src/main/core/store/__tests__/store.test.ts -t work_attempts`
Expected: PASS.

- [ ] **Step 5: Failing engine test**

In `engine.test.ts`, next to `'worker session: read/see route…'`, using the same `createEngine` + `store` setup:

```ts
it('session.bump is durable, change-free, and cleared on done', async () => {
  const engine = createEngine({ store, sources: { get: () => undefined }, inference: {
    complete: async () => '', see: async () => '', read: async () => '', hear: async () => '' },
    convert: async (d: DocumentInput) => d, logs: noopLogs });
  const account = await store.createAccount({ source: 'test', identifier: 'b' });
  const counts: number[] = [];
  let runs = 0;
  const worker: Worker = {
    name: 'bumper', version: 1,
    matches: (ch) => ch.kind === 'document' && ch.document.externalId === 'p',
    async work(_ch, session) {
      runs += 1;
      counts.push(await session.bump('parse'));
      return runs < 3 ? 'defer' : 'done';
    },
  };
  const handle = engine.attach(worker);
  await store.commit({ account: account.id, documents: [doc('p')], cursor: 1 });
  await new Promise((r) => setTimeout(r, 1_000));
  // deferred once on the live tail; force re-drives:
  await handle.redriveNow?.(); await handle.redriveNow?.();
  await new Promise((r) => setTimeout(r, 1_000));
  await handle.stop();
  expect(counts).toEqual([1, 2, 3]);
  // cleared on done: a fresh bump starts at 1
  const d = (await store.read.search({ limit: 10 })).find((x) => x.externalId === 'p')!;
  expect(await store.bumpAttempt('worker:bumper:v1', d.id, 'parse')).toBe(1);
  // the doc was fed to the worker exactly once by the live tail (no bump-induced re-feed)
  expect(runs).toBe(3);
});
```

**Re-drive trigger.** Check how existing engine tests force a deferred re-drive (grep `REDRIVE_PAGE` / `schedule` usage in `engine.test.ts`) and use that mechanism in place of `redriveNow`. If the tests drive cadence via fake timers or a short `schedule: { every }`, set the worker's `schedule` the same way.

- [ ] **Step 6: Run, and confirm it fails**

Run: `npx jest src/main/core/engine/__tests__/engine.test.ts -t "session.bump"`
Expected: FAIL (`session.bump` is not a function).

- [ ] **Step 7: Implement the engine side**

`contracts.ts`, `WorkerSession`:

```ts
  /** Durable attempt counter for a crash-prone step, keyed per (worker,
   *  document, key). Written immediately, outside the batch, and appends
   *  NO document change (so it never re-feeds the doc). Returns the count
   *  including this attempt. Cleared when the doc's `done` outcome commits. */
  bump(key: string): Promise<number>;
```

`engine.ts`, in the session literal inside `workOne`. `consumer` is `workerConsumerName(worker)`; `change.document.id` is the doc:

```ts
        async bump(key: string) {
          if (change.kind !== 'document')
            throw new Error('bump() needs a document change');
          return store.bumpAttempt(workerConsumerName(worker), change.document.id, key);
        },
```

(If `workOne` lacks `change`/`worker` in scope at that point, thread them in. Both are its parameters today.)

**Live tail commit** (~l.1726): collect done doc ids:

```ts
              let clear: string[] = [];
              …
                if (matched) {
                  const r = await workOne(worker, change, abort.signal);
                  …
                  if (r.outcome === 'done' && change.kind === 'document') clear.push(change.document.id);
                }
              …
              await store.commit({ consumer, cursor,
                documents: emitted.length ? emitted : undefined,
                enrich: enrich.length ? enrich : undefined,
                clearAttempts: clear.length ? clear : undefined });
```

**Re-drive commit** (~l.1880): same collection, and commit when `emitted.length || enrich.length || clear.length`.

Worker fakes: add `bump: async () => 1,` to every `WorkerSession` literal in the files listed under Files.

- [ ] **Step 8: Run**

Run: `npx jest src/main/core src/main/workers`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/core src/shared/contracts.ts src/main/workers
git commit -m "feat(engine): durable change-free attempt counter (session.bump), cleared in the done commit"
```

---

### Task 5: Convert worker: per-kind cap, re-admission, crash fence, output cap, version 2

**Files:**
- Modify: `src/main/workers/convert/convert-worker.ts`
- Modify: `src/main/workers/convert/outcome.ts`
- Test: `src/main/workers/convert/__tests__/convert-worker.test.ts`

**Interfaces:**
- Consumes: `MAX_FETCH_BYTES`, `MAX_LOCAL_BINARY_BYTES` (Task 1); `session.bump` (Task 4).
- Produces:
  - `MAX_CONVERT_BYTES` is removed, replaced by `convertCapFor(kind: ConvertibleKind): number`
  - `MAX_MARKDOWN_CHARS = 2 * 1024 * 1024`
  - `ConversionOutcome` gains `truncated?: true`
  - worker `version: 2`
  - `PDF_OCR_AFTER_STATUSES = ['text-poor', 'failed']`

- [ ] **Step 1: Failing tests**

Add to `convert-worker.test.ts`, reusing its `baseDoc`, `tinyPdf` and the session fake (which now has `bump`):

```ts
const MiB = 1024 * 1024;
it('a 40 MiB PDF is fetched and parsed (fetch cap, not eager cap)', async () => {
  const s = session({ fetchBytes: async () => tinyPdf('large pdf body text here') });
  const out = await createConvertWorker().work(change({ metadata: { mime: 'application/pdf', sizeBytes: 40 * MiB } }), s);
  expect(out).toBe('done');
  expect(s.enriched[0].metadata.conversion.status).toBe('ok');
});
it('a 30 MiB docx is too-large and never fetched', async () => {
  const fetchBytes = jest.fn();
  const s = session({ fetchBytes });
  await createConvertWorker().work(change({ title: 'a.docx', metadata: { mime: DOCX_MIME, sizeBytes: 30 * MiB } }), s);
  expect(fetchBytes).not.toHaveBeenCalled();
  expect(s.enriched[0].metadata.conversion.status).toBe('too-large');
});
it('re-admits a too-large PDF now under the cap', () => {
  expect(isConvertCandidate(docWith({ metadata: { mime: 'application/pdf', sizeBytes: 40 * MiB,
    conversion: { status: 'too-large', at: 'x' } } }))).toBe(true);
  expect(isConvertCandidate(docWith({ metadata: { mime: 'application/pdf', sizeBytes: 150 * MiB,
    conversion: { status: 'too-large', at: 'x' } } }))).toBe(false);
  expect(isConvertCandidate(docWith({ title: 'a.docx', metadata: { mime: DOCX_MIME, sizeBytes: 30 * MiB,
    conversion: { status: 'too-large', at: 'x' } } }))).toBe(false);
});
it('fence: a third parse attempt over the eager cap records failed without parsing', async () => {
  const s = session({ fetchBytes: async () => tinyPdf('x'.repeat(40)), bump: async () => 3 });
  await createConvertWorker().work(change({ metadata: { mime: 'application/pdf', sizeBytes: 40 * MiB } }), s);
  expect(s.enriched[0].metadata.conversion.status).toBe('failed');
});
it('fence is not consulted for eager-size docs', async () => {
  const bump = jest.fn(async () => 99);
  const s = session({ fetchBytes: async () => tinyPdf('small pdf body text'), bump });
  await createConvertWorker().work(change({ metadata: { mime: 'application/pdf', sizeBytes: 1000 } }), s);
  expect(bump).not.toHaveBeenCalled();
});
it('a deferred fetch never bumps', async () => {
  const bump = jest.fn(async () => 1);
  const s = session({ fetchBytes: async () => { throw new FetchDeferredError('offline'); }, bump });
  await expect(createConvertWorker().work(change({ metadata: { mime: 'application/pdf', sizeBytes: 40 * MiB } }), s))
    .rejects.toBeInstanceOf(FetchDeferredError);
  expect(bump).not.toHaveBeenCalled();
});
it('output over 2 MiB chars is truncated and marked', async () => {
  const big = 'word '.repeat(600_000); // 3,000,000 chars
  const s = session({ fetchBytes: async () => new TextEncoder().encode(big) });
  await createConvertWorker().work(change({ title: 'a.txt', metadata: { mime: 'text/plain', sizeBytes: big.length } }), s);
  const e = s.enriched[0];
  expect(e.markdown.length).toBeLessThanOrEqual(2 * MiB + 20);
  expect(e.markdown.endsWith('[truncated]')).toBe(true);
  expect(e.metadata.conversion.truncated).toBe(true);
});
it('worker version is 2 (one shared replay for this release)', () => {
  expect(createConvertWorker().version).toBe(2);
});
```

`session()`, `change()` and `docWith()`: use or extend the file's existing helpers. If the existing fake is a single `session` factory, add an `over` parameter the way `vision-worker.test.ts`'s `fakeSession(over)` does.

In `outcome` tests (or `convert-worker.test.ts`):

```ts
import { pdfReadyForOcr } from '../outcome';
it('too-large no longer hands a PDF to OCR', () => {
  expect(pdfReadyForOcr({ status: 'too-large' })).toBe(false);
  expect(pdfReadyForOcr({ status: 'text-poor' })).toBe(true);
});
```

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/main/workers/convert`
Expected: FAIL on each new case.

- [ ] **Step 3: Implement**

`outcome.ts`:

```ts
export interface ConversionOutcome { status: ConversionStatus; at: string; error?: string; truncated?: true }
export const PDF_OCR_AFTER_STATUSES = ['text-poor', 'failed'] as const satisfies readonly ConversionStatus[];
```

Update the doc comment: `too-large` = over the per-kind cap. It is re-admitted when the cap rises, and never OCR'd.

`convert-worker.ts`:

```ts
import { MAX_FETCH_BYTES, MAX_LOCAL_BINARY_BYTES } from '@shared/file-indexability';
import { convertibleKind, parse, type ConvertibleKind } from '@main/core/engine/convert';

/** Largest file the worker fetches+parses, per kind: PDFs up to the fetch
 *  cap; everything else only up to the eager cap (their parsers inline
 *  images and are not hardened for huge inputs). */
export function convertCapFor(kind: ConvertibleKind): number {
  return kind === 'pdf' ? MAX_FETCH_BYTES : MAX_LOCAL_BINARY_BYTES;
}
export const MAX_MARKDOWN_CHARS = 2 * 1024 * 1024;
const EAGER_MAX = MAX_LOCAL_BINARY_BYTES;

export function isConvertCandidate(doc: Document): boolean {
  if (doc.archivedAt) return false;
  if (doc.type !== 'attachment' && doc.type !== 'file') return false;
  const meta = doc.metadata as ConvertMeta;
  if (meta.extraction != null) return false;
  const kind = convertibleKind(str(meta.mime), fileName(doc));
  if (kind === null) return false;
  if (meta.conversion != null) {
    // too-large is cap-relative: re-admit when the current cap admits it.
    const st = (meta.conversion as { status?: unknown }).status;
    const declared = num(meta.sizeBytes) ?? num(meta.size);
    return st === 'too-large' && declared !== undefined && declared <= convertCapFor(kind);
  }
  if ((doc.markdown ?? '').trim().length >= HAS_TEXT_CHARS) return false;
  return true;
}
```

In `work()`:

```ts
    name: 'convert',
    version: 2, // bump = one full feed replay: re-admits too-large rows (large-file), .msg attachments, garbled PDFs
    …
      const kind = convertibleKind(str(meta.mime), name);
      if (kind === null) return 'skip';
      const capBytes = convertCapFor(kind);
      const declared = num(meta.sizeBytes) ?? num(meta.size);
      if (declared !== undefined && declared > capBytes) return record('too-large');

      const bytes = await session.fetchBytes(doc); // FetchDeferredError propagates: never counted
      if (!bytes) return record('unavailable');
      if (bytes.length > capBytes) return record('too-large');
      // Crash fence AFTER the bytes arrive, BEFORE the parse: only a parse can
      // kill main; counting deferred fetches would fail docs on an outage.
      if (bytes.length > EAGER_MAX && (await session.bump('parse')) > 2)
        return record('failed', { error: 'parser crashed twice on this document' });

      let markdown: string | null;
      try { markdown = await parse(bytes, str(meta.mime) ?? '', name); }
      catch (err) { session.log('warn', `parse failed for ${name ?? doc.id}: ${String(err)}`);
                    return record('failed', { error: String(err) }); }
      if (markdown === null || markdown.trim().length === 0) return record('text-poor');
      if (markdown.length > MAX_MARKDOWN_CHARS)
        return record('ok', { markdown: `${markdown.slice(0, MAX_MARKDOWN_CHARS)}\n\n[truncated]`, truncated: true });
      return record('ok', { markdown });
```

`record` gains `truncated?: true` in `extra` and writes it into `conversion` when set.

Remove the `MAX_CONVERT_BYTES` export. Fix its importers: grep `MAX_CONVERT_BYTES`. The existing test imports it; switch to `convertCapFor('docx')`.

- [ ] **Step 4: Run, and confirm they pass**

Run: `npx jest src/main/workers/convert src/main/core/store`
Expected: PASS. `PENDING_VISUAL_WHERE` derives from the status list; the store tests confirm it still builds.

- [ ] **Step 5: Commit**

```bash
git add src/main/workers/convert
git commit -m "feat(convert): per-kind fetch cap, cap-relative too-large re-admission, parse crash fence, 2 MiB output cap, v2"
```

---

### Task 6: Net-guard cap follows the fetch cap

**Files:**
- Modify: `src/main/platform/net-guard.ts:37`
- Test: `src/main/platform/__tests__/net-guard.test.ts` (existing)

- [ ] **Step 1: Failing test**

```ts
import { MAX_FETCH_BYTES } from '@shared/file-indexability';
import { MAX_NET_FETCH_BYTES } from '../net-guard';
it('net fetch cap equals the worker fetch cap', () => {
  expect(MAX_NET_FETCH_BYTES).toBe(MAX_FETCH_BYTES);
});
```

- [ ] **Step 2: Run, and confirm it fails.** `npx jest src/main/platform/__tests__/net-guard.test.ts`: FAIL (50 MiB ≠ 100 MiB).

- [ ] **Step 3: Implement**

```ts
import { MAX_FETCH_BYTES } from '@shared/file-indexability';
/** One connector download for one background fetchBytes; equals the
 *  worker fetch cap so a deferred 100 MiB PDF is reachable. */
export const MAX_NET_FETCH_BYTES = MAX_FETCH_BYTES;
```

If an existing test asserts that a 60 MiB body is refused, change it to `MAX_FETCH_BYTES + 1`.

- [ ] **Step 4: Run, and confirm it passes.** Then commit:

```bash
git add src/main/platform
git commit -m "feat(net-guard): fetch cap follows MAX_FETCH_BYTES (100 MiB)"
```

---

### Task 7: Rasterizer renders an explicit page list and reports the page count

**Files:**
- Modify: `src/main/workers/vision/rasterize.ts`
- Modify: `src/main/providers/apple-vision/vision-helper.ts` (`rasterize`, `rasterizePdf`)
- Modify: `native/vision-helper/main.swift` (`--pages`)
- Test: `src/main/workers/vision/__tests__/rasterize.test.ts`, `src/main/providers/apple-vision/__tests__/vision-helper.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RasterPage { page: number; png: Uint8Array }   // 1-based page
export interface RasterResult { pageCount: number; pages: RasterPage[] }
export interface Rasterizer { pdfToPngs(bytes: Uint8Array, opts: { pages: number[] }): Promise<RasterResult> }
export interface VisionHelper { rasterizePdf(bytes: Uint8Array, pages: number[]): Promise<RasterResult> }
```

Out-of-range page numbers are silently skipped.

- [ ] **Step 1: Failing wasm test**

`rasterize.test.ts` (it already builds a PDF fixture; reuse it, or `tinyPdf` with 3 pages):

```ts
it('renders only the requested pages and reports pageCount', async () => {
  const r = await wasmRasterizer().pdfToPngs(threePagePdf, { pages: [3, 1, 9] });
  expect(r.pageCount).toBe(3);
  expect(r.pages.map((p) => p.page)).toEqual([1, 3]); // sorted, 9 skipped
  for (const p of r.pages) expect(p.png.subarray(1, 4)).toEqual(new Uint8Array([0x50, 0x4e, 0x47])); // "PNG"
});
```

If no 3-page fixture exists, write `threePagePdf` by extending `tinyPdf` to N pages: one `/Page` object per page, `/Kids` listing all, `/Count N`.

- [ ] **Step 2: Run, and confirm it fails.** `npx jest src/main/workers/vision/__tests__/rasterize.test.ts`.

- [ ] **Step 3: Implement wasm**

```ts
export function wasmRasterizer(): Rasterizer {
  return {
    async pdfToPngs(bytes, { pages }) {
      const { PDFiumLibrary } = await import('@hyzyla/pdfium');
      const library = await PDFiumLibrary.init();
      try {
        const doc = await library.loadDocument(bytes);
        try {
          const pageCount = doc.getPageCount();
          const wanted = [...new Set(pages)].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
          const out: RasterPage[] = [];
          for (const n of wanted) {
            const img = await doc.getPage(n - 1).render({ scale: DEFAULT_SCALE, render: 'bitmap' });
            out.push({ page: n, png: new Uint8Array(encodePng(img.data, img.width, img.height)) });
          }
          return { pageCount, pages: out };
        } finally { doc.destroy(); }
      } finally { library.destroy(); }
    },
  };
}
export function pickRasterizer(helper: VisionHelper | null, platform = process.platform): Rasterizer {
  if (platform === 'darwin' && helper) return { pdfToPngs: (bytes, { pages }) => helper.rasterizePdf(bytes, pages) };
  return wasmRasterizer();
}
```

(Keep the existing render-loop body, i.e. `page.render(...)` args and `encodePng`, exactly as it is today. Only the page selection changes.)

- [ ] **Step 4: Swift `--pages`**

In `main.swift`:
- `runRasterize(pdfPath:outDir:pages:[Int]:scale:)` iterates `pages.filter { $0 >= 1 && $0 <= total }.sorted()` instead of `1...limit`;
- `emit(["pages": pagesOut, "pageNumbers": numbersOut, "pageCount": total])`;
- arg parsing: `--pages 3,17,41` → `[Int]`;
- keep `--max-pages N` as an alias meaning `1...N`, so an old TS caller still works;
- the usage strings mention `--pages`.

- [ ] **Step 5: TS helper**

`vision-helper.ts`:

```ts
interface RasterizeResult { pages: string[]; pageNumbers?: number[]; pageCount: number }
private rasterize(pdfPath: string, outDir: string, opts: { pages?: number[]; scale?: number } = {}) {
  const args = ['rasterize', pdfPath, outDir];
  if (opts.pages) args.push('--pages', opts.pages.join(','));
  if (opts.scale !== undefined) args.push('--scale', String(opts.scale));
  return this.runJson<RasterizeResult>(args);
}
async rasterizePdf(bytes: Uint8Array, pages: number[]): Promise<RasterResult> {
  // …same temp dir dance…
  const result = await this.rasterize(pdfPath, outDir, { pages });
  const pngs = await Promise.all(result.pages.map(async (p) => new Uint8Array(await fs.promises.readFile(p))));
  const numbers = result.pageNumbers ?? pngs.map((_, i) => i + 1);
  return { pageCount: result.pageCount, pages: pngs.map((png, i) => ({ page: numbers[i], png })) };
}
```

Update the `VisionHelper` interface type in `vision-helper.ts` and in `rasterize.ts`. Update `vision-helper.test.ts`'s fake `execFileFn`: it must accept `--pages` and return `pageNumbers`/`pageCount`. Assert that the args contain `['--pages', '3,1']` for `rasterizePdf(bytes, [3, 1])`.

- [ ] **Step 6: Rebuild the mac helper and smoke it (darwin only)**

```bash
rm -f assets/vision/darwin-*/kia-vision && node scripts/build-vision-helper.mjs
./assets/vision/darwin-$(uname -m | sed 's/x86_64/x64/')/kia-vision rasterize <any 3-page pdf> /tmp/kv --pages 3,1
```

Expected JSON: `pageNumbers: [1,3]`, `pageCount: 3`.

- [ ] **Step 7: Run tests and commit**

Run: `npx jest src/main/workers/vision src/main/providers/apple-vision` (vision-worker tests will fail until Task 9; run `-t` on the rasterize/helper suites only now).

```bash
git add src/main/workers/vision/rasterize.ts src/main/providers/apple-vision native/vision-helper src/main/workers/vision/__tests__/rasterize.test.ts
git commit -m "feat(vision): rasterize an explicit page list and report pageCount (wasm + kia-vision --pages)"
```

---

### Task 8: `mergeExtraction` labels real page numbers

**Files:**
- Modify: `src/main/workers/vision/merge.ts`
- Test: `src/main/workers/vision/__tests__/merge.test.ts`

**Interfaces:**
- Produces: `PageResult = { page?: number; ocrText?: string; description?: string }`. Labels use `page ?? index + 1`. Multi-page labelling applies when `pages.length > 1` **or** any `page > 1`.

- [ ] **Step 1: Failing test**

```ts
it('labels by real page number', () => {
  const md = mergeExtraction([{ page: 3, ocrText: 'three' }, { page: 17, ocrText: 'seventeen' }]);
  expect(md).toContain('--- page 3 ---');
  expect(md).toContain('--- page 17 ---');
  expect(md.indexOf('three')).toBeLessThan(md.indexOf('seventeen'));
});
it('a single page numbered > 1 is still labelled', () => {
  expect(mergeExtraction([{ page: 5, ocrText: 'five' }])).toContain('--- page 5 ---');
});
```

- [ ] **Step 2: Run, confirm it fails, then implement**

```ts
export interface PageResult { page?: number; ocrText?: string; description?: string }
export function mergeExtraction(pages: PageResult[]): string {
  const multi = pages.length > 1 || pages.some((p) => (p.page ?? 1) > 1);
  …
    parts.push(multi ? [`--- page ${p.page ?? i + 1} ---`, ...sec].join('\n\n') : sec.join('\n\n'));
```

- [ ] **Step 3: Run, confirm it passes, and commit**

`npx jest src/main/workers/vision/__tests__/merge.test.ts`

```bash
git add src/main/workers/vision/merge.ts src/main/workers/vision/__tests__/merge.test.ts
git commit -m "feat(vision): merge labels real page numbers"
```

---

### Task 9: Windowed, resumable OCR in the vision worker

**Files:**
- Modify: `src/main/workers/vision/classify.ts`
- Modify: `src/main/workers/vision/vision-worker.ts`
- Modify: `src/main/core/store/schema.ts` (`PENDING_VISUAL_WHERE`)
- Test: `src/main/workers/vision/__tests__/vision-worker.test.ts`, `classify.test.ts`, `src/main/core/engine/__tests__/engine.test.ts` (one integration case)

**Interfaces:**
- Consumes: `Rasterizer.pdfToPngs(bytes, {pages}) → {pageCount, pages:[{page,png}]}` (Task 7); `mergeExtraction` with `page` (Task 8); `MAX_FETCH_BYTES` (Task 1).
- Produces:
  - `metadata.ocrProgress = { pageCount: number; pages: Record<string, string> }`. Keys are page numbers as strings; the value is the OCR text, possibly `''`.
  - `MAX_OCR_PAGES = 200`, `OCR_WINDOW = 10`.
  - Completion writes `extraction: { engine:'local-ocr', at, pagesSkipped? }` and `ocrProgress: undefined`.

- [ ] **Step 1: Failing classifier tests**

```ts
it('a doc with ocrProgress and no extraction is a candidate even with markdown', () => {
  expect(classifyDocument(pdfDoc({ markdown: 'x'.repeat(500), metadata: {
    mime: 'application/pdf', conversion: { status: 'text-poor' }, ocrProgress: { pageCount: 45, pages: { 1: 'a' } } } }))).toBe('candidate');
});
it('a 90 MiB text-poor pdf is a candidate (fetch cap)', () => {
  expect(classifyDocument(pdfDoc({ metadata: { mime: 'application/pdf', sizeBytes: 90 * 1024 * 1024,
    conversion: { status: 'text-poor' } } }))).toBe('candidate');
});
it('too-large pdf is not an OCR candidate', () => {
  expect(classifyDocument(pdfDoc({ metadata: { mime: 'application/pdf', conversion: { status: 'too-large' } } }))).toBe('skip');
});
```

(`pdfDoc`: the classify test file's existing doc builder; adapt to its name.)

- [ ] **Step 2: Failing worker tests**

```ts
function pagedRasterizer(pageCount: number) {
  const calls: number[][] = [];
  const r: Rasterizer = { pdfToPngs: jest.fn(async (_b, { pages }) => {
    calls.push(pages);
    return { pageCount, pages: pages.filter((n) => n <= pageCount).map((n) => ({ page: n, png: new Uint8Array([n]) })) };
  }) };
  return { r, calls };
}
const ocrByPage = async (img: Uint8Array) => `page text ${img[0]} `.repeat(5);

it('OCRs the first 10 pages, records progress, re-renders markdown, returns done', async () => {
  const { r, calls } = pagedRasterizer(45);
  const s = fakeSession({ read: ocrByPage });
  const out = await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(change({}), s);
  expect(out).toBe('done');
  expect(calls[0]).toEqual([1,2,3,4,5,6,7,8,9,10]);
  const e = s.enriched[0];
  expect(Object.keys(e.metadata.ocrProgress.pages)).toHaveLength(10);
  expect(e.metadata.ocrProgress.pageCount).toBe(45);
  expect(e.metadata.extraction).toBeUndefined();
  expect(e.markdown).toContain('--- page 10 ---');
});
it('resumes from ocrProgress and finishes on the last window', async () => {
  const { r, calls } = pagedRasterizer(12);
  const s = fakeSession({ read: ocrByPage });
  const prior = { pageCount: 12, pages: Object.fromEntries([1,2,3,4,5,6,7,8,9,10].map((n) => [String(n), `page text ${n} `.repeat(5)])) };
  const out = await createVisionWorker({ rasterizer: r, laneOpen: () => true })
    .work(change({ metadata: { ...baseDoc.metadata, ocrProgress: prior } }), s);
  expect(out).toBe('done');
  expect(calls[0]).toEqual([11, 12]);
  const e = s.enriched[0];
  expect(e.metadata.extraction.engine).toBe('local-ocr');
  expect(e.metadata).toHaveProperty('ocrProgress', undefined);
  expect(e.markdown.indexOf('page text 1 ')).toBeLessThan(e.markdown.indexOf('page text 12 '));
});
it('caps at MAX_OCR_PAGES and records pagesSkipped', async () => {
  const { r } = pagedRasterizer(250);
  const done = Object.fromEntries(Array.from({ length: 190 }, (_, i) => [String(i + 1), 'x '.repeat(30)]));
  const s = fakeSession({ read: ocrByPage });
  await createVisionWorker({ rasterizer: r, laneOpen: () => true })
    .work(change({ metadata: { ...baseDoc.metadata, ocrProgress: { pageCount: 250, pages: done } } }), s);
  expect(s.enriched[0].metadata.extraction.pagesSkipped).toBe(50);
});
it('fetches bytes once across consecutive windows of the same doc', async () => {
  const { r } = pagedRasterizer(25);
  const fetchBytes = jest.fn(async () => new Uint8Array(100));
  const worker = createVisionWorker({ rasterizer: r, laneOpen: () => true });
  const s1 = fakeSession({ read: ocrByPage, fetchBytes });
  await worker.work(change({}), s1);
  const s2 = fakeSession({ read: ocrByPage, fetchBytes });
  await worker.work(change({ metadata: { ...baseDoc.metadata, ocrProgress: s1.enriched[0].metadata.ocrProgress } }), s2);
  expect(fetchBytes).toHaveBeenCalledTimes(1);
});
it('a thin whole-doc OCR still runs VLM pass 2 on the first ≤20 pages', async () => {
  const { r, calls } = pagedRasterizer(3);
  const see = jest.fn(async () => 'desc');
  const s = fakeSession({ read: async () => '', see });
  await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(change({}), s);
  expect(see).toHaveBeenCalledTimes(3);
  expect(calls[calls.length - 1]).toEqual([1, 2, 3]);
});
```

Existing worker tests that build `pdfToPngs: jest.fn(async () => [png, png])` must return the new `{ pageCount, pages }` shape. Update them.

- [ ] **Step 3: Run, and confirm they fail.** `npx jest src/main/workers/vision`.

- [ ] **Step 4: Implement `classify.ts`**

```ts
import { MAX_FETCH_BYTES, MAX_LOCAL_IMAGE_BYTES } from '@shared/file-indexability';
export const MAX_PDF_BYTES = MAX_FETCH_BYTES;
export const MAX_PAGES = 20;          // VLM pass 2 only
export const MAX_OCR_PAGES = 200;
export const OCR_WINDOW = 10;
…
export function classifyDocument(doc: Document): 'candidate' | 'skip' {
  if (doc.archivedAt) return 'skip';
  if (doc.type !== 'attachment' && doc.type !== 'file') return 'skip';
  const meta = doc.metadata as VisualMeta & { ocrProgress?: unknown };
  if (meta.extraction != null) return 'skip';
  // Windowed OCR in progress: continue it even though markdown exists now.
  if (meta.ocrProgress != null && typeof meta.ocrProgress === 'object') return 'candidate';
  …unchanged…
}
```

`schema.ts` `PENDING_VISUAL_WHERE`: wrap the existing predicate:

```ts
export const PENDING_VISUAL_WHERE = `json_extract(metadata,'$.extraction') IS NULL
   AND archived_at IS NULL
   AND type IN ('attachment','file')
   AND (json_extract(metadata,'$.ocrProgress') IS NOT NULL
        OR ((markdown IS NULL OR length(trim(markdown)) < 16)
            AND ( …the existing mime/ext/conversion OR-block, verbatim… )))`;
```

- [ ] **Step 5: Implement `vision-worker.ts`**

Inside `createVisionWorker`:

```ts
  // One doc's bytes, kept across its consecutive windows (the enrich of window
  // N re-feeds the doc immediately). Dropped on completion or a different doc.
  let cache: { key: string; bytes: Uint8Array } | null = null;
  const keyOf = (d: Document) => `${d.id}:${d.contentHash}`;
```

In `work()`, after the lane check:

```ts
      const pdf = isPdfDoc(doc);
      const key = keyOf(doc);
      let bytes = cache?.key === key ? cache.bytes : null;
      if (!bytes) {
        bytes = await session.fetchBytes(doc);
        if (!bytes) return 'skip';
        if (bytes.length > (pdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES)) return 'skip';
        cache = pdf ? { key, bytes } : null;
      }
      if (!pdf) { /* existing single-image path, unchanged: pages = [bytes] … */ }

      const prog = (doc.metadata as { ocrProgress?: OcrProgress }).ocrProgress ?? null;
      const done: Record<string, string> = { ...(prog?.pages ?? {}) };
      // First window: pageCount is unknown until the rasterizer reports it.
      const known = prog?.pageCount;
      const limit = Math.min(known ?? Number.MAX_SAFE_INTEGER, MAX_OCR_PAGES);
      const next: number[] = [];
      for (let n = 1; n <= limit && next.length < OCR_WINDOW; n += 1) if (!(String(n) in done)) next.push(n);

      const raster = await deps.rasterizer.pdfToPngs(bytes, { pages: next });
      const pageCount = raster.pageCount;
      for (const { page, png } of raster.pages) {
        try { done[String(page)] = (await session.read(png, { mime: 'image/png' })) ?? ''; }
        catch (err) {
          if (err instanceof NoProviderError) { cache = null; return vlmOnly(); } // no OCR at all: legacy pass-2 path
          return 'defer';
        }
      }
      const cap = Math.min(pageCount, MAX_OCR_PAGES);
      const remaining = Array.from({ length: cap }, (_, i) => i + 1).some((n) => !(String(n) in done));
      const pagesOut = Object.keys(done).map(Number).sort((a, b) => a - b)
        .map((n): PageResult => ({ page: n, ocrText: done[String(n)] }));
      if (remaining) {
        session.enrich({ documentId: doc.id, markdown: mergeExtraction(pagesOut),
          metadata: { ocrProgress: { pageCount, pages: done } } });
        return 'done';
      }
      cache = null;
      const chars = Object.values(done).join('').replace(/\s+/g, '').length;
      if (chars >= OCR_SUFFICIENT_CHARS) {
        session.enrich({ documentId: doc.id, markdown: mergeExtraction(pagesOut), metadata: {
          ocrProgress: undefined,
          extraction: { engine: 'local-ocr', at: new Date().toISOString(),
            ...(pageCount > MAX_OCR_PAGES ? { pagesSkipped: pageCount - MAX_OCR_PAGES } : {}) } } });
        return 'done';
      }
      return vlmPass(pagesOut, Math.min(pageCount, MAX_PAGES));
```

**`vlmPass` and `vlmOnly`.** Extract today's pass-2 block into a local `vlmPass(ocrPages, firstN)`. It rasterizes `pages: [1..firstN]`, calls `seeWithMeta` per page (keep the existing downscale and `byModel` bookkeeping), merges `{ page, ocrText: done[page], description }`, and writes `extraction: { engine: 'local-ocr+vlm', … }` **plus `ocrProgress: undefined`**. It returns `'defer'` on a caught error, exactly as today.

`vlmOnly()` is `vlmPass([], Math.min(pageCount ?? MAX_PAGES, MAX_PAGES))`. It handles the case where `read` has no provider: there is no OCR, so the VLM gets the first ≤20 pages, exactly as today's `ocrFailed` branch does. For `vlmOnly`, call the rasterizer once with `pages: [1..20]` to learn `pageCount`.

Keep the non-VLM-decodable image branch unchanged (images only).

```ts
interface OcrProgress { pageCount: number; pages: Record<string, string> }
```

Import `OCR_WINDOW` and `MAX_OCR_PAGES` from `./classify`.

- [ ] **Step 6: Engine integration test (windows advance through the real feed)**

In `engine.test.ts`, attach a real `createVisionWorker` with:
- a `pagedRasterizer(25)`-style fake;
- an inference whose `read` returns `'ocr text '.repeat(10)`;
- a source fake whose `fetchBytes` returns `new Uint8Array(10)`.

The engine's `sources.get` must return that fake for the account's source. Then commit one `file` doc with:

```ts
metadata: { mime: 'application/pdf', sizeBytes: 1000, conversion: { status: 'text-poor', at: 'x' } }
```

Wait about 2 s, then assert:
- the stored doc has `metadata.extraction.engine === 'local-ocr'`;
- its markdown contains `--- page 25 ---`;
- `metadata.ocrProgress` is absent.

That proves the done → enrich → re-feed loop drives all 3 windows.

- [ ] **Step 7: Run everything vision/engine/store**

Run: `npx jest src/main/workers src/main/core`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/workers/vision src/main/core/store/schema.ts src/main/core/engine/__tests__/engine.test.ts
git commit -m "feat(vision): windowed resumable OCR (10 pages/run, 200 max, per-page ocrProgress, single-entry bytes cache)"
```

---

### Task 10: Memory gate on real large PDFs (release check)

**Files:**
- Create: `scripts/measure-large-pdf.mjs`

- [ ] **Step 1: Write the measurement script**

```js
// Usage: ELECTRON_RUN_AS_NODE=1 npx electron scripts/measure-large-pdf.mjs <file.pdf>
// Parses one PDF with the SAME pdf-parse the converter uses and reports the
// peak RSS / external memory increase. Gate: < 400 MB increase.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');
const file = process.argv[2];
const base = process.memoryUsage();
let peakRss = base.rss, peakExt = base.external;
const t = setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakExt = Math.max(peakExt, m.external); }, 20);
const bytes = new Uint8Array(fs.readFileSync(file));
const out = await pdfParse(bytes);
clearInterval(t);
const mb = (n) => Math.round(n / 1024 / 1024);
console.log(JSON.stringify({ file, sizeMB: mb(bytes.length), pages: out.numpages, chars: out.text.length,
  rssIncreaseMB: mb(peakRss - base.rss), externalIncreaseMB: mb(peakExt - base.external) }));
process.exit(peakRss - base.rss > 400 * 1024 * 1024 ? 1 : 0);
```

- [ ] **Step 2: Run on a ~77 MB text PDF and a ~77 MB scanned PDF**

Run: `ELECTRON_RUN_AS_NODE=1 npx electron scripts/measure-large-pdf.mjs ~/path/big-text.pdf`
Expected: exit 0 and `rssIncreaseMB` < 400. **If either file exits 1, stop.** Do not release. Open a follow-up to move `parse()` for deferred docs into a utility process. That decision is the spec's gate.

- [ ] **Step 3: Live check in the dev app (macOS)**

Run against a **dedicated dev profile**, never a shared checkout's running app. Put the 77 MB PDFs in a local-folder root and check:
- the rows appear by name right after the scan;
- the text appears after the convert worker runs;
- for the scan, OCR text arrives in 10-page increments (`ocrProgress` grows, visible via MCP `get`);
- the app's RSS stays flat between windows.

- [ ] **Step 4: Commit**

```bash
git add scripts/measure-large-pdf.mjs
git commit -m "chore(scripts): large-PDF memory gate for the fetch-cap rollout"
```

---

## Self-Review notes

- **Spec coverage:**
  - §1 → T1, T2.
  - §2 → T5, T6 (output cap in T5; `too-large` removal in T5).
  - §3 → T5 (re-admission, fence) and T4 (bump).
  - §4 → T7, T8, T9.
  - §5/§6 local → T3. Cloud re-enumeration lives in the connectors plan (`2026-10-02-large-file-connectors.md`).
  - §7 → T4.
  - Rollout gate → T10.
- **Types:**
  - `FileIndexDecision.bytes` (T1) is used in T2 and T3.
  - `RasterResult`/`RasterPage` (T7) are used in T9.
  - `PageResult.page` (T8) is used in T9.
  - `session.bump` (T4) is used in T5.
  - `convertCapFor` (T5) is defined and used in T5 only.
