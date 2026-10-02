# Garbled / Missing PDF Text Layers Implementation Plan (core)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PDF pages whose text layer is garbled or (almost) empty get OCR'd, and good pages keep their text. The existing corpus is re-assessed once, and no text is ever lost when OCR can't run.

**Architecture:**
- A pure `assessPage(text)` judges each page `good | sparse | garbled`.
- The PDF parser returns per-page text. Whoever parses (commit path or convert worker) writes a **deterministic** `conversion: { status: 'needs-ocr', pages, quality: 1 }` marker and keeps **all** the text.
- The vision worker, already windowed by the large-file plan, OCRs only the listed pages. Non-empty OCR replaces a page's text-layer text, with no VLM pass.
- A whole-text check in the convert worker's `matches()` re-admits old garbled rows through the large-file plan's convert v2 replay.

**Tech Stack:** TypeScript, jest + ts-jest, pdf-parse 1.1.4 (`pagerender` hook), the large-file plan's page-list rasterizer and `ocrProgress`.

**Spec:** `docs/superpowers/specs/2026-10-02-garbled-pdf-text-design.md` (r3 + implementation notes)

## Global Constraints

- Lands on top of the large-file core plan (`2026-10-02-large-file-indexing.md`), in the same core release. It needs Task 5 (convert v2 and `record`), Task 6 (rasterizer page list) and Task 7 (windowed OCR, `ocrProgress`, `complete`).
- **No version bump here.** The convert worker stays at v2, and its replay carries the §5 re-assessment.
- The `needs-ocr` marker carries **no `at`**, because `write-tx.ts` hashes metadata into `contentHash`. Its shape is exactly `{ status: 'needs-ocr', pages: number[], quality: 1 }`, with pages 1-based, ascending and de-duplicated.
- Suspect text is never dropped. A page's text-layer text is replaced only by **non-empty** OCR for that page.
- `needs-ocr` docs never get a VLM pass. `NoProviderError('read')` → `defer`.
- `MAX_OCR_PAGES` (200) caps the **number** of OCR'd pages, not page numbers.
- Never add a `json_extract` over `ocrProgress.pages` to a hot query.
- Commits: no `Co-Authored-By` line, never `--no-verify`, never amend. Tests run sequentially.

## Review Focus

1. **A 40-page numeric bank statement** (dates, amounts, few words). It must stay `good`, with no OCR churn. Task 1 (fixture strings) and Task 2 (a real PDF page of numbers).
2. **A Windows host with no OCR provider.** A `needs-ocr` doc keeps its full text forever and is re-driven without loss. Task 4.
3. **The same unchanged file rescanned** after `needs-ocr` was recorded. Same `contentHash`; `extraction`/`ocrProgress` are preserved, and OCR is not restarted. Task 3.
4. **A 300-page mixed bundle with 250 scanned pages.** Exactly 200 pages are OCR'd, `pagesSkipped: 50`, and every page appears in order. Task 4.
5. **A clean old PDF re-seen by the v2 replay.** It is not re-fetched (the whole-text check says clean), so a big corpus doesn't download every PDF again. Task 5.

---

### Task 1: `assessPage` (pure)

**Files:**
- Create: `src/main/core/engine/text-quality.ts`
- Test: `src/main/core/engine/__tests__/text-quality.test.ts`

**Interfaces:**
- Produces: `type PageQuality = 'good' | 'sparse' | 'garbled'`; `assessPage(text: string): PageQuality`; `QUALITY_VERSION = 1`.

- [ ] **Step 1: Failing tests**

```ts
import { assessPage } from '../text-quality';

// Shifts upper- and lower-case letters, like a PDF font with a wrong ToUnicode offset.
const shift = (s: string, k: number) =>
  s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + k) % 26) + 97))
   .replace(/[A-Z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 65 + k) % 26) + 65));
const PROSE = {
  en: 'The tenant shall pay the rent on the first day of each month and the landlord shall maintain the property. The parties agree that any dispute shall be settled by the court of the place where the property is located.',
  de: 'Der Mieter zahlt die Miete am ersten Tag jedes Monats und der Vermieter hält die Wohnung in gutem Zustand. Streitigkeiten werden vom zuständigen Landgericht München entschieden.',
  fr: 'Le locataire paie le loyer le premier jour de chaque mois et le bailleur entretient le logement. Les parties conviennent que tout litige sera tranché par le tribunal.',
  it: 'Il conduttore paga il canone il primo giorno di ogni mese e il locatore mantiene la proprietà. Le parti convengono che ogni controversia sarà decisa dal tribunale.',
  es: 'El inquilino paga el alquiler el primer día de cada mes y el arrendador mantiene la propiedad. Las partes acuerdan que cualquier disputa será resuelta por el tribunal.',
  nl: 'De huurder betaalt de huur op de eerste dag van elke maand en de verhuurder onderhoudt de woning. Geschillen worden beslecht door de bevoegde rechter.',
  pl: 'Najemca płaci czynsz pierwszego dnia każdego miesiąca, a wynajmujący utrzymuje lokal w należytym stanie. Spory rozstrzyga właściwy sąd.',
  cs: 'Nájemce platí nájemné první den každého měsíce a pronajímatel udržuje nemovitost v dobrém stavu. Spory rozhoduje příslušný soud.',
  tr: 'Kiracı kirayı her ayın ilk günü öder ve ev sahibi mülkü bakımlı tutar. Anlaşmazlıklar yetkili mahkeme tarafından çözülür.',
  ru: 'Арендатор оплачивает аренду в первый день каждого месяца, а арендодатель содержит имущество.',
};
const NOT_PROSE_BUT_GOOD = {
  'numeric statement (CHF)': Array.from({ length: 30 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}  4711-${i}  1.234,${String(i).padStart(2, '0')} CHF  -56,78`).join('\n'),
  'numeric statement (GBP)': Array.from({ length: 30 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}  4711-${i}  1,234.${String(i).padStart(2, '0')} GBP  -56.78`).join('\n'),
  'bank statement rows': Array.from({ length: 25 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')} SEPA Lastschrift REWE Markt GmbH Kartenzahlung VISA ${i},99 EUR`).join('\n'),
  'table of contents': 'Invoice Summary Customer Account Balance Payment History Contact Details Shipping Address Billing Information Order Number Tax Total',
  'German term list': 'Kläger Beklagter Streitwert Aktenzeichen Landgericht München Kammer Termin Verhandlung Beweisaufnahme Zeugen Sachverständiger Gutachten Urteil Berufung',
  'surname list': 'Müller Schmidt Schneider Fischer Weber Meyer Wagner Becker Schulz Hoffmann Schäfer Koch Bauer Richter Klein Wolf Schröder Neumann Schwarz Zimmermann',
  'invoice lines': 'Pos Art.-Nr. Bezeichnung Menge Einzelpreis Gesamt 1 XK-4471-B Schraube M8x40 verzinkt 200 0,12 24,00 2 ZB-993 Dübel Fischer SX 8 100 0,09 9,00 3 HKZ-12 Winkel 90° 40 1,10 44,00 Zwischensumme Versand MwSt 19% Gesamtbetrag',
  'bank footer codes': 'IBAN DE89 3704 0044 0532 0130 00 BIC COBADEFFXXX USt-IdNr DE123456789 HRB 12345 Amtsgericht Köln GmbH KG AG',
  'URLs and addresses': 'https://www.example.com/de/kundenportal?ref=xyz123 support@example.com www.bundesanzeiger.de kontakt@kanzlei-mueller.de https://login.microsoftonline.com/common/oauth2',
  '§-dense statute index': '§ 1 Anwendungsbereich § 2 Begriffe § 3 Pflichten § 4 Haftung § 5 Kündigung § 6 Schlussbestimmungen',
  'currency-heavy line': '£ 1,200.00 ¥ 34,000 € 990.10 £ 15.00 ¥ 1,000 § 4 total £ 2,205.10 paid',
  'terse heading': 'Anlage K 12 – Schreiben der Beklagten vom 3. März 2026',
  'statement with distinct hex payment refs': Array.from({ length: 30 }, (_, i) =>
    `2026-03-${String(i + 1).padStart(2, '0')} GBP 123.45 Payment Ref ${(0x5feceb66 + i * 7919).toString(16)}ffc86f38d952786c6d696c79`).join('\n'),
  'transfers with IBANs and invoice refs': Array.from({ length: 30 }, (_, i) =>
    `2026-03-${i + 1} Überweisung an DE${89370400440532013000n + BigInt(i)} Verwendungszweck RG-${4711 + i}/2026 Kunde K${i}X${i}`).join('\n'),
};

