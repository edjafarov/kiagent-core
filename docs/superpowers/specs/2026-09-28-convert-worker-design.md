# Convert worker: one parse path for every attachment/file

**Date:** 2026-09-28 · **Branch:** `feat/convert-worker` (from v0.96.0)

## Problem

The engine converter (`core/engine/convert.ts`: pdf-parse, mammoth docx,
xlsx, csv, html, eml, text) runs ONLY on `DocumentInput.binary` at commit
time. Sources that push bytes eagerly (local-folder, onedrive, google-docs,
slack, whatsapp, telegram) get parsed. Gmail — built into core — commits
every attachment bytes-less with `markdown: null`; afterwards only the
vision worker (PDF/images, via `fetchBytes`) and the audio worker ever pull
bytes. Result in the live corpus: 0 of 108 .docx, 214 .doc, 31 xlsx, 81 eml,
csv… Gmail attachments have text. Gmail PDFs skip pdf-parse entirely and are
rasterized + OCR'd (slow, processing-window-gated, 20-page cap). A parse
that throws at commit time is logged and silently left null forever.

## Goal

One extraction chain that does not care which source a document came from:

```
attachment/file doc, markdown empty
  └─ convertible? (same predicate parse() dispatches on)
       ├─ bytes on ingest  → commit-path converter   ─┐
       └─ no bytes          → CONVERT WORKER          ─┤ (fetchBytes → parse)
                                                        ▼
                             metadata.conversion = {status}
                               ok        → markdown written, done
                               text-poor → vision (PDF only)
                               failed / too-large / unavailable → PDF: vision; else terminal
  └─ image → vision (unchanged)      └─ audio/video → audio worker (unchanged)
```

## Design

1. **One predicate, next to the parser.** `convert.ts` exports
   `convertibleKind(mime, filename): Kind | null` (pdf, docx, xlsx, csv,
   html, email, text). `parse()` dispatches on it, the worker matches on it
   — they cannot drift.

2. **Outcome marker** `metadata.conversion = { status, error? }`,
   status ∈ `ok | text-poor | failed | too-large | unavailable`.
   - Written by the commit-path converter whenever it ran on bytes.
     **No timestamp** there: `contentHash` covers metadata, a clock value
     would rewrite every local file on every rescan.
   - Written by the convert worker via `enrich` (may carry `at`).
   - Existing `metadata.extraction` stays the vision/audio marker; `ok`
     also sets `extraction: {engine: 'parser'}`? **No** — keep one meaning
     per key; stats query for "processed" is unchanged (vision-owned).

3. **Convert worker** (`workers/convert/`), name `convert`, v1, schedule
   `live` + a `{every: '5m'}` re-drive for deferred items that is **not**
   processing-window-gated (no inference; parsing is deterministic).
   - `matches`: document change, type `attachment|file`, not archived,
     `markdown` null/under 16 chars, no `conversion` marker, no
     `extraction` marker, `convertibleKind != null`.
   - `work`: size from `metadata.sizeBytes ?? size`; over
     `MAX_LOCAL_BINARY_BYTES` (20 MB) → marker `too-large` (no fetch).
     `fetchBytes` throws → `defer` (auth/network; re-drive retries).
     `fetchBytes` → null → marker `unavailable`. Parse → `ok` (markdown) /
     `text-poor` (null) / `failed` (error message, truncated).
   - Re-entrancy: every enrich sets `conversion`, which `matches` excludes.
   - Starts at cursor 0 → the existing backlog (≈450 Gmail attachments) is
     processed on first boot, with no migration.

4. **Enrich may write `markdown: null`.** `EnrichInput.markdown` widens to
   `string | null` so non-ok outcomes record the marker without inventing
   text (store already handles null markdown on upsert/FTS). Widening an
   input type is SDK-compatible.

5. **Vision waits for the parser on PDFs.** `classifyDocument`: a PDF is a
   vision candidate only once `conversion.status` is `text-poor | failed |
   too-large` (a PDF with real text never reaches vision). Images are
   unchanged. Legacy pending PDFs (no marker) now go parser-first; the
   convert enrich re-emits the doc and vision sees the marked version.

6. **Gmail:** no source change beyond the stale `to-document.ts` comment.
   Its `fetchBytes` already re-resolves rotating attachment ids.

## Out of scope (follow-ups)

- New formats: legacy `.doc` (214 docs), `.pptx`, `.rtf`, `.xls` via mime
  `application/vnd.ms-excel` already works by ext.
- IMAP and ms365 mail attachments (not ingested at all today).
- Marketplace connectors keep pushing eager `binary`; now an optimisation,
  not a requirement.
- Moving parsing off the main thread (same in-process cost as today's
  commit path; converter pool is LEFTOVERS).

## Tests (named requirements)

- `convertibleKind` table incl. octet-stream + `.docx` filename.
- commit-path converter: marker `ok` / `text-poor` / `failed`, and the
  marker is deterministic (two runs → identical `contentHash`).
- worker `matches`: excludes marked docs (re-entrancy), images, audio,
  docs with text, archived.
- worker `work`: ok/text-poor/failed/too-large/unavailable/defer-on-throw.
- vision classify: PDF without marker → skip; with `text-poor` → candidate;
  image unchanged.
- store: enrich with `markdown: null` merges metadata, leaves markdown null.
- engine integration: bytes-less docx attachment + fake `fetchBytes` →
  markdown populated after the worker runs.

## Revision 1 (after fable + codex astra design review)

Supersedes the sections above where they differ.

- **Single marker writer.** Only the convert worker writes
  `metadata.conversion`. The commit-path converter is unchanged (parse bytes,
  markdown or null, no marker) — no hashed marker, no determinism concern.
  A text-poor/failed local binary is re-fetched + re-parsed once by the
  worker; cheap.
- **`EnrichInput.markdown` becomes optional** (omitted = leave the row's
  markdown untouched). Non-ok outcomes write only the marker, so a late
  write can never erase text (mitigates the live/re-drive overlap race
  codex raised; a per-doc seq check was judged out of proportion).
- **Source-not-ready ≠ unavailable.** Workers attach before sources register
  (main.ts). `WorkerSession.fetchBytes` now throws `SourceNotReadyError`
  when the account exists but its source is not registered; convert,
  vision and audio map it to `defer`. Pre-existing bug fixed on the way:
  vision/audio used to `skip` (terminal) such docs at startup.
  `fetchBytes → null` stays terminal: status `unavailable`, not routed to
  vision (it would get the same null).
- **Scheduling:** `schedule: {every: '5m'}`, attached via `boot.attachWorker`
  (live tail + ungated re-drive). No new contract.
- **One text-poor threshold:** `TEXT_POOR_CHARS = 200` non-whitespace chars
  (= vision's `OCR_SUFFICIENT_CHARS`) for PDFs, in `parse()` itself, so the
  commit path and the worker agree.
- **Vision PDF gate mirrored in `PENDING_VISUAL_WHERE`** (partial index is
  rebuilt on SQL-text change; no migration).
- **Gmail:** `attachmentId` removed from attachment metadata (it rotates and
  sits in `contentHash`, so every thread refresh wiped `conversion` /
  `extraction`). `fetchBytes` resolves the current id from `partId`.
