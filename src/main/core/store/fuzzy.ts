/**
 * Pure helpers for the trigram fuzzy-fallback pass (spec:
 * docs/superpowers/specs/2026-07-11-search-parity-design.md). Trigram
 * matching is SUBSTRING recall: each query token matches documents that
 * contain it as a contiguous substring ("rechnung" → "Jahresrechnung") —
 * the legacy semantics, not edit-distance typo correction.
 */

import { normalizeForStem } from '../stemming';

/** Fold a string the way the primary index folds tokens (NFKC, ё→е,
 *  lowercase, diacritics stripped) so the fuzzy negation post-filter can
 *  never be WEAKER than the grammar's own negation. Phrase negation across
 *  punctuation remains narrower than FTS phrase semantics — documented in
 *  the spec. */
export function foldForNegation(s: string): string {
  return normalizeForStem(s).normalize('NFD').replace(/\p{M}/gu, '');
}

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
 *  AND-joined (deviating from legacy's OR) so every surviving ≥3-char term
 *  must appear as a substring — the fallback can never smuggle partial
 *  matches into an implicit-AND query. */
export function toTrigramMatch(terms: string[]): string | null {
  const usable = terms.filter((t) => t.length >= 3);
  if (usable.length === 0) return null;
  return usable.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
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

/** Newest trigram matches considered per fuzzy pass (spec §3.2). */
export const FUZZY_CANDIDATES = 100;

/** The ONE fuzzy statement: keeps every eligibility filter (`where` is
 *  `AND …` or empty), drops bm25 (its cost grows with the match count), takes
 *  the NEWEST matches (trigram rowid = documents.rowid = insert order; FTS5
 *  serves `ORDER BY rowid DESC` without sorting) and reads no body unless
 *  negated terms need folding. */
export function fuzzyCandidatesSql(where: string, withBody: boolean): string {
  return `SELECT d.id, d.title, d.created_at, d.ingested_at${withBody ? ', d.markdown' : ''}
            FROM documents_tri t JOIN documents d ON d.id = t.doc_id
           WHERE documents_tri MATCH ? ${where}
           ORDER BY t.rowid DESC LIMIT ?`;
}

export interface FuzzyCandidate {
  id: string;
  title: string | null;
  created_at: string | null;
  ingested_at: string;
  markdown?: string | null;
}

/** Local ranking: a folded title that contains a positive term first, then
 *  newest by origin date (stable, so ties keep newest-rowid order). */
export function rankFuzzyCandidates<T extends FuzzyCandidate>(
  cands: readonly T[],
  positiveFolded: readonly string[],
): T[] {
  const dateOf = (c: T) => c.created_at ?? c.ingested_at;
  const titleHit = (c: T) => {
    const t = foldForNegation(c.title ?? '');
    return positiveFolded.some((p) => t.includes(p)) ? 1 : 0;
  };
  return [...cands].sort(
    (a, b) =>
      titleHit(b) - titleHit(a) ||
      (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0),
  );
}

/** Fuzzy may only FILL the page's free slots: ids already in the exact list
 *  are skipped, the rest are taken in ranked order up to `free`. */
export function pickFuzzyWinners(
  exactIds: ReadonlySet<string>,
  ranked: readonly { id: string }[],
  free: number,
): string[] {
  const out: string[] = [];
  for (const c of ranked) {
    if (out.length >= free) break;
    if (!exactIds.has(c.id)) out.push(c.id);
  }
  return out;
}
