# Search Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore legacy search behaviors on the greenfield store — snowball stemming (per-document language) and a trigram substring-recall fallback fused with RRF — entirely inside `store.read.search`.

**Architecture:** Two stem columns are appended to the existing `documents_fts` FTS5 table and a new `documents_tri` trigram FTS5 table is added (both rowid-pinned to `documents.rowid`, the schema-v2 invariant). The commit transaction writes all of them; the query side expands positive plain terms with stem variants and, when the first page comes up short, runs a trigram pass and merges by Reciprocal Rank Fusion. Spec: `docs/superpowers/specs/2026-07-11-search-parity-design.md`.

**Tech Stack:** TypeScript, better-sqlite3 (bundled SQLite 3.53.2), FTS5 (`unicode61`, `trigram`), `snowball-stemmers@0.6.0` (already in dependencies), Jest.

## Global Constraints

- TDD: every step of production code is preceded by a failing test you watched fail.
- `snowball-stemmers` has NO bundled types — the ambient declaration in Task 1 is required before anything imports it.
- Trigram tokenizer option `remove_diacritics 1` requires SQLite ≥ 3.45 (bundled: 3.53.2 — verified working).
- Trigram matching is **substring** recall (a query token must appear as a contiguous substring of the document) — never write tests expecting transposition-typo tolerance.
- RRF constant k=60. bm25 weights `(0, 4.0, 1.0, 2.0, 0.5)` = (doc_id, title, markdown, title_stem, markdown_stem).
- FTS rows (both tables) always sit at their document's rowid — every write/rebuild preserves this.
- Run tests with `npx jest <path>` from the repo root. Full suite must be green before each commit.
- Conventional commit messages (`feat(store): …`, `test(store): …`).
- No new dependencies.

## File Structure

- `src/types/snowball-stemmers.d.ts` — new: ambient types for the untyped package.
- `src/main/core/stemming.ts` — new: ISO-639-3→snowball map, `normalizeForStem`, `buildStemView` (index side), `stemVariants` (query side).
- `src/main/core/__tests__/stemming.test.ts` — new.
- `src/main/core/store/schema.ts` — modify: function-migration support, v3 migration, exported `repopulateSearchIndex`.
- `src/main/core/store/write-tx.ts` — modify: stem columns + trigram twin on every FTS write/delete.
- `src/main/core/store/fuzzy.ts` — new: pure helpers (`extractTerms`, `toTrigramMatch`, `rrfMerge`, `buildSnippet`).
- `src/main/core/store/__tests__/fuzzy.test.ts` — new.
- `src/main/core/store/store.ts` — modify: query-side stem expansion, corpus-language cache, fuzzy fallback, maintenance.
- `src/main/core/store/__tests__/search-parity.test.ts` — new: end-to-end store search behavior.
- `src/main/core/store/__tests__/fts.test.ts` — modify: pinning assertions extended to `documents_tri`, migration tests.
- `src/main/db/worker-entry.ts` — modify: register `rebuildSearchIndex` proc.
- `docs/rebuild/LEFTOVERS.md` — modify: close item 5.

---

### Task 1: Stemming module

**Files:**
- Create: `src/types/snowball-stemmers.d.ts`
- Create: `src/main/core/stemming.ts`
- Test: `src/main/core/__tests__/stemming.test.ts`

**Interfaces:**
- Consumes: `snowball-stemmers` (`newStemmer(algo).stem(word)`).
- Produces: `normalizeForStem(text: string): string`, `buildStemView(text: string, languages: string[]): string`, `stemVariants(term: string, languages: string[]): string[]` — Tasks 2, 3, 5 import these from `@main/core/stemming` (or relative `../stemming` / `../../stemming`).

- [ ] **Step 1: Write the ambient type declaration** (not TDD-able; required for the test file to compile)

`src/types/snowball-stemmers.d.ts`:

```ts
declare module 'snowball-stemmers' {
  export interface Stemmer {
    stem(word: string): string;
  }
  export function newStemmer(language: string): Stemmer;
  export function algorithms(): string[];
}
```

- [ ] **Step 2: Write the failing test**

`src/main/core/__tests__/stemming.test.ts`:

```ts
import { buildStemView, normalizeForStem, stemVariants } from '../stemming';

describe('normalizeForStem', () => {
  it('applies NFKC, ё-folding and lowercasing', () => {
    expect(normalizeForStem('Ёлка')).toBe('елка');
    expect(normalizeForStem('ＲＵＮ')).toBe('run'); // fullwidth → ASCII via NFKC
  });
});

describe('buildStemView', () => {
  it('stems German text with the document language', () => {
    const tokens = buildStemView('Die Rechnungen sind bezahlt', ['deu']).split(' ');
    expect(tokens).toContain('rechnung');
    expect(tokens).not.toContain('rechnungen');
  });

  it('stems English and Russian', () => {
    expect(buildStemView('running daily', ['eng']).split(' ')).toContain('run');
    expect(buildStemView('Бегущий по лесу', ['rus']).split(' ')).toContain('бегущ');
  });

  it('uses the first MAPPED language', () => {
    // 'und' and 'jpn' have no snowball algorithm — 'deu' is the first mapped.
    const tokens = buildStemView('Rechnungen', ['und', 'jpn', 'deu']).split(' ');
    expect(tokens).toContain('rechnung');
  });

  it('returns empty for unmapped languages, empty language list, empty text', () => {
    expect(buildStemView('こんにちは世界', ['jpn'])).toBe('');
    expect(buildStemView('hello world', [])).toBe('');
    expect(buildStemView('', ['eng'])).toBe('');
  });
});

describe('stemVariants', () => {
  it('produces stems that differ from the raw term, per corpus language', () => {
    expect(stemVariants('Rechnungen', ['deu', 'eng'])).toContain('rechnung');
    expect(stemVariants('running', ['eng'])).toEqual(['run']);
  });

  it('excludes identity stems and dedupes across languages', () => {
    expect(stemVariants('run', ['eng'])).toEqual([]); // stem === term
    expect(stemVariants('running', ['eng', 'eng'])).toEqual(['run']);
  });

  it('returns nothing when no language maps to a stemmer', () => {
    expect(stemVariants('running', ['jpn', 'und'])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest src/main/core/__tests__/stemming.test.ts`
Expected: FAIL — `Cannot find module '../stemming'`.

