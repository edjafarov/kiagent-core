# Local inference & OCR — design

Date: 2026-07-02 · Status: draft for review
Closes LEFTOVERS items 2 (inference providers) and 3 (vision/OCR worker);
extends item 4's Gmail deviation (attachments as child docs).

## Goal

Port the legacy "deep extraction" subsystem onto the greenfield contracts:
pick the best local model for this hardware, download it, and use it — plus
native local OCR — so scanned PDFs and images become searchable. Decisions
made with the user 2026-07-02:

- **Auto-download** (like the legacy app): the model download starts on its
  own when text-poor documents need the vision pass; Settings can cancel and
  disable. No install button gate.
- **Scope: phases A + B** (macOS-native OCR + the local llama runtime).
  Windows/Linux parity (WinRT helper, GLM-OCR fallback, Vulkan probing) is
  phase C, deferred.
- **Gmail attachments included**: the Gmail source starts emitting
  `attachment` child documents and implements `fetchBytes`, so email scans
  feed the OCR worker (today only local-folder has OCR-able bytes).

## What we port from kiagent-ref (verbatim where possible)

`src/main/inference/` in kiagent-ref is self-contained and battle-hardened;
these files port with minimal edits:

- `runtime/capability.ts` — 8 GB RAM floor on CPU-only hosts; GPU always passes.
- `runtime/backend.ts` — darwin → Metal (capacity = unified RAM); phase C:
  Vulkan probing. CPU fallback ports as-is.
- `runtime/models.ts` — the curated catalog, pinned HF revisions + SHA-256:
  Gemma 4 12B Q4_K_M (≥48 GB), E4B (≥24 GB), E2B (else / CPU-only).
  GLM-OCR 0.9B stays in the catalog but nothing selects it until phase C.
- `runtime/downloader.ts` — resumable (`.part` + Range), streamed+on-disk
  SHA-256, 1.5× free-disk preflight, chunk-copy workaround for the multi-GB
  fetch corruption bug. Files land in `<userData>/data/models/<model.id>/`.
- `runtime/server.ts` — `llama-server` supervisor: free port, `/health`
  polling, crash respawn with backoff, `-ngl 999` on Metal.
- `vision-helper.ts` + `native/vision-helper` — the `kia-vision` Swift
  binary (Apple Vision OCR + CoreGraphics PDF rasterization). Already in
  this repo with its build script.
- `rasterize/wasm.ts` — pdfium WASM rasterizer (dep already present); used
  off-mac and as fallback. 20-page cap, 2× scale.
- `classify.ts` / `merge.ts` heuristics — eligibility predicate and the
  `**Description:** / **Text content (OCR):**` markdown merge format, 1 MB cap.

Not ported: the legacy `RuntimeManager` state machine, `InferenceScheduler`,
`inference_jobs` table, and IPC channels — the greenfield plane, Worker
ledger (`done|skip|defer`), and scheduler replace all of them.

## Contract changes (src/shared/contracts.ts + concept/greenfield.ts)

1. **Third inference kind: `read`** — OCR, image in → plain text out.
   ```ts
   interface Inference {
     complete(prompt, opts?): Promise<string>;
     see(image, prompt, opts?): Promise<string>;   // describe / layout
     read(image, opts?): Promise<string>;          // NEW — OCR only
   }
   // InferenceProvider.supports: Array<'complete' | 'see' | 'read'>
   ```
   Rationale: the router picks by kind. OCR (cheap, native, no download) and
   VLM describe (expensive, needs the model) must route to different
   providers — collapsing both into `see` makes two-pass unroutable.
2. **WorkerSession sugar**: `see(image, prompt)` and `read(image)` pinned to
   the background lane, next to the existing `inference()` (complete).
