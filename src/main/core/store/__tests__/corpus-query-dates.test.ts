/** @jest-environment node */
// A bare YYYY-MM-DD bound means that whole LOCAL day; Berlin pins the DST
// edge (CEST ended 2026-10-25, so 2026-10-26 is UTC+1).
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { createCorpusQuery } from '../corpus-query';
import { openStore, type CoreStore } from '../store';

process.env.TZ = 'Europe/Berlin';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const event = (title: string, createdAt: string): DocumentInput => ({
  externalId: title,
  type: 'calendar.event',
  title,
  markdown: title,
  metadata: { start: createdAt },
  createdAt,
});

const NOW = new Date('2026-10-26T07:18:00.000Z'); // 08:18 Berlin

describe('corpus query: day bounds and nearest-first listings', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let acc: AccountId;
  let sqls: Array<{ sql: string; params: unknown }>;
  let query: ReturnType<typeof createCorpusQuery>['query'];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-cq-dates-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    acc = (await store.createAccount({ source: 'cal', identifier: 'a@x' })).id;
    await store.commit({
      account: acc,
      cursor: null,
      documents: [
        event('yesterday late', '2026-10-25T21:30:00.000Z'), // 22:30 on the 25th
        event('first instant of the day', '2026-10-25T23:00:00Z'), // 00:00, no ms
        event('early today', '2026-10-26T05:00:00.000Z'), // 06:00
        event('swimming', '2026-10-26T14:45:00.000Z'), // 15:45
        event('minecraft', '2026-10-26T17:00:00.000Z'), // 18:00
        event('first instant of tomorrow', '2026-10-26T23:00:00Z'), // 00:00 on the 27th, no ms
        event('next year', '2027-10-21T15:00:00.000Z'),
      ],
    });
    sqls = [];
    const spy = {
      ...db,
      all: (sql: string, params?: never) => {
        sqls.push({ sql, params });
        return db.all(sql, params);
      },
    } as AppDb;
    query = createCorpusQuery(spy, { now: () => NOW }).query;
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const titles = (docs: Array<{ title: string | null }>) =>
    docs.map((d) => d.title);

  test('from_date = to_date = a bare day lists that whole local day', async () => {
    const docs = await query.search({
      fromDate: '2026-10-26',
      toDate: '2026-10-26',
    });
    expect(titles(docs).sort()).toEqual(
      [
        'early today',
        'first instant of the day',
        'minecraft',
        'swimming',
      ].sort(),
    );
  });

  test('a bare day uses that day’s local midnight on both sides of a DST change', async () => {
    await query.search({ fromDate: '2026-10-26', toDate: '2026-10-26' });
    const recency = sqls[sqls.length - 1];
    expect(recency.sql).toContain('COALESCE(d.created_at, d.ingested_at) < ?');
    expect(recency.params).toEqual(
      expect.arrayContaining([
        '2026-10-25T23:00:00.000Z',
        '2026-10-26T23:00:00.000Z',
      ]),
    );
  });

  test('full timestamps stay inclusive bounds, unchanged', async () => {
    const docs = await query.search({
      fromDate: '2026-10-26T14:45:00.000Z',
      toDate: '2026-10-26T17:00:00.000Z',
    });
    expect(titles(docs).sort()).toEqual(['minecraft', 'swimming']);
  });

  test('count and countBy take the same whole-day bounds', async () => {
    const day = { fromDate: '2026-10-26', toDate: '2026-10-26' };
    expect(await query.count(day)).toBe(4);
    const rows = await query.countBy({ ...day, field: 'from' });
    expect(rows).toEqual([{ key: '(none)', count: 4 }]);
  });

  test("orderBy 'nearest' lists the closest to now first, upcoming included", async () => {
    const docs = await query.search({ orderBy: 'nearest' });
    expect(titles(docs)).toEqual([
      'early today', // 2 h 18 ago
      'swimming', // in 7 h 27
      'first instant of the day', // 8 h 18 ago
      'minecraft', // in 9 h 42
      'yesterday late', // 9 h 48 ago
      'first instant of tomorrow', // in 15 h 42
      'next year',
    ]);
  });

  test("orderBy 'nearest' pages exactly", async () => {
    const all = titles(await query.search({ orderBy: 'nearest' }));
    const pages: Array<string | null> = [];
    for (let offset = 0; offset < all.length; offset += 2)
      pages.push(
        ...titles(await query.search({ orderBy: 'nearest', limit: 2, offset })),
      );
    expect(pages).toEqual(all);
  });

  test("orderBy 'nearest' reads both halves in index order", async () => {
    await query.search({ orderBy: 'nearest', account: acc, limit: 3 });
    const halves = sqls.filter((s) => /ORDER BY COALESCE/.test(s.sql));
    expect(halves).toHaveLength(2);
    for (const h of halves) {
      const plan = (await db.all(
        `EXPLAIN QUERY PLAN ${h.sql}`,
        h.params as never,
      )) as unknown as Array<{ detail: string }>;
      const detail = plan.map((p) => p.detail).join(' | ');
      expect(detail).toContain('docs_account_recency');
      // The date order comes from the index; only the id tie-break may sort.
      expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    }
  });
});