describe('assessPage', () => {
  it.each(Object.entries(PROSE))('%s prose is good', (_l, t) => expect(assessPage(t)).toBe('good'));
  it.each(Object.entries(NOT_PROSE_BUT_GOOD))('%s is good', (_l, t) => expect(assessPage(t)).toBe('good'));
  it.each(['en', 'de', 'fr', 'it', 'es'] as const)('%s prose under every Caesar shift is garbled', (l) => {
    for (let k = 1; k < 26; k++) expect([k, assessPage(shift(PROSE[l], k))]).toEqual([k, 'garbled']);
  });
  it('the classic -29 ToUnicode offset ("7KH") is garbled', () =>
    expect(assessPage('7KH WHQDQW VKDOO SD\\ WKH UHQW RQ WKH ILUVW GD\\ RI HDFK PRQWK DQG WKH ODQGORUG VKDOO PDLQWDLQ WKH SURSHUW\\ LQ JRRG UHSDLU')).toBe('garbled'));
  it('PUA-heavy text is garbled', () =>
    expect(assessPage('\uE001\uE002\uE003 \uE004\uE005\uE006 \uE007\uE008\uE009 \uE00A\uE00B\uE00C \uE00D\uE00E\uE00F \uE010\uE011')).toBe('garbled'));
  it('Latin-1 symbol soup is garbled', () => expect(assessPage('Í¶ÈÆ¸ ´¨¯ ¤¦¬ Í¶ÈÆ¸ ´¨¯ ¤¦¬ Í¶ÈÆ¸')).toBe('garbled'));
  it('U+FFFD runs are garbled', () => expect(assessPage('Vertrag \uFFFD\uFFFD\uFFFD\uFFFD zwischen \uFFFD\uFFFD\uFFFD und')).toBe('garbled'));
  it('empty and near-empty pages are sparse', () => {
    expect(assessPage('')).toBe('sparse');
    expect(assessPage('  Page 3  ')).toBe('sparse');
  });
});
```

- [ ] **Step 2: Run, and confirm it fails.** `npx jest src/main/core/engine/__tests__/text-quality.test.ts`

- [ ] **Step 3: Implement**

```ts
/** Per-page text-layer quality (garbled-PDF spec §1). Pure; thresholds are
 *  constants tuned on the fixtures. `garbled` needs POSITIVE corruption
 *  evidence — low letter density alone never qualifies (numeric pages). */
export type PageQuality = 'good' | 'sparse' | 'garbled';
export const QUALITY_VERSION = 1;

const SPARSE_BELOW = 16;     // non-whitespace chars
const BAD_RATIO = 0.05;      // signal (a)
const MIN_PAIRS = 40;        // signal (b) needs this much evidence
const COMMON_PAIR_RATIO = 0.68;
// (a) U+FFFD, Private Use Area, C0/C1 controls except \t \n \r, rare Latin-1 marks.
const BAD_CHAR = /[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F¤¦¨¯´¸¶¬]/gu;
// (b) Letter pairs common inside words of en/de/fr/it/es/nl plus the most
// frequent Polish/Czech ones (accents folded, ß → ss). Real text — prose,
// statements, term lists, codes — scores ≥ 0.71 over its DISTINCT words; a
// font-offset (Caesar) shift of any of those languages scores ≤ 0.62.
const COMMON_PAIRS = new Set((
  'ab ac ad af ag ah ai ak al am an ap ar as at au av aw ay ba be bi bl bo br bu by ca cc ce ch ci ck cl co cr ct cu ' +
  'da de di do dr ds du ea ec ed ee ef eg eh ei el em en eo ep er es et eu ev ew ex ey fa fe ff fi fl fo fr ft fu ' +
  'ga ge gg gh gi gl gn go gr gt gu ha he hi hl hm hn ho hr hs ht hu ia ib ic id ie if ig ih il im in io ip ir is it iv iz ' +
  'ka ke ki kl ko ks la ld le li ll lo ls lt lu ly lz ma me mi mm mo mp ms mu my na nc nd ne nf ng ni nk nl nn no ns nt nu ny nz ' +
  'ob oc od oe of og oh oi ok ol om on oo op or os ot ou ov ow pa pe ph pi pl po pp pr pt pu qu ' +
  'ra rb rc rd re rf rg ri rk rl rm rn ro rr rs rt ru rv ry rz sa sc se sh si sm so sp ss st su sy ' +
  'ta te th ti tl to tr ts tt tu tw ty tz ua ub uc ud ue ug uh ui ul um un up ur us ut uz va ve vi vo ' +
  'wa we wh wi wn wo wu ye yo za ze zi zu cz sz dz wy kt zy yc ej aj je ja sk'
).split(' '));

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').toLowerCase();

