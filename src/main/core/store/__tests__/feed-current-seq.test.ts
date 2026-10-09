/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, Change, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (
  externalId: string,
  markdown = `body ${externalId}`,
): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});

describe('ledger seqs are current document seqs (#59 §0)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-curseq-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me' })
    ).id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seqsOf = async (externalId: string) => {
    const id = (
      (await db.all(`SELECT id, seq FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ id: string; seq: number }>
    )[0];
    const all = (
      (await db.all(
        `SELECT seq FROM changes WHERE kind = 'document' AND ref_id = ? ORDER BY seq`,
        [id.id],
      )) as Array<{ seq: number }>
    ).map((r) => r.seq);
    return { current: id.seq, all };
  };

  it('feed yields a twice-changed document once, under its current seq', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [doc('a', 'edited')],
      cursor: 2,
    });
    const { current, all } = await seqsOf('a');
    expect(all).toHaveLength(2);

    const it = store.feed(0)[Symbol.asyncIterator]();
    const first = await it.next();
    const docs = (first.value as Change[]).filter(
      (c): c is Extract<Change, { kind: 'document' }> => c.kind === 'document',
    );
    expect(docs.map((c) => c.seq)).toEqual([current]);
    expect(docs[0].document.seq).toBe(current);
  });

  it('changesAt resolves through documents; a stale or unknown seq resolves to nothing', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [doc('a', 'edited')],
      cursor: 2,
    });
    const a = await seqsOf('a');
    const b = await seqsOf('b');
    const got = await store.changesAt([
      b.current,
      a.all[0],
      a.current,
      999_999,
    ]);
    expect(got.map((c) => c.seq)).toEqual([b.current, a.current]);
    expect(got.every((c) => c.kind === 'document')).toBe(true);
  });

  it('changesAt never reads the changes table', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 1,
    });
    const { current } = await seqsOf('a');
    const spy = jest.spyOn(db, 'all');
    await store.changesAt([current]);
    expect(
      spy.mock.calls.filter(([sql]) => /\bFROM changes\b/.test(sql as string)),
    ).toEqual([]);
  });
});
