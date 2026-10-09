/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { createCorpusQuery } from '../corpus-query';
import { FUZZY_CANDIDATES, fuzzyCandidatesSql } from '../fuzzy';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: (text: string) =>
    /[äöüß]|Rechnung/i.test(text) ? ['deu'] : ['eng'],
};

const doc = (
  externalId: string,
  over: Partial<DocumentInput> = {},
): DocumentInput => ({
  externalId,
  type: 'note',
  title: `Title ${externalId}`,
  markdown: `body-${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('corpus query: fuzzy pass and projections', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let acc: AccountId;
  let sqls: string[];
  let query: ReturnType<typeof createCorpusQuery>['query'];
  let corpus: ReturnType<typeof createCorpusQuery>;

  const commit = (account: AccountId, documents: DocumentInput[]) =>
    store.commit({ account, cursor: null, documents });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-cq-search-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    acc = (await store.createAccount({ source: 'test', identifier: 'a@x' })).id;
    sqls = [];
    const spy = {
      ...db,
      all: (sql: string, params?: never) => {
        sqls.push(sql);
        return db.all(sql, params);
      },
    } as AppDb;
    corpus = createCorpusQuery(spy);
    query = corpus.query;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fuzzySql = () => sqls.find((s) => s.includes('documents_tri')) ?? '';

  it('account-restricted fuzzy search is not crowded out by another account in the newest rowids', async () => {
    const b = (await store.createAccount({ source: 'test', identifier: 'b@x' }))
      .id;
    await commit(
      acc,
      [1, 2, 3].map((i) => doc(`a${i}`, { markdown: `Jahresrechnung a${i}` })),
    );
    await commit(
      b,
      Array.from({ length: FUZZY_CANDIDATES + 50 }, (_, i) =>
        doc(`b${i}`, { markdown: `Jahresrechnung b${i}` }),
      ),
    );
    const hits = await query.search({
      text: 'rechnung',
      account: acc,
      limit: 10,
    });
    expect(hits.map((h) => h.externalId).sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('without an account filter the candidate window is the NEWEST 100 matches: the oldest 50 rowids never appear', async () => {
    await commit(
      acc,
      Array.from({ length: FUZZY_CANDIDATES + 50 }, (_, i) =>
        doc(`old${String(i).padStart(3, '0')}`, {
          markdown: `Jahresrechnung n${i}`,
        }),
      ),
    );
    const rows = (await db.all(fuzzyCandidatesSql('', false), [
      '"rechnung"',
      FUZZY_CANDIDATES,
    ])) as Array<{ id: string }>;
    expect(rows).toHaveLength(FUZZY_CANDIDATES);
    const idToExternal = new Map(
      (
        (await db.all(`SELECT id, external_id FROM documents`)) as Array<{
          id: string;
          external_id: string;
        }>
      ).map((r) => [r.id, r.external_id]),
    );
    const got = new Set(rows.map((r) => idToExternal.get(r.id)));
    for (let i = 0; i < 50; i += 1) {
      expect(got.has(`old${String(i).padStart(3, '0')}`)).toBe(false);
    }
    for (let i = 50; i < FUZZY_CANDIDATES + 50; i += 1) {
      expect(got.has(`old${String(i).padStart(3, '0')}`)).toBe(true);
    }
  });

  it('fuzzyRuns counts only real executions of the trigram fallback statement', async () => {
    await commit(acc, [
      ...Array.from({ length: 12 }, (_, i) =>
        doc(`inv${i}`, { markdown: `the invoice number ${i}` }),
      ),
      doc('jr', { markdown: 'Jahresrechnung offen' }),
    ]);
    expect(corpus.fuzzyRuns()).toBe(0);
    // a stemmed term whose exact page is FULL never runs the fuzzy pass
    await query.search({ text: 'invoices', limit: 10 });
    expect(corpus.fuzzyRuns()).toBe(0);
    // a later page never runs it either
    await query.search({ text: 'invoice', limit: 10, offset: 10 });
    expect(corpus.fuzzyRuns()).toBe(0);
    // a real misspelling / fragment leaves the page short: the statement runs once
    const hits = await query.search({ text: 'rechnung', limit: 10 });
    expect(hits.map((h) => h.externalId)).toEqual(['jr']);
    expect(corpus.fuzzyRuns()).toBe(1);
  });

  it('archived-heavy corpus still returns the live fuzzy hits', async () => {
    await commit(
      acc,
      [1, 2, 3, 4, 5].map((i) =>
        doc(`live${i}`, { markdown: `Jahresrechnung live${i}` }),
      ),
    );
    await commit(
      acc,
      Array.from({ length: 110 }, (_, i) =>
        doc(`arch${i}`, { markdown: `Jahresrechnung arch${i}` }),
      ),
    );
    await db.run(
      `UPDATE documents SET archived_at = '2026-02-01T00:00:00Z' WHERE external_id LIKE 'arch%'`,
    );
    const hits = await query.search({ text: 'rechnung', limit: 10 });
    expect(hits).toHaveLength(5);
    expect(hits.every((h) => h.externalId.startsWith('live'))).toBe(true);
  });

  it('fuzzy order is local: title hit first, then newest', async () => {
    await commit(acc, [
      doc('d1', {
        markdown: 'Jahresrechnung eins',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      doc('d2', {
        title: 'Jahresrechnung 2024',
        markdown: 'zwei',
        createdAt: '2026-02-01T00:00:00Z',
      }),
      doc('d3', {
        markdown: 'Jahresrechnung drei',
        createdAt: '2026-03-01T00:00:00Z',
      }),
    ]);
    const hits = await query.search({ text: 'rechnung', limit: 10 });
    expect(hits.map((h) => h.externalId)).toEqual(['d2', 'd3', 'd1']);
  });

  it('keeps the exact hit first and appends the fuzzy hit once', async () => {
    await commit(acc, [
      doc('exact', {
        markdown: 'a rechnung here',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      doc('fuzzy', {
        markdown: 'Jahresrechnung there',
        createdAt: '2026-02-01T00:00:00Z',
      }),
    ]);
    const hits = await query.search({ text: 'rechnung', limit: 10 });
    expect(hits.map((h) => h.externalId)).toEqual(['exact', 'fuzzy']);
  });

  it('reads no body in the fuzzy statement unless the query has negated terms, and still honours the negation', async () => {
    await commit(acc, [
      doc('keep', { markdown: 'Jahresrechnung ok' }),
      doc('drop', { markdown: 'Jahresrechnung spamwort' }),
    ]);
    await query.search({ text: 'rechnung', limit: 10 });
    expect(fuzzySql()).not.toMatch(/markdown/);
    expect(fuzzySql()).not.toMatch(/bm25\(documents_tri/);

    sqls.length = 0;
    const hits = await query.search({ text: 'rechnung -spam', limit: 10 });
    expect(fuzzySql()).toMatch(/d\.markdown/);
    expect(hits.map((h) => h.externalId)).toEqual(['keep']);
  });

  it('EXPLAIN QUERY PLAN of the fuzzy statement has no temp b-tree for ORDER BY', async () => {
    await commit(acc, [doc('x1', { markdown: 'Jahresrechnung' })]);
    const plan = (await db.all(
      `EXPLAIN QUERY PLAN ${fuzzyCandidatesSql('AND d.account_id = ?', false)}`,
      ['"rechnung"', acc, FUZZY_CANDIDATES],
    )) as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join('\n')).not.toMatch(
      /USE TEMP B-TREE FOR ORDER BY/,
    );
  });

  describe('projections', () => {
    beforeEach(async () => {
      await commit(acc, [
        doc('p1', {
          title: 'Quarterly',
          markdown: 'line1\nThe invoice is due\nline3\nline4',
        }),
      ]);
    });

    it("'snippet' text search: empty markdown, FTS snippet, no body column", async () => {
      const [h] = await query.search({ text: 'invoice', project: 'snippet' });
      expect(h.markdown).toBe('');
      expect(h.snippet).toContain('<b>invoice</b>');
      const exact = sqls.find((s) => s.includes('documents_fts')) ?? '';
      expect(exact).not.toMatch(/d\.markdown|d\.\*/);
    });

    it("'snippet' fuzzy-filled row keeps the fuzzy window and blanks the body", async () => {
      await commit(acc, [doc('f1', { markdown: 'Jahresrechnung steht aus' })]);
      const hits = await query.search({ text: 'rechnung', project: 'snippet' });
      const f = hits.find((h) => h.externalId === 'f1')!;
      expect(f.markdown).toBe('');
      expect(f.snippet).toContain('<b>rechnung</b>');
    });

    it("'snippet' recency / filter-only listings use the line window", async () => {
      const recency = await query.search({
        project: 'snippet',
        contextLines: 1,
      });
      expect(recency[0].markdown).toBe('');
      expect(recency[0].snippet).toBe('line1\nThe invoice is due\nline3\n…');
      const filtered = await query.search({ account: acc, project: 'snippet' });
      expect(filtered[0].snippet).toContain('line1');
    });

    it("'metadata': no body, no snippet, no snippet work", async () => {
      sqls.length = 0;
      const [h] = await query.search({ text: 'invoice', project: 'metadata' });
      expect(h.markdown).toBe('');
      expect(h.snippet).toBeUndefined();
      expect(sqls.some((s) => /d\.markdown|d\.\*|snippet\(/.test(s))).toBe(
        false,
      );
      await query.search({ project: 'metadata' });
      expect(sqls.some((s) => /d\.markdown|d\.\*/.test(s))).toBe(false);
    });

    it("'full' (default) keeps today's rows", async () => {
      const [h] = await query.search({ text: 'invoice' });
      expect(h.markdown).toContain('The invoice is due');
    });

    it('recency snippets are head-limited to the first 64 KiB and end with an ellipsis', async () => {
      const lines = Array.from({ length: 100 }, (_, i) =>
        i === 90 ? `TAILMARK ${'x'.repeat(1490)}` : `${i} ${'y'.repeat(1490)}`,
      );
      await commit(acc, [
        doc('big', {
          markdown: lines.join('\n'),
          createdAt: '2027-01-01T00:00:00Z',
        }),
      ]);
      const [h] = await query.search({
        project: 'snippet',
        contextLines: 30,
        limit: 1,
      });
      expect(h.externalId).toBe('big');
      expect(h.snippet).not.toContain('TAILMARK');
      expect(h.snippet!.endsWith('…')).toBe(true);
      const [full] = await query.search({ limit: 1 });
      expect(full.markdown!.length).toBeGreaterThan(65536);
    });
  });
});