export function assessPage(text: string): PageQuality {
  const compact = text.replace(/\s+/g, '');
  const n = compact.length;
  if (n < SPARSE_BELOW) return 'sparse';
  const bad = compact.match(BAD_CHAR)?.length ?? 0;
  if (bad / n > BAD_RATIO) return 'garbled';
  // Distinct words, so 30 rows of "CHF" or "SEPA Lastschrift" count once.
  // Tokens holding a digit (payment refs, hashes, IBANs, SKUs) are identifiers,
  // not language: drop them BEFORE splitting into letter runs.
  const words = new Set(text.split(/\s+/).filter((t) => !/\d/.test(t))
    .flatMap((t) => fold(t).split(/[^a-z]+/)).filter((w) => w.length >= 2));
  let pairs = 0;
  let common = 0;
  for (const w of words) {
    for (let i = 0; i < w.length - 1; i++) {
      pairs++;
      if (COMMON_PAIRS.has(w.slice(i, i + 2))) common++;
    }
  }
  if (pairs >= MIN_PAIRS && common / pairs < COMMON_PAIR_RATIO) return 'garbled';
  return 'good';
}
```

Non-Latin scripts (Cyrillic, Greek, CJK) fold to no `a-z` words, so signal (b) never fires on them. Only (a) applies there.

The 0.71 floor holds for real *language*: prose, statements, lists, and codes mixed with words. It is not universal. A long page of pure digit-free non-words (a base64 blob, a long acronym table) can score lower and gets one OCR pass, with its text kept. The spec accepts that cost.

Tune only the constants, and only if a fixture fails. Never add a signal that fires on low letter density alone. The measured margin is narrow but clean: real text scores ≥ 0.71 (the bank footer codes), and shifts score ≤ 0.62. If you add a common pair, re-run the all-shifts test. Every pair you add raises the shifted scores too.

- [ ] **Step 4: Run, and confirm it passes. Then commit**

```bash
git add src/main/core/engine/text-quality.ts src/main/core/engine/__tests__/text-quality.test.ts
git commit -m "feat(convert): per-page text-layer quality assessment"
```

---

### Task 2: Per-page PDF parse and `needs-ocr` on both conversion paths

**Files:**
- Modify: `src/main/core/engine/convert.ts` (`parsePdfPages`, `parseDetailed`, `parse`, `createConverter`)
- Create: `src/main/core/engine/__tests__/pdf-fixture.ts` (multi-page PDF builder; a helper, not a test)
- Test: `src/main/core/engine/__tests__/convert-pdf.test.ts`

**Interfaces:**
- Produces:
  - `parsePdfPages(bytes): Promise<string[]>` (index 0 = page 1)
  - `parseDetailed(bytes, mime, filename?): Promise<{ markdown: string | null; ocrPages?: number[] }>`
  - `parse()` returns `(await parseDetailed(...)).markdown` (unchanged contract for other callers)
  - `needsOcrMarker(pages: number[])` → `{ status: 'needs-ocr', pages, quality: 1 }`

- [ ] **Step 1: Fixture builder**

`pdf-fixture.ts` generalizes `tinyPdf` to N pages. A page is either text lines in Helvetica or an image-only "scan": an inline 2×2 gray image, with no text operators.

```ts
export type FixturePage = { text?: string[] } | { scan: true } | { blank: true };
export function multiPagePdf(pages: FixturePage[]): Uint8Array {
  const objs: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids: string[] = [];
  for (const p of pages) {
    const stream = 'text' in p && p.text
      ? `BT /F1 11 Tf 72 740 Td 14 TL ${p.text.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) '`).join(' ')} ET`
      : 'scan' in p ? 'q 400 0 0 500 100 150 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x80\x40\x40\x80 EI Q' : '';
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const contents = objs.length;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => { const at = out.length; out += `${i + 1} 0 obj\n${body}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
export const PROSE_LINES = [
  'The tenant shall pay the rent on the first day of each month and the',
  'landlord shall maintain the property in good repair at all times.',
];
export const shifted = (lines: string[], k = 7) => lines.map((l) => l.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + k) % 26) + 97)));
```

The large-file plan's rasterize test (Task 6) builds its own 3-page PDF. Optionally switch it to `multiPagePdf` afterwards; don't block on that.

- [ ] **Step 2: Failing tests (`convert-pdf.test.ts`)**

```ts
import { multiPagePdf, PROSE_LINES, shifted } from './pdf-fixture';
import { parseDetailed } from '../convert';

const conv = (bytes: Uint8Array) => createConverter({ log: jest.fn() })({
  externalId: 'x.pdf', type: 'file', title: 'x.pdf', markdown: null,
  binary: { bytes, mime: 'application/pdf', filename: 'x.pdf' }, metadata: { mime: 'application/pdf' },
} as never);

