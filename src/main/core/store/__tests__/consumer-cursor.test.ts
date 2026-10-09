/**
 * Consumer-cursor contract (#147 §4): a consumer commit WITHOUT `cursor`
 * runs no statement against `consumers`; with it, today's upsert.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('consumer commit without a cursor', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-ccursor-'));
    db = await openDb(path.join(dir, 'kiagent.db'));
    store = openStore(db, deps);
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const consumerRows = (name: string): number =>
    Number(
      (
        db
          ._conn!.prepare(`SELECT COUNT(*) AS n FROM consumers WHERE name = ?`)
          .get(name) as { n: number }
      ).n,
    );

  it('leaves a stored cursor untouched', async () => {
    await store.commit({ consumer: 'worker:t:v1', cursor: 100 });
    const acc = await store.createAccount({ source: 'test', identifier: 'a' });
    await store.commit({
      account: acc.id,
      cursor: 1,
      documents: [
        {
          externalId: 'x',
          type: 'note',
          title: 'x',
          markdown: 'old',
          metadata: {},
          createdAt: null,
        },
      ],
    });
    const doc = await store.read.byExternalId(acc.id, 'x', 'note');
    await store.commit({
      consumer: 'worker:t:v1',
      enrich: [{ documentId: doc!.id, markdown: 'new body' }],
    });
    expect(await store.consumerCursor('worker:t:v1')).toBe(100);
    expect((await store.read.document(doc!.id))?.markdown).toBe('new body');
  });

  it('creates no consumers row for a consumer that never wrote a cursor', async () => {
    await store.commit({ consumer: 'worker:fresh:v1', clearAttempts: ['d1'] });
    expect(consumerRows('worker:fresh:v1')).toBe(0);
    expect(await store.consumerCursor('worker:fresh:v1')).toBe(0);
  });

  it('with a cursor still upserts it (today)', async () => {
    await store.commit({ consumer: 'worker:t:v1', cursor: 5 });
    await store.commit({ consumer: 'worker:t:v1', cursor: 7 });
    expect(await store.consumerCursor('worker:t:v1')).toBe(7);
  });
});
