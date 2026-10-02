# Large files: always findable, PDFs text-searchable up to 100 MiB

Status: r2 (fable + codex-astra round 1 folded in) · 2026-10-02

This spec also defines two shared mechanisms the sibling specs reuse:
**§6 policy re-enumeration** and **§7 durable attempt counter**.

## Problem

A client's legal data room (1,724 files) is missing **every file ≥ ~25 MB**:
court submissions and exhibit bundles of 26–77 MB, mostly scanned or mixed,
often far over 20 pages. They cannot be found even by name.

**Root cause.** In `src/shared/file-indexability.ts` one number does two
unrelated jobs:

1. *How many bytes may ride in an ingest batch.* This is real: a
   photo-heavy OneDrive once crash-looped the extension process by cloning a
   whole delta page of bytes over IPC. It is now also bounded by the
   connectors' 32 MiB `BATCH_BYTE_BUDGET`.
2. *Whether the file gets a row at all.* Nothing backs this.

Above the cap, `decideFileIndexing` returns `ignore: too-large`, and the
connectors drop the file: gdrive `reconcile()` omits it, OneDrive
`pageChunks` archives it, and both `fetchBytes` return null.

| Where | Cap today | Over the cap |
|---|---|---|
| Cloud convertible (`MAX_CLOUD_BINARY_BYTES`) | 25 MiB | **no row** |
| Local converter (`MAX_LOCAL_BINARY_BYTES`) | 20 MiB | PDF: metadata-only row, OCR-only; others: no row |
| Local PDF (`MAX_LOCAL_PDF_BYTES`) | 50 MiB | no row |
| Convert worker (`MAX_CONVERT_BYTES`) | 20 MiB, all kinds | `too-large`, recorded `done` |
| Vision (`MAX_PDF_BYTES`, `MAX_PAGES`) | 50 MiB, first 20 pages | skip |
| `platform/net-guard.ts` `MAX_NET_FETCH_BYTES` | 50 MiB, buffered in main | refused |

## Goals

- Every supported **document** gets a row at any size, findable by title
  (FTS indexes `title`).
- PDFs up to `MAX_FETCH_BYTES` (100 MiB) get their text layer indexed;
  scanned PDFs are OCR'd up to 200 pages.
- Files already missing come back without user action.
- No new OOM or crash loop: batches stay byte-bounded, each OCR run renders
  a bounded window, and a document that kills the process stops being
  retried.

## Non-goals

- Deferred extraction for docx/xlsx/other kinds over the eager cap. They
  get a findable row and `too-large`; their parsers are a separate risk.
- Mixed scanned + text PDFs (a text page hides scanned pages). Fixed per
  page by the garbled-pdf-text spec, which builds on §4 here.
- Streaming bytes to temp files / redesigning `fetchBytes` IPC, unless the
  step-2 measurement demands it.
- Path search (no FTS path column), and a user-facing size setting.

## Design

### 1. A row for every document; bytes are a separate decision

`decideFileIndexing`'s index decision gains a field:

```ts
| { kind: 'index'; pipeline: FilePipeline; bytes: 'eager' | 'deferred' | 'none' }
```

| Case | `bytes` | Meaning |
|---|---|---|
| ≤ eager cap (20 MiB local, 25 MiB cloud) | `eager` | today's behaviour |
| PDF, eager cap < size ≤ `MAX_FETCH_BYTES` | `deferred` | metadata-only row now; convert worker fetches later |
| PDF > `MAX_FETCH_BYTES`, or any other document kind > its eager cap | `none` | metadata-only row; nothing ever fetches it |

`ignore: too-large` remains only for **media**: images over 20 MiB and
audio/video over 200 MiB (unchanged).

Local 20–50 MiB PDFs move from the `vision` route to
`converter` + `deferred`. They are parsed first, and OCR'd only if
text-poor.

**Connectors** (OneDrive, gdrive):

- Map `deferred` and `none` onto the metadata-only item shape each already
  has (`failedItem` / `metadataOnly`): no download, `markdown: ''`, title,
  path, size and mime in metadata.
- gdrive `reconcile()` includes these refs. OneDrive `pageChunks` stops
  archiving them.
- `fetchBytes` serves `deferred` and refuses `none`.

