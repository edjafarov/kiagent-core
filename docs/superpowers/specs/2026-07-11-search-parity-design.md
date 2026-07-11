# Search parity: snowball stemming + trigram fuzzy fallback

**Date:** 2026-07-11
**Status:** approved
**Closes:** LEFTOVERS.md deferred item 5 (search parity)

## Goal

Restore the two legacy search behaviors the greenfield rebuild dropped, on top
of the existing FTS5 pipeline:

1. **Stemming** — inflected forms match ("Rechnungen" finds "Rechnung",
   "running" finds "run"), using snowball stemmers selected by each document's
   stored `languages` (ISO-639-3, detected at ingest by `core/language.ts`).
2. **Fuzzy fallback** — near-miss queries still find documents via a trigram
   index, fused into the ranking with Reciprocal Rank Fusion (RRF, k=60 — the
   legacy constant). Trigram matching is *substring* recall (FTS5 matches a
   query token as a contiguous substring): word-parts and compound words
   ("Rechnung" finds "Jahresrechnung", "rechnun" finds "Rechnung") — the same
   semantics legacy had, not edit-distance typo correction.

Both live inside `store.read.search`, so every consumer — the Search screen
(`search:query` IPC), the MCP `search` tool, and extension-host
`query.search` — inherits them from one implementation.

### Legacy reference

alpha-cent (`src/main/search/` + `mcp/tools/search.ts`, preserved in
`.claude/worktrees/ms-connect-verify`): `documents_fts` stored a *stemmed*
view (snowball russian/english picked by a Cyrillic-ratio heuristic),
`documents_tri` held raw text under the trigram tokenizer, and the MCP tool
RRF-merged both result lists. Snippets were built in JS near a matched term.

This design keeps the greenfield improvements the legacy shape would lose:
raw text stays indexed (exact matches, phrases, and `snippet()` keep
working), and the boolean query language keeps its semantics.

## Decisions (agreed with Eldar, 2026-07-11)

- Store-level: stemming + fuzzy apply to **all** search consumers.
- Stemming languages: **every** language `snowball-stemmers` ships, mapped
  from the stored franc codes (not a curated subset, not the legacy
  heuristic).
- Fuzzy pass runs **only when the exact pass comes up short** (fewer hits
  than `limit`, first page only) — not on every query like legacy.
- Index shape: stem **columns inside `documents_fts`**, not a separate
  stemmed table; `documents_tri` is a new second virtual table.

## Schema (migration v3)

`src/main/core/store/schema.ts`:

- `MIGRATIONS` becomes `Array<string | ((db: BetterSqlite3.Database) => void)>`.
  String entries run through `db.exec` as today; function entries are called
  with the open connection. Each still runs inside one transaction with the
  same version bookkeeping. (The v3 backfill must stem text in JS, which SQL
  strings cannot express.)
- **v3 (function):**
  1. `DROP TABLE documents_fts` and recreate:

     ```sql
     CREATE VIRTUAL TABLE documents_fts USING fts5(
       doc_id UNINDEXED,
       title,
       markdown,
       title_stem,
       markdown_stem,
       tokenize = 'unicode61 remove_diacritics 2'
     );
     ```

  2. Create the trigram table:

     ```sql
     CREATE VIRTUAL TABLE documents_tri USING fts5(
       doc_id UNINDEXED,
       body,
       tokenize = 'trigram remove_diacritics 1'
     );
     ```

     (`remove_diacritics` on the trigram tokenizer needs SQLite ≥ 3.45; the
     bundled build is 3.53.2 — verified. `body` = raw `title + '\n' +
     markdown`.)

  3. Repopulate both tables from `documents`, computing
     `title_stem`/`markdown_stem` per row via the stemming module using the
     row's stored `languages`. Rowids stay pinned to the document's rowid
     (schema-v2 invariant, unchanged).

Raw columns keep their positions (`title`=1, `markdown`=2), so
`snippet(documents_fts, 2, …)` is untouched; the two stem columns append
after.

## Stemming module

New `src/main/core/stemming.ts` (sibling of `language.ts`):

