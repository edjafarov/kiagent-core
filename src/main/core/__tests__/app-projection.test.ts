import v8 from 'v8';

import type {
  Account,
  AccountId,
  Change,
  Document,
  Query,
} from '@shared/contracts';

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
      scopeRootId: null,
      ...over,
    },
  };
}

describe('appProjection.init', () => {
  const projection = createAppProjection(extras);

  function fakeQuery(accounts: Account[]): Query {
    return {
      document: jest.fn(async () => null),
      children: jest.fn(async () => []),
      byExternalId: jest.fn(async () => null),
      search: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      accounts: jest.fn(async () => accounts),
    } as unknown as Query;
  }

  it('marks the snapshot ready — the first-hydration signal for renderers', async () => {
    const s = await projection.init(fakeQuery([]));
    expect(s.ready).toBe(true);
  });
});

describe('appProjection.apply', () => {
  const projection = createAppProjection(extras);
  const base = {
    accounts: [{ account: account('a1'), docCount: 0, recent: [] }],
    processing: { pending: 0, done: 0, skipped: 0, failed: 0 },
    mcp: { port: null, clients: 0 },
    identity: null,
    prefs: DEFAULT_PREFS,
    extensions: [],
    ready: true,
  };

  it('preserves ready through apply (spread, not recomputed)', () => {
    const s = projection.apply(base, [docChange(1, 'a1', 'd1')]);
    expect(s.ready).toBe(true);
  });

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
describe('account-cursor-not-projected', () => {
  const projection = createAppProjection(extras);
  const withCursor = (id: string, cursor: unknown): Account => ({
    ...account(id),
    cursor,
  });

  it('init strips the cursor', async () => {
    const q = {
      document: jest.fn(async () => null),
      children: jest.fn(async () => []),
      byExternalId: jest.fn(async () => null),
      search: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      accounts: jest.fn(async () => [
        withCursor('a1', { big: 'x'.repeat(1000) }),
      ]),
    } as unknown as Query;
    const s = await projection.init(q);
    expect(s.accounts[0].account.cursor).toBeNull();
    expect(s.accounts[0].account.identifier).toBe('a1@x');
  });

  it('apply strips the cursor on update and on insert', () => {
    const base = {
      accounts: [{ account: account('a1'), docCount: 3, recent: [] }],
      processing: { pending: 0, done: 0, skipped: 0, failed: 0 },
      mcp: { port: null, clients: 0 },
      identity: null,
      prefs: DEFAULT_PREFS,
      extensions: [],
      ready: true,
    };
    const s = projection.apply(base, [
      {
        seq: 1,
        kind: 'account',
        account: withCursor('a1', { n: 1 }),
      } as Change,
      {
        seq: 2,
        kind: 'account',
        account: withCursor('a2', { n: 2 }),
      } as Change,
    ]);
    expect(s.accounts.map((a) => a.account.cursor)).toEqual([null, null]);
    expect(s.accounts[0].docCount).toBe(3);
  });
});

// #180 (alpha-cent): restoring an archived document keeps its original
// ingestedAt, so the "new document" heuristic alone never counted it back.
describe('appProjection archived → live transitions', () => {
  const projection = createAppProjection(extras);
  const base = {
    accounts: [{ account: account('a1'), docCount: 0, recent: [] }],
    processing: { pending: 0, done: 0, skipped: 0, failed: 0 },
    mcp: { port: null, clients: 0 },
    identity: null,
    prefs: DEFAULT_PREFS,
    extensions: [],
    ready: true,
  };
  const archive = (seq: number, id: string) =>
    docChange(seq, 'a1', id, {
      ingestedAt: '2026-01-01T00:00:01Z',
      updatedAt: `2026-01-01T00:00:0${seq}Z`,
      archivedAt: `2026-01-01T00:00:0${seq}Z`,
    });
  const restore = (seq: number, id: string) =>
    docChange(seq, 'a1', id, {
      ingestedAt: '2026-01-01T00:00:01Z',
      updatedAt: `2026-01-01T00:00:0${seq}Z`,
    });

  it('counts a restore back in and puts the document back in recents', () => {
    let s = projection.apply(base, [docChange(1, 'a1', 'd1')]);
    s = projection.apply(s, [archive(2, 'd1')]);
    expect(s.accounts[0].docCount).toBe(0);
    s = projection.apply(s, [restore(3, 'd1')]);
    expect(s.accounts[0].docCount).toBe(1);
    expect(s.accounts[0].recent.map((r) => r.id)).toEqual(['d1']);
  });

  it('counts a restore of a document that was already archived at init', async () => {
    const withArchived = createAppProjection({
      ...extras,
      archiveSnapshot: async () => ({
        live: 0,
        archived: ['d1' as Document['id']],
      }),
    });
    const read = {
      document: jest.fn(async () => null),
      children: jest.fn(async () => []),
      byExternalId: jest.fn(async () => null),
      search: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      accounts: jest.fn(async () => [account('a1')]),
    } as unknown as Query;
    let s = await withArchived.init(read);
    expect(s.accounts[0].docCount).toBe(0);
    s = withArchived.apply(s, [restore(3, 'd1')]);
    expect(s.accounts[0].docCount).toBe(1);
  });

  it('counts a replayed restore once', () => {
    let s = projection.apply(base, [docChange(1, 'a1', 'd1')]);
    s = projection.apply(s, [archive(2, 'd1')]);
    s = projection.apply(s, [restore(3, 'd1')]);
    s = projection.apply(s, [restore(3, 'd1')]);
    expect(s.accounts[0].docCount).toBe(1);
  });

  it('counts a replayed archive, or an update to an archived document, once', () => {
    let s = projection.apply(base, [
      docChange(1, 'a1', 'd1'),
      docChange(2, 'a1', 'd2'),
    ]);
    s = projection.apply(s, [archive(3, 'd1')]);
    s = projection.apply(s, [archive(3, 'd1'), archive(4, 'd1')]);
    expect(s.accounts[0].docCount).toBe(1);
  });

  it('stays pure: a later archive never leaks into an earlier state', () => {
    const s1 = projection.apply(base, [
      docChange(1, 'a1', 'd1'),
      docChange(2, 'a1', 'd2'),
    ]);
    const s2 = projection.apply(s1, [archive(3, 'd1')]);
    const s3 = projection.apply(s2, [archive(4, 'd2')]);
    expect(s3.accounts[0].docCount).toBe(0);
    // In s2's history d2 was never archived: this is an ordinary update.
    expect(projection.apply(s2, [restore(5, 'd2')]).accounts[0].docCount).toBe(
      1,
    );
    // Applying to the same state twice gives the same answer.
    expect(projection.apply(s3, [restore(5, 'd2')]).accounts[0].docCount).toBe(
      1,
    );
    expect(projection.apply(s3, [restore(5, 'd2')]).accounts[0].docCount).toBe(
      1,
    );
  });

  it('keeps the archived index out of the state windows receive', () => {
    const id = 'doc-archived-only-here';
    let s = projection.apply(base, [docChange(1, 'a1', id)]);
    s = projection.apply(s, [archive(2, id)]);
    // v8's serializer is the structured clone Electron IPC uses — and unlike
    // JSON it carries a Map or a Set, the index's own shape, with its ids.
    expect(v8.serialize(s).toString('latin1')).not.toContain(id);
    expect(Object.keys(s).sort()).toEqual(Object.keys(base).sort());
    expect(Object.getOwnPropertySymbols(s)).toEqual([]);
  });
});