The **local-folder source** treats both like its existing metadata-only
path. Its `fetchBytes` already re-runs `decideLocalFile` and refuses
`none`.

The SDK ships `file-indexability.ts` verbatim, so this is a core policy
change regenerated into the SDK.

### 2. The workers use per-kind fetch caps

`MAX_CONVERT_BYTES` becomes **per kind** in the convert worker:

- PDF → `MAX_FETCH_BYTES` (100 MiB).
- Everything else → its eager cap, which records `too-large` exactly as §1
  says.

The worker checks the declared size before fetching, as today.

- Vision `MAX_PDF_BYTES` becomes `MAX_FETCH_BYTES`.
- `MAX_NET_FETCH_BYTES` rises to `MAX_FETCH_BYTES`.
- **Output cap:** extracted markdown is truncated at 2 MiB of characters
  with a `[truncated]` marker and `conversion.truncated: true`.

**`too-large` no longer hands PDFs to OCR.** It is removed from
`PDF_OCR_AFTER_STATUSES`. With the caps aligned, vision could not fetch
above the convert cap anyway. `PENDING_VISUAL_WHERE` derives from that list
and the partial index rebuilds on SQL change.

### 3. Re-admission and crash fence

- **Re-admission.** `isConvertCandidate` admits `conversion.status ===
  'too-large'` when the declared size ≤ the current per-kind cap.
  - A changed predicate alone re-drives nothing: those rows were recorded
    `done` and the live tail is past them.
  - So the **convert worker's `version` is bumped**. Its consumer key
    `worker:convert:v<version>` gets cursor 0 and replays the feed, and
    `activeConsumers()` keeps the retired key out of pending counts.
  - **One bump serves this spec, the `.msg` spec and the garbled-pdf spec;
    they ship in the same core release.**
- Rows that already carry `extraction` (local 20–50 MiB PDFs OCR'd under the
  old route) stay OCR-only. Re-parsing them is not worth a special case.
- **Crash fence.** For a doc over the eager cap, the convert worker calls
  `await session.bump('fetch')` (§7) **before** fetching:
  - when it returns > 2, it records `failed` without fetching;
  - a doc that kills the process twice is never tried again.

### 4. Windowed OCR, one window per run

Raising the page cap on today's render-every-page rasterizer is the next
OOM, so the change is windowed:

- **Rasterizer API.** `Rasterizer.pdfToPngs(bytes, { pages: number[] })`
  renders exactly the listed pages (1-based). The mac helper's
  `rasterizePdf` gets `--pages`. wasm pdfium renders per page already.
  Windows needs no helper change. Page *lists*, not ranges, so the
  garbled-pdf spec can pick scattered pages.
- **One window per `work()` run.** The vision worker OCRs the next 10
  pages, enriches progress plus markdown re-rendered from it, and returns
  `done`.
  - Progress lives in a sibling key,
    `ocrProgress: { pageCount, pages: Record<pageNo, text> }`, never inside
    `extraction`. Per-page OCR text is keyed by the **original page
    number**, including pages that came back empty.
  - Markdown is always re-rendered from that map. `merge.ts` labels pages
    by their real number, not array position.
  - On completion, `ocrProgress` is cleared and `extraction` is set.
  - The garbled-pdf spec uses the same representation for scattered pages.
    `extraction` keeps meaning "finished", and the SQL mirror's
    `extraction IS NULL` stays true while in progress.
  - Every enrich appends a document change, so the doc re-enters the feed
    and the next run takes the next window.
  - Each window is committed durably by the normal batch commit. A crash
    loses at most one window.
- **Bytes cache.** Re-entry is immediate, so the worker keeps a
  **single-entry** in-memory cache (docId + contentHash → bytes). The next
  window doesn't re-download 77 MB. It is dropped on completion or on a
  different doc.
- **Cost accepted.** pdfium re-loads the PDF once per window (about 20 loads
  for 200 pages).
- **Caps.** `MAX_OCR_PAGES = 200`. Pages beyond it are recorded in
  `extraction.pagesSkipped`. VLM pass 2 is unchanged: only when the whole
  document's OCR yields fewer than 200 characters, and only on the first
  20 pages.
- `classifyDocument` admits a doc with `ocrProgress` and no `extraction`,
  **bypassing the has-text skip**: after window 1 the doc has markdown.
  `PENDING_VISUAL_WHERE` gets the same clause.

