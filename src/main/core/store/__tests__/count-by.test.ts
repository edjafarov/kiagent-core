/**
 * Query.countBy — per-sender / per-label aggregation over documents.metadata
 * JSON (spec 2026-08-08 kia-search-operators). Also pins the fromDate/toDate
 * bounds added to Query.count itself.
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

describe('Query.countBy', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-countby-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    accountId = (
      await store.createAccount({ source: 'gmail', identifier: 'me@x.com' })
    ).id;
    const mk = (
      externalId: string,
      from: string,
      labels: string[],
      createdAt: string,
    ): DocumentInput => ({
      externalId,
      type: 'email.thread',
      title: externalId,
      markdown: 'body',
      metadata: { from, labels },
      createdAt,
    });
    await store.commit({
      account: accountId,
      documents: [
        mk(
          'a',
          'Roman Kaplun <rkaplun@zoolatech.com>',
          ['INBOX'],
          '2026-08-01T00:00:00Z',
        ),
        mk(
          'b',
          'Roman Kaplun <rkaplun@zoolatech.com>',
          ['INBOX', 'IMPORTANT'],
          '2026-08-07T00:00:00Z',
        ),
        mk('c', 'Sebastian <s@x.se>', [], '2026-07-01T00:00:00Z'),
      ],
      cursor: null,
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('groups by metadata.from, biggest first', async () => {
    const rows = await store.read.countBy({ field: 'from' });
    expect(rows).toEqual([
      { key: 'Roman Kaplun <rkaplun@zoolatech.com>', count: 2 },
      { key: 'Sebastian <s@x.se>', count: 1 },
    ]);
  });

  it('explodes the labels array', async () => {
    const rows = await store.read.countBy({ field: 'label' });
    expect(rows).toEqual([
      { key: 'INBOX', count: 2 },
      { key: 'IMPORTANT', count: 1 },
    ]);
  });

  it('applies date bounds on the origin date', async () => {
    const rows = await store.read.countBy({
      field: 'from',
      fromDate: '2026-08-01T00:00:00Z',
    });
    expect(rows).toEqual([
      { key: 'Roman Kaplun <rkaplun@zoolatech.com>', count: 2 },
    ]);
  });

  it('count(q) accepts the same date bounds', async () => {
    expect(await store.read.count({ fromDate: '2026-08-01T00:00:00Z' })).toBe(
      2,
    );
  });

  it('applies the toDate upper bound on the origin date', async () => {
    const rows = await store.read.countBy({
      field: 'from',
      toDate: '2026-07-31T23:59:59Z',
    });
    expect(rows).toEqual([{ key: 'Sebastian <s@x.se>', count: 1 }]);
  });

  it('count(q) accepts the toDate bound', async () => {
    expect(await store.read.count({ toDate: '2026-07-31T23:59:59Z' })).toBe(1);
  });
});
