import { assessPage } from '../text-quality';

// Shifts upper- and lower-case letters, like a PDF font with a wrong ToUnicode offset.
const shift = (s: string, k: number) =>
  s
    .replace(/[a-z]/g, (c) =>
      String.fromCharCode(((c.charCodeAt(0) - 97 + k) % 26) + 97),
    )
    .replace(/[A-Z]/g, (c) =>
      String.fromCharCode(((c.charCodeAt(0) - 65 + k) % 26) + 65),
    );
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
  'numeric statement (CHF)': Array.from(
    { length: 30 },
    (_, i) =>
      `2026-03-${String(i + 1).padStart(2, '0')}  4711-${i}  1.234,${String(i).padStart(2, '0')} CHF  -56,78`,
  ).join('\n'),
  'numeric statement (GBP)': Array.from(
    { length: 30 },
    (_, i) =>
      `2026-03-${String(i + 1).padStart(2, '0')}  4711-${i}  1,234.${String(i).padStart(2, '0')} GBP  -56.78`,
  ).join('\n'),
  'bank statement rows': Array.from(
    { length: 25 },
    (_, i) =>
      `2026-03-${String(i + 1).padStart(2, '0')} SEPA Lastschrift REWE Markt GmbH Kartenzahlung VISA ${i},99 EUR`,
  ).join('\n'),
  'table of contents':
    'Invoice Summary Customer Account Balance Payment History Contact Details Shipping Address Billing Information Order Number Tax Total',
  'German term list':
    'Kläger Beklagter Streitwert Aktenzeichen Landgericht München Kammer Termin Verhandlung Beweisaufnahme Zeugen Sachverständiger Gutachten Urteil Berufung',
  'surname list':
    'Müller Schmidt Schneider Fischer Weber Meyer Wagner Becker Schulz Hoffmann Schäfer Koch Bauer Richter Klein Wolf Schröder Neumann Schwarz Zimmermann',
  'invoice lines':
    'Pos Art.-Nr. Bezeichnung Menge Einzelpreis Gesamt 1 XK-4471-B Schraube M8x40 verzinkt 200 0,12 24,00 2 ZB-993 Dübel Fischer SX 8 100 0,09 9,00 3 HKZ-12 Winkel 90° 40 1,10 44,00 Zwischensumme Versand MwSt 19% Gesamtbetrag',
  'bank footer codes':
    'IBAN DE89 3704 0044 0532 0130 00 BIC COBADEFFXXX USt-IdNr DE123456789 HRB 12345 Amtsgericht Köln GmbH KG AG',
  'URLs and addresses':
    'https://www.example.com/de/kundenportal?ref=xyz123 support@example.com www.bundesanzeiger.de kontakt@kanzlei-mueller.de https://login.microsoftonline.com/common/oauth2',
  '§-dense statute index':
    '§ 1 Anwendungsbereich § 2 Begriffe § 3 Pflichten § 4 Haftung § 5 Kündigung § 6 Schlussbestimmungen',
  'currency-heavy line':
    '£ 1,200.00 ¥ 34,000 € 990.10 £ 15.00 ¥ 1,000 § 4 total £ 2,205.10 paid',
  'terse heading': 'Anlage K 12 – Schreiben der Beklagten vom 3. März 2026',
  'statement with distinct hex payment refs': Array.from(
    { length: 30 },
    (_, i) =>
      `2026-03-${String(i + 1).padStart(2, '0')} GBP 123.45 Payment Ref ${(0x5feceb66 + i * 7919).toString(16)}ffc86f38d952786c6d696c79`,
  ).join('\n'),
  'transfers with IBANs and invoice refs': Array.from(
    { length: 30 },
    (_, i) =>
      `2026-03-${i + 1} Überweisung an DE${89370400440532013000n + BigInt(i)} Verwendungszweck RG-${4711 + i}/2026 Kunde K${i}X${i}`,
  ).join('\n'),
};

describe('assessPage', () => {
  it.each(Object.entries(PROSE))('%s prose is good', (_l, t) =>
    expect(assessPage(t)).toBe('good'),
  );
  it.each(Object.entries(NOT_PROSE_BUT_GOOD))('%s is good', (_l, t) =>
    expect(assessPage(t)).toBe('good'),
  );
  it.each(['en', 'de', 'fr', 'it', 'es'] as const)(
    '%s prose under every Caesar shift is garbled',
    (l) => {
      for (let k = 1; k < 26; k++)
        expect([k, assessPage(shift(PROSE[l], k))]).toEqual([k, 'garbled']);
    },
  );
  it('the classic -29 ToUnicode offset ("7KH") is garbled', () =>
    expect(
      assessPage(
        '7KH WHQDQW VKDOO SD\\ WKH UHQW RQ WKH ILUVW GD\\ RI HDFK PRQWK DQG WKH ODQGORUG VKDOO PDLQWDLQ WKH SURSHUW\\ LQ JRRG UHSDLU',
      ),
    ).toBe('garbled'));
  it('PUA-heavy text is garbled', () =>
    expect(
      assessPage(
        '\uE001\uE002\uE003 \uE004\uE005\uE006 \uE007\uE008\uE009 \uE00A\uE00B\uE00C \uE00D\uE00E\uE00F \uE010\uE011',
      ),
    ).toBe('garbled'));
  it('Latin-1 symbol soup is garbled', () =>
    expect(assessPage('Í¶ÈÆ¸ ´¨¯ ¤¦¬ Í¶ÈÆ¸ ´¨¯ ¤¦¬ Í¶ÈÆ¸')).toBe('garbled'));
  it('U+FFFD runs are garbled', () =>
    expect(
      assessPage(
        'Vertrag \uFFFD\uFFFD\uFFFD\uFFFD zwischen \uFFFD\uFFFD\uFFFD und',
      ),
    ).toBe('garbled'));
  it('empty and near-empty pages are sparse', () => {
    expect(assessPage('')).toBe('sparse');
    expect(assessPage('  Page 3  ')).toBe('sparse');
  });
});
