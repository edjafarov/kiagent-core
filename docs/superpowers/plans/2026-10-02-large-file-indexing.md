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

1. **A 60 MiB scanned PDF in a local folder.** It must appear by name right after the scan, get parsed (text-poor), then be OCR'd in windows. It must never be read eagerly in `buildItem`. Owned by Tasks 1 and 8.
2. **A cloud source going offline while large PDFs are pending.** Repeated `FetchDeferredError` must never mark a doc `failed`. Owned by Task 5.
3. **App quit in the middle of a 200-page OCR.** On resume it continues at the next missing page; pages already OCR'd are never redone. Owned by Task 7.
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

Delete `MAX_LOCAL_PDF_BYTES` **only if** no other module imports it. `src/main/workers/vision/classify.ts` does; Task 7 switches it to `MAX_FETCH_BYTES`. Keep the export until then.

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

`entryReadCost` (`scanner.ts:46`): a metadata-only entry costs 0. Without this, a 60 MiB deferred PDF would still be counted at full size when sizing batches.

```ts
if (decision.kind !== 'index' || decision.bytes !== 'eager') return 0;
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

### Task 3: Local policy recovery (`policyVersion` in the cursor)

**Files:**
- Modify: `src/main/sources/local-folder/cursor.ts`
- Modify: `src/main/sources/local-folder/local-folder-source.ts` (`pruneToConfiguredRoots`, `incrementalRescanRoot`, `pull`)
- Test: `src/main/sources/local-folder/__tests__/local-folder-source.test.ts`

**Interfaces:**
- Consumes: `newlyAdmitted`, `FILE_POLICY_VERSION` (Task 1); `resolvePathMime` (`./mime`).
- Produces: `LocalFolderCursor = { roots: Record<string,{completedAt:string}>; policyVersion?: number } | null`.

**Design.** There is no separate re-walk pass. The existing per-root incremental rescan already walks every file of a root each cycle (it filters on mtime/ctime). It also admits `newlyAdmitted(candidate, fromVersion)`. Roots that backfill this cycle already enumerate everything under the new policy. One trailing cursor-only batch, after every root has finished, stamps `policyVersion`.

A crash before that stamp just repeats the newly-admitted emission next cycle. That is cheap: deferred/none entries read no bytes, and the hash short-circuit absorbs the rest. A cursor that mixes old and new roots therefore recovers its old roots correctly, which an "every root just backfilled" shortcut would not.

This deviates from the spec's "watermarks untouched". The incremental rescan advances watermarks on its last batch every cycle anyway. The spec's real concern is preserved: eager files are never re-emitted.

- [ ] **Step 1: Failing tests**

```ts
it('an old cursor emits only newly admitted files once, then stamps policyVersion', async () => {
  // 3 small pdfs already indexed + 1 sparse 60 MiB pdf the old policy dropped
  for (const n of ['a', 'b', 'c']) await fs.promises.writeFile(path.join(root, `${n}.pdf`), tinyPdf(n));
  const big = path.join(root, 'big.pdf');
  const fh = await fs.promises.open(big, 'w'); await fh.truncate(60 * 1024 * 1024); await fh.close();
  const future = new Date(Date.now() + 60_000).toISOString(); // watermark in the future: mtime filter finds nothing
  const old = { roots: { [root]: { completedAt: future } } };
  const batches = await collect(pull(sessionFor([root], { watch: false }), old));
  expect(batches.flatMap((b) => b.items.map((i) => path.basename(i.absPath)))).toEqual(['big.pdf']);
  expect((batches[batches.length - 1].cursor as { policyVersion?: number }).policyVersion).toBe(FILE_POLICY_VERSION);
});
it('mixed cursor: an old root is recovered even though a new root backfilled this cycle', async () => {
  const fresh = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kia-new-root-'));
  await fs.promises.writeFile(path.join(fresh, 'n.txt'), 'hello');
  const big = path.join(root, 'big.pdf');
  const fh = await fs.promises.open(big, 'w'); await fh.truncate(60 * 1024 * 1024); await fh.close();
  const old = { roots: { [root]: { completedAt: new Date(Date.now() + 60_000).toISOString() } } };
  const batches = await collect(pull(sessionFor([root, fresh], { watch: false }), old));
  const names = batches.flatMap((b) => b.items.map((i) => path.basename(i.absPath)));
  expect(names).toEqual(expect.arrayContaining(['big.pdf', 'n.txt']));
});
it('a current cursor emits nothing', async () => {
  const big = path.join(root, 'big.pdf');
  const fh = await fs.promises.open(big, 'w'); await fh.truncate(60 * 1024 * 1024); await fh.close();
  const cur = { roots: { [root]: { completedAt: new Date(Date.now() + 60_000).toISOString() } }, policyVersion: FILE_POLICY_VERSION };
  const batches = await collect(pull(sessionFor([root], { watch: false }), cur));
  expect(batches.flatMap((b) => b.items)).toEqual([]);
});
it('a fresh backfill stamps policyVersion', async () => {
  await fs.promises.writeFile(path.join(root, 'a.txt'), 'hi');
  const batches = await collect(pull(sessionFor([root], { watch: false }), null));
  expect((batches[batches.length - 1].cursor as { policyVersion?: number }).policyVersion).toBe(FILE_POLICY_VERSION);
});
```

Reuse the file's existing `collect` and `sessionFor` helpers. If `tinyPdf` is missing, copy it from `src/main/workers/convert/__tests__/convert-worker.test.ts`. If `sessionFor` has no watch option, use whatever config the existing tests use to disable `watchLoop` (grep `isWatchEnabled`).

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/main/sources/local-folder/__tests__/local-folder-source.test.ts -t "policyVersion|newly admitted|mixed cursor|current cursor"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`cursor.ts`:

```ts
export type LocalFolderCursor = {
  roots: Record<string, { completedAt: string }>;
  /** FILE_POLICY_VERSION the roots were last enumerated under; absent = 1. */
  policyVersion?: number;
} | null;

