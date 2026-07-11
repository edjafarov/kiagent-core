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

  it('never resurfaces a doc excluded by grouped negation (NOT (a OR b)) via fuzzy', async () => {
    // The discriminating shape: flat extraction negates only 'offen' and
    // flattens 'bezahlt' to POSITIVE, so without the grouped-negation veto
    // the 'paid' doc (grammar-excluded via 'bezahlt') resurfaces via trigram.
    const hits = await store.read.search({
      text: 'Rechnung NOT (offen OR bezahlt)',
    });
    const bodies = hits.map((h) => h.markdown);
    expect(bodies).not.toContain('Jahresrechnung bezahlt und abgelegt');
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
