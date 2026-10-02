# Large files: always findable, text-searchable up to ~100 MiB

Status: r1 (draft) · 2026-10-02

## Problem

A client's legal data room (1,724 files) is missing **every file ≥ ~25 MB**:
court submissions and exhibit bundles of 26–77 MB, mostly scanned or mixed
scanned + text, often far over 20 pages. They cannot be found even by file
name. Advisory reviews (fable, codex astra) traced it to one design flaw.

**Root cause.** In `src/shared/file-indexability.ts`, one number does two
unrelated jobs:

1. *How many bytes may ride in an ingest batch.* A real constraint: a
   photo-heavy OneDrive once cloned a whole delta page of bytes over IPC and
   crash-looped the extension process (now bounded by the connectors' 32 MiB
   `BATCH_BYTE_BUDGET`).
2. *Whether the file gets a row at all.* No constraint backs this.

`decideFileIndexing` returns `ignore: too-large` above the cap, so the
connectors emit nothing (gdrive `reconcile()` omits the ref, OneDrive
`pageChunks` pushes a deletion, both `fetchBytes` return null).

| Where | Cap today | Over the cap |
|---|---|---|
| Cloud, any convertible (`MAX_CLOUD_BINARY_BYTES`) | 25 MiB | **no row** |
| Local converter (`MAX_LOCAL_BINARY_BYTES`) | 20 MiB | PDF: metadata-only row, OCR only (20 pages); others: no row |
| Local PDF (`MAX_LOCAL_PDF_BYTES`) | 50 MiB | no row |
| Convert worker (`MAX_CONVERT_BYTES`) | 20 MiB | `conversion.status: too-large`, **terminal** |
| Vision (`MAX_PDF_BYTES`, `MAX_PAGES`) | 50 MiB, 20 pages | skip / pages 21+ never read |
| `platform/net-guard.ts` `MAX_NET_FETCH_BYTES` | 50 MiB, body buffered in main | fetch refused |

Rasterization (`vision/rasterize.ts`, mac `vision-helper.rasterizePdf`)
returns **all** page PNGs in one array, so the 20-page cap is also a memory
cap.

## Goals

- Every supported file gets a row, at any size. Findable by title
  immediately (FTS indexes `title`).
- PDFs up to the fetch cap (100 MiB) get their text layer indexed, and
  scanned pages are OCR'd up to 200 pages.
- No new OOM or crash-loop path: batches stay byte-bounded, and so does each
  rasterized window.

## Non-goals

- Streaming bytes to temp files, or redesigning `fetchBytes` IPC. A single
  ≤ 100 MiB transfer in a serial worker is not what crashed; a page of them
  was. Revisit only if the measurement in step 2 says so.
- Deferred extraction for docx/xlsx over the eager cap. They get a row
  (findable by name) and `too-large`; their parsers inline images and are a
  separate risk.
- Path search (FTS has no path column; adding one is an FTS rebuild). Title
  search covers the reported need.
- A user-facing size setting.

## Design

### 1. Two caps, and a row for everything

Two kinds of cap:

- The **eager cap** limits the bytes shipped with a document at commit,
  inside a batch. It stays at 20 MiB local and 25 MiB cloud.
- The **fetch cap**, `MAX_FETCH_BYTES = 100 MiB`, limits one later
  `fetchBytes` by a background worker. It is new.

`decideFileIndexing` gains a field on the index decision:

```ts
| { kind: 'index'; pipeline: FilePipeline; bytes: 'eager' | 'deferred' }
```