- `SNOWBALL_BY_ISO6393`: map from franc's ISO-639-3 codes to the 23
  algorithms `snowball-stemmers@0.6.0` ships (`eng→english`, `deu→german`,
  `rus→russian`, `fra→french`, `spa→spanish`, `nld→dutch`, `ita→italian`,
  `por→portuguese`, `swe→swedish`, `dan→danish`, `fin→finnish`,
  `nob/nno→norwegian`, `tur→turkish`, `ron→romanian`, `hun→hungarian`,
  `ces→czech`, `cat→catalan`, `eus→basque`, `gle→irish`, `slv→slovene`,
  `tam→tamil`, `ara→arabic`, `hye→armenian`). Stemmers are created lazily and
  cached per algorithm.
- `normalizeForStem(text)`: NFKC, `Ё/ё → Е/е`, lowercase — the exact legacy
  normalization, applied identically at index and query time.
- `buildStemView(text, languages)`: normalize, tokenize on `[\p{L}\p{N}]+`,
  stem each token with the stemmer of the **first** mapped language in
  `languages`; join with spaces. No mapped language (or empty `languages`) ⇒
  return `''` — an empty stem column, never fake English stems on
  unsupported-language text. Raw columns still match such documents.
- `stemVariants(term, languages)`: query-side helper — normalized term
  stemmed with **each** mapped language in the given set, deduplicated,
  excluding the raw term itself.

## Write path

`src/main/core/store/write-tx.ts`:

- `write-tx.ts` imports `buildStemView` directly from `core/stemming` — it is
  pure, deterministic JS (no Electron, no async), so unlike `detectLanguages`
  there is nothing to inject: injection would only ripple a new required dep
  through every `openStore` call site (10 files) for no testability gain. The
  DB worker gets it transitively through the same import.
- `ftsInsert`/`ftsUpsert` take the document's `languages` and write all five
  columns, plus the `documents_tri` row (`body` = raw title + `'\n'` +
  markdown) with the same pinned rowid. The enrich path recomputes stems
  from its freshly re-detected `languages`.
- Every existing `documents_fts` delete gets a `documents_tri` twin:
  per-document delete (rowid-pinned), `removeAccount`'s set-based delete,
  and `purgeArchived`'s set-based delete. Archiving continues to leave both
  FTS tables intact (current behavior).

`src/main/core/store/store.ts` maintenance:

- `compact()` (VACUUM repopulate) rebuilds **both** tables, stemming during
  the repopulate (it needs `buildStemView` from `StoreDeps`).
- `resetAll()` clears `documents_tri` alongside `documents_fts`.

## Query path

All inside `store.read.search` (`store.ts`); the MCP tool, IPC handler, and
host surface change not at all.

### Term expansion (stemming)

- The boolean compiler (`ftsQuery`) expands each **positive plain term** to
  an OR-group of the raw term plus its stem variants:
  `running` → `("running" OR "run")`. Phrases, `prefix*` terms, and negated
  terms stay raw — exact semantics preserved.
- Variant languages = distinct languages present in the corpus ∪ `eng`.
  The distinct set comes from `SELECT DISTINCT languages FROM documents`,
  parsed and unioned, cached in the store closure and invalidated on every
  `commit` (recomputed lazily on the next search). Bounded by the 23
  supported algorithms — no cap needed.
- Ranking: `bm25(documents_fts, 0, 4.0, 1.0, 2.0, 0.5)` — raw title >
  stem title > raw markdown > stem markdown. (A stem variant can also match
  a raw column token; that broadened recall is intended.)

### Fuzzy fallback (trigram + RRF)

Runs only when **all** hold: `q.text` non-empty, `offset === 0`, the primary
pass returned fewer than `limit` rows, and **every** positive term (plain
terms and phrases, lowercase) is ≥ 3 chars — the trigram tokenizer cannot
verify shorter terms, and silently dropping one from the AND group would
smuggle partial matches past the implicit-AND grammar (same principle as the
AND-join decision; a query with any sub-3-char positive term simply gets no
fuzzy pass).

- Trigram query: tokens AND-joined as quoted FTS5 strings against
  `documents_tri MATCH ?`, with the same SQL filters (archived/type/account/
  date), ordered by `bm25(documents_tri)`, limited to `limit`.
  (Decision 2026-07-11, deviating from legacy's OR-join: implementation
  showed OR-joining lets partial single-word matches into implicit-AND
  queries whenever the first page is thin, breaking the boolean grammar
  this design promises to preserve. AND requires every ≥3-char positive
  term as a substring — single-term queries, the main fuzzy case, are
  unaffected.)
