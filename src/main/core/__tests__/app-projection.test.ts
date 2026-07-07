import type { Account, AccountId, Change, Document } from '@shared/contracts';

import { createAppProjection } from '../app-projection';
import { DEFAULT_PREFS } from '../prefs';

const extras = {
  prefs: () => DEFAULT_PREFS,
  identity: async () => null,
  mcp: () => ({ port: 7421, clients: 0 }),
  processing: async () => ({ pending: 0, done: 0, skipped: 0, failed: 0 }),
  extensions: () => [],
};

function account(id: string): Account {
  return {
    id: id as AccountId,
    source: 'test',
    identifier: `${id}@x`,
    config: {},
    status: 'live',
    cursor: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function docChange(
  seq: number,
  accountId: string,
  id: string,
  over: Partial<Document> = {},
): Change {
  const ts = `2026-01-01T00:00:0${seq}Z`;
  return {
    seq,
    kind: 'document',
    document: {
      id: id as Document['id'],
      accountId: accountId as AccountId,
      externalId: id,
      type: 'note',
      title: id,
      markdown: null,
      metadata: {},
      createdAt: null,
      parentId: null,
      contentHash: 'h',
      seq,
      archivedAt: null,
      languages: [],
      ingestedAt: ts,
      updatedAt: ts,
      ...over,
    },
  };
}

describe('appProjection.apply', () => {
  const projection = createAppProjection(extras);
  const base = {
    accounts: [{ account: account('a1'), docCount: 0, recent: [] }],
    processing: { pending: 0, done: 0, skipped: 0, failed: 0 },
    mcp: { port: null, clients: 0 },
    identity: null,
    prefs: DEFAULT_PREFS,
    extensions: [],
  };

  it('counts new documents and tracks recents', () => {
    const s = projection.apply(base, [
      docChange(1, 'a1', 'd1'),
      docChange(2, 'a1', 'd2'),
    ]);
    expect(s.accounts[0].docCount).toBe(2);
    expect(s.accounts[0].recent[0].id).toBe('d2'); // newest first
  });

  it('updates in place without double counting', () => {
    let s = projection.apply(base, [docChange(1, 'a1', 'd1')]);
    s = projection.apply(s, [
      docChange(5, 'a1', 'd1', {
        ingestedAt: '2026-01-01T00:00:01Z',
        updatedAt: '2026-01-01T00:00:05Z',
      }),
    ]);
    expect(s.accounts[0].docCount).toBe(1);
    expect(s.accounts[0].recent).toHaveLength(1);
  });

  it('archive removes from count and recents', () => {
    let s = projection.apply(base, [docChange(1, 'a1', 'd1')]);
    s = projection.apply(s, [
      docChange(6, 'a1', 'd1', {
        ingestedAt: '2026-01-01T00:00:01Z',
        updatedAt: '2026-01-01T00:00:06Z',
        archivedAt: '2026-01-01T00:00:06Z',
      }),
    ]);
    expect(s.accounts[0].docCount).toBe(0);
    expect(s.accounts[0].recent).toHaveLength(0);
  });

  it('accountRemoved drops the entry; account upsert keeps counts', () => {
    let s = projection.apply(base, [docChange(1, 'a1', 'd1')]);
    s = projection.apply(s, [
      {
        seq: 7,
        kind: 'account',
        account: { ...account('a1'), status: 'paused' },
      },
    ]);
    expect(s.accounts[0].account.status).toBe('paused');
    expect(s.accounts[0].docCount).toBe(1); // preserved through account update
    s = projection.apply(s, [
      { seq: 8, kind: 'accountRemoved', accountId: 'a1' as AccountId },
    ]);
    expect(s.accounts).toHaveLength(0);
  });
});
