# Garbled or missing PDF text layers: OCR the pages that need it

Status: r1 (draft) · 2026-10-02

## Problem

Some PDFs have a text layer that is **garbage**: fonts with no or broken
ToUnicode maps, Identity-H CID fonts, or "scanned + bad OCR" exports. In a
client's legal data room (e.g. *Rechtsbeilage 0119*) Kia stores the
unreadable characters as the document text, so search can never find it.

`core/engine/convert.ts` accepts any pdf-parse output with ≥ 16 non-space
characters (`HAS_TEXT_CHARS`) as real text. Such a document never reaches
OCR. Nothing in the chain judges text *quality*.

A related case has the same cause: **mixed PDFs**. An exhibit bundle can
have 10 text pages and 90 scanned pages. The text pages clear the 16-char
bar, so the 90 scanned pages are never OCR'd. Quality is judged per
document, but the defect is per page.

## Goals

- A PDF whose text layer is garbled on some pages, or empty on some pages,
  gets **those pages** OCR'd. Good text-layer pages keep their text.
- The existing corpus is re-assessed once, with no user action.
- No regression where OCR cannot run (no OCR provider, processing window
  closed): a document keeps whatever good text it has meanwhile.

## Non-goals

- Fixing text by font remapping or re-decoding. OCR is the fix.
- Garble detection for non-PDF formats. docx and xlsx carry real Unicode.
- Language identification. The heuristic is script-aware, not
  language-aware.

## Design

### 1. A per-page text assessment (pure function)

New module `src/main/core/engine/text-quality.ts`:

```ts
type PageQuality = 'good' | 'empty' | 'garbled';
assessPage(text: string): PageQuality
```

Over the page's non-whitespace characters (`n`):

- `empty` when `n < 16`.
- `garbled` when `n ≥ 16` and **any** of the following holds:
  - (a) **bad-char ratio > 5%.** Bad chars are U+FFFD, the Private Use Area
    (U+E000–U+F8FF), C0/C1 controls other than tab/newline, and literal
    `(cid:NN)` runs.
  - (b) **letter ratio < 40%.** That is `\p{L}` / n. Real prose and even
    tables of numbers with labels sit well above this; glyph-ID garbage is
    mostly punctuation and symbols.
  - (c) **Too few plausible Latin words.** This applies only when ≥ 20
    Latin-script tokens of ≥ 3 letters exist: fewer than 50% of them
    contain a vowel (`aeiouy` plus accented/umlaut forms, any case).
    Shifted-glyph garbage like `Wkh vhfrqg` or `Í¶ÈÆ¸` fails this; German,
    English, French and Italian prose pass easily.
  - Non-Latin scripts (Cyrillic, CJK, …) are judged by (a) and (b) only.
- `good` otherwise.

The thresholds are constants, tuned on the fixture set (Testing). The
function is exported for unit tests and reused by §4.

### 2. pdf-parse per page

`parse()` for PDFs uses pdf-parse's `pagerender` hook to collect an array of
page texts instead of one joined string. It then decides:

| Pages | Result |
|---|---|
| all `good` | markdown = joined text (today's behaviour) |
| all `empty` | `null` → `text-poor` (today's behaviour) |
| some `garbled` or `empty`, some `good` | markdown = the **good** pages' text only, outcome `needs-ocr` with the bad page numbers |
| none `good` | `null` → `text-poor`, outcome `garbled` if any page was garbled |

**Exception:** documents of ≤ 2 pages where only the last page is empty are
treated as all-good. A cover letter plus a blank page is normal and not
worth an OCR pass.

`parse()`'s return type widens to carry this:

```ts
{ markdown: string | null; ocrPages?: number[] }
```

All existing callers read `.markdown`.

### 3. Who writes the outcome

Today only the convert worker writes `metadata.conversion`. This spec
relaxes that: **whichever stage ran the parser writes the outcome.**

- The commit path (`EngineDeps.convert`) sets
  `metadata.conversion = { status: 'needs-ocr', pages }` alongside the
  good-page markdown when `parse()` reports `ocrPages`.
- The convert worker does the same for bytes-less docs it parses.

One rule, no second pass to translate a hint into a marker, and no
re-fetch.

- New `ConversionStatus` values:
  - `needs-ocr`: has good text; listed pages need OCR.
  - `garbled`: no usable text; OCR all pages.
- `PDF_OCR_AFTER_STATUSES` adds both.

### 4. The vision worker merges per page

`classifyDocument` treats `conversion.status === 'needs-ocr'` as a
candidate **even though markdown ≥ 16 chars** (today's "has real text"
skip is bypassed for this status only).

For such a doc the vision worker:

1. Fetches the bytes.
2. Re-runs pdf-parse per page to recover the text-layer pages. This is
   cheap next to OCR.
3. Rasterizes and OCRs **only** `pages`, up to the vision page cap; with
   the large-file spec, windowed up to 200 pages.
4. Writes markdown in page order: text layer for good pages, OCR text for
   OCR'd pages.

The `extraction` marker is set as today.

`garbled` docs flow exactly like `text-poor` (OCR all pages; VLM pass 2 if
OCR < 200 chars).

**If OCR never runs**, a `needs-ocr` doc keeps its good-page text, which is
better than today. A `garbled` doc keeps none, where today it keeps
garbage. That is acceptable, because garbage text matches nothing anyway.
Windows OCR availability is its own spec.

### 5. Re-assessing the existing corpus

Existing PDFs were committed by the old parser: markdown present, no
marker, page boundaries lost. A one-time pass:

- Bump the convert worker's `version`. Its consumer key is
  `worker:convert:v<version>`, so it starts a fresh pass over the feed.
  Confirm a new consumer starts from the beginning, not the head.
- `matches()` additionally admits a PDF with no `conversion` marker and
  markdown ≥ 16 chars when `assessPage(markdown)` on the **whole stored
  text** is `garbled`. Whole-text assessment is coarse, but enough to catch
  documents that are mostly garbage.
- For those, the worker re-fetches and re-parses per page, then records
  `needs-ocr` or `garbled` as in §3.
- Mixed scanned + text PDFs already in the corpus are **not** detected by
  this pass, because their stored text looks clean. They are picked up only
  when re-committed (content change).

  A full re-fetch of every existing PDF to find them is not worth it.
  - **Decision:** accept that.
  - **Alternative for reviewers:** detect them via
    `pageCount × 400 chars > markdown length`. This needs pdf-parse's
    `numpages` stored at commit, which old rows lack.

## Testing

- **`text-quality` unit tests** on strings:
  - German, English, French legal prose → `good`.
  - Tables of numbers with labels → `good`.
  - Russian prose → `good`.
  - Caesar-shifted text, PUA-heavy text, `(cid:12)(cid:45)…` runs and
    U+FFFD runs → `garbled`.
  - `"  \n 1 "` → `empty`.
- **PDF fixtures** (committed, small):
  - a clean 3-page PDF;
  - a PDF made with a Type3/no-ToUnicode font (generated with a script,
    e.g. via `pdf-lib` with a subset font and the ToUnicode stripped);
  - a 4-page mixed PDF, pages 2–3 image-only.

  `parse()` returns the expected `ocrPages`.
- **Vision worker:** a `needs-ocr` mixed fixture comes out with text-layer
  pages 1 and 4 plus fake-OCR pages 2–3 in order.
- **Backfill:** a pre-existing row with garbled markdown and no marker is
  admitted after the version bump. A clean row is not.
- **Live:** a real broken-font legal PDF becomes searchable by a phrase
  from its body after the processing window runs (macOS). Ask the client
  for Rechtsbeilage 0119 if shareable; otherwise use any known-bad-ToUnicode
  sample.