- **Negation safety:** trigram hits whose raw `title + markdown` contains any
  negated term or phrase (JS `toLowerCase().includes(…)` — Unicode-correct,
  deliberately more aggressive than FTS token semantics) are dropped, so a
  `NOT`-excluded document can never resurface via fuzzy. Grouped negation
  (`NOT (a b)`) cannot be represented by the fuzzy pass's flat term
  extraction, so a query containing `NOT (` skips the fuzzy pass entirely —
  the same cannot-represent-it-⇒-don't-fuzz principle as the sub-trigram
  veto.
- **Fusion:** RRF with k=60 over the two ranked lists
  (`score = Σ 1/(60 + rank + 1)`; docs in both lists sum), sorted descending,
  capped at `limit`.
- **Snippets:** primary-pass rows keep their FTS `snippet()`. Trigram-only
  rows get a JS-built snippet (port of legacy `buildSnippet`): ~240 chars of
  raw markdown anchored at the first case-insensitive occurrence of any
  positive term, falling back to the document head; matched terms wrapped in
  `<b>…</b>` to match the FTS snippet convention.

### Unchanged

- No-text searches (filter-only listing), `count`, pagination beyond page
  one, the query-language grammar and its error messages, and the shape of
  returned rows (`Document & { snippet? }`).

## Error handling

- Migration v3 failure rolls back with the transaction; the version stays at
  2 and boot fails loudly (existing behavior for failed migrations).
- An unknown/absent language at write time degrades to empty stem columns —
  never a thrown error in the commit path.
- The fuzzy pass is not defensively wrapped: its MATCH expression is built
  from quoted string literals only, so it is deterministic SQL — a throw
  there is a real bug and propagates like any other search error.

## Testing (TDD, red first)

Unit — `stemming.test.ts`:
- German, Russian, English stems; ё-folding; NFKC width folding.
- Unmapped language ⇒ `buildStemView` returns `''`; `stemVariants` returns `[]`
  for a term that stems to itself.

Store — extend `fts.test.ts` / `store.test.ts`:
- Inflection: doc "Die Rechnung ist bezahlt" (deu) found by query
  `Rechnungen`; "running daily" found by `runs`.
- Substring rescue: `Rechnung` finds a doc containing only `Jahresrechnung`
  (and a truncated `rechnun` finds `Rechnung`) via trigram fusion; ranking
  places an exact match above a fuzzy-only match.
- Thin-results gate: a query already returning `limit` exact hits performs no
  trigram work (observable via a query counter on the AppDb test double, or
  by result identity).
- Negation: `-bezahlt` never resurfaces an excluded doc through fuzzy.
- Operators intact: phrases, prefix, AND/OR/NOT behave exactly as the
  existing tests assert (all existing tests stay green, weights aside).
- Snippet: fuzzy-only hits carry a non-empty snippet from raw markdown.
- Migration: a v2 corpus (built via the v1+v2 migrations with rows present)
  migrates to v3 with both tables populated and stems queryable.
- Maintenance: `compact()` after writes leaves both tables consistent
  (search still finds stemmed + fuzzy matches); `resetAll()` empties both.
- Worker parity: the commit path through the DB worker
  (`db/__tests__` pattern) produces identical FTS rows to in-process.

## Costs (accepted)

- Trigram index ≈ 2–3× the raw text size (legacy accepted the same).
- Commit does roughly 2× FTS write work (5 columns + tri row).
- One-time migration pass stems the whole corpus (fast: snowball is
  ~10⁶ tokens/s; bounded by corpus size).

## Out of scope

- Legacy's per-paragraph weighted language scores (`DetectedLanguage[]`) —
  greenfield keeps its single-code `detectLanguages`.
- UI changes (the Search screen just gets better results).
- MCP `search` tool signature/behavior changes beyond inherited ranking.
- Trigram `detail=` shrinking, snowball for CJK (unsupported upstream),
  re-ranking beyond RRF.