- At or under the eager cap → `bytes: 'eager'` (today's behaviour).
- A **PDF** over the eager cap and at or under `MAX_FETCH_BYTES` →
  `{ pipeline: 'converter', bytes: 'deferred' }`.
- Any **other document type** over its eager cap gets
  `{ pipeline: 'converter' | 'inline-text', bytes: 'deferred' }`. These
  are docx, xlsx, csv, html, email and text. The convert worker records
  `too-large`, so the row exists but has no text.
- `ignore: too-large` remains for:
  - PDFs above `MAX_FETCH_BYTES`;
  - images over 20 MiB and audio/video over 200 MiB. These are media, not
    documents, and keep today's behaviour.

The local 20–50 MiB PDF `vision` route is subsumed: those PDFs become
`converter` + `deferred`, so a large text-layer PDF is now parsed instead of
OCR'd page-by-page.

**Connectors** (OneDrive, Google Drive) map `bytes: 'deferred'` onto the
metadata-only item shape they already have (`failedItem` / `metadataOnly`):
no download, `markdown: ''`, title + path + size + mime in metadata. Three
more changes in each connector:

- gdrive `reconcile()` includes deferred refs.
- OneDrive `pageChunks` no longer archives them.
- Both `fetchBytes` admit them, since `chooseRoute` no longer says `ignore`.

The **local-folder source** treats `deferred` like its existing
metadata-only path. Its `fetchBytes` enforces `MAX_FETCH_BYTES` for
deferred PDFs.

The SDK ships `file-indexability.ts` verbatim, so this is one policy change
in core, regenerated into the SDK.

### 2. The workers use the fetch cap

- `MAX_CONVERT_BYTES` and vision's `MAX_PDF_BYTES` become `MAX_FETCH_BYTES`.
- `MAX_NET_FETCH_BYTES` rises to `MAX_FETCH_BYTES`. Body buffering in main
  stays.
- **Output cap:** extracted markdown is truncated at 2 MiB of characters,
  with a trailing `[truncated]` marker and `conversion.truncated: true`.
  This replaces the input cap as the guard on FTS size.

### 3. `too-large` is relative to the cap, and crashes are fenced

`isConvertCandidate` excludes any doc carrying a `conversion` marker, so
rows already marked `too-large` would never re-enter after the cap rises.
The change:

- A doc with `conversion.status === 'too-large'` is a candidate again when
  its declared size ≤ the current cap.
- `failed`, `unavailable` and `text-poor` stay terminal.
- **Fence:** before fetching a doc whose declared size is over the eager
  cap, enrich `conversion: { status: 'in-progress', attempts: n+1 }`. A doc
  found `in-progress` with `attempts ≥ 2` is recorded `failed` without
  fetching. This guarantees a document that kills the process is never
  retried forever.

### 4. Windowed, resumable OCR for long scans

Raising `MAX_PAGES` on today's collect-every-page rasterizer is the next
OOM, so windowing comes first:

- `Rasterizer.pdfToPngs(bytes, { from, to })` and the mac helper's
  `rasterizePdf` take a page range. The wasm pdfium path renders per page
  already; the Swift helper gets `--from/--to`.
- The vision worker fetches bytes **once** per `work()`, then loops over
  windows of 10 pages: rasterize the window, OCR it, drop the PNGs.
- After each window it persists progress with
  `extraction: { engine: 'local-ocr', partial: { nextPage, pageCount } }`
  plus the merged markdown so far. `classifyDocument` treats a `partial`
  extraction as a candidate.
- A lane close or crash therefore resumes at `nextPage`. It never restarts
  at page 1.
- `MAX_OCR_PAGES = 200`. Pages beyond it are not OCR'd; the doc records
  `extraction.pagesSkipped`.
- VLM pass 2 is unchanged: it runs only when the whole doc's OCR yields
  < 200 chars, and only on the first 20 pages.

### 5. Recovering what is already missing

Already-ignored cloud files have no row and are unchanged upstream:

- gdrive's next full walk re-emits them.
- OneDrive delta will not. The OneDrive release bumps its cursor format
  (cursor without `deferred:1` → full re-enumeration). That precedent was
  set by `attachments:1` in ms365 2.2.0.
- Local rows get rescanned.

The rows marked `too-large` are re-admitted by §3. No user action is
needed, and Remove-and-re-add (which destroys documents) is never
suggested.

## Rollout

1. **Policy + connectors** (`bytes` field, deferred rows, OneDrive cursor
   bump). Release order:
   1. Core release, which regenerates the SDK.
   2. OneDrive + gdrive connector releases built against that SDK.
   3. The alpha-cent pin that bumps core.

   Connectors may ship *before* the app pin. An updated connector on an old
   core emits deferred rows that old core marks `too-large` and keeps, which
   is harmless. **Outcome:** every file is findable by name.
2. **Fetch cap, net cap, output cap, re-admission, fence** (core only).
   **Outcome:** text-layer PDFs up to 100 MiB are full-text searchable.
   - **Gate:** parse a real 77 MB PDF in the dev app with a heap snapshot
     before and after.
   - If the main-process heap delta exceeds 300 MB, move `parse()` for
     deferred docs into a utility process before shipping. Otherwise keep
     it in main.
3. **Windowed OCR** (core + the Swift helper). **Outcome:** scans up to
   200 pages are searchable.

## Testing

- **Policy:** table tests at eager-cap ±1 byte, fetch-cap ±1 byte, and a
  docx over the eager cap → deferred.
- **Connectors:** a 60 MiB PDF fixture makes zero content downloads at
  ingest, produces one metadata-only item, survives reconcile, and its
  `fetchBytes` returns bytes. The OneDrive cursor bump causes one
  re-enumeration.
- **Workers:**
  - Re-admission: an existing `too-large` 40 MiB row is parsed after the
    upgrade.
  - Fence: a parser that throws the process-killing path twice → `failed`.
  - Truncation at 2 MiB.
- **Windowed OCR:** a 45-page scanned fixture with the lane closed after
  window 2 resumes at page 21, and the final markdown has every page in
  order.
- **Live:** a 77 MB mixed PDF in a local folder and in OneDrive is findable
  by name right after sync, and its text appears after the workers run.