export function advanceCursor(cur: LocalFolderCursor, root: string, completedAt: string): LocalFolderCursor {
  return { ...(cur ?? {}), roots: { ...(cur?.roots ?? {}), [root]: { completedAt } } };
}
```

`pruneToConfiguredRoots` carries the version: `return { ...cursor, roots };`. `watch.ts` goes through `advanceCursor`, so the watch loop keeps it too.

`incrementalRescanRoot(root, since, rescanStartIso, working, fromVersion: number)`. In `changed()`:

```ts
for await (const e of walkRoot(root)) {
  const touched = Math.max(e.stats.mtime.getTime(), e.stats.ctime.getTime()) > sinceMs;
  // After a FILE_POLICY_VERSION bump, also files the previous policy ignored
  // (deferred/none PDFs, newly admitted types). Never eager files that were
  // already indexed: re-emitting those would re-read and re-parse them in main.
  if (touched || newlyAdmitted({ profile: 'local-folder', filename: path.basename(e.absPath),
        mime: resolvePathMime(e.absPath), sizeBytes: e.stats.size, path: e.absPath }, fromVersion))
    yield e;
}
```

In `pull()`:

```ts
const fromVersion = working?.policyVersion ?? 1;
…per-root loop passes fromVersion to incrementalRescanRoot…
const stamp = didBackfill || fromVersion < FILE_POLICY_VERSION;
if (stamp) working = { ...(working ?? { roots: {} }), policyVersion: FILE_POLICY_VERSION };
// (replaces `if (didBackfill)`) — the cursor-only live batch now also commits the stamp
if (stamp) yield { phase: 'live', items: [], cursor: working };
```

Never put the stamp into `working` before or inside the per-root loop. An intermediate batch would persist it mid-walk.

Imports: `newlyAdmitted`, `FILE_POLICY_VERSION` from `@shared/file-indexability`; `resolvePathMime` from `./mime`.

- [ ] **Step 4: Run, and confirm they pass**

Run: `npx jest src/main/sources/local-folder`
Expected: PASS, including the existing cursor tests. Where an existing test asserts an exact cursor shape with `toEqual` after a completed backfill, add `policyVersion: FILE_POLICY_VERSION`.

- [ ] **Step 5: Commit**

```bash
git add src/main/sources/local-folder
git commit -m "feat(local-folder): recover newly admitted files once per FILE_POLICY_VERSION"
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
  (db) => db.exec(`CREATE TABLE work_attempts (
     consumer TEXT NOT NULL,
     doc_id TEXT NOT NULL,
     key TEXT NOT NULL,
     n INTEGER NOT NULL,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (consumer, doc_id, key)
   );`),
```

Migrations are functions; copy the v8 entry's exact signature.

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
  // deferred once on the live tail; force two re-drives (the scheduler's API):
  await engine.rerunDeferred(worker);
  await engine.rerunDeferred(worker);
  await handle.stop();
  expect(counts).toEqual([1, 2, 3]);
  // cleared on done: a fresh bump starts at 1
  const d = (await store.read.search({ limit: 10 })).find((x) => x.externalId === 'p')!;
  expect(await store.bumpAttempt('worker:bumper:v1', d.id, 'parse')).toBe(1);
  // the doc was fed to the worker exactly once by the live tail (no bump-induced re-feed)
  expect(runs).toBe(3);
});
```

Add the crash case the spec requires: the process dies after `work()` returned `done` but before the batch committed. Attempt rows are written by their own immediate statement, so "the process died" is, for the DB, "the commit never ran". Simulate it by closing the store without committing, then reopening the **same on-disk file**. Use the file-backed store helper the store tests use (grep `openStore`/`tmpdir` in `store.test.ts`). An in-memory DB would vanish.

```ts
it('attempt rows survive a crash before the done commit', async () => {
  const file = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kia-att-')), 'core.db');
  let s1 = await openTestStore(file);
  expect(await s1.bumpAttempt('worker:convert:v2', 'd1', 'parse')).toBe(1);
  await s1.close(); // died: no commit carried clearAttempts
  const s2 = await openTestStore(file);
  expect(await s2.bumpAttempt('worker:convert:v2', 'd1', 'parse')).toBe(2);
  await s2.close();
});
```

