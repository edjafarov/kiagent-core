import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (
  externalId: string,
  extra: Partial<DocumentInput> = {},
): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: null,
  ...extra,
});

describe('sub-commit store support', () => {
  let dir: string;
  let store: CoreStore;
  let account: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-syncstore-'));
    store = openStore(await openDb(path.join(dir, 'kiagent.db')), deps);
    account = (await store.createAccount({ source: 'test', identifier: 'me' }))
      .id;
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('relink links a child committed by an earlier sub-commit once its parent lands', async () => {
    const parent = { externalId: 'msg', type: 'note' };
    await store.commit({
      account,
      cursor: null,
      documents: [doc('att', { parent })],
    });
    expect(
      (await store.read.byExternalId(account, 'att', 'note'))?.parentId,
    ).toBeNull();
    await store.commit({
      account,
      cursor: 'c1',
      documents: [doc('msg')],
      relink: [{ child: { externalId: 'att', type: 'note' }, parent }],
    });
    const msg = await store.read.byExternalId(account, 'msg', 'note');
    expect(
      (await store.read.byExternalId(account, 'att', 'note'))?.parentId,
    ).toBe(msg!.id);
  });

  it('reconcileArchiveChunk runs one bounded transaction per call and ends the pass when done', async () => {
    await store.commit({
      account,
      cursor: 1,
      documents: ['a', 'b', 'c', 'd', 'e'].map((x) => doc(x)),
    });
    const head = await store.headSeq();
    await store.reconcileBegin(account);
    await store.reconcileStage(account, [{ externalId: 'a', type: 'note' }]);
    expect(await store.reconcileArchiveChunk(account, head, 2)).toEqual({
      archived: 2,
      done: false,
    });
    expect(await store.reconcileArchiveChunk(account, head, 2)).toEqual({
      archived: 2,
      done: false,
    });
    expect(await store.reconcileArchiveChunk(account, head, 2)).toEqual({
      archived: 0,
      done: true,
    });
    await expect(store.reconcileArchiveChunk(account, head, 2)).rejects.toThrow(
      /reconcile staging lost/,
    );
    expect(await store.read.count({ account })).toBe(1);
  });

  it('a doc committed between chunks (newer than startSeq) is never archived', async () => {
    await store.commit({
      account,
      cursor: 1,
      documents: ['a', 'b', 'c'].map((x) => doc(x)),
    });
    const head = await store.headSeq();
    await store.reconcileBegin(account);
    await store.reconcileStage(account, [{ externalId: 'a', type: 'note' }]);
    expect((await store.reconcileArchiveChunk(account, head, 1)).archived).toBe(
      1,
    );
    await store.commit({ account, cursor: 2, documents: [doc('late')] });
    while (!(await store.reconcileArchiveChunk(account, head, 1)).done) {
      /* drain */
    }
    expect(
      (await store.read.byExternalId(account, 'late', 'note'))?.archivedAt,
    ).toBeNull();
  });
});