- [ ] **Step 4: Write the implementation**

`src/main/core/stemming.ts`:

```ts
import { newStemmer } from 'snowball-stemmers';
import type { Stemmer } from 'snowball-stemmers';

/**
 * Snowball stemming for search (spec:
 * docs/superpowers/specs/2026-07-11-search-parity-design.md). The SAME
 * normalization + stemmer choice runs at index time (buildStemView, fed by
 * the document's detected languages) and at query time (stemVariants, fed by
 * the languages present in the corpus), so query stems match stored stems.
 */

/** franc's ISO-639-3 codes → the 23 algorithms snowball-stemmers ships.
 *  Codes outside this map simply don't stem — raw-text search still works. */
const SNOWBALL_BY_ISO6393: Record<string, string> = {
  ara: 'arabic',
  hye: 'armenian',
  eus: 'basque',
  cat: 'catalan',
  ces: 'czech',
  dan: 'danish',
  nld: 'dutch',
  eng: 'english',
  fin: 'finnish',
  fra: 'french',
  deu: 'german',
  hun: 'hungarian',
  gle: 'irish',
  ita: 'italian',
  nno: 'norwegian',
  nob: 'norwegian',
  por: 'portuguese',
  ron: 'romanian',
  rus: 'russian',
  slv: 'slovene',
  spa: 'spanish',
  swe: 'swedish',
  tam: 'tamil',
  tur: 'turkish',
};

const stemmers = new Map<string, Stemmer>();

function stemmerFor(iso: string): Stemmer | null {
  const algo = SNOWBALL_BY_ISO6393[iso];
  if (!algo) return null;
  let s = stemmers.get(algo);
  if (!s) {
    s = newStemmer(algo);
    stemmers.set(algo, s);
  }
  return s;
}

const TOKEN = /[\p{L}\p{N}]+/gu;

/** NFKC + Ё→Е + lowercase — the legacy normalization, applied identically at
 *  index and query time so stems land in (and match) the same token space. */
export function normalizeForStem(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/Ё/g, 'Е')
    .replace(/ё/g, 'е')
    .toLowerCase();
}

/** The stemmed, space-joined view of a document field, stemmed with the
 *  FIRST of the document's languages that maps to a snowball algorithm.
 *  '' when nothing maps — never fake English stems on unsupported text. */
export function buildStemView(text: string, languages: string[]): string {
  if (!text) return '';
  let stemmer: Stemmer | null = null;
  for (const lang of languages) {
    stemmer = stemmerFor(lang);
    if (stemmer) break;
  }
  if (!stemmer) return '';
  const tokens = normalizeForStem(text).match(TOKEN) ?? [];
  return tokens.map((t) => stemmer!.stem(t)).join(' ');
}

/** Query-side expansion: the term stemmed with EACH given language, minus
 *  identity stems, deduplicated. */
export function stemVariants(term: string, languages: string[]): string[] {
  const norm = normalizeForStem(term);
  const out = new Set<string>();
  for (const lang of languages) {
    const s = stemmerFor(lang);
    if (!s) continue;
    const stem = s.stem(norm);
    if (stem && stem !== norm) out.add(stem);
  }
  return [...out];
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest src/main/core/__tests__/stemming.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add src/types/snowball-stemmers.d.ts src/main/core/stemming.ts src/main/core/__tests__/stemming.test.ts
git commit -m "feat(core): snowball stemming module keyed by detected languages"
```

---

### Task 2: Schema v3 — stem columns, trigram table, function migrations

**Files:**
- Modify: `src/main/core/store/schema.ts`
- Test: `src/main/core/store/__tests__/fts.test.ts`

**Interfaces:**
- Consumes: `buildStemView` from `../stemming` (Task 1).
- Produces: `repopulateSearchIndex(db: BetterSqlite3.Database): void` exported from `schema.ts` — Task 6 calls it from `store.ts` (compact) and `db/worker-entry.ts`. After this task `documents_fts` has 5 columns and `documents_tri` exists.

- [ ] **Step 1: Write the failing migration test**

Append to the `describe` block in `src/main/core/store/__tests__/fts.test.ts`:

```ts
it('v3 migration backfills stem columns and the trigram table from a v2 corpus', async () => {
  await store.commit({
    account: accountId,
    documents: [
      doc('g', { title: 'Rechnungen', markdown: 'Die Rechnungen sind offen' }),
    ],
    cursor: null,
  });
  await store.close();

  // Regress the file to v2 shape: 3-column FTS, no trigram table, version 2.
  const raw = new Database(dbPath);
  raw.exec(`DROP TABLE IF EXISTS documents_fts; DROP TABLE IF EXISTS documents_tri;`);
  raw.exec(`CREATE VIRTUAL TABLE documents_fts USING fts5(
    doc_id UNINDEXED, title, markdown, tokenize = 'unicode61 remove_diacritics 2')`);
  raw
    .prepare(
      `INSERT INTO documents_fts(rowid, doc_id, title, markdown)
       SELECT rowid, id, coalesce(title,''), coalesce(markdown,'') FROM documents`,
    )
    .run();
  // German so the backfill exercises a non-English stemmer (module deps stub
  // detects everything as 'eng').
  raw.prepare(`UPDATE documents SET languages='["deu"]'`).run();
  raw.prepare(`UPDATE meta SET value='2' WHERE key='schemaVersion'`).run();

  migrate(raw);

  const stem = raw
    .prepare(
      `SELECT count(*) AS c FROM documents_fts WHERE documents_fts MATCH 'markdown_stem: rechnung'`,
    )
    .get() as { c: number };
  expect(stem.c).toBe(1);
  const tri = raw
    .prepare(
      `SELECT count(*) AS c FROM documents_tri WHERE documents_tri MATCH '"rechnungen"'`,
    )
    .get() as { c: number };
  expect(tri.c).toBe(1);
  raw.close();
  assertPinned(dbPath);

  store = openStore(await openDb(dbPath), deps); // afterEach close is a no-op
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/core/store/__tests__/fts.test.ts -t 'v3 migration'`
Expected: FAIL — SQLite error `no such column: markdown_stem` (or `no such table: documents_tri`): the migration doesn't exist yet.

- [ ] **Step 3: Implement function migrations + v3 in `schema.ts`**

Add the import at the top:

```ts
import { buildStemView } from '../stemming';
```

