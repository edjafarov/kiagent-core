import {
  buildSnippet,
  extractTerms,
  foldForNegation,
  rrfMerge,
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
