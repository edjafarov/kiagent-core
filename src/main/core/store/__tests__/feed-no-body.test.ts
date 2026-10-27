/** @jest-environment node */
// feed({ noBody }): documents arrive without bodies, each window's documents
// read in ONE statement instead of one per change.
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Change, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: `title ${externalId}`,
  markdown: `a long body ${externalId}`,
  metadata: { k: externalId },
  createdAt: '2026-10-27T10:00:00.000Z',
});

async function firstWindow(store: CoreStore, opts: object): Promise<Change[]> {
  const it = store.feed(0, opts)[Symbol.asyncIterator]();
  const r = await it.next();
  await it.return?.();
  return r.value as Change[];
}

describe('store.feed noBody', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let docReads: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-feed-nobody-'));
    const real = await openDb(path.join(dir, 'test.db'));
    db = real;
    docReads = [];
    const spy = {
      ...real,
      all: (sql: string, params?: never) => {
        if (/FROM documents/.test(sql)) docReads.push(sql);
        return real.all(sql, params);
      },
    } as AppDb;
    store = openStore(spy, deps);
    const acc = await store.createAccount({ source: 's', identifier: 'a' });
    await store.commit({
      account: acc.id,
      cursor: null,
      documents: [doc('a'), doc('b'), doc('c')],
    });
    // An update: two change rows now name document 'a'.
    await store.commit({
      account: acc.id,
      cursor: null,
      documents: [{ ...doc('a'), markdown: 'edited', title: 'title a2' }],
    });
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('feeds the same changes as the full feed, minus the bodies', async () => {
    const full = await firstWindow(store, { everySeq: true });
    const light = await firstWindow(store, { everySeq: true, noBody: true });
    expect(light.map((c) => [c.seq, c.kind])).toEqual(
      full.map((c) => [c.seq, c.kind]),
    );
    const docs = (cs: Change[]) =>
      cs.flatMap((c) => (c.kind === 'document' ? [c.document] : []));
    expect(docs(full)[0].markdown).toBe('edited');
    expect(
      docs(light).map((d) => {
        const { markdown, metadata, languages, ...rest } = d;
        expect([markdown, metadata, languages]).toEqual(['', {}, []]);
        return rest;
      }),
    ).toEqual(
      docs(full).map((d) => {
        const { markdown: _m, metadata: _md, languages: _l, ...rest } = d;
        return rest;
      }),
    );
  });

  it('reads a window of documents in one statement', async () => {
    docReads = [];
    await firstWindow(store, { everySeq: true, noBody: true });
    expect(docReads).toHaveLength(1);
    docReads = [];
    await firstWindow(store, { everySeq: true });
    expect(docReads).toHaveLength(4); // per change, as before
  });

  it('keeps feeding a document only under its current seq without everySeq', async () => {
    const full = await firstWindow(store, {});
    const light = await firstWindow(store, { noBody: true });
    expect(light.map((c) => c.seq)).toEqual(full.map((c) => c.seq));
  });
});
