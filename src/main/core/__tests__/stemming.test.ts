import { buildStemView, normalizeForStem, stemVariants } from '../stemming';

describe('normalizeForStem', () => {
  it('applies NFKC, ё-folding and lowercasing', () => {
    expect(normalizeForStem('Ёлка')).toBe('елка');
    expect(normalizeForStem('ＲＵＮ')).toBe('run'); // fullwidth → ASCII via NFKC
  });
});

describe('buildStemView', () => {
  it('stems German text with the document language', () => {
    const tokens = buildStemView('Die Rechnungen sind bezahlt', ['deu']).split(
      ' ',
    );
    expect(tokens).toContain('rechnung');
    expect(tokens).not.toContain('rechnungen');
  });

  it('stems English and Russian', () => {
    expect(buildStemView('running daily', ['eng']).split(' ')).toContain('run');
    expect(buildStemView('Бегущий по лесу', ['rus']).split(' ')).toContain(
      'бегущ',
    );
  });

  it('uses the first MAPPED language', () => {
    // 'und' and 'jpn' have no snowball algorithm — 'deu' is the first mapped.
    const tokens = buildStemView('Rechnungen', ['und', 'jpn', 'deu']).split(
      ' ',
    );
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
