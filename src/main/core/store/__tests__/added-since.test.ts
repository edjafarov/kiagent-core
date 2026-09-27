/**
 * CoreStore.addedSince — documents that ENTERED the store since a moment,
 * per account: read off the change log (a document's insert change is the
 * one whose seq is its ingestSeq), so later updates, moves and restores of
 * older documents do not count.
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

const doc = (externalId: string, markdown = 'body'): DocumentInput => ({
  externalId,
  type: 'email.thread',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: '2020-01-01T00:00:00Z',
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('CoreStore.addedSince', () => {
  let dir: string;
  let store: CoreStore;
  let mail: AccountId;
  let chat: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-added-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    mail = (await store.createAccount({ source: 'gmail', identifier: 'a' })).id;
    chat = (await store.createAccount({ source: 'slack', identifier: 'b' })).id;
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('counts new documents per account, not updates of older ones', async () => {
    await store.commit({
      account: mail,
      documents: [doc('old')],
      cursor: null,
    });
    await tick();
    const since = new Date().toISOString();
    await tick();
    await store.commit({
      account: mail,
      documents: [doc('old', 'edited'), doc('new-1'), doc('new-2')],
      cursor: null,
    });
    await store.commit({
      account: chat,
      documents: [doc('c-1')],
      cursor: null,
    });

    const added = await store.addedSince(since);
    expect(
      Object.fromEntries(added.map((a) => [a.accountId, a.count])),
    ).toEqual({ [mail]: 2, [chat]: 1 });
  });

  test('nothing since now, and an empty store, read as no rows', async () => {
    expect(await store.addedSince(new Date(0).toISOString())).toEqual([]);
    await store.commit({ account: mail, documents: [doc('x')], cursor: null });
    await tick();
    expect(await store.addedSince(new Date().toISOString())).toEqual([]);
  });
});
