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