it('a clean 3-page PDF has no marker', async () => {
  const out = await conv(multiPagePdf([{ text: PROSE_LINES }, { text: PROSE_LINES }, { text: PROSE_LINES }]));
  expect(out.markdown).toContain('tenant shall pay');
  expect((out.metadata as any).conversion).toBeUndefined();
});
it('a blank last page → needs-ocr [3], text intact', async () => {
  const out = await conv(multiPagePdf([{ text: PROSE_LINES }, { text: PROSE_LINES }, { blank: true }]));
  expect((out.metadata as any).conversion).toEqual({ status: 'needs-ocr', pages: [3], quality: 1 });
  expect(out.markdown).toContain('tenant shall pay');
});
it('a 4-page mixed PDF with pages 2–3 scanned → needs-ocr [2,3]', async () => {
  const out = await conv(multiPagePdf([{ text: PROSE_LINES }, { scan: true }, { scan: true }, { text: PROSE_LINES }]));
  expect((out.metadata as any).conversion).toEqual({ status: 'needs-ocr', pages: [2, 3], quality: 1 });
});
it('a text cover + scanned exhibit → needs-ocr [2]', async () => {
  const out = await conv(multiPagePdf([{ text: PROSE_LINES }, { scan: true }]));
  expect((out.metadata as any).conversion.pages).toEqual([2]);
});
it('a shifted-glyph text layer → needs-ocr on every page, suspect text KEPT', async () => {
  const out = await conv(multiPagePdf([{ text: shifted(PROSE_LINES) }, { text: shifted(PROSE_LINES) }]));
  expect((out.metadata as any).conversion.pages).toEqual([1, 2]);
  expect(out.markdown).toContain(shifted(PROSE_LINES)[0].slice(0, 20));
});
it('a page of numbers stays good', async () => {
  const nums = Array.from({ length: 20 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}  1.234,56 EUR  -${i},00`);
  const out = await conv(multiPagePdf([{ text: nums }, { text: PROSE_LINES }]));
  expect((out.metadata as any).conversion).toBeUndefined();
});
it('a whole document under 16 chars stays text-poor (null), as today', async () => {
  const r = await parseDetailed(multiPagePdf([{ text: ['Page 1 of 3'] }, { scan: true }]), 'application/pdf', 'x.pdf');
  expect(r.markdown).toBeNull();
  expect(r.ocrPages).toBeUndefined();
});
it('the marker is deterministic: converting the same bytes twice gives identical metadata', async () => {
  const b = multiPagePdf([{ text: PROSE_LINES }, { scan: true }]);
  expect(JSON.stringify((await conv(b)).metadata)).toBe(JSON.stringify((await conv(b)).metadata));
});
```

The existing "markdown-null for OCR" test (`tinyPdf('Page 1 of 3')`) must keep passing unchanged.

- [ ] **Step 3: Run, and confirm they fail.** `npx jest src/main/core/engine/__tests__/convert-pdf.test.ts`

- [ ] **Step 4: Implement**

```ts
import { assessPage, QUALITY_VERSION } from './text-quality';

/** pdf-parse's default page renderer, kept verbatim (line joining by y),
 *  but recording each page's text by its index. A page pdf.js fails on is
 *  caught inside pdf-parse and never reaches the hook → stays ''. */
export async function parsePdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdfParse = (await import('pdf-parse')).default;
  const pages: string[] = [];
  const out = await pdfParse(new Uint8Array(bytes) as Buffer, {
    pagerender: async (pageData: { pageIndex: number; getTextContent: (o: object) => Promise<{ items: Array<{ str: string; transform: number[] }> }> }) => {
      const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      let lastY: number | undefined; let text = '';
      for (const item of tc.items) {
        text += lastY === item.transform[5] || lastY === undefined ? item.str : `\n${item.str}`;
        lastY = item.transform[5];
      }
      pages[pageData.pageIndex] = text;
      return text;
    },
  });
  return Array.from({ length: out.numpages }, (_, i) => pages[i] ?? '');
}

export function needsOcrMarker(pages: number[]) {
  return { status: 'needs-ocr' as const, pages, quality: QUALITY_VERSION };
}

export async function parseDetailed(bytes: Uint8Array, mime: string, filename?: string)
  : Promise<{ markdown: string | null; ocrPages?: number[] }> {
  if (convertibleKind(mime, filename) !== 'pdf') return { markdown: await parseOther(bytes, mime, filename) };
  const pages = await parsePdfPages(bytes);
  const text = pages.join('\n\n').trim();
  // Whole doc under the has-text bar: today's text-poor path (whole-doc OCR + VLM).
  if (text.replace(/\s+/g, '').length < HAS_TEXT_CHARS) return { markdown: null };
  const ocrPages = pages.flatMap((t, i) => (assessPage(t) === 'good' ? [] : [i + 1]));
  return { markdown: text, ...(ocrPages.length ? { ocrPages } : {}) };
}

export async function parse(bytes: Uint8Array, mime: string, filename?: string): Promise<string | null> {
  return (await parseDetailed(bytes, mime, filename)).markdown;
}
```

`parseOther` is today's `parse` body minus the `pdf` case. Rename it, and keep it module-private. Update the old PDF comment ("a short real PDF must keep its text…") into `parseDetailed`.

`createConverter`, the commit path:

```ts
const { markdown: md, ocrPages } = await parseDetailed(bytes, mime, filename);
if (md !== null) {
  const base = { ...stripBinary(input), markdown: capMarkdown(md).markdown };
  // Deterministic, no timestamp: contentHash covers metadata (garbled spec §3).
  return ocrPages
    ? { ...base, metadata: { ...input.metadata, conversion: needsOcrMarker(ocrPages) } }
    : base;
}
```

- [ ] **Step 5: Run, and confirm they pass**

Run: `npx jest src/main/core/engine`
Expected: PASS, including `convert-email.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/engine
git commit -m "feat(convert): per-page PDF parse; deterministic needs-ocr marker on the commit path"
```

---

### Task 3: Convert worker writes the marker; vision classifies `needs-ocr`; hash stability

**Files:**
- Modify: `src/main/workers/convert/convert-worker.ts`, `src/main/workers/convert/outcome.ts`
- Modify: `src/main/workers/vision/classify.ts`, `src/main/core/store/schema.ts` (`PENDING_VISUAL_WHERE`)
- Test: `src/main/workers/convert/__tests__/convert-worker.test.ts`, `src/main/workers/vision/__tests__/classify.test.ts`, `src/main/core/store/__tests__/store.test.ts`

**Interfaces:**
- Produces:
  - `ConversionStatus` gains `'needs-ocr'`
  - `ConversionOutcome` gains `pages?: number[]` and `quality?: 1`
  - `classifyDocument` treats `conversion.status === 'needs-ocr'` with no `extraction` as a candidate, even with markdown

- [ ] **Step 1: Failing tests**

`convert-worker.test.ts`. `multiPagePdf` and `PROSE_LINES` are imported from `src/main/core/engine/__tests__/pdf-fixture`; `pdfDoc` comes from the large-file plan's Task 5 tests.

```ts
it('a mixed PDF records needs-ocr with pages, quality and NO timestamp, keeping all text', async () => {
  const s = fakeSession(async () => multiPagePdf([{ text: PROSE_LINES }, { scan: true }]));
  await createConvertWorker().work(change(pdfDoc(5000)), s);
  expect(s.enriched[0].metadata.conversion).toEqual({ status: 'needs-ocr', pages: [2], quality: 1 });
  expect(s.enriched[0].markdown).toContain('tenant shall pay');
});
it('a clean PDF records ok with quality 1', async () => {
  const s = fakeSession(async () => multiPagePdf([{ text: PROSE_LINES }]));
  await createConvertWorker().work(change(pdfDoc(5000)), s);
  expect(s.enriched[0].metadata.conversion).toMatchObject({ status: 'ok', quality: 1 });
});
```

`classify.test.ts`:

```ts
it('needs-ocr with markdown and no extraction is a candidate', () => {
  expect(classifyDocument(pdfDoc({ markdown: 'x'.repeat(500), metadata: { mime: 'application/pdf',
    conversion: { status: 'needs-ocr', pages: [2], quality: 1 } } }))).toBe('candidate');
});
it('needs-ocr with extraction is done', () => {
  expect(classifyDocument(pdfDoc({ markdown: 'x', metadata: { mime: 'application/pdf',
    conversion: { status: 'needs-ocr', pages: [2], quality: 1 }, extraction: { engine: 'local-ocr', at: 'x' } } }))).toBe('skip');
});
```

`store.test.ts`, covering the SQL mirror and hash stability:

```ts
it('PENDING_VISUAL_WHERE counts a needs-ocr doc with text', async () => { /* commit one file doc with markdown 'x'.repeat(500)
   and metadata.conversion = needs-ocr; assert the pending-visual count query (the one that uses PENDING_VISUAL_WHERE) returns 1 */ });
it('re-committing an unchanged needs-ocr file keeps contentHash, extraction and ocrProgress', async () => {
  const a = await store.createAccount({ source: 't', identifier: 'h' });
  const input = { externalId: 'p', type: 'file', title: 'p.pdf', markdown: 'text layer', url: 'u',
    metadata: { mime: 'application/pdf', conversion: { status: 'needs-ocr', pages: [2], quality: 1 } } };
  await store.commit({ account: a.id, documents: [input as never], cursor: 1 });
  const d1 = (await store.read.byExternalId(a.id, 'p', 'file'))!;
  await store.commit({ consumer: 'worker:vision:v1', cursor: 0,
    enrich: [{ documentId: d1.id, markdown: 'ocr merged', metadata: { ocrProgress: { pageCount: 2, pages: { 2: 'o' } } } }] });
  await store.commit({ account: a.id, documents: [input as never], cursor: 2 });
  const d2 = (await store.read.byExternalId(a.id, 'p', 'file'))!;
  expect(d2.contentHash).toBe(d1.contentHash);
  expect(d2.markdown).toBe('ocr merged');
  expect((d2.metadata as any).ocrProgress).toBeDefined();
});
```

For the first store test, use the exact count helper that reads `PENDING_VISUAL_WHERE` (grep it in `store.ts`), and follow the existing pending-visual tests in that file.

- [ ] **Step 2: Run, and confirm they fail.** `npx jest src/main/workers/convert src/main/workers/vision/__tests__/classify.test.ts src/main/core/store`

- [ ] **Step 3: Implement**

`outcome.ts`: add `'needs-ocr'` to `ConversionStatus`. `ConversionOutcome` becomes `{ status; at?: string; error?; truncated?; pages?: number[]; quality?: 1 }`. `at` is optional because only `needs-ocr` omits it.

In `convert-worker.ts` `work()`, replace the large-file plan's `parse` call with `parseDetailed` (keep the `deps.parse` seam, now typed as `parseDetailed`):

```ts
let res: { markdown: string | null; ocrPages?: number[] };
try { res = await parse(bytes, str(meta.mime) ?? '', name); }
catch (err) { … unchanged → record('failed') }
if (res.markdown === null || res.markdown.trim().length === 0) return record('text-poor');
const capped = capMarkdown(res.markdown);
if (res.ocrPages) {
  session.enrich({ documentId: doc.id, markdown: capped.markdown, metadata: { conversion: needsOcrMarker(res.ocrPages) } });
  return 'done';
}
return record('ok', { markdown: capped.markdown, ...(capped.truncated ? { truncated: true as const } : {}),
  ...(kind === 'pdf' ? { quality: 1 as const } : {}) });
```

`record`'s `extra` gains `quality?: 1`, written into `conversion`.

`classify.ts`, right after the large-file plan's `ocrProgress` bypass:

```ts
  const conv = meta.conversion as { status?: string } | undefined;
  if (conv?.status === 'needs-ocr') return 'candidate';
```

`schema.ts` `PENDING_VISUAL_WHERE`: extend the large-file plan's top-level OR:

```sql
AND (json_extract(metadata,'$.ocrProgress') IS NOT NULL
     OR json_extract(metadata,'$.conversion.status') = 'needs-ocr'
     OR ((markdown IS NULL OR …existing…)))
```

`QUERY_INDEXES` rebuilds the partial index when its SQL text changes. No migration entry is needed; confirm with the store's existing index-rebuild test.

- [ ] **Step 4: Run, and confirm they pass.** `npx jest src/main/workers src/main/core/store`

- [ ] **Step 5: Commit**

```bash
git add src/main/workers/convert src/main/workers/vision/classify.ts src/main/core/store
git commit -m "feat: needs-ocr marker from the convert worker; vision + pending SQL pick it up"
```

---

### Task 4: Vision worker OCRs only the listed pages

**Files:**
- Modify: `src/main/workers/vision/vision-worker.ts`
- Test: `src/main/workers/vision/__tests__/vision-worker.test.ts`, `src/main/core/engine/__tests__/engine.test.ts` (one integration case)

**Interfaces:**
- Consumes: the large-file plan's windowed loop: `done`, `next`, `remaining`, the single-entry `cache`, `complete(engine, pages, extra)`, `pagedRasterizer`.
- Produces: `cache` entries also hold `layer?: string[]` (the per-page text-layer text, parsed once per doc). `complete` is unchanged; the listed path writes its own completion.

- [ ] **Step 1: Failing tests**

```ts
const needsOcr = (pages: number[], extra: Record<string, unknown> = {}) => change({ markdown: 'layer text',
  metadata: { ...baseDoc.metadata, mime: 'application/pdf', conversion: { status: 'needs-ocr', pages, quality: 1 }, ...extra } });

it('OCRs only the listed pages and merges them with the text layer in page order, no VLM', async () => {
  const { r, calls } = pagedRasterizer(4);
  const see = jest.fn();
  const fetchBytes = async () => multiPagePdf([{ text: ['one one one one one one'] }, { scan: true }, { scan: true }, { text: ['four four four four four'] }]);
  const s = fakeSession({ read: async (png: Uint8Array) => `ocr page ${png[0]} text`, see, fetchBytes });
  expect(await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(needsOcr([2, 3]), s)).toBe('done');
  expect(calls).toEqual([[2, 3]]);
  expect(see).not.toHaveBeenCalled();
  const md = s.enriched[0].markdown as string;
  expect(md.indexOf('one one')).toBeLessThan(md.indexOf('ocr page 2'));
  expect(md.indexOf('ocr page 3')).toBeLessThan(md.indexOf('four four'));
  expect(s.enriched[0].metadata.extraction.engine).toBe('local-ocr');
});
it('empty OCR for a page keeps that page\'s text-layer text', async () => {
  const { r } = pagedRasterizer(2);
  const fetchBytes = async () => multiPagePdf([{ text: PROSE_LINES }, { text: shifted(PROSE_LINES) }]);
  const s = fakeSession({ read: async () => '', fetchBytes });
  await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(needsOcr([2]), s);
  expect(s.enriched[0].markdown).toContain(shifted(PROSE_LINES)[0].slice(0, 20));
});
it('no read provider → defer, text untouched', async () => {
  const { r } = pagedRasterizer(2);
  const s = fakeSession({ read: async () => { throw new NoProviderError('read'); }, fetchBytes: async () => multiPagePdf([{ text: PROSE_LINES }, { scan: true }]) });
  expect(await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(needsOcr([2]), s)).toBe('defer');
  expect(s.enriched).toEqual([]);
});
it('60 pages, bad pages 3/17/41/58: resumes from ocrProgress after a restart and renders every page in order', async () => {
  const pages = Array.from({ length: 60 }, (_, i) => ([3, 17, 41, 58].includes(i + 1) ? { scan: true } : { text: [`body of page ${i + 1} here`] })) as never;
  const bytes = multiPagePdf(pages);
  const { r, calls } = pagedRasterizer(60);
  const prior = { pageCount: 60, pages: { 3: 'ocr3', 17: 'ocr17' } };
  // fresh worker = "process restarted": empty cache
  const s = fakeSession({ read: async (png: Uint8Array) => `ocr${png[0]}`, fetchBytes: async () => bytes });
  await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(needsOcr([3, 17, 41, 58], { ocrProgress: prior }), s);
  expect(calls).toEqual([[41, 58]]);
  const md = s.enriched[0].markdown as string;
  expect(md.indexOf('body of page 2 ')).toBeLessThan(md.indexOf('ocr3'));
  expect(md.indexOf('ocr58')).toBeLessThan(md.indexOf('body of page 59 '));
});
it('MAX_OCR_PAGES caps the number of listed pages and records pagesSkipped', async () => {
  const listed = Array.from({ length: 250 }, (_, i) => i + 1);
  const done = Object.fromEntries(listed.slice(0, 200).map((n) => [String(n), `o${n}`]));
  const { r, calls } = pagedRasterizer(250);
  const s = fakeSession({ read: async () => 'x', fetchBytes: async () => multiPagePdf(Array.from({ length: 250 }, () => ({ scan: true })) as never) });
  await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(needsOcr(listed, { ocrProgress: { pageCount: 250, pages: done } }), s);
  expect(calls).toEqual([]);                       // nothing left within the cap
  expect(s.enriched[0].metadata.extraction.pagesSkipped).toBe(50);
});
```

**Bounded cost and no livelock:**

```ts
it('no read provider: later needs-ocr docs defer WITHOUT fetching until the retry window passes', async () => {
  const { r } = pagedRasterizer(2);
  const fetchBytes = jest.fn(async () => multiPagePdf([{ text: PROSE_LINES }, { scan: true }]));
  const s = fakeSession({ read: async () => { throw new NoProviderError('read'); }, fetchBytes });
  const w = createVisionWorker({ rasterizer: r, laneOpen: () => true });
  expect(await w.work(needsOcr([2]), s)).toBe('defer');
  expect(await w.work(needsOcr([2], { filename: 'other.pdf' }), s)).toBe('defer');
  expect(fetchBytes).toHaveBeenCalledTimes(1);
});
it('a listed page the rasterizer skips does not loop: the doc completes with its text-layer text', async () => {
  const skipping = { pdfToPngs: jest.fn(async (_b: Uint8Array, o: { pages: number[] }) =>
    ({ pageCount: 3, pages: o.pages.filter((n) => n !== 2).map((n) => ({ page: n, png: new Uint8Array([n]) })) })) };
  const s = fakeSession({ read: async () => 'ocr', fetchBytes: async () => multiPagePdf([{ text: PROSE_LINES }, { text: shifted(PROSE_LINES) }, { scan: true }]) });
  expect(await createVisionWorker({ rasterizer: skipping as never, laneOpen: () => true }).work(needsOcr([2, 3]), s)).toBe('done');
  expect(s.enriched[0].metadata.extraction.engine).toBe('local-ocr');
  expect(s.enriched[0].markdown).toContain(shifted(PROSE_LINES)[0].slice(0, 20));
});
```

**Long text layers survive** (the `mergeExtraction` cap would cut at 1,000,000 chars):

```ts
it('keeps text-layer text beyond 1M chars when rendering needs-ocr pages', async () => {
  const big = Array.from({ length: 1700 }, () => 'Vertragstext der Parteien Absatz eins zwei drei vier fuenf sechs'); // ~110 KB per page
  const pages = Array.from({ length: 12 }, (_, i) => (i === 11 ? { scan: true as const } : { text: [...big, `ENDE${i + 1}`] }));
  const { r } = pagedRasterizer(12);
  const s = fakeSession({ read: async () => 'ocr12', fetchBytes: async () => multiPagePdf(pages) as never });
  await createVisionWorker({ rasterizer: r, laneOpen: () => true }).work(needsOcr([12]), s);
  const md = s.enriched.at(-1)!.markdown as string;
  expect(md.length).toBeGreaterThan(1_000_000);
  expect(md).toContain('ENDE11');
  expect(md).toContain('ocr12');
});
```

`pagedRasterizer` returns `png[0] = page number`, so `ocr${png[0]}` identifies the page. A 250-page `multiPagePdf` is about 60 KB; that is fine.

**Engine integration** (in `engine.test.ts`, same setup as the large-file plan's windowed-OCR case):
- Get one file doc through the **real commit path**. `store.commit` bypasses `deps.convert`; conversion runs only inside `src.pull` (`engine.ts` ~1074). So use a source fake whose pull yields the doc with the binary `multiPagePdf([{ text: PROSE_LINES }, { scan: true }])`, and keep the engine's `createConverter`.
- Attach `createVisionWorker` with a fake rasterizer and `read`.
- After about 2 s, the stored doc has `extraction.engine === 'local-ocr'` and markdown containing both the prose and the page-2 OCR text.

- [ ] **Step 2: Run, and confirm they fail.** `npx jest src/main/workers/vision`

- [ ] **Step 3: Implement: one windowed loop, two candidate lists**

Don't add a second loop. Generalize the large-file plan's loop so `next` and `remaining` come from one candidate list:

```ts
// Worker-local: one probe per cadence across ALL needs-ocr docs while no
// read provider exists (a Linux host, or Windows before OCR ships). Without
// it every needs-ocr doc re-downloads, parses and rasterizes every 30 min.
let readUnavailableUntil = 0;
const READ_RETRY_MS = 25 * 60_000;
```

In `work()`, **before** `fetchBytes`:

```ts
const conv = meta.conversion as { status?: string; pages?: number[] } | undefined;
const listed = conv?.status === 'needs-ocr'
  ? [...new Set(conv.pages ?? [])].sort((a, b) => a - b).slice(0, MAX_OCR_PAGES) : null;
if (listed && Date.now() < readUnavailableUntil) return 'defer';
```

Then, in the large-file loop:
- **Candidates:** `const candidates = listed ?? Array.from({ length: limit }, (_, i) => i + 1);` (`limit` ≤ `MAX_OCR_PAGES`, as there).
- **Window:** `next = candidates.filter((n) => !(String(n) in done)).slice(0, OCR_WINDOW)`.
- **Raster:** `const raster = next.length ? await deps.rasterizer.pdfToPngs(bytes, { pages: next }) : null;`. Use `pageCount = raster?.pageCount ?? prog?.pageCount ?? 0` (only the `listed` path can reach `raster === null`).
- **Read errors.** On `NoProviderError`:
  - when `listed`: `readUnavailableUntil = Date.now() + READ_RETRY_MS; cache = null; return 'defer';`. There is no VLM and the text is kept.
  - when not `listed`: the existing fill-and-fall-through.

  Any other read error → `'defer'`, as today.
- **No livelock:** when `listed`, after the read loop, run `for (const n of next) done[String(n)] ??= '';`. Listed pages come from pdf.js, but `done` keys come from pdfium. A page pdfium skips or can't render would otherwise stay "remaining" forever, and every progress enrich would re-feed the doc.
- **Remaining:** `candidates.some((n) => !(String(n) in done))` for `listed`. The default path keeps its `cap`-based check.
- **Text layer:** parse it lazily, only when rendering, so a deferred doc never pays for it:

  ```ts
  let layer: string[];
  try { layer = cache.layer ??= await parsePdfPages(bytes); } catch { cache = null; return 'defer'; }
  if (layer.length === 0) { cache = null; return 'defer'; }   // never render from nothing
  const texts = layer.map((t, i) => { const o = done[String(i + 1)]; return o && o.trim() ? o : t; });
  ```

- **Render** with `renderListedPages(texts)`, a small helper next to `work()`:

  ```ts
  /** needs-ocr rendering: every page in order, text-layer or OCR. Not
   *  mergeExtraction: its 1M-char cap and "Text content (OCR)" labels are for
   *  VLM output; a long text-layer PDF keeps up to MAX_MARKDOWN_CHARS. */
  function renderListedPages(texts: string[]): string {
    const body = texts.length > 1
      ? texts.map((t, i) => `--- page ${i + 1} ---\n\n${t.trim()}`).join('\n\n')
      : (texts[0] ?? '').trim();
    return capMarkdown(body).markdown;
  }
  ```

  Import `capMarkdown` from `@main/core/engine/convert` (large-file plan Task 5). The progress enrich uses this rendering too when `listed`.
- **Completion (listed)** writes the enrich directly. There is **never** a sufficiency check or VLM pass:

  ```ts
  cache = null;
  const skipped = Math.max(0, new Set(conv!.pages ?? []).size - MAX_OCR_PAGES);
  session.enrich({ documentId: doc.id, markdown: renderListedPages(texts), metadata: {
    ocrProgress: undefined,
    extraction: { engine: 'local-ocr', at: new Date().toISOString(), ...(skipped ? { pagesSkipped: skipped } : {}) } } });
  return 'done';
  ```

The default (non-`listed`) path and its `complete` are unchanged.

- [ ] **Step 4: Run, and confirm they pass.** `npx jest src/main/workers src/main/core`

- [ ] **Step 5: Commit**

```bash
git add src/main/workers/vision src/main/core/engine/__tests__/engine.test.ts
git commit -m "feat(vision): OCR only needs-ocr pages; merge with the text layer, no VLM"
```

---

### Task 5: Re-assess the existing corpus (§5) through the convert v2 replay

**Files:**
- Modify: `src/main/workers/convert/convert-worker.ts` (`isConvertCandidate`, `work`)
- Test: `src/main/workers/convert/__tests__/convert-worker.test.ts`, `src/main/core/engine/__tests__/engine.test.ts`

- [ ] **Step 1: Failing tests**

```ts
const garbledText = shifted([...PROSE_LINES, ...PROSE_LINES]).join('\n');
const oldPdf = (markdown: string, conversion?: object) => doc({ title: 'old.pdf', markdown,
  metadata: { mime: 'application/pdf', filename: 'old.pdf', sizeBytes: 5000, ...(conversion ? { conversion } : {}) } });

it('admits an old garbled PDF row (no marker, or ok without quality)', () => {
  expect(isConvertCandidate(oldPdf(garbledText))).toBe(true);
  expect(isConvertCandidate(oldPdf(garbledText, { status: 'ok', at: 'x' }))).toBe(true);
});
it('does not admit a clean old row, or anything carrying quality', () => {
  expect(isConvertCandidate(oldPdf(PROSE_LINES.join('\n')))).toBe(false);
  expect(isConvertCandidate(oldPdf(garbledText, { status: 'ok', at: 'x', quality: 1 }))).toBe(false);
  expect(isConvertCandidate(oldPdf(garbledText, { status: 'needs-ocr', pages: [1], quality: 1 }))).toBe(false);
});
it('re-assessment records needs-ocr with quality and leaves the markdown as is', async () => {
  const s = fakeSession(async () => multiPagePdf([{ text: shifted(PROSE_LINES) }, { text: PROSE_LINES }]));
  await createConvertWorker().work(change(oldPdf(garbledText)), s);
  expect(s.enriched[0]).toEqual({ documentId: 'd', metadata: { conversion: { status: 'needs-ocr', pages: [1], quality: 1 } } });
});
it('re-assessment of a clean re-parse records ok + quality, markdown untouched', async () => {
  const s = fakeSession(async () => multiPagePdf([{ text: PROSE_LINES }]));
  await createConvertWorker().work(change(oldPdf(garbledText)), s);
  expect(s.enriched[0].markdown).toBeUndefined();
  expect(s.enriched[0].metadata.conversion).toMatchObject({ status: 'ok', quality: 1 });
});
```

**Engine (the v2 replay end to end).** In `engine.test.ts`:
- Commit an old-style PDF row: markdown = `garbledText`, `conversion: { status: 'ok', at: 'x' }`.
- Attach the v2 convert worker (cursor 0, replay), with a source fake serving `multiPagePdf([{ text: shifted(PROSE_LINES) }])`.
- After about 1 s, the row has `needs-ocr` and its markdown is unchanged.
- A second, clean row is never passed to `fetchBytes`. Count the calls.

- [ ] **Step 2: Run, and confirm they fail.** `npx jest src/main/workers/convert`

- [ ] **Step 3: Implement**

In `isConvertCandidate`, after the large-file plan's `too-large` re-admission and **last**, behind every cheaper predicate:

```ts
/** Garbled-spec §5: an old PDF whose stored text is itself garbled gets one
 *  per-page re-assessment. `quality` marks "assessed by this algorithm" —
 *  never re-admitted. O(n) on the markdown, so it runs after the cheap checks. */
function needsReassessment(doc: Document, kind: ConvertibleKind, conv: { status?: unknown; quality?: unknown } | undefined): boolean {
  if (kind !== 'pdf' || conv?.quality != null) return false;
  if (conv != null && conv.status !== 'ok') return false;
  const md = doc.markdown ?? '';
  return md.trim().length >= HAS_TEXT_CHARS && assessPage(md) === 'garbled';
}
```

Wire it in at the two places that return `false` for a doc with text or a conversion marker:
- In the `meta.conversion != null` branch: `return reAdmitTooLarge || needsReassessment(doc, kind, meta.conversion)`.
- Change `if (markdown ≥ HAS_TEXT_CHARS) return false` to `return needsReassessment(doc, kind, undefined)`.

In `work()`, for a doc that arrived **with** text (`(doc.markdown ?? '').trim().length >= HAS_TEXT_CHARS`), do not touch the markdown:

```ts
const reassess = (doc.markdown ?? '').trim().length >= HAS_TEXT_CHARS;
// Immediately after `res = await parse(...)` and BEFORE Task 3's text-poor /
// needs-ocr enrich, which would overwrite the existing markdown.
if (reassess) {
  const conversion = res.ocrPages ? needsOcrMarker(res.ocrPages) : { status: 'ok' as const, at: now().toISOString(), quality: 1 as const };
  session.enrich({ documentId: doc.id, metadata: { conversion } });
  return 'done';
}
```

The fence, caps and fetch stay exactly as they are. A re-assessed PDF is fetched once.

- [ ] **Step 4: Run, and confirm they pass.** `npx jest src/main/workers src/main/core`

- [ ] **Step 5: Commit**

```bash
git add src/main/workers/convert src/main/core/engine/__tests__/engine.test.ts
git commit -m "feat(convert): one-time per-page re-assessment of old garbled PDF rows (v2 replay)"
```

---

### Task 6: Live check (macOS dev app, dedicated worktree and profile)

- [ ] Put a real broken-font PDF (the client's kind: legal exhibit, no ToUnicode) into a local-folder root. Use a public sample or one you generate; never client data.
- [ ] Right after the scan, MCP `get` shows `conversion.status === 'needs-ocr'` with the expected page list, and the markdown still has the old text.
- [ ] Once the processing window runs, the doc is findable by a body phrase through MCP `search`, and `extraction.engine === 'local-ocr'`.
- [ ] A clean 50-page text PDF in the same root never gets a marker.

## Self-Review notes

- **Spec coverage:**
  - §1 → T1.
  - §2 (per-page parse, outcome table, no text dropped) → T2.
  - §3 (deterministic marker, both writers, `quality`) → T2 and T3.
  - §4 (classify bypass, SQL mirror, listed-page windows, per-page merge, cap on count, no VLM, `NoProviderError` defers) → T3 and T4.
  - §5 (replay, whole-text admission, `quality` stop, markdown untouched) → T5.
  - Testing list → T1–T6. Hash stability → T3.
  - Implementation notes → T4 (`ocrProgress` cleared via `complete`'s `undefined`), T5 (checked last), and the constraints (no hot `json_extract`).
- **Spec deviation.** The "no-ToUnicode font PDF generated by a script" fixture is replaced by a script-generated **shifted-glyph** text layer, which takes the same per-page path through real pdf-parse. Reliably producing a no-ToUnicode CID font by hand is fiddly, and that is what the live check (T6) covers with a real file.