### 5. Recovering what is already missing

| Missing because | Mechanism |
|---|---|
| Cloud file had no row | §6 policy re-enumeration (OneDrive **and** gdrive) |
| Local file > 50 MiB had no row | §6 (local) |
| Row marked `too-large` | §3 worker version bump |

No user action. Remove-and-re-add (which destroys documents) is never the
answer.

### 6. Shared: policy re-enumeration (`FILE_POLICY_VERSION`)

`file-indexability.ts` exports `FILE_POLICY_VERSION` (starts at 2, bumped
whenever a change makes previously ignored files indexable). Each file
source stores it in its cursor; when the stored value ≠ the current one,
the source does one full re-enumeration:

- **gdrive:** the cursor gains `policy_version`. A mismatch is handled like
  the existing `scope_roots` mismatch branch (`source.ts` ~1406): a
  `backfill_done: false` re-walk.
- **OneDrive:** the cursor gains `policy_version`. A mismatch means a delta
  from scratch, as the `attachments:1` precedent did in ms365 2.2.0.
- **local-folder:** `LocalFolderCursor` gains `policyVersion`. A mismatch
  drops all `roots` entries, so each root takes `backfillRoot`.

Re-enumeration is cheap where nothing changed: unchanged rows hit the
store's same-`content_hash` short-circuit, so there is no feed churn. The
`.msg` spec bumps nothing extra; it ships in the same policy version.

### 7. Shared: durable attempt counter (`session.bump`)

`session.enrich` is buffered until the batch commits, and every enrich
appends a document change. So a counter kept in document metadata is
neither crash-safe nor loop-free.

- **Store.** New table `work_attempts(consumer, doc_id, key, n,
  PRIMARY KEY(consumer, doc_id, key))`.
- **Worker session.** `bump(key): Promise<number>` increments and commits
  **immediately**, in its own write, with **no** document change. It
  returns the new count.
- **Lifetime.** The engine deletes a doc's rows for that consumer when
  `work()` returns `done`. Rows of retired consumers are swept with them.

Users: §3's crash fence (`'fetch'`), and the windows-ocr spec's VLM failure
count (`'vlm'`).

## Rollout

1. **Core release, one release.** Policy `bytes` field + `FILE_POLICY_VERSION`,
   local re-enumeration, per-kind caps, net cap, output cap, re-admission
   via the worker version bump, `session.bump` + fence, removal of
   `too-large` from the OCR hand-off. It regenerates the SDK.
   - **Gate:** in the dev app, parse a real 77 MB PDF and a 77 MB scanned
     PDF. Measure **peak RSS and `process.memoryUsage().external`**, not just
     heap snapshots.
   - If the peak main-process increase exceeds 400 MB, move `parse()` for
     deferred docs into a utility process before release.
2. **alpha-cent pin + app release.**
3. **OneDrive + gdrive connector releases** against the new SDK. These ship
   after the app, so no new-connector-on-old-core window produces rows the
   old core mishandles. After this step, cloud files come back findable.
4. **Windowed OCR** (core + Swift helper `--pages`): scans up to 200 pages.

## Testing

- **Policy table:** eager cap ±1, fetch cap ±1, a docx over the eager cap
  → `none`, a 150 MiB PDF → `none`, a 30 MiB PNG → `ignore`.
- **Connectors:**
  - A 60 MiB PDF triggers zero downloads at ingest, produces one
    metadata-only item, survives reconcile, and `fetchBytes` returns bytes.
  - A 150 MiB PDF gets a row and `fetchBytes` returns null.
  - An old cursor without `policy_version` triggers exactly one
    re-enumeration.
- **Upgrade (engine integration, not hand-called workers):** an account
  whose old convert consumer already recorded a 40 MiB PDF `too-large` gets
  it parsed after upgrade.
- **Fence:** a fake parser that crashes the worker process twice ends in
  `failed`. Use real process termination in an integration test.
- **Windowed OCR:** a 45-page scanned fixture produces 5 committed runs,
  and the markdown has every page in order. Killing the process after run
  2 resumes at page 21. The bytes are fetched once.
- **Live:** a 77 MB mixed PDF in a local folder and in OneDrive is findable
  by name right after sync, and its text appears once the workers have run.