`openTestStore` is the store test file's existing file-backed opener; adapt to its real name. A real child-process kill test is **not** added. Process death has exactly one DB effect, a missing commit, and this test pins that.

**Retired consumers.** A worker version bump orphans the old consumer's attempt rows. Sweep them where the engine already computes `activeConsumers()` at attach/start (one statement, in a new store method):

```ts
  /** Drop attempt rows of consumers no longer attached (retired versions). */
  pruneAttempts(active: string[]): Promise<void>;
  // impl: DELETE FROM work_attempts WHERE consumer NOT IN (?, ?, …)   (no-op when active is empty)
```

Call it once after the bundled workers attach, from the same place that first uses `activeConsumers()`. Test: two rows for `worker:x:v1` and `worker:x:v2`; `pruneAttempts(['worker:x:v2'])`; a v1 bump returns 1 again and a v2 bump returns 2.

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

**One doc, one `work()` per batch.** `store.feed` materializes every change row as the doc's **current** row (`store.ts:650`). A version-bump replay therefore hands a worker the same document once per historical change, all in one uncommitted batch. Without coalescing, a 40 MiB PDF with 3 historical changes would be parsed twice successfully and then, on the third invocation, be fenced `failed` by `bump('parse')` without any crash, at twice the parse cost.

Both commit loops keep a per-batch `seen: Set<DocumentId>`. A document change whose doc is already in `seen` is **not** worked: no `workOne`, no ledger row. The cursor still advances past it. Every copy is the same current row, so skipping it is exact. If the first copy deferred, its ledger row re-drives the doc.

Failing test in `engine.test.ts` (same setup as the bump test):

```ts
it('a doc with several changes in one feed batch is worked once', async () => {
  let runs = 0;
  const worker: Worker = { name: 'once', version: 1,
    matches: (ch) => ch.kind === 'document' && ch.document.externalId === 'm',
    async work() { runs += 1; return 'done'; } };
  // three changes for the same doc BEFORE the worker attaches → one replay batch
  await store.commit({ account: account.id, documents: [doc('m', { markdown: 'a' })], cursor: 1 });
  await store.commit({ account: account.id, documents: [doc('m', { markdown: 'b' })], cursor: 2 });
  await store.commit({ account: account.id, documents: [doc('m', { markdown: 'c' })], cursor: 3 });
  const handle = engine.attach(worker);
  await new Promise((r) => setTimeout(r, 1_000));
  await handle.stop();
  expect(runs).toBe(1);
});
```

**Live tail commit** (~l.1726): coalesce, and collect done doc ids:

```ts
              let clear: string[] = [];
              const seen = new Set<string>();
              …
                if (matched && change.kind === 'document') {
                  if (seen.has(change.document.id)) { cursor = change.seq; continue; }
                  seen.add(change.document.id);
                }
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

**Re-drive commit** (~l.1880): the same `seen` coalescing per re-drive page. A skipped duplicate's ledger row is resolved the same way a `skip` outcome resolves it today, so it is not re-driven forever. Collect `clear` the same way, and commit when `emitted.length || enrich.length || clear.length`.

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

### Task 5: Convert worker: per-kind cap, re-admission, crash fence, shared output cap, net cap, version 2

**Files:**
- Modify: `src/main/workers/convert/convert-worker.ts`
- Modify: `src/main/workers/convert/outcome.ts`
- Modify: `src/main/core/engine/convert.ts` (`MAX_MARKDOWN_CHARS`, `capMarkdown`, `createConverter`)
- Modify: `src/main/platform/net-guard.ts` (`MAX_NET_FETCH_BYTES`)
- Test: `src/main/workers/convert/__tests__/convert-worker.test.ts`, `src/main/core/engine/__tests__/convert-email.test.ts`, `src/main/core/engine/__tests__/engine.test.ts` (upgrade case), `src/main/platform/__tests__/net-guard.test.ts`

**Interfaces:**
- Consumes: `MAX_FETCH_BYTES`, `MAX_LOCAL_BINARY_BYTES`, `MAX_CLOUD_BINARY_BYTES` (Task 1); `session.bump` (Task 4).
- Produces:
  - `MAX_CONVERT_BYTES` is removed, replaced by `convertCapFor(kind: ConvertibleKind): number` (pdf → 100 MiB, else 25 MiB)
  - `MAX_MARKDOWN_CHARS = 2 * 1024 * 1024` and `capMarkdown(md)`, both in `convert.ts`
  - `createConvertWorker({ now?, parse? })`
  - `MAX_NET_FETCH_BYTES = MAX_FETCH_BYTES`
  - `ConversionOutcome` gains `truncated?: true`
  - worker `version: 2`
  - `PDF_OCR_AFTER_STATUSES = ['text-poor', 'failed']`

- [ ] **Step 1: Failing tests**

Add to `convert-worker.test.ts`. First extend its `fakeSession(fetchBytes)` (`:86`) with an optional second argument, so existing call sites keep working:

```ts
function fakeSession(fetchBytes: WorkerSession['fetchBytes'], over: Partial<WorkerSession> = {}) {
  // …existing literal…, plus:
  //   bump: async () => 1,
  //   ...over,
}
```

`baseDoc.metadata` carries `filename: 'offer.docx'`, and `fileName()` prefers it. So every non-docx case below **must** override `filename`.

```ts
import { MAX_CLOUD_BINARY_BYTES, MAX_FETCH_BYTES } from '@shared/file-indexability';
const MiB = 1024 * 1024;
const pdfDoc = (sizeBytes: number, over: Record<string, unknown> = {}) =>
  doc({ title: 'big.pdf', metadata: { mime: 'application/pdf', filename: 'big.pdf', sizeBytes, ...over } });