Change the array declaration (line 7) from `const MIGRATIONS: string[] = [` to:

```ts
type Migration = string | ((db: BetterSqlite3.Database) => void);

const MIGRATIONS: Migration[] = [
```

Append a third entry after the v2 string (after line 126's closing backtick + comma):

```ts
  // v3 — search parity (docs/superpowers/specs/2026-07-11-search-parity-design.md):
  // stem columns on documents_fts (snowball, per-document language) and a
  // trigram table for substring-recall fuzzy fallback. A FUNCTION migration:
  // the backfill stems text in JS, which a SQL string cannot express. DROPs
  // are IF EXISTS so a re-run against an already-v3-shaped file (version
  // regression in tests) is idempotent. Raw columns keep positions 1/2, so
  // snippet(documents_fts, 2, …) and the search JOIN are unchanged.
  (db: BetterSqlite3.Database): void => {
    db.exec(`
      DROP TABLE IF EXISTS documents_fts;
      DROP TABLE IF EXISTS documents_tri;
      CREATE VIRTUAL TABLE documents_fts USING fts5(
        doc_id UNINDEXED,
        title,
        markdown,
        title_stem,
        markdown_stem,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE documents_tri USING fts5(
        doc_id UNINDEXED,
        body,
        tokenize = 'trigram remove_diacritics 1'
      );
    `);
    repopulateSearchIndex(db);
  },
];
```

Add the exported rebuild helper below the array (used by v3, `maintenance.compact`, and the DB worker proc):

```ts
/**
 * Clear and refill BOTH search tables from `documents`, rowid-pinned,
 * stemming each row with its stored languages. Used by the v3 migration and
 * by maintenance.compact (VACUUM can renumber documents rowids — see the v2
 * note above).
 */
export function repopulateSearchIndex(db: BetterSqlite3.Database): void {
  db.exec(`DELETE FROM documents_fts; DELETE FROM documents_tri;`);
  const rows = db
    .prepare(
      `SELECT rowid AS rid, id, title, markdown, languages FROM documents`,
    )
    .all() as Array<{
    rid: number;
    id: string;
    title: string | null;
    markdown: string | null;
    languages: string;
  }>;
  const fts = db.prepare(
    `INSERT INTO documents_fts(rowid, doc_id, title, markdown, title_stem, markdown_stem)
     VALUES(?, ?, ?, ?, ?, ?)`,
  );
  const tri = db.prepare(
    `INSERT INTO documents_tri(rowid, doc_id, body) VALUES(?, ?, ?)`,
  );
  for (const r of rows) {
    const langs = JSON.parse(r.languages) as string[];
    const title = r.title ?? '';
    const markdown = r.markdown ?? '';
    fts.run(
      r.rid,
      r.id,
      title,
      markdown,
      buildStemView(title, langs),
      buildStemView(markdown, langs),
    );
    tri.run(r.rid, r.id, `${title}\n${markdown}`.trim());
  }
}
```

In `migrate()`, replace the loop body line `db.exec(MIGRATIONS[i]);` with:

```ts
      const m = MIGRATIONS[i];
      if (typeof m === 'string') db.exec(m);
      else m(db);
```

- [ ] **Step 4: Run the fts suite; fix the two version assertions**

Run: `npx jest src/main/core/store/__tests__/fts.test.ts`
Expected: the new test PASSES; two existing tests FAIL on version literals:

1. In `'v2 migration repins an unpinned (v1-shaped) database'`: change `).toBe('2');` to `).toBe('3');` (migrate now runs through v3).
2. In `'migrate() fails closed on a corpus newer than this build'`: change the restore line `raw.prepare(`UPDATE meta SET value='2' WHERE key='schemaVersion'`).run();` to `value='3'` (the file is already v3-shaped; restoring '2' would needlessly re-run v3 on reopen).

- [ ] **Step 5: Run to verify green**

Run: `npx jest src/main/core/store/`
Expected: PASS (fts + store suites — write path still fills only raw columns; nothing asserts stems from live writes yet).

- [ ] **Step 6: Commit**

```bash
git add src/main/core/store/schema.ts src/main/core/store/__tests__/fts.test.ts
git commit -m "feat(store): schema v3 — FTS stem columns + trigram table, function migrations"
```

---

### Task 3: Write path — commit fills stems and the trigram table

**Files:**
- Modify: `src/main/core/store/write-tx.ts`
- Test: `src/main/core/store/__tests__/fts.test.ts`

**Interfaces:**
- Consumes: `buildStemView` (Task 1); 5-column `documents_fts` + `documents_tri` (Task 2).
- Produces: every commit path (insert/update/enrich/removeAccount/purgeArchived) maintains both tables, rowid-pinned. Tasks 5–6 rely on stems/tri rows existing for freshly committed docs.

- [ ] **Step 1: Extend the pinning assertion (this is the failing test)**

In `fts.test.ts`, replace the body of `assertPinned` with a version that checks BOTH tables:

```ts
/** Every search-index row (both tables) must sit at its document's rowid. */
function assertPinned(dbPath: string): void {
  const raw = new Database(dbPath);
  try {
    for (const table of ['documents_fts', 'documents_tri']) {
      const rows = raw
        .prepare(
          `SELECT f.rowid AS fts_rowid, d.rowid AS doc_rowid
             FROM ${table} f JOIN documents d ON d.id = f.doc_id`,
        )
        .all() as Array<{ fts_rowid: number; doc_rowid: number }>;
      const count = (
        raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }
      ).c;
      const docCount = (
        raw.prepare(`SELECT COUNT(*) AS c FROM documents`).get() as { c: number }
      ).c;
      expect(rows.length).toBe(count); // no orphaned index rows
      expect(count).toBe(docCount); // no missing index rows
      for (const r of rows) expect(r.fts_rowid).toBe(r.doc_rowid);
    }
  } finally {
    raw.close();
  }
}
```

Also append a live-write test to the describe block:

```ts
it('write path fills stem columns and the trigram table', async () => {
  // deps.detectLanguages stubs ['eng'] — 'running' stems to 'run'.
  await store.commit({
    account: accountId,
    documents: [doc('s', { markdown: 'running daily' })],
    cursor: null,
  });
  await store.close();
  const raw = new Database(dbPath);
  try {
    expect(
      (
        raw
          .prepare(
            `SELECT count(*) AS c FROM documents_fts WHERE documents_fts MATCH 'markdown_stem: run'`,
          )
          .get() as { c: number }
      ).c,
    ).toBe(1);
    expect(
      (
        raw
          .prepare(
            `SELECT count(*) AS c FROM documents_tri WHERE documents_tri MATCH '"running"'`,
          )
          .get() as { c: number }
      ).c,
    ).toBe(1);
  } finally {
    raw.close();
  }
  store = openStore(await openDb(dbPath), deps); // afterEach close is a no-op
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/fts.test.ts`
Expected: FAIL — the multi-path pinning test and the new test fail because fresh commits write no `documents_tri` rows (count ≠ docCount) and leave stem columns empty.

- [ ] **Step 3: Implement in `write-tx.ts`**

Add the import:

```ts
import { buildStemView } from '../stemming';
```

Replace `ftsDelete` / `ftsInsert` / `ftsUpsert` (lines 78–115) with:

```ts
  // Search-index rows (documents_fts AND documents_tri) are rowid-pinned to
  // their document's rowid (schema v2/v3): deletes and replacements are
  // rowid-equality lookups instead of full virtual-table scans on the
  // UNINDEXED doc_id. Both callers write the documents row before touching
  // the index, so the subselect always resolves.
  const ftsDelete = (docId: string): void => {
    for (const table of ['documents_fts', 'documents_tri']) {
      conn
        .prepare(
          `DELETE FROM ${table}
          WHERE rowid = (SELECT rowid FROM documents WHERE id = ?)`,
        )
        .run(docId);
    }
  };

  /** Insert-only index write for a brand-new document — its id was minted in
   *  this transaction, so there is nothing to delete first. Stem columns are
   *  built with the document's just-detected languages; the trigram body is
   *  the raw title + markdown. */
  const ftsInsert = (
    docId: string,
    title: string | null,
    markdown: string | null,
    languages: string[],
  ): void => {
    const t = title ?? '';
    const m = markdown ?? '';
    conn
      .prepare(
        `INSERT INTO documents_fts(rowid, doc_id, title, markdown, title_stem, markdown_stem)
        VALUES((SELECT rowid FROM documents WHERE id = ?), ?, ?, ?, ?, ?)`,
      )
      .run(
        docId,
        docId,
        t,
        m,
        buildStemView(t, languages),
        buildStemView(m, languages),
      );
    conn
      .prepare(
        `INSERT INTO documents_tri(rowid, doc_id, body)
        VALUES((SELECT rowid FROM documents WHERE id = ?), ?, ?)`,
      )
      .run(docId, docId, `${t}\n${m}`.trim());
  };

  const ftsUpsert = (
    docId: string,
    title: string | null,
    markdown: string | null,
    languages: string[],
  ): void => {
    ftsDelete(docId);
    ftsInsert(docId, title, markdown, languages);
  };
```

Update the three call sites to pass `languages` (the local variable already computed at each):

- `upsertDocument` update path (line 164): `ftsUpsert(existing.id, input.title, input.markdown, languages);`
- `upsertDocument` insert path (line 193): `ftsInsert(id, input.title, input.markdown, languages);`
- enrich path (~line 302): `ftsUpsert(row.id, row.title, e.markdown, languages);`

In the `removeAccount` arm, duplicate the set-based FTS delete for the trigram table — directly after the existing `DELETE FROM documents_fts …` statement (before `DELETE FROM documents`):

```ts
      conn
        .prepare(
          `DELETE FROM documents_tri
          WHERE rowid IN (SELECT rowid FROM documents WHERE account_id = ?)`,
        )
        .run(acc.id);
```

In the `purgeArchived` arm, likewise after the existing `DELETE FROM documents_fts …`:

```ts
      conn
        .prepare(
          `DELETE FROM documents_tri
          WHERE rowid IN (SELECT rowid FROM documents
                          WHERE archived_at IS NOT NULL AND archived_at < ?)`,
        )
        .run(batch.purgeArchived.before);
```

- [ ] **Step 4: Run to verify green (store + DB worker suites)**

Run: `npx jest src/main/core/store/ src/main/db/`
Expected: PASS. (`db-worker.test.ts` drives the same `createWriteTx` through a real worker thread — no worker-specific change needed.)

- [ ] **Step 5: Commit**

```bash
git add src/main/core/store/write-tx.ts src/main/core/store/__tests__/fts.test.ts
git commit -m "feat(store): commit path maintains stem columns and the trigram table"
```

---

### Task 4: Fuzzy helpers (pure functions)

**Files:**
- Create: `src/main/core/store/fuzzy.ts`
- Test: `src/main/core/store/__tests__/fuzzy.test.ts`

**Interfaces:**
- Consumes: nothing project-internal.
- Produces (Task 6 imports all four from `./fuzzy`):
  - `extractTerms(text: string): { positive: string[]; negated: string[] }`
  - `toTrigramMatch(terms: string[]): string | null`
  - `rrfMerge<T>(primary: T[], fallback: T[], idOf: (row: T) => string, limit: number): T[]`
  - `buildSnippet(markdown: string, terms: string[]): string`

- [ ] **Step 1: Write the failing test**

`src/main/core/store/__tests__/fuzzy.test.ts`:

```ts
import { buildSnippet, extractTerms, rrfMerge, toTrigramMatch } from '../fuzzy';

describe('extractTerms', () => {
  it('splits positives and negatives, handling -term, NOT, phrases, prefix and parens', () => {
    expect(extractTerms('alpha -beta NOT gamma "a phrase" delta*')).toEqual({
      positive: ['alpha', 'a phrase', 'delta'],
      negated: ['beta', 'gamma'],
    });
  });

  it('drops uppercase operators, keeps lowercase words, lowercases terms', () => {
    expect(extractTerms('Alpha AND or OR beta')).toEqual({
      positive: ['alpha', 'or', 'beta'],
      negated: [],
    });
  });

  it('handles grouped negation input without choking on parens', () => {
    expect(extractTerms('(alpha beta) -gamma')).toEqual({
      positive: ['alpha', 'beta'],
      negated: ['gamma'],
    });
  });
});

describe('toTrigramMatch', () => {
  it('AND-joins quoted tokens of length >= 3', () => {
    // AND, not legacy's OR (decision 2026-07-11): every surviving term must
    // appear as a substring, preserving the grammar's implicit-AND.
    expect(toTrigramMatch(['rechnung', 'ab', 'a phrase'])).toBe(
      '"rechnung" AND "a phrase"',
    );
  });

  it('returns null when no token qualifies', () => {
    expect(toTrigramMatch(['ab', 'x'])).toBeNull();
    expect(toTrigramMatch([])).toBeNull();
  });

  it('escapes embedded double quotes', () => {
    expect(toTrigramMatch(['say "hi"'])).toBe('"say ""hi"""');
  });
});

describe('rrfMerge', () => {
  const row = (id: string) => ({ id });
  it('sums reciprocal ranks for rows in both lists (k=60)', () => {
    const merged = rrfMerge(
      [row('a'), row('b')],
      [row('b'), row('c')],
      (r) => r.id,
      10,
    );
    // b: 1/62 + 1/61 > a: 1/61 > c: 1/62
    expect(merged.map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('caps at limit', () => {
    const merged = rrfMerge([row('a'), row('b')], [row('c')], (r) => r.id, 2);
    expect(merged).toHaveLength(2);
  });
});

describe('buildSnippet', () => {
  it('anchors a window at the earliest term and bolds hits', () => {
    const md = `${'x'.repeat(300)} the Jahresrechnung is attached ${'y'.repeat(300)}`;
    const s = buildSnippet(md, ['rechnung']);
    expect(s).toContain('<b>rechnung</b>');
    expect(s.length).toBeLessThan(300);
    expect(s.startsWith('…')).toBe(true);
  });

  it('falls back to the document head when nothing matches literally', () => {
    const s = buildSnippet('plain start of text', ['zzz']);
    expect(s).toContain('plain start');
  });

  it('returns empty for empty markdown', () => {
    expect(buildSnippet('', ['a'])).toBe('');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/fuzzy.test.ts`
Expected: FAIL — `Cannot find module '../fuzzy'`.

- [ ] **Step 3: Write the implementation**

`src/main/core/store/fuzzy.ts`:

```ts
/**
 * Pure helpers for the trigram fuzzy-fallback pass (spec:
 * docs/superpowers/specs/2026-07-11-search-parity-design.md). Trigram
 * matching is SUBSTRING recall: each query token matches documents that
 * contain it as a contiguous substring ("rechnung" → "Jahresrechnung") —
 * the legacy semantics, not edit-distance typo correction.
 */

export interface QueryTerms {
  positive: string[];
  negated: string[];
}

/**
 * Pull literal terms out of the user's search text, mirroring the boolean
 * grammar loosely (this feeds recall widening and snippet anchoring, not
 * exact matching): quoted phrases stay whole, leading '-' or a preceding
 * NOT marks negation, UPPERCASE AND/OR are dropped, 'term*' loses the star,
 * parens are ignored. Everything lowercased.
 */
export function extractTerms(text: string): QueryTerms {
  const positive: string[] = [];
  const negated: string[] = [];
  const re = /(-)?"([^"]*)"|([^\s()]+)/g;
  let pendingNot = false;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text)) !== null) {
    if (m[2] === undefined && m[3] !== undefined) {
      if (m[3] === 'AND' || m[3] === 'OR') continue;
      if (m[3] === 'NOT') {
        pendingNot = true;
        continue;
      }
    }
    let raw = m[2] ?? m[3] ?? '';
    let neg = pendingNot || m[1] === '-';
    pendingNot = false;
    if (m[2] === undefined) {
      if (raw.startsWith('-')) {
        neg = true;
        raw = raw.slice(1);
      }
      raw = raw.replace(/\*+$/, '').replace(/["*]/g, '');
    }
    const term = raw.trim().toLowerCase();
    if (!term) continue;
    (neg ? negated : positive).push(term);
  }
  return { positive, negated };
}

/** MATCH expression for documents_tri: the trigram tokenizer needs >= 3-char
 *  tokens; shorter ones are dropped. Null when no token qualifies. Terms are
 *  AND-joined (decision 2026-07-11, deviating from legacy's OR): every
 *  surviving term must appear as a substring, so the fallback can never
 *  smuggle partial matches into an implicit-AND query. */
export function toTrigramMatch(terms: string[]): string | null {
  const usable = terms.filter((t) => t.length >= 3);
  if (usable.length === 0) return null;
  return usable.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
}

const RRF_K = 60;

/** Reciprocal Rank Fusion: merge two ranked lists by rank position (bm25
 *  scores from different tables aren't comparable). Rows present in both
 *  lists sum their contributions; higher fused score = better. */
export function rrfMerge<T>(
  primary: T[],
  fallback: T[],
  idOf: (row: T) => string,
  limit: number,
): T[] {
  const byId = new Map<string, { row: T; score: number }>();
  const add = (list: T[]): void => {
    list.forEach((row, i) => {
      const key = idOf(row);
      const inc = 1 / (RRF_K + i + 1);
      const existing = byId.get(key);
      if (existing) existing.score += inc;
      else byId.set(key, { row, score: inc });
    });
  };
  add(primary);
  add(fallback);
  return [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.row);
}

/**
 * JS snippet for trigram-only hits (FTS5's snippet() only covers rows the
 * primary MATCH found): a ~240-char window anchored at the earliest literal
 * occurrence of any positive term, hits wrapped in <b>…</b> to match the
 * FTS snippet convention, whitespace collapsed. Falls back to the document
 * head when no term occurs literally.
 */
export function buildSnippet(markdown: string, terms: string[]): string {
  if (!markdown) return '';
  const lower = markdown.toLowerCase();
  let bestIdx = -1;
  let bestLen = 0;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (bestIdx < 0 || i < bestIdx)) {
      bestIdx = i;
      bestLen = t.length;
    }
  }
  const radius = 120;
  let window: string;
  if (bestIdx < 0) {
    window = markdown.slice(0, radius * 2);
    if (markdown.length > window.length) window += '…';
  } else {
    const start = Math.max(0, bestIdx - radius);
    const end = Math.min(markdown.length, bestIdx + bestLen + radius);
    window = markdown.slice(start, end);
    if (start > 0) window = `…${window}`;
    if (end < markdown.length) window += '…';
  }
  for (const t of terms) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    window = window.replace(new RegExp(escaped, 'gi'), '<b>$&</b>');
  }
  return window.replace(/\s+/g, ' ').trim();
}
```

- [ ] **Step 4: Run to verify green**

Run: `npx jest src/main/core/store/__tests__/fuzzy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/store/fuzzy.ts src/main/core/store/__tests__/fuzzy.test.ts
git commit -m "feat(store): pure fuzzy-search helpers (terms, trigram match, RRF, snippet)"
```

---

### Task 5: Query-side stemming in `search`

**Files:**
- Modify: `src/main/core/store/store.ts`
- Test: `src/main/core/store/__tests__/search-parity.test.ts` (new)

**Interfaces:**
- Consumes: `stemVariants` (Task 1); stem columns filled by Task 3.
- Produces: `ftsQuery(text: string, expand?: (term: string) => string[]): string` (signature change, internal); corpus-language cache + invalidation used again in Task 6.

- [ ] **Step 1: Write the failing test file**

`src/main/core/store/__tests__/search-parity.test.ts`:

```ts
/**
 * Search parity (spec: docs/superpowers/specs/2026-07-11-search-parity-design.md):
 * snowball stemming via per-document languages + trigram substring fallback
 * fused with RRF, all inside store.read.search.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore } from '../store';
import type { CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  // Deterministic per-content detection: German markers → deu, else eng.
  detectLanguages: (text: string) =>
    /[äöüß]|Rechnung/i.test(text) ? ['deu'] : ['eng'],
};

function doc(
  externalId: string,
  over: Partial<DocumentInput> = {},
): DocumentInput {
  return {
    externalId,
    type: 'note',
    title: `Title ${externalId}`,
    markdown: `body-${externalId}`,
    metadata: {},
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('search parity: stemming', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-parity-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'test',
      identifier: 'me@example.com',
    });
    accountId = account.id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds German singular via an inflected query (index + query stems)', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('de', { markdown: 'Die Rechnung ist offen' })],
      cursor: null,
    });
    const hits = await store.read.search({ text: 'Rechnungen' });
    expect(hits).toHaveLength(1);
    expect(hits[0].markdown).toContain('Rechnung');
  });

  it('finds English inflections both directions', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('en', { markdown: 'we run daily' })],
      cursor: null,
    });
    expect(await store.read.search({ text: 'running' })).toHaveLength(1);
  });

  it('ranks a literal title match above a stem-only body match', async () => {
    // The literal doc matches 'running' in the TITLE (bm25 weight 4.0 raw +
    // 2.0 stem); the stem-only doc matches just via markdown (1.0/0.5) — the
    // ordering is decisive, not a term-frequency coin flip.
    await store.commit({
      account: accountId,
      documents: [
        doc('lit', { title: 'Running review', markdown: 'shoes' }),
        doc('stem', { markdown: 'we run daily' }),
      ],
      cursor: null,
    });
    const hits = await store.read.search({ text: 'running' });
    expect(hits).toHaveLength(2);
    expect(hits[0].title).toBe('Running review');
  });

  it('keeps exclusion exact: -term applies, stemming never widens a negation', async () => {
    await store.commit({
      account: accountId,
      documents: [
        doc('kept', { markdown: 'apples oranges' }),
        doc('dropped', { markdown: 'apples running' }),
      ],
      cursor: null,
    });
    const hits = await store.read.search({ text: 'apples -running' });
    expect(hits).toHaveLength(1);
    expect(hits[0].markdown).toBe('apples oranges');
  });

  it('keeps prefix matching raw', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('p', { markdown: 'runningmate profile' })],
      cursor: null,
    });
    expect(await store.read.search({ text: 'runningm*' })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/search-parity.test.ts`
Expected: FAIL — the German-inflection and English-inflection tests get 0 hits (no query-side stem expansion yet). The literal/negation/prefix tests may already pass; the suite as a whole must be red via the first two.

- [ ] **Step 3: Implement in `store.ts`**

Add the import:

```ts
import { stemVariants } from '../stemming';
```

Give `ftsQuery` the expansion hook — change its signature (line 226):

```ts
function ftsQuery(
  text: string,
  expand?: (term: string) => string[],
): string {
```

and inside `parseAnd`, replace the plain-term operand branch (currently lines 256–259):

```ts
      } else {
        negated = negated || t.negated;
        const quoted = `"${t.value.replace(/"/g, '""')}"${t.prefix ? ' *' : ''}`;
        // Stem expansion widens POSITIVE plain terms only: phrases (value
        // contains whitespace), prefix terms and negations stay raw so their
        // exact semantics survive.
        const variants =
          expand && !negated && !t.prefix && !/\s/.test(t.value)
            ? expand(t.value)
            : [];
        operand = variants.length
          ? `(${[
              quoted,
              ...variants.map((v) => `"${v.replace(/"/g, '""')}"`),
            ].join(' OR ')})`
          : quoted;
      }
```

