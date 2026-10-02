# Garbled or missing PDF text layers: OCR the pages that need it

Status: r2 (fable + codex-astra round 1 folded in) · 2026-10-02
Depends on: large-file spec §4 (page-list rasterizer, one-window-per-run
OCR). This spec lands after it.

## Problem

Some PDFs have a text layer that is **garbage**: fonts with no or broken
ToUnicode maps, or "scanned + bad OCR" exports. In a client's legal data
room (e.g. *Rechtsbeilage 0119*) Kia stores the unreadable characters as
the document text, so search can never find it.

`core/engine/convert.ts` accepts any pdf-parse output with ≥ 16 non-space
characters (`HAS_TEXT_CHARS`) as real text. Nothing judges text *quality*.

The same cause hides **mixed PDFs**: an exhibit bundle with 10 text pages
and 90 scanned pages clears the 16-char bar, so the 90 scans are never
OCR'd. Quality is judged per document, but the defect is per page.

## Goals

- Pages that are garbled, or that are image-only, get OCR'd. Good
  text-layer pages keep their text.
- The existing corpus is re-assessed once, with no user action.
- **No text loss when OCR can't run.** A false positive must never cost
  the default user searchable text they have today.

## Non-goals

- Re-decoding fonts. OCR is the fix.
- Garble detection outside PDFs.
- Language identification.

## Design

### 1. Per-page assessment (pure function)

New module `src/main/core/engine/text-quality.ts`:

```ts
type PageQuality = 'good' | 'blank' | 'image-only' | 'garbled';
assessPage(text: string, hasImages: boolean): PageQuality
```

Here `n` = the page's non-whitespace characters.

- If `n < 16`, the page is `image-only` when `hasImages` is true, and
  `blank` otherwise. A blank page is treated like a good page: there is
  nothing to OCR. This covers duplex backs and separator sheets.
- If `n ≥ 16`, the page is `garbled` only on **positive corruption
  evidence**. Low letter density alone never qualifies, because numeric
  statements and schedules must stay `good`. Either signal suffices:
  - **(a) Bad characters exceed 5% of `n`.** Bad characters are:
    - U+FFFD;
    - the Private Use Area;
    - C0/C1 controls other than tab and newline;
    - Latin-1 symbol characters U+00A1–U+00BF (e.g. `¶ ¸ ¤`), which only
      occur this densely in mis-mapped glyphs.
  - **(b) Latin text with no words in it.** The page has ≥ 60 Latin letters
    and **zero** hits from a small function-word list (de/en/fr/it/es, about
    15 words each: `der die und the and of le la et il di de per…`), **and**
    fewer than 50% of its ≥ 3-letter Latin tokens contain a vowel.
    Shifted-glyph garbage fails this; real prose of any of those languages,
    even a terse one, hits a function word.
- Otherwise the page is `good`.
- Non-Latin scripts are judged by (a) only.

Thresholds are constants, tuned on the fixtures.

### 2. Per-page parse

For PDFs, `parse()` uses pdf-parse's `pagerender` hook. `pageData` is a
pdf.js `PDFPageProxy`, which gives each page's text and whether its
`getOperatorList()` contains an image paint op (`paintImageXObject`,
`paintInlineImageXObject`, `paintJpegXObject`). It returns a structured
result:

```ts
interface PdfParseResult {
  markdown: string | null;      // good pages' text, in page order
  ocrPages: number[];           // 1-based, garbled + image-only pages
}
```

`parse()` for other formats keeps returning `string | null`. Callers
dispatch on kind.