it('a 40 MiB PDF is fetched and parsed (fetch cap, not eager cap)', async () => {
  const s = fakeSession(async () => tinyPdf('large pdf body text here'));
  expect(await createConvertWorker().work(change(pdfDoc(40 * MiB)), s)).toBe('done');
  expect(s.enriched[0].metadata.conversion.status).toBe('ok');
});
it('a docx over the cloud eager cap is too-large and never fetched', async () => {
  const fetchBytes = jest.fn();
  const s = fakeSession(fetchBytes);
  await createConvertWorker().work(change(doc({ metadata: { sizeBytes: MAX_CLOUD_BINARY_BYTES + 1 } })), s);
  expect(fetchBytes).not.toHaveBeenCalled();
  expect(s.enriched[0].metadata.conversion.status).toBe('too-large');
});
it('a 22 MiB cloud docx (between the local and cloud eager caps) is parsed', async () => {
  const s = fakeSession(async () => tinyDocx('docx body text here'));
  await createConvertWorker().work(change(doc({ metadata: { sizeBytes: 22 * MiB } })), s);
  expect(s.enriched[0].metadata.conversion.status).not.toBe('too-large');
});
it('re-admits a too-large row only when the current cap admits it', () => {
  const tl = { conversion: { status: 'too-large', at: 'x' } };
  expect(isConvertCandidate(pdfDoc(40 * MiB, tl))).toBe(true);
  expect(isConvertCandidate(pdfDoc(MAX_FETCH_BYTES + 1, tl))).toBe(false);
  expect(isConvertCandidate(doc({ metadata: { sizeBytes: 30 * MiB, ...tl } }))).toBe(false);
});
it('fence: the third attempt on an over-eager-cap doc records failed WITHOUT parsing', async () => {
  // Declared 40 MiB; the fence keys on max(declared, actual), so a tiny
  // fixture is enough. The parse spy proves the third attempt never parses.
  const parse = jest.fn(async () => 'never');
  const s = fakeSession(async () => tinyPdf('x'.repeat(40)), { bump: async () => 3 });
  await createConvertWorker({ parse }).work(change(pdfDoc(40 * MiB)), s);
  expect(s.enriched[0].metadata.conversion.status).toBe('failed');
  expect(parse).not.toHaveBeenCalled();
});
it('fence is not consulted for eager-size docs', async () => {
  const bump = jest.fn(async () => 99);
  const s = fakeSession(async () => tinyPdf('small pdf body text'), { bump });
  await createConvertWorker().work(change(pdfDoc(1000)), s);
  expect(bump).not.toHaveBeenCalled();
});
it('a deferred fetch never bumps', async () => {
  const bump = jest.fn(async () => 1);
  const s = fakeSession(async () => { throw new FetchDeferredError('offline'); }, { bump });
  await expect(createConvertWorker().work(change(pdfDoc(40 * MiB)), s)).rejects.toBeInstanceOf(FetchDeferredError);
  expect(bump).not.toHaveBeenCalled();
});
it('output over 2 MiB chars is truncated and marked', async () => {
  const big = 'word '.repeat(600_000); // 3,000,000 chars
  const s = fakeSession(async () => new TextEncoder().encode(big));
  await createConvertWorker().work(change(doc({ title: 'a.txt',
    metadata: { mime: 'text/plain', filename: 'a.txt', sizeBytes: big.length } })), s);
  const e = s.enriched[0];
  expect(e.markdown.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS + 20);
  expect(e.markdown.endsWith('[truncated]')).toBe(true);
  expect(e.metadata.conversion.truncated).toBe(true);
});
it('worker version is 2 (one shared replay for this release)', () => {
  expect(createConvertWorker().version).toBe(2);
});
```

`createConvertWorker(deps)` gains an optional `parse` (default: the real `parse` from `convert.ts`), next to its existing `now`. That makes it a test seam only.

In `convert-email.test.ts` (the eager path, `createConverter`):

```ts
it('the eager commit path applies the same 2 MiB output cap', async () => {
  const big = 'word '.repeat(600_000);
  const out = await convert(input('big.txt', 'text/plain', big));
  expect(out.markdown!.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS + 20);
  expect(out.markdown!.endsWith('[truncated]')).toBe(true);
});
```

**Upgrade (engine integration, the spec's required test)**, in `engine.test.ts`:
1. Attach a `createConvertWorker()` whose `version` is overridden to 1. Commit an attachment doc (`application/pdf`, `sizeBytes: 40 MiB`). Let the v1 worker record `too-large`; assert it.
2. Stop it. Attach the real v2 worker, with a source fake whose `fetchBytes` returns `tinyPdf('large pdf body text here')`.
3. Wait about 1 s. Assert `metadata.conversion.status === 'ok'` and that the markdown contains `large pdf body`.

Commit the doc **three times** (three historical changes) before step 1, so that the v2 replay meets it three times in one batch. Assert `status === 'ok'`, never `failed`. This proves the cursor-0 replay, re-admission and per-batch coalescing through the real feed. For the v1 run, use `{ ...createConvertWorker(), version: 1, work: async (_c, s) => { s.enrich({ documentId: id, metadata: { conversion: { status: 'too-large', at: 'x' } } }); return 'done'; } }`. That fakes the old worker's verdict without the old code.

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
import { MAX_CLOUD_BINARY_BYTES, MAX_FETCH_BYTES, MAX_LOCAL_BINARY_BYTES } from '@shared/file-indexability';
import { capMarkdown, convertibleKind, parse as realParse, type ConvertibleKind } from '@main/core/engine/convert';

/** Largest file the worker fetches+parses, per kind: PDFs up to the fetch
 *  cap; everything else up to the LARGEST eager cap (cloud, 25 MiB) — their
 *  parsers inline images and are not hardened for huge inputs. The worker
 *  does not know the source's profile; a local file over ITS eager cap is
 *  `bytes: 'none'`, whose fetchBytes returns null without reading. */
export function convertCapFor(kind: ConvertibleKind): number {
  return kind === 'pdf' ? MAX_FETCH_BYTES : MAX_CLOUD_BINARY_BYTES;
}

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
      // Keyed on max(declared, actual): the size is what makes a parse risky.
      const large = Math.max(declared ?? 0, bytes.length) > MAX_LOCAL_BINARY_BYTES;
      if (large && (await session.bump('parse')) > 2)
        return record('failed', { error: 'parser crashed twice on this document' });

      let markdown: string | null;
      try { markdown = await parse(bytes, str(meta.mime) ?? '', name); }
      catch (err) { session.log('warn', `parse failed for ${name ?? doc.id}: ${String(err)}`);
                    return record('failed', { error: String(err) }); }
      if (large) logPeak(session, name ?? doc.id, bytes.length, rssBefore); // the memory probe
      if (markdown === null || markdown.trim().length === 0) return record('text-poor');
      const capped = capMarkdown(markdown);
      return record('ok', { markdown: capped.markdown, ...(capped.truncated ? { truncated: true as const } : {}) });
```