(Note: the original branch computed `operand` first and `negated` second — the reorder above is required so negated terms skip expansion. `negated` here is the local inside `parseAnd`, seeded from `pendingNot`.)

Inside `openStore` (after the `writeTx` setup, ~line 304), add the corpus-language cache:

```ts
  // Distinct languages present in the corpus (∪ 'eng'), feeding query-side
  // stem expansion. Invalidated on every commit, recomputed lazily — a
  // search-as-you-type burst pays for the DISTINCT scan once.
  let corpusLangsCache: string[] | null = null;
  const corpusLanguages = async (): Promise<string[]> => {
    if (corpusLangsCache) return corpusLangsCache;
    const rows = (await db.all(
      `SELECT DISTINCT languages FROM documents`,
    )) as unknown as Array<{ languages: string }>;
    const set = new Set<string>(['eng']);
    for (const r of rows)
      for (const l of JSON.parse(r.languages) as string[]) set.add(l);
    corpusLangsCache = [...set];
    return corpusLangsCache;
  };
```

In `commit` (line 530), invalidate before the nudge:

```ts
    async commit(batch) {
      const seq = writeTx
        ? writeTx.commit(batch)
        : ((await db.proc!('commit', batch)) as Seq);
      corpusLangsCache = null;
      nudge.emit('commit');
      return seq;
    },
```