| Pages | Outcome |
|---|---|
| all `good`/`blank` | markdown = text; status `ok` (today's behaviour) |
| some bad, some good | markdown = good pages; status `needs-ocr`, `pages: ocrPages` |
| no good pages | markdown `null`; status `text-poor` with `reason: 'garbled'` when any page was garbled (diagnostics only, same flow as today) |

### 3. Whoever parses writes the marker, deterministically

The commit path (`EngineDeps.convert`) and the convert worker both write
`metadata.conversion` with what they parsed:
`{ status: 'needs-ocr', pages, quality: 1 }`.

**Neither carries a timestamp.** `write-tx.ts` hashes the converted
metadata into `contentHash`. A timestamped marker would rehash every rescan
of an unchanged file, rewrite the row, wipe `extraction` and re-OCR
forever. This is why the old "only the worker writes `conversion`" rule
(convert-worker design R1) can be relaxed safely. The worker's other
outcomes keep their `at` (they are not on the commit path).

`quality: 1` is the assessment version. It marks the doc as assessed by
this algorithm, so the backfill (§5) never re-admits it.

### 4. The vision worker OCRs only the listed pages

- `classifyDocument` treats `conversion.status === 'needs-ocr'` as a
  candidate even though it has markdown. That is the only bypass of the
  has-text skip.
- `PENDING_VISUAL_WHERE` (`schema.ts`) gets the same
  `OR json_extract(metadata,'$.conversion.status') = 'needs-ocr'` clause.
  This keeps the classifier/SQL mirror rule from the convert-worker design
  R2. The partial index is recreated in an append-only migration.
- Per run, the worker:
  1. Fetches the bytes.
  2. Re-parses per page to recover the good pages' text.
  3. Rasterizes **only the next window of `pages`**, using the large-file
     spec's page-list rasterizer (`pdfToPngs(bytes, { pages })`), and OCRs
     it.
  4. Writes markdown merged in page order (text layer for good pages, OCR
     for done pages, nothing yet for pending ones), plus the large-file
     spec's `ocrProgress` sibling key.
  5. Uses the same single-entry bytes cache, so the next window does not
     re-download.
- One window per run, as in the large-file spec, so each window is
  committed durably.
- `MAX_OCR_PAGES` caps the **number of OCR'd pages**, not page numbers.
- **No VLM pass for `needs-ocr` docs.** They already have real text.
  Whatever OCR returns, including nothing for a page, completes that
  window.
- `NoProviderError('read')` still defers, so the doc gets OCR when a
  provider appears (Windows spec).
- A `needs-ocr` doc that never gets OCR keeps its good-page text. No
  regression.

### 5. Re-assessing the existing corpus

Old PDFs carry markdown and either no marker or `ok` (attachments go
through the worker), never `quality`.

- Bump the convert worker's `version`. `consumerCursor` returns 0 for an
  unknown consumer, so it replays the feed. `activeConsumers()` keeps the
  retired `v1` row out of pending counts.
- `matches()` additionally admits a PDF with markdown ≥ 16 chars, status
  absent or `ok`, no `quality`, whose **whole stored text** assesses
  `garbled` under §1 (a)/(b).
- For those, the worker re-fetches and runs §2's per-page parse. It then
  writes:
  - the outcome with `quality: 1` (`ok`, `needs-ocr` or `text-poor`);
  - and, for `text-poor`, an **explicit `markdown: ''`**, so the garbage is
    gone and vision's has-text skip doesn't block OCR.
- A doc re-parsed as clean records `ok` with `quality: 1` and is never
  re-admitted.
- Mixed scanned + text PDFs already in the corpus look clean as whole text,
  so they are only caught on re-commit. Accepted: re-fetching every PDF to
  find them is not worth it.

## Testing

- **`text-quality` unit tests:**
  - Prose in de/en/fr/it/ru → `good`.
  - A numeric bank statement or invoice page (dates, amounts, few words) →
    `good`.
  - Caesar-shifted text, PUA-heavy text, Latin-1-symbol-heavy text
    (`Í¶ÈÆ¸…`) and U+FFFD runs → `garbled`.
  - Empty with images → `image-only`; empty without → `blank`.
- **PDF fixtures** (small, committed):
  - a clean 3-page PDF with a blank last page → `ok`;
  - a no-ToUnicode-font PDF (generated by a script) → `text-poor`/garbled;
  - a 4-page mixed PDF with pages 2–3 image-only → `needs-ocr [2,3]`;
  - a text cover plus a scanned exhibit (2 pages) → `needs-ocr [2]`.
- **Hash stability:** rescan of an unchanged `needs-ocr` file → same
  `contentHash`, and `extraction` is preserved.
- **Vision:** the mixed fixture merges text pages 1 and 4 with fake-OCR
  pages 2–3 in order, with no VLM call.
- **Backfill:**
  - An old `ok` row with garbled markdown is admitted, then becomes
    `text-poor` + `markdown ''`.
  - A clean old row is not admitted.
  - A row with `quality: 1` is never re-admitted.
- **Live:** a real broken-font PDF becomes searchable by a body phrase
  after the processing window runs (macOS).
