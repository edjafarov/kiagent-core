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
 *  AND-joined (deviating from legacy's OR) so every surviving ≥3-char term
 *  must appear as a substring — the fallback can never smuggle partial
 *  matches into an implicit-AND query. */
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