3. **`enrich` arm on the consumer commit** — OCR output must update the
   *original* document (that is what makes it searchable); `emit()` only
   creates new docs under the worker's synthetic account.
   ```ts
   | { consumer: string; cursor: Seq; documents?: DocumentInput[];
       enrich?: Array<{ documentId: DocumentId; markdown: string;
                        metadata?: Record<string, unknown> }> }
   ```
   Same transaction as the cursor; updates markdown + merges metadata, bumps
   `updatedAt`, reindexes FTS, emits a `document` change into the feed.
   Enrich does NOT touch `contentHash` (that hashes source content; an
   enriched doc re-synced from source must still dedupe correctly — the
   source's own markdown wins on next real change).

## Components

### 1. `apple-vision` provider — `src/main/providers/apple-vision/`
Supports `['read']`. Drives the bundled `kia-vision` helper (spawn + JSON,
120 s timeout). `ready` on darwin when the helper binary exists,
`unsupported` otherwise. Zero download, zero configuration. The helper
driver module is shared: the vision worker also uses its CoreGraphics
rasterization directly (rasterization is not an inference kind).

### 2. `local-llm` provider — `src/main/providers/local-llm/`
Supports `['complete', 'see']`. Wraps catalog + downloader + server:

- **Status mapping**: no model on disk → `standby`; capability check fails →
  `unsupported`; download in flight → `{downloading: {pct}}`; files on disk →
  `ready` (the llama-server itself starts lazily on the first `handle()` and
  idle-stops after 10 min to free RAM — "ready" means "can serve", cold
  start included); failure → `{error}`.
- **Auto-install**: `ensureInstalled()` — no-op if on disk or already
  downloading or auto-install was cancelled; otherwise selects the tier
  (prefs override else hardware tier) and starts the download. Called by the
  vision worker when it defers for lack of a `see` provider, gated on
  `prefs.processing.enabled`. A user cancel in Settings sets a persisted
  `models.autoInstall = false` so the worker cannot re-trigger it; enabling
  again from Settings resets the flag and starts the download.
- **Prefs**: `AppPrefs.models = { override: 'auto' | <model-id>, autoInstall: boolean }`
  (defaults `'auto'`, `true`). Changing the override while installed swaps
  models (old files stay on disk, as legacy did).

### 3. `vision` worker — `src/main/workers/vision.ts`
Bundled `Worker` (`worker:vision:v1`), `schedule: 'live'`; deferred changes
re-drive via the scheduler's existing `rerunDeferred` on the processing
window (`prefs.processing.window`).

- **matches(change)**: `kind === 'document'`, not archived, type
  `attachment` | `file`, mime `application/pdf` | `image/*` (or extension
  fallback list), markdown null or < 16 chars, and not already enriched
  (`metadata.extraction == null`). Images < 8 KB skip (decorative).
- **work()** pass 1 (OCR): `fetchBytes` (null → `skip`) → size caps (images
  20 MB, PDFs 50 MB → `skip`) → rasterize PDFs (CoreGraphics on mac, pdfium
  fallback; ≤ 20 pages) → `session.read(page)` per page → merged text
  ≥ 200 chars → enrich (`metadata.extraction = {engine: 'apple-vision', at}`)
  → `done`. Text-poor → trigger `ensureInstalled()` → `defer`.
- **Pass 2 (deferred re-drive)**: if a `see` provider is `ready`, per page
  `session.see(page, INDEXING_PROMPT)` (the legacy retrieval-oriented
  prompt: describe for search, don't transcribe verbatim), merge OCR text +
  description, enrich (`engine: 'apple-vision+<model-id>'`) → `done`. If no
  provider ready yet → `defer` again (stays parked; free — it's a ledger row).
- No `read` provider at all (non-mac until phase C): pass 1 defers straight
  to pass 2, where GLM-OCR would handle it (phase C).

### 4. Store: `enrich` commit arm — `src/main/core/store/store.ts`
As specified in contract change 3. One new branch in `commit()`; FTS row
replace mirrors the existing document-update path.

### 5. Gmail attachments — `src/main/sources/gmail/`
- Thread conversion additionally emits one `attachment` child doc per file
  part: `externalId = <messageId>/<attachmentId-or-partId>`, parent = the
  thread, `markdown: null`, `metadata = {mime, filename, sizeBytes,
  messageId, attachmentId}`, `createdAt` = message date. Skip
  inline-disposition images < 8 KB early (signature noise never enters the
  store).
- `Source.fetchBytes(session, doc)` via
  `users.messages.attachments.get(messageId, attachmentId)` (base64url →
  bytes). Attachment ids can rotate; on 404, re-fetch the message to
  re-resolve the part by filename+index before giving up.
- Existing accounts: already-synced threads won't re-emit (content hash
  unchanged). Acceptable: new mail gets attachments immediately; history
  backfills whenever a thread changes or on a future re-index. Not worth a
  forced re-sync in this pass.

### 6. Settings UI — `LocalProcessing.tsx`
The pane already renders provider status + progress. Add:
- Model row for `local-llm`: auto-picked tier name + size when `standby`
  ("will download automatically when needed"), Cancel while downloading,
  model override dropdown (Auto + the three tiers), "Download now" button
  when `autoInstall` is off.
- Poll `inference:providers` every 2 s while any provider is downloading
  (client-side; no new push channel).
- New IPC: `inference:install` (starts/retries), `inference:cancel`,
  model override rides the existing `prefs:patch`.

### 7. Build wiring
`scripts/fetch-llama-server.mjs`, `llama-assets.mjs`,
`build-vision-helper.mjs`, `vendor-deep-extraction.mjs` already exist in
this repo. Wire them into `package` (electron-builder extraResources) and
add a dev bootstrap script (`npm run vendor:inference`) that fetches the
llama binary + builds the Swift helper once. Dev runs without them:
providers report `unsupported`/`error` gracefully when binaries are absent.

## Error handling

- Helper binary missing/crashing → provider `{error}`, worker outcomes
  become `defer` (not `skip`) so documents recover after a fix.
- Download failure → `{error}` + retry on next `ensureInstalled()` trigger
  (downloader resumes from `.part`).
- llama-server crash → supervisor respawns with backoff; in-flight request
  fails, worker retry ledger (maxAttempts 3) absorbs it.
- Poison documents (bad PDFs, huge pages): caps + `skip` outcome; the ledger
  guarantees a poison doc can't stall the cursor.

## Testing

- Unit: catalog tier selection (accel × capacity matrix), downloader
  (resume, sha mismatch, disk preflight — mocked fetch), classify predicate,
  merge format, store `enrich` (FTS reindex + feed change + same-tx cursor).
- Worker: fake providers — pass-1-sufficient, pass-1-thin → defer →
  pass-2-after-ready, no-provider → parked, fetchBytes-null → skip.
- Gmail: fixture message with attachment → child doc emitted; fetchBytes
  decode; 404 re-resolve.
- Smoke (manual): drop a scanned PDF into a local folder account → its text
  is searchable; check Settings shows apple-vision `ready`; watch the model
  auto-download kick in for an image-only PDF.

## Out of scope

Phase C (Windows WinRT OCR, GLM-OCR fallback, Vulkan probing), embeddings
(dead table in legacy too), interactive `see`/`read` over MCP, re-sync of
historical Gmail threads to backfill attachments.