Here `parse` is `deps.parse ?? realParse`. `rssBefore = process.memoryUsage().rss` is captured **before `session.fetchBytes`**, so the measured peak covers fetch, transport copies and parse together. The memory-gate task defines `logPeak`; until then, leave that line out.

`record` gains `truncated?: true` in `extra` and writes it into `conversion` when set.

**One output cap for both conversion paths.** In `src/main/core/engine/convert.ts`:

```ts
/** Upper bound on one document's markdown, whichever path parsed it. */
export const MAX_MARKDOWN_CHARS = 2 * 1024 * 1024;
export function capMarkdown(md: string): { markdown: string; truncated: boolean } {
  return md.length > MAX_MARKDOWN_CHARS
    ? { markdown: `${md.slice(0, MAX_MARKDOWN_CHARS)}\n\n[truncated]`, truncated: true }
    : { markdown: md, truncated: false };
}
```

In `createConverter`, return `{ ...stripBinary(input), markdown: capMarkdown(markdown).markdown }`. The commit path writes no `conversion` marker, so it gets no `truncated` flag either.

**Net-guard** (formerly a separate task). In `src/main/platform/net-guard.ts:37`:

```ts
import { MAX_FETCH_BYTES } from '@shared/file-indexability';
/** One connector download for one background fetchBytes; equals the
 *  worker fetch cap so a deferred 100 MiB PDF is reachable. */
export const MAX_NET_FETCH_BYTES = MAX_FETCH_BYTES;
```

Add a test to `src/main/platform/__tests__/net-guard.test.ts`: `expect(MAX_NET_FETCH_BYTES).toBe(MAX_FETCH_BYTES)`. If an existing test asserts that a 60 MiB body is refused, change it to `MAX_FETCH_BYTES + 1`.

Remove the `MAX_CONVERT_BYTES` export. Fix its importers: grep `MAX_CONVERT_BYTES`. The existing test imports it; switch to `convertCapFor('docx')`.

- [ ] **Step 4: Run, and confirm they pass**

Run: `npx jest src/main/workers/convert src/main/core/store src/main/core/engine src/main/platform`
Expected: PASS. `PENDING_VISUAL_WHERE` derives from the status list; the store tests confirm it still builds.

- [ ] **Step 5: Commit**

