import {
  buildSnippet,
  extractTerms,
  foldForNegation,
  FUZZY_CANDIDATES,
  fuzzyCandidatesSql,
  pickFuzzyWinners,
  rankFuzzyCandidates,
  toTrigramMatch,
} from '../fuzzy';

describe('foldForNegation', () => {
  it('strips diacritics after folding (Über -> uber)', () => {
    expect(foldForNegation('Über')).toBe('uber');
  });

  it('folds ё -> е and leaves no combining marks (Ёлка -> елка)', () => {
    const folded = foldForNegation('Ёлка');
    expect(folded).toBe('елка');
    expect(/\p{M}/u.test(folded)).toBe(false);
  });
});

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

describe('fuzzyCandidatesSql', () => {
  it('is newest-first, ranks nothing by bm25 and reads no body by default', () => {
    const sql = fuzzyCandidatesSql('AND d.account_id = ?', false);
    expect(sql).toMatch(/ORDER BY t\.rowid DESC LIMIT \?/);
    expect(sql).not.toMatch(/bm25/);
    expect(sql).not.toMatch(/markdown/);
    expect(sql).toMatch(/AND d\.account_id = \?/);
  });

  it('selects the body only when negated terms need folding', () => {
    expect(fuzzyCandidatesSql('', true)).toMatch(/d\.markdown/);
  });

  it('caps candidates at 100', () => {
    expect(FUZZY_CANDIDATES).toBe(100);
  });
});

describe('rankFuzzyCandidates / pickFuzzyWinners', () => {
  const c = (id: string, title: string, at: string) => ({
    id,
    title,
    created_at: at,
    ingested_at: at,
  });

  it('ranks a folded title hit first, then newest', () => {
    const ranked = rankFuzzyCandidates(
      [
        c('old', 'misc', '2026-01-01'),
        c('new', 'misc', '2026-03-01'),
        c('title', 'Jahresrechnung 2024', '2026-02-01'),
      ],
      ['rechnung'],
    );
    expect(ranked.map((r) => r.id)).toEqual(['title', 'new', 'old']);
  });

  it('keeps exact-hit order and appends only the new fuzzy hits', () => {
    // exact [A,B,C] + fuzzy [C,B,A,F] with one free slot -> [A,B,C,F]
    const exact = ['A', 'B', 'C'];
    const winners = pickFuzzyWinners(
      new Set(exact),
      ['C', 'B', 'A', 'F'].map((id) => ({ id })),
      1,
    );
    expect([...exact, ...winners]).toEqual(['A', 'B', 'C', 'F']);
  });

  it('never exceeds the free slots', () => {
    expect(
      pickFuzzyWinners(
        new Set(),
        ['x', 'y', 'z'].map((id) => ({ id })),
        2,
      ),
    ).toEqual(['x', 'y']);
  });
});
