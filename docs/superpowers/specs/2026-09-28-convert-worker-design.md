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

## Revision 2 (after fable + codex astra implementation review)

- **Fetch failures defer, engine-wide.** Both reviewers: a rethrown
  auth/network error spent the engine's 3 retries and ended as a terminal
  `failed` ledger row no re-drive revisits (and, with `attachmentId` out of
  the hash, no thread refresh re-emits it either). Now
  `WorkerSession.fetchBytes` throws `FetchDeferredError` both when the
  source is not registered yet AND when the source's own fetch throws;
  `workOne` records it as `deferred` without spending retries. Convert,
  vision, audio (and third-party workers) get it for free — the three
  per-worker catch blocks are gone. `null` stays the terminal "no bytes".
  Cost: an account needing re-auth has its deferred docs retried each
  re-drive (convert 5 m, ungated; vision/audio on their gated cadence).
- **`PENDING_VISUAL_WHERE` now mirrors the PDF gate** (codex): PDFs count
  as pending OCR only with `conversion.status` text-poor/failed/too-large,
  so `unavailable` PDFs stop showing as pending forever. The partial index
  is rebuilt automatically on first open (SQL-text change).
- `HAS_TEXT_CHARS` (16) shared by the convert and vision classifiers.

**One-time transition to expect (fable):** legacy Gmail attachment docs
still carry `attachmentId`; the first refresh of their thread changes the
hash, and `upsertDocument` rewrites metadata + markdown wholesale — so each
such attachment is converted (and each image OCR'd) once more. Bounded,
one-time; afterwards thread refreshes no longer churn attachments.

## Part 2 — IMAP and ms365 mail attachments (2026-09-28)

Goal: both mail sources emit bytes-less `attachment` child documents with a
`fetchBytes`, exactly like Gmail, so the convert → OCR chain above covers
them with no per-source parsing.

### Core: children live and die with their parent (generic)

Today (a) `reconcile` archives every live doc of the account whose
`(externalId, type)` was not listed, and (b) `deletions` archive exactly the
named refs. Attachment children are listed by no mail source, so (a) would
archive every IMAP attachment on each reconcile pass, and (b) already
orphans Gmail attachments when their thread is deleted.

- **Reconcile:** a document with `parent_id` counts as listed when its
  parent row is listed. (Survey: of the sources that emit children —
  gmail, hubspot, slack, instagram, telegram, whatsapp, agent-sessions —
  none implements `reconcile`, so no current behaviour changes; the sources
  that reconcile — imap, ms365, onedrive, google-docs, notion, local-folder
  — only IMAP/ms365 will have children, via this change.)
- **Deletions:** `archiveByRef` also archives the target's live children in
  the same transaction (one level; attachments have none).
- Known limit: a child that disappears while its parent survives (one mail
  removed from a still-live thread) stays live. Rare; not addressed.

### IMAP (core)

`fetchMany` already downloads the full RFC822 source and mailparser already
parses attachments — they were discarded. Now `parseImapMessage` keeps
attachment METADATA only (index, filename, contentType, size), skipping
tiny inline images (Gmail's 8 KB rule). `toDocument` returns
`[message, ...attachments]`; child `externalId = <messageExternalId>#<index>`,
`parent = {message externalId, 'email.message'}`, metadata `{mime,
filename, sizeBytes, mailbox, uid, uidValidity, attachmentIndex}`.
`fetchBytes`: reconnect, check UIDVALIDITY, `fetchMany([uid])`, re-parse,
return `attachments[attachmentIndex].content` (null when the UID/validity/
index no longer matches → terminal `unavailable`). Descriptor documentTypes
gains `attachment`. No bytes are held in items (memory unchanged).

### ms365 (marketplace connector, `~/work/ms365-kia-connector`)

- Pull: for messages with `hasAttachments`, list
  `/me/messages/{id}/attachments?$select=id,name,contentType,size,isInline`
  (metadata only, no contentBytes), skip tiny inline images and non-file
  attachments (item/reference attachments have no bytes).
- `toDocument` → `[thread, ...attachments]`. Graph message ids are NOT
  immutable (they change on folder moves), so the child externalId is
  `<conversationId>/<internetMessageId>/<index>` (stable across moves);
  the CURRENT `messageId`/`attachmentId` live in metadata and refresh
  whenever the thread re-emits (a move changes the thread hash).
- `fetchBytes`: `GET /me/messages/{messageId}/attachments/{attachmentId}/$value`;
  404 → null (terminal `unavailable`; a later move re-emits fresh ids and
  the upsert resets the outcome).
- Size: skip fetch over the connector's existing binary cap.
- Released as ms365 connector 2.2.0 against the current SDK (contract
  unchanged for sources).

### Part 2 — Revision 1 (after fable + codex astra design review)

- **Backfill (codex, blocking):** IMAP mailbox cursor entries gain
  `attachments: 1`; an entry without it re-fetches the mailbox once from
  UID 0 (no reset, nothing archived; unchanged messages hash-skip).
  ms365: same shape — the v2 cursor gains `attachments: 1`; any cursor
  without it (v1 included) restarts enumeration once, which let the v1→v2
  migration be deleted. (Implemented this way instead of a v3 bump.)
- **ms365 identity (fable blocking + codex):** every Graph request sends
  `Prefer: IdType="ImmutableId"`. Child externalId =
  `<immutableMessageId>#<name>#<size>`; metadata holds only the immutable
  `messageId`, `filename`, `mime`, `sizeBytes` — no mutable attachment id —
  so a folder move never churns the child's hash. `fetchBytes` lists the
  message's attachments (`$select=id,name,size`), matches name+size, GETs
  `$value`; no match / 404 → null (terminal `unavailable`).
- **ms365 enumeration (codex, blocking):** `hasAttachments` is false for
  inline-only mail, so attachment metadata comes from
  `$expand=attachments($select=id,name,contentType,size,isInline)` on the
  existing conversation fetch — no per-message request, no flag.
  Only `#microsoft.graph.fileAttachment` entries; tiny inline images
  dropped (8 KB, as Gmail/IMAP).
- **ms365 binary transport (both, blocking):** `GraphClient.request` gains
  `responseType: 'bytes'` (keeps bearer, 401 → auth error, 429 retry).
  No connector size cap — the convert worker refuses oversize before
  fetching; vision has its own caps.
- **ms365 children carry the thread's `scopeRootId`** (folder-scoped
  account).
- **Reconcile race (codex):** archiving a parent — via deletions,
  reconcile, or folder-scope refs — archives its live children in the same
  transaction regardless of their seq. The listing rule keys on the parent
  being in `reconcile_listing` (fable), shared by the archive and the diff
  count.
- **IMAP:** `fetchBytes` runs `simpleParser` on a one-message cache
  (last raw source by account/mailbox/uidValidity/uid), so an N-attachment
  mail is downloaded once, not N times.
- **Known limit, stated plainly:** a message deleted from a still-live
  thread leaves its attachments indexed (routine for ms365/Gmail
  conversations). Deferred.

### Part 2 — Revision 2 (after fable + codex astra implementation review)

- **Reconcile race, other direction (codex, blocking):** a parent refreshed
  mid-pass is protected by the snapshot, but its unchanged children were
  still eligible. The shared diff/archive predicate now keeps a child while
  its parent is live and either listed or newer than the snapshot.
- **Oversized files never fetched by vision (codex, blocking):** vision's
  classifier skips by DECLARED size over its caps (50 MB PDF / 20 MB image)
  before any fetch — fetching first would, for an extension transport that
  refuses such bodies, throw → defer → re-drive forever.
- **No fetch while an account needs re-auth (fable):** the engine's
  `fetchBytes` defers without calling the source, so a stale IMAP password
  is not one LOGIN per doc per re-drive.
- ms365: exact name+size match only (a same-named replacement never fills
  the old identity); attachment listing `$top=999`; version 2.2.0.
- **Not done — pre-existing Gmail orphans (fable):** the live corpus has
  none (checked 2026-09-28), so no one-way schema migration was added.
- **Live smoke owed:** ms365 `$expand=attachments(...)` + `$filter` +
  `Prefer: IdType="ImmutableId"` are only exercised against a mocked Graph.
