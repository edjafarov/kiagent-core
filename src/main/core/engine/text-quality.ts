/** Per-page text-layer quality (garbled-PDF spec §1). Pure; thresholds are
 *  constants tuned on the fixtures. `garbled` needs POSITIVE corruption
 *  evidence — low letter density alone never qualifies (numeric pages). */
export type PageQuality = 'good' | 'sparse' | 'garbled';
export const QUALITY_VERSION = 1;

const SPARSE_BELOW = 16; // non-whitespace chars
const BAD_RATIO = 0.05; // signal (a)
const MIN_PAIRS = 40; // signal (b) needs this much evidence
const COMMON_PAIR_RATIO = 0.68;
// (a) U+FFFD, Private Use Area, C0/C1 controls except \t \n \r, rare Latin-1 marks.
const BAD_CHAR =
  // eslint-disable-next-line no-control-regex -- control chars ARE the signal
  /[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F¤¦¨¯´¸¶¬]/gu;
// (b) Letter pairs common inside words of en/de/fr/it/es/nl plus the most
// frequent Polish/Czech ones (accents folded, ß → ss). Real text — prose,
// statements, term lists, codes — scores ≥ 0.71 over its DISTINCT words; a
// font-offset (Caesar) shift of any of those languages scores ≤ 0.62.
const COMMON_PAIRS = new Set(
  (
    'ab ac ad af ag ah ai ak al am an ap ar as at au av aw ay ba be bi bl bo br bu by ca cc ce ch ci ck cl co cr ct cu ' +
    'da de di do dr ds du ea ec ed ee ef eg eh ei el em en eo ep er es et eu ev ew ex ey fa fe ff fi fl fo fr ft fu ' +
    'ga ge gg gh gi gl gn go gr gt gu ha he hi hl hm hn ho hr hs ht hu ia ib ic id ie if ig ih il im in io ip ir is it iv iz ' +
    'ka ke ki kl ko ks la ld le li ll lo ls lt lu ly lz ma me mi mm mo mp ms mu my na nc nd ne nf ng ni nk nl nn no ns nt nu ny nz ' +
    'ob oc od oe of og oh oi ok ol om on oo op or os ot ou ov ow pa pe ph pi pl po pp pr pt pu qu ' +
    'ra rb rc rd re rf rg ri rk rl rm rn ro rr rs rt ru rv ry rz sa sc se sh si sm so sp ss st su sy ' +
    'ta te th ti tl to tr ts tt tu tw ty tz ua ub uc ud ue ug uh ui ul um un up ur us ut uz va ve vi vo ' +
    'wa we wh wi wn wo wu ye yo za ze zi zu cz sz dz wy kt zy yc ej aj je ja sk'
  ).split(' '),
);

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase();

export function assessPage(text: string): PageQuality {
  const compact = text.replace(/\s+/g, '');
  const n = compact.length;
  if (n < SPARSE_BELOW) return 'sparse';
  const bad = compact.match(BAD_CHAR)?.length ?? 0;
  if (bad / n > BAD_RATIO) return 'garbled';
  // Distinct words, so 30 rows of "CHF" or "SEPA Lastschrift" count once.
  // Tokens holding a digit (payment refs, hashes, IBANs, SKUs) are identifiers,
  // not language: drop them BEFORE splitting into letter runs.
  const words = new Set(
    text
      .split(/\s+/)
      .filter((t) => !/\d/.test(t))
      .flatMap((t) => fold(t).split(/[^a-z]+/))
      .filter((w) => w.length >= 2),
  );
  let pairs = 0;
  let common = 0;
  for (const w of words) {
    for (let i = 0; i < w.length - 1; i++) {
      pairs++;
      if (COMMON_PAIRS.has(w.slice(i, i + 2))) common++;
    }
  }
  if (pairs >= MIN_PAIRS && common / pairs < COMMON_PAIR_RATIO)
    return 'garbled';
  return 'good';
}