```bash
git add src/main/workers/convert src/main/core/engine src/main/platform
git commit -m "feat(convert): per-kind fetch cap, too-large re-admission, parse crash fence, shared 2 MiB output cap, v2"
```

---

### Task 6: Rasterizer renders an explicit page list and reports the page count

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

- [ ] **Step 7: Keep today's caller working (no behaviour change)**

`vision-worker.ts` calls `pdfToPngs(bytes, { maxPages })` today. Adapt it in place, so this task leaves every suite green:

```ts
const first = Array.from({ length: MAX_PAGES }, (_, i) => i + 1);
const pages = (await deps.rasterizer.pdfToPngs(bytes, { pages: first })).pages.map((p) => p.png);
```

Change the `vision-worker.test.ts` fakes from `async () => [png, png]` to `async () => ({ pageCount: 2, pages: [{ page: 1, png }, { page: 2, png }] })`.

- [ ] **Step 8: Run tests and commit**

Run: `npx tsc -p tsconfig.json --noEmit && npx jest src/main/workers/vision src/main/providers/apple-vision`
Expected: PASS.

```bash
git add src/main/workers/vision src/main/providers/apple-vision native/vision-helper
git commit -m "feat(vision): rasterize an explicit page list and report pageCount (wasm + kia-vision --pages)"
```

---

### Task 7: Windowed, resumable OCR in the vision worker (with real page labels)

**Files:**
- Modify: `src/main/workers/vision/classify.ts`
- Modify: `src/main/workers/vision/merge.ts`
- Modify: `src/main/workers/vision/vision-worker.ts`
- Modify: `src/main/core/store/schema.ts` (`PENDING_VISUAL_WHERE`)
- Test: `src/main/workers/vision/__tests__/vision-worker.test.ts`, `classify.test.ts`, `merge.test.ts`, `src/main/core/engine/__tests__/engine.test.ts` (one integration case)

**Interfaces:**
- Consumes: `Rasterizer.pdfToPngs(bytes, {pages}) → {pageCount, pages:[{page,png}]}` (Task 6); `MAX_FETCH_BYTES` (Task 1).
- Produces:
  - `metadata.ocrProgress = { pageCount: number; pages: Record<string, string> }`. Keys are page numbers as strings; the value is the OCR text, possibly `''`.
  - `MAX_OCR_PAGES = 200`, `OCR_WINDOW = 10`.
  - `PageResult = { page?: number; ocrText?: string; description?: string }`. Labels use `page ?? index + 1`. Multi-page labelling applies when `pages.length > 1` **or** any `page > 1`.
  - One completion writer, `complete(engine, pagesOut)`. It writes the markdown of **every** OCR'd page (with descriptions merged in where the VLM ran), `extraction: { engine, at, pagesSkipped? }` and `ocrProgress: undefined`.

- [ ] **Step 0: Page labels (`merge.ts`)**

Failing test in `merge.test.ts`:

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

Implement:

