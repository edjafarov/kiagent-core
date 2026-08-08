/**
 * Structured metadata filters on Query.search (people/label/attachment/
 * filename/ext/orderBy) — spec 2026-08-08 kia-search-operators. All are
 * json_extract-over-metadata WHERE clauses; these tests pin that they apply
 * on BOTH the FTS-text path and the no-text recency path, and that
 * orderBy:'newest' overrides bm25 ordering.
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
  detectLanguages: () => ['eng'],
};

function doc(
  externalId: string,
  over: Partial<DocumentInput> = {},
): DocumentInput {
  return {
    externalId,
    type: 'email.thread',
    title: `Title ${externalId}`,
    markdown: `common-word body of ${externalId}`,
    metadata: {},
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('Query.search structured filters', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-searchf-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    accountId = account.id;
    await store.commit({
      account: accountId,
      documents: [
        doc('t1', {
          metadata: {
            from: 'Roman Kaplun <rkaplun@zoolatech.com>',
            to: 'Eldar <me@example.com>',
            participants: ['rkaplun@zoolatech.com', 'me@example.com'],
            labels: ['INBOX', 'IMPORTANT'],
          },
          createdAt: '2026-08-07T10:00:00Z',
        }),
        doc('t2', {
          metadata: {
            from: 'Sebastian <sebastian@example.se>',
            labels: ['INBOX'],
          },
          createdAt: '2026-08-02T10:00:00Z',
        }),
        doc('t3', {
          type: 'file',
          metadata: { filename: 'Invoice-2026.pdf', ext: 'pdf' },
          createdAt: '2026-07-01T10:00:00Z',
        }),
        // Mirrors gmail attachments (src/main/sources/gmail/to-document.ts):
        // filename/mime only, no metadata.ext. No parent — a top-level doc,
        // not anyone's attachment child.
        doc('att2', {
          type: 'attachment',
          metadata: {
            filename: 'Quarterly Report.PDF',
            mime: 'application/pdf',
          },
          createdAt: '2026-06-01T10:00:00Z',
        }),
      ],
      cursor: null,
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('people.from is a case-insensitive substring over name and address', async () => {
    const byName = await store.read.search({ people: { from: ['roman'] } });
    expect(byName.map((d) => d.externalId)).toEqual(['t1']);
    const byDomain = await store.read.search({
      people: { from: ['@zoolatech.com'] },
    });
    expect(byDomain.map((d) => d.externalId)).toEqual(['t1']);
  });

  it('ORs within people.from, ANDs across fields', async () => {
    const either = await store.read.search({
      people: { from: ['roman', 'sebastian'] },
    });
    expect(either).toHaveLength(2);
    const both = await store.read.search({
      people: { from: ['roman'] },
      label: ['important'],
    });
    expect(both.map((d) => d.externalId)).toEqual(['t1']);
  });

  it('people.to is a case-insensitive substring over name and address', async () => {
    const hits = await store.read.search({ people: { to: ['eldar'] } });
    expect(hits.map((d) => d.externalId)).toEqual(['t1']);
  });

  it('people.participant matches any people-ish metadata path', async () => {
    const hits = await store.read.search({
      people: { participant: ['me@example.com'] },
    });
    expect(hits.map((d) => d.externalId)).toEqual(['t1']);
  });

  it('label matches whole array tokens, not substrings of them', async () => {
    expect(await store.read.search({ label: ['inbox'] })).toHaveLength(2);
    expect(await store.read.search({ label: ['in'] })).toHaveLength(0);
  });

  it('filename substring + ext exact', async () => {
    expect(
      (await store.read.search({ filename: ['invoice'] }))[0].externalId,
    ).toBe('t3');
    expect((await store.read.search({ ext: ['pdf'] }))[0].externalId).toBe(
      't3',
    );
    expect(await store.read.search({ ext: ['pd'] })).toHaveLength(0);
  });

  it('ext falls back to a filename suffix when metadata.ext is absent (gmail attachments)', async () => {
    // t3 matches via exact metadata.ext; att2 (gmail-shaped: filename/mime,
    // no ext key) matches only via the filename-suffix fallback.
    const hits = await store.read.search({ ext: ['pdf'] });
    expect(new Set(hits.map((d) => d.externalId))).toEqual(
      new Set(['t3', 'att2']),
    );
  });

  it('ext filename-suffix fallback is a suffix match, not a substring match', async () => {
    // att2's filename is 'Quarterly Report.PDF' — ext:pd must not match the
    // '.PDF' suffix via substring.
    expect(await store.read.search({ ext: ['pd'] })).toHaveLength(0);
  });

  it('ext filename-suffix fallback tolerates a leading dot, like the exact-match path', async () => {
    const hits = await store.read.search({ ext: ['.pdf'] });
    expect(new Set(hits.map((d) => d.externalId))).toEqual(
      new Set(['t3', 'att2']),
    );
  });

  it('hasAttachment keeps only docs with live attachment children', async () => {
    const [t1] = await store.read.search({ people: { from: ['roman'] } });
    await store.commit({
      account: accountId,
      documents: [
        doc('att1', {
          type: 'attachment',
          parent: { externalId: 't1', type: 'email.thread' },
          metadata: { filename: 'kiagent.log.jsonl' },
        }),
      ],
      cursor: null,
    });
    const hits = await store.read.search({ hasAttachment: true });
    expect(hits.map((d) => d.id)).toEqual([t1.id]);
  });

  it('filters compose with FTS text, and orderBy newest overrides bm25', async () => {
    const filtered = await store.read.search({
      text: 'common-word',
      people: { from: ['sebastian'] },
    });
    expect(filtered.map((d) => d.externalId)).toEqual(['t2']);
    const newest = await store.read.search({
      text: 'common-word',
      orderBy: 'newest',
    });
    // att2 also has the default 'common-word' body (doc() helper) and is
    // the oldest of the four seeded docs, so it sorts last.
    expect(newest.map((d) => d.externalId)).toEqual(['t1', 't2', 't3', 'att2']);
  });

  it('orderBy newest on a FULL FTS page pins the SQL ORDER BY itself (fuzzy fallback skipped)', async () => {
    // All 3 seeded docs match 'common-word'; limit:3 makes the primary FTS
    // pass fill the page exactly (rows.length === limit), so the
    // rows.length < limit fallback guard in store.ts short-circuits and this
    // ordering can only come from the orderSql ternary, not the fallback's
    // own re-sort.
    const newest = await store.read.search({
      text: 'common-word',
      orderBy: 'newest',
      limit: 3,
    });
    expect(newest.map((d) => d.externalId)).toEqual(['t1', 't2', 't3']);
  });

  it('LIKE metacharacters in values are literal, not wildcards', async () => {
    expect(await store.read.search({ people: { from: ['%'] } })).toHaveLength(
      0,
    );
  });
});