In `search`'s text branch, expand terms and extend the bm25 weights:

```ts
      if (q.text?.trim()) {
        const langs = await corpusLanguages();
        const rows = (await db.all(
          `SELECT d.*, snippet(documents_fts, 2, '<b>', '</b>', '…', 24) AS _snippet
             FROM documents_fts f JOIN documents d ON d.id = f.doc_id
             WHERE documents_fts MATCH ? ${where}
             ORDER BY bm25(documents_fts, 0, 4.0, 1.0, 2.0, 0.5)
             LIMIT ? OFFSET ?`,
          [
            ftsQuery(q.text, (term) => stemVariants(term, langs)),
            ...params,
            limit,
            offset,
          ],
        )) as unknown as Array<DocRow & { _snippet: string }>;
        return rows.map((r) => ({ ...toDocument(r), snippet: r._snippet }));
      }
```

- [ ] **Step 4: Run to verify green (search-parity + everything touching ftsQuery/search)**

Run: `npx jest src/main/core/store/ src/main/core/mcp/`
Expected: PASS. If an existing store test asserts result ORDER for multi-hit text searches, re-check whether the new weights change it legitimately (stem columns are empty for docs whose language didn't map — ordering of existing fixtures should be stable).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/store/store.ts src/main/core/store/__tests__/search-parity.test.ts
git commit -m "feat(store): stem-expanded search terms via corpus languages"
```

---

### Task 6: Trigram fuzzy fallback in `search`

**Files:**
- Modify: `src/main/core/store/store.ts`
- Test: `src/main/core/store/__tests__/search-parity.test.ts`

**Interfaces:**
- Consumes: `extractTerms` / `toTrigramMatch` / `rrfMerge` / `buildSnippet` from `./fuzzy` (Task 4); `documents_tri` rows (Task 3).
- Produces: final `search` behavior — the deliverable of the feature.

- [ ] **Step 1: Write the failing tests**

Append a second describe block to `search-parity.test.ts`:

```ts
describe('search parity: trigram fuzzy fallback', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-fuzzy-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'test',
      identifier: 'me@example.com',
    });
    accountId = account.id;
    await store.commit({
      account: accountId,
      documents: [
        doc('exact', { markdown: 'Die Rechnung ist offen' }),
        doc('compound', { markdown: 'Die Jahresrechnung liegt bei' }),
        doc('paid', { markdown: 'Jahresrechnung bezahlt und abgelegt' }),
      ],
      cursor: null,
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rescues compound words via trigram substring recall', async () => {
    // 'Rechnung' raw/stem never tokenizes out of 'Jahresrechnung'; the
    // trigram pass finds it as a substring and RRF fuses it in.
    const hits = await store.read.search({ text: 'Rechnung' });
    const bodies = hits.map((h) => h.markdown);
    expect(bodies).toEqual(
      expect.arrayContaining([
        'Die Rechnung ist offen',
        'Die Jahresrechnung liegt bei',
      ]),
    );
    // Exact/stemmed match outranks a fuzzy-only match.
    expect(hits[0].markdown).toBe('Die Rechnung ist offen');
  });

  it('rescues truncated terms (substring of the real word)', async () => {
    const hits = await store.read.search({ text: 'rechnun' });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('skips the fuzzy pass when the first page is already full', async () => {
    const hits = await store.read.search({ text: 'Rechnung', limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0].markdown).toBe('Die Rechnung ist offen'); // no fuzzy row
  });

  it('never resurfaces a NOT-excluded document via fuzzy', async () => {
    const hits = await store.read.search({ text: 'Rechnung -bezahlt' });
    const bodies = hits.map((h) => h.markdown);
    expect(bodies).not.toContain('Jahresrechnung bezahlt und abgelegt');
    expect(bodies).toContain('Die Jahresrechnung liegt bei');
  });

  it('gives fuzzy-only hits a snippet built from raw markdown', async () => {
    const hits = await store.read.search({ text: 'jahresrech' });
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.snippet).toBeTruthy();
      expect(h.snippet!.toLowerCase()).toContain('<b>jahresrech</b>');
    }
  });

  it('applies SQL filters to the fuzzy pass too', async () => {
    const hits = await store.read.search({
      text: 'Rechnung',
      type: 'other-type',
    });
    expect(hits).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/search-parity.test.ts`
Expected: FAIL — compound/truncated/snippet tests find nothing (no fuzzy pass exists). The negation and page-full tests pass vacuously; the suite is red.

- [ ] **Step 3: Implement the fallback in `store.ts`**

Add the import:

```ts
import {
  buildSnippet,
  extractTerms,
  rrfMerge,
  toTrigramMatch,
} from './fuzzy';
```

Replace the text branch of `search` (the block from Task 5 Step 3) with:

```ts
      if (q.text?.trim()) {
        const langs = await corpusLanguages();
        const rows = (await db.all(
          `SELECT d.*, snippet(documents_fts, 2, '<b>', '</b>', '…', 24) AS _snippet
             FROM documents_fts f JOIN documents d ON d.id = f.doc_id
             WHERE documents_fts MATCH ? ${where}
             ORDER BY bm25(documents_fts, 0, 4.0, 1.0, 2.0, 0.5)
             LIMIT ? OFFSET ?`,
          [
            ftsQuery(q.text, (term) => stemVariants(term, langs)),
            ...params,
            limit,
            offset,
          ],
        )) as unknown as Array<DocRow & { _snippet: string }>;

        // Fuzzy fallback (trigram substring recall + RRF, spec 2026-07-11):
        // only when the exact+stemmed pass left the FIRST page short — good
        // queries never pay for a second index scan, near-misses (compound
        // words, truncations) get rescued.
        if (offset === 0 && rows.length < limit) {
          const { positive, negated } = extractTerms(q.text);
          const triMatch = toTrigramMatch(positive);
          if (triMatch) {
            const triRows = (await db.all(
              `SELECT d.* FROM documents_tri t JOIN documents d ON d.id = t.doc_id
                 WHERE documents_tri MATCH ? ${where}
                 ORDER BY bm25(documents_tri) LIMIT ?`,
              [triMatch, ...params, limit],
            )) as unknown as DocRow[];
            // A NOT-excluded document must never resurface via fuzzy: drop
            // hits containing any negated term (substring match, Unicode
            // lowercase — deliberately broader than FTS token semantics).
            const safe = triRows.filter(
              (r) =>
                !negated.some((n) =>
                  `${r.title ?? ''}\n${r.markdown ?? ''}`
                    .toLowerCase()
                    .includes(n),
                ),
            );
            const snippets = new Map(rows.map((r) => [r.id, r._snippet]));
            const fused = rrfMerge<DocRow>(rows, safe, (r) => r.id, limit);
            return fused.map((r) => ({
              ...toDocument(r),
              snippet:
                snippets.get(r.id) ?? buildSnippet(r.markdown ?? '', positive),
            }));
          }
        }
        return rows.map((r) => ({ ...toDocument(r), snippet: r._snippet }));
      }
```

- [ ] **Step 4: Run to verify green**

Run: `npx jest src/main/core/store/ src/main/core/mcp/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/store/store.ts src/main/core/store/__tests__/search-parity.test.ts
git commit -m "feat(store): trigram fuzzy fallback fused with RRF in search"
```

---

### Task 7: Maintenance parity (compact, resetAll, worker proc)

**Files:**
- Modify: `src/main/core/store/store.ts` (`maintenance.compact`, `maintenance.resetAll`)
- Modify: `src/main/db/worker-entry.ts`
- Test: `src/main/core/store/__tests__/fts.test.ts`

**Interfaces:**
- Consumes: `repopulateSearchIndex` from `./schema` (Task 2).
- Produces: `rebuildSearchIndex` proc registered in the DB worker (name used by `maintenance.compact`'s worker path).

- [ ] **Step 1: Extend the failing tests**

In `fts.test.ts`, extend the existing `'compact() rebuilds the pinning after VACUUM renumbers rowids'` test — after the final `expect(await store.read.search({ text: 'post-compact' })).toHaveLength(1);` add:

```ts
    // The rebuilt index still carries stems: 'bodies' stems to 'bodi', which
    // matches the stem view of 'body' in both surviving docs ('a' was purged;
    // 'b' now reads 'post-compact body', 'c' keeps 'unique-c body').
    expect(await store.read.search({ text: 'bodies' })).toHaveLength(2);
```

Then add a new test:

```ts
it('resetAll empties the trigram table too', async () => {
  await store.commit({
    account: accountId,
    documents: [doc('r')],
    cursor: null,
  });
  await store.maintenance.resetAll();
  await store.close();
  const raw = new Database(dbPath);
  try {
    expect(
      (raw.prepare(`SELECT count(*) AS c FROM documents_tri`).get() as {
        c: number;
      }).c,
    ).toBe(0);
    expect(
      (raw.prepare(`SELECT count(*) AS c FROM documents_fts`).get() as {
        c: number;
      }).c,
    ).toBe(0);
  } finally {
    raw.close();
  }
  store = openStore(await openDb(dbPath), deps); // afterEach close is a no-op
});
```

- [ ] **Step 2: Run to verify failures**

Run: `npx jest src/main/core/store/__tests__/fts.test.ts -t 'compact|resetAll'`
Expected: FAIL —
- compact: the post-VACUUM rebuild still runs the old 4-column `INSERT INTO documents_fts(rowid, doc_id, title, markdown)` batch. The explicit column list means it succeeds — but it leaves the stem columns empty and never rebuilds `documents_tri`, so the extended `assertPinned` fails on the tri table and the `'bodies'` stem search returns 0.
- resetAll: `documents_tri` still has 1 row.

- [ ] **Step 3: Implement**

In `store.ts`, add `repopulateSearchIndex` to the existing schema import (or add `import { repopulateSearchIndex } from './schema';` if none exists), then replace `maintenance.compact`'s post-VACUUM batch:

```ts
      async compact() {
        await db.exec('VACUUM');
        // documents has a TEXT primary key, so VACUUM may renumber its
        // implicit rowids — which BOTH search tables' rows are pinned to
        // (schema v2/v3). Rebuild the pinning right after; the rebuild stems
        // in JS, so in-process it runs directly on the raw connection and
        // worker-backed it dispatches to the registered proc (same pattern
        // as `commit`).
        if (db._conn) repopulateSearchIndex(db._conn);
        else await db.proc!('rebuildSearchIndex', null);
      },
```

In `maintenance.resetAll`, add `'documents_tri'` to the table list right after `'documents_fts'`:

```ts
          ...[
            'documents_fts',
            'documents_tri',
            'documents',
            'changes',
            'consumers',
            'work_ledger',
            'vault',
            'schedule',
            'accounts',
          ].map((t) => ({ sql: `DELETE FROM ${t}` })),
```

In `src/main/db/worker-entry.ts`, import and register the proc:

```ts
import { repopulateSearchIndex } from '@main/core/store/schema';
```

and extend the procs object:

```ts
      {
        commit: (args) => writeTx.commit(args as CommitBatch),
        rebuildSearchIndex: () => {
          repopulateSearchIndex(db._conn!);
          return null;
        },
      },
```

- [ ] **Step 4: Run to verify green**

Run: `npx jest src/main/core/store/ src/main/db/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/store/store.ts src/main/db/worker-entry.ts src/main/core/store/__tests__/fts.test.ts
git commit -m "feat(store): compact/resetAll rebuild both search tables (worker proc included)"
```

---

### Task 8: Full verification + docs closeout

**Files:**
- Modify: `docs/rebuild/LEFTOVERS.md`
- Modify: `docs/superpowers/specs/2026-07-11-search-parity-design.md` (status line)

- [ ] **Step 1: Full suite + typecheck + lint**

Run: `npx jest && npm run typecheck && npm run lint`
Expected: all green. Fix anything that fails before proceeding (a failing unrelated suite must be reported, not silently skipped).

- [ ] **Step 2: Update LEFTOVERS.md item 5**

Replace the item under "Deferred features":

```markdown
5. **Search parity** — DONE (2026-07-11, spec
   `docs/superpowers/specs/2026-07-11-search-parity-design.md`): snowball
   stemming via per-document detected languages (stem columns on
   `documents_fts`) and a trigram substring-recall fallback
   (`documents_tri`, RRF k=60) fused inside `store.read.search`. Legacy
   trigram/stemming behavior is restored with greenfield semantics kept
   (raw exact match, phrases, snippets, boolean grammar). Legacy's
   per-paragraph weighted language scores were NOT ported (single-code
   `detectLanguages` remains).
```

- [ ] **Step 3: Flip the spec status**

In the spec header, change `**Status:** approved` to `**Status:** implemented`.

- [ ] **Step 4: Commit**

```bash
git add docs/rebuild/LEFTOVERS.md docs/superpowers/specs/2026-07-11-search-parity-design.md
git commit -m "docs: close search-parity leftover (implemented per spec)"
```