```ts
export interface PageResult { page?: number; ocrText?: string; description?: string }
export function mergeExtraction(pages: PageResult[]): string {
  const multi = pages.length > 1 || pages.some((p) => (p.page ?? 1) > 1);
  …
    parts.push(multi ? [`--- page ${p.page ?? i + 1} ---`, ...sec].join('\n\n') : sec.join('\n\n'));
```

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
it('the VLM completion keeps OCR text of pages beyond the first 20, and pagesSkipped', async () => {
  const { r } = pagedRasterizer(230);
  // 199 pages already done with a whisper of text; total stays under the sufficiency bar
  const done = Object.fromEntries(Array.from({ length: 199 }, (_, i) => [String(i + 1), i === 149 ? 'p150' : '']));
  const s = fakeSession({ read: async () => '', see: async () => 'desc' });
  await createVisionWorker({ rasterizer: r, laneOpen: () => true })
    .work(change({ metadata: { ...baseDoc.metadata, ocrProgress: { pageCount: 230, pages: done } } }), s);
  const e = s.enriched[0];
  expect(e.metadata.extraction.engine).toBe('local-ocr+vlm');
  expect(e.metadata.extraction.pagesSkipped).toBe(30);
  expect(e.markdown).toContain('p150');
  expect(e.metadata).toHaveProperty('ocrProgress', undefined);
});
it('no read provider: first window marks pages empty and goes straight to the VLM', async () => {
  const { r } = pagedRasterizer(5);
  const see = jest.fn(async () => 'desc');
  const s = fakeSession({ read: async () => { throw new NoProviderError('read'); }, see });
  expect(await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(change({}), s)).toBe('done');
  expect(see).toHaveBeenCalledTimes(5);
  expect(s.enriched[0].metadata.extraction.engine).toBe('local-ocr+vlm');
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
      const cap = Math.min(pageCount, MAX_OCR_PAGES);
      for (const { page, png } of raster.pages) {
        try { done[String(page)] = (await session.read(png, { mime: 'image/png' })) ?? ''; }
        catch (err) {
          if (!(err instanceof NoProviderError)) return 'defer';
          // No OCR provider at all: mark every page empty (no rendering) and
          // fall through. chars = 0 < OCR_SUFFICIENT_CHARS → the VLM pass,
          // exactly today's ocrFailed path. One path, no special case.
          for (let n = 1; n <= cap; n += 1) done[String(n)] ??= '';
          break;
        }
      }
      const remaining = Array.from({ length: cap }, (_, i) => i + 1).some((n) => !(String(n) in done));
      const pagesOut = (): PageResult[] => Object.keys(done).map(Number).sort((a, b) => a - b)
        .map((n) => ({ page: n, ocrText: done[String(n)] }));
      if (remaining) {
        session.enrich({ documentId: doc.id, markdown: mergeExtraction(pagesOut()),
          metadata: { ocrProgress: { pageCount, pages: done } } });
        return 'done';
      }
      cache = null;
      // The ONE completion writer: every OCR'd page, page-ordered, with VLM
      // descriptions merged in where pass 2 ran.
      const complete = (engine: string, pages: PageResult[], extra: Record<string, unknown> = {}): WorkOutcome => {
        session.enrich({ documentId: doc.id, markdown: mergeExtraction(pages), metadata: {
          ocrProgress: undefined,
          extraction: { engine, at: new Date().toISOString(), ...extra,
            ...(pageCount > MAX_OCR_PAGES ? { pagesSkipped: pageCount - MAX_OCR_PAGES } : {}) } } });
        return 'done';
      };
      const chars = Object.values(done).join('').replace(/\s+/g, '').length;
      if (chars >= OCR_SUFFICIENT_CHARS) return complete('local-ocr', pagesOut());
      return vlmPass(pagesOut(), Math.min(pageCount, MAX_PAGES), complete);
```

**`vlmPass(pages, firstN, complete)`** is today's pass-2 block, extracted:
- It rasterizes `pages: [1..firstN]` and calls `seeWithMeta` per page. Keep the existing downscale and the `byModel` bookkeeping.
- It sets `description` on the matching `pages` entry, so pages beyond `firstN` keep their OCR text.
- It finishes with `complete('local-ocr+vlm', pages, { …today's model fields… })`.
- It returns `'defer'` on a caught error, exactly as today. The Windows OCR plan later refines that catch.

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

### Task 8: Memory gate in the real app (release check)

**Files:**
- Create: `src/main/workers/mem-probe.ts`
- Modify: `src/main/workers/convert/convert-worker.ts` (the `logPeak` call from Task 5)
- Modify: `src/main/workers/vision/vision-worker.ts` (around one window's rasterize + OCR)
- Test: `src/main/workers/__tests__/mem-probe.test.ts`

**Why in-app, not a script.** The gate must cover the real path: the converter's buffer copies, the source transport, and pdfium/kia-vision rasterization. `process.resourceUsage().maxRSS` is the kernel's high-water mark, in KiB, on every platform. Unlike a timer it cannot miss a peak while a synchronous parse blocks the event loop. Both buffers and wasm heaps live in RSS.

- [ ] **Step 1: Failing test**

```ts
import { peakIncreaseMB } from '../mem-probe';
it('peak increase is the high-water mark over the pre-step RSS, in MB', () => {
  expect(peakIncreaseMB(100 * 1024 * 1024, { maxRSS: 600 * 1024 })).toBe(500);
  expect(peakIncreaseMB(700 * 1024 * 1024, { maxRSS: 600 * 1024 })).toBe(0);
});
```

- [ ] **Step 2: Implement**

```ts
// src/main/workers/mem-probe.ts
import type { WorkerSession } from '@shared/contracts';
/** Main-process memory gate for large-file work (large-file spec, Rollout).
 *  maxRSS is a high-water mark (KiB), so the increase is exact even when a
 *  synchronous parse blocks the event loop. It is process-wide: concurrent
 *  work inflates it, so the gate is read on a quiet dev app. */
export function peakIncreaseMB(rssBefore: number, usage: { maxRSS: number } = process.resourceUsage()): number {
  return Math.max(0, Math.round((usage.maxRSS * 1024 - rssBefore) / (1024 * 1024)));
}
export function logPeak(session: WorkerSession, what: string, bytes: number, rssBefore: number): void {
  session.log('info', `mem: ${what} ${Math.round(bytes / 1048576)} MB → peak +${peakIncreaseMB(rssBefore)} MB`);
}
```

Wire it in:
- **Convert worker:** the `logPeak` line from Task 5, only for `large` docs.
- **Vision worker:** for a PDF over the eager cap, capture `rssBefore` **before the doc's first `fetchBytes`** and keep it in the single-entry bytes cache (`cache = { key, bytes, rssBefore }`). Every window logs `logPeak(session, `ocr window ${next[0]}-${next.at(-1)}`, bytes.length, cache.rssBefore)` after its OCR. One baseline per document, so growth that accumulates across windows shows up.

- [ ] **Step 3: Run and commit**

Run: `npx jest src/main/workers`
Expected: PASS.

```bash
git add src/main/workers
git commit -m "feat(workers): maxRSS memory probe on large-file parse and OCR windows"
```

- [ ] **Step 4: The gate (macOS dev app, dedicated profile and worktree)**

Never use a shared checkout's running app (see the `dev-app-in-shared-checkout-restarts` memory).

- Start the dev app **fresh for each fixture**: one file per run, then quit. A long-running app's high-water mark already includes old peaks, so the probe would under-report.
- Run 1: a ~77 MB **text** PDF in a local-folder root. Run 2: a ~77 MB **scanned** PDF.
- The cloud transport (connector download → net-guard → bridge) is gated in the connectors plan's live check, with the same `mem:` lines and the same 400 MB bar, before the connector release.
- Wait for the `mem:` lines in the main log.

Gate: every `mem:` line shows `peak +` < 400 MB.

Also check:
- the rows appear by name right after the scan;
- the text appears after the convert worker runs;
- OCR arrives in 10-page increments (MCP `get` shows `ocrProgress` growing).

**If any line exceeds 400 MB, stop.** Do not release. Moving `parse()` for deferred docs into a utility process becomes a release blocker; that is the spec's gate.

---

### Task 9: Regenerate and release the connector SDK

**Files:**
- Modify: `sdk/connector-sdk/package.json` (`version` 1.7.0 → 1.8.0; `kiagentCore` → the core version being released)
- Test: `sdk/connector-sdk/test/file-indexability.test.mjs`

The SDK copies `src/shared/file-indexability.ts` verbatim (`scripts/generate.mjs`). Connectors consume the new `bytes` field and `MAX_FETCH_BYTES` / `FILE_POLICY_VERSION` from it (connectors plan, `2026-10-02-large-file-connectors.md`).

- [ ] **Step 1: Failing SDK test**

Add to `file-indexability.test.mjs`, following its existing import style (it imports from the built `dist`):

```js
test('exports the bytes-aware policy', () => {
  assert.equal(sdk.FILE_POLICY_VERSION, 2);
  assert.equal(sdk.MAX_FETCH_BYTES, 100 * 1024 * 1024);
  assert.deepEqual(
    sdk.decideFileIndexing({ profile: 'cloud-drive', filename: 'a.pdf', mime: 'application/pdf', sizeBytes: 60 * 1024 * 1024 }),
    { kind: 'index', pipeline: 'converter', bytes: 'deferred' });
});
```

- [ ] **Step 2: Build and test**

Run: `cd sdk/connector-sdk && npm test`
Expected: PASS. `npm test` runs `generate`, so the new policy is copied in.

- [ ] **Step 3: Commit, then release at release time**

```bash
git add sdk/connector-sdk
git commit -m "chore(sdk): connector-sdk 1.8.0 with the bytes-aware file policy"
```

The release runs **after** the core release that contains this branch, from the tagged commit: `sdk/connector-sdk/scripts/release.sh`. It refuses a dirty `sdk/` tree and tags `sdk-v1.8.0` at HEAD. During development, connectors use `npm pack` output from this worktree (connectors plan, Setup).

## Rollout (where each step lives)

1. Core release: Tasks 1–8 on this branch, with the gate in Task 8, Step 4. Then the SDK release (Task 9).
2. alpha-cent `core.lock` pin, then the app release (release runbook).
3. OneDrive and gdrive releases: `2026-10-02-large-file-connectors.md`, Task 4.

## Self-Review notes

- **Spec coverage:**
  - §1 → T1, T2.
  - §2 → T5 (per-kind cap, net cap, shared output cap, `too-large` removal).
  - §3 → T5 (re-admission, fence, upgrade test) and T4 (bump).
  - §4 → T6, T7.
  - §5/§6 local → T3. Cloud → the connectors plan.
  - §7 → T4 (including the retired-consumer sweep).
  - Rollout gate → T8. SDK → T9.
- **Types:**
  - `FileIndexDecision.bytes` (T1) is used in T2, T3 and T9.
  - `RasterResult`/`RasterPage` (T6) are used in T7.
  - `PageResult.page` is defined and used in T7.
  - `session.bump` (T4) is used in T5.
  - `capMarkdown` (T5) is used in both conversion paths.
  - `logPeak` (T8) is called from T5's line, added in T8.
- **Review-round-1 changes:**
  - T3 is folded into the incremental rescan, which fixes mixed old/new roots.
  - The non-PDF worker cap is 25 MiB.
  - Fence tests use the declared size; the parse is injected.
  - (round 2) Per-batch coalescing: a doc is worked once per feed batch, so a replay can't trip the fence.
  - (round 2) The memory baseline is taken before the fetch, once per document.
  - (round 2) Local non-PDF files of 20–25 MiB end `unavailable` (local `fetchBytes` refuses `none`), not `too-large`. This is cosmetic: nothing re-admits either status for them.
  - `rerunDeferred` replaces the made-up re-drive API.
  - A crash is simulated by reopening the on-disk DB.
  - The upgrade replay test is added.
  - One output cap covers both paths.
  - The old net-guard task is folded into T5, and the old merge-labels task into the OCR task (T7).
  - `vlmOnly` is deleted, and there is one completion writer.
  - The memory gate is in-app via maxRSS.
  - The SDK task is added.
