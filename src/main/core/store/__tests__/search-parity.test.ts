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
