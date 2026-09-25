/**
 * #180 (alpha-cent): the live document count against the REAL store — the
 * projection folds the materialized feed after every write, and after each
 * step its docCount must equal the authoritative `store.read.count`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  AppState,
  Change,
  DocumentInput,
  Seq,
} from '@shared/contracts';

import { openDb } from '../../db/app-db';
import { openStore } from '../store/store';
import type { CoreStore } from '../store/store';
import { createAppProjection } from '../app-projection';
import { DEFAULT_PREFS } from '../prefs';

// A strictly advancing clock, unless a test freezes it: #265 is about
// writes landing in the same millisecond.
let tick = 0;
let frozen: string | null = null;
const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
  now: () => {
    if (frozen) return frozen;
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1) + tick * 1000).toISOString();
  },
};

const extras = {
  prefs: () => DEFAULT_PREFS,
  identity: async () => null,
  mcp: () => ({ port: null, clients: 0 }),
  processing: async () => ({ pending: 0, done: 0, skipped: 0, failed: 0 }),
  extensions: () => [],
};

const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: `Title ${externalId}`,
  markdown: `Body of ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});

describe('app projection docCount vs the store (#180)', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let state: AppState;
  let seq: Seq;
  let projection: ReturnType<typeof createAppProjection>;

  /** Fold every change up to the current head into `state`. */
  async function catchUp(): Promise<void> {
    const head = await store.headSeq();
    if (head <= seq) return;
    const changes: Change[] = [];
    for await (const batch of store.feed(seq)) {
      changes.push(...batch);
      if (batch.length && batch[batch.length - 1].seq >= head) break;
    }
    state = projection.apply(state, changes);
    seq = head;
  }

  async function expectExact(): Promise<void> {
    await catchUp();
    expect(state.accounts[0].docCount).toBe(
      await store.read.count({ account: accountId }),
    );
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-projection-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me@x.com' })
    ).id;
    projection = createAppProjection({
      ...extras,
      archiveSnapshot: (account) => store.archiveSnapshot(account),
    });
    state = await projection.init(store.read);
    seq = await store.headSeq();
  });

  afterEach(async () => {
    frozen = null;
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const del = (externalId: string) => ({ externalId, type: 'note' });

  it('ingest → archive → restore tracks the store at every step', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    await expectExact(); // 2
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [del('a')],
      cursor: 2,
    });
    await expectExact(); // 1
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 3,
    });
    await expectExact(); // 2 — the restore counts back in
    expect(state.accounts[0].docCount).toBe(2);
  });

  it('restores a document that was already archived when the projection (re)initialized', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [del('a')],
      cursor: 2,
    });
    // Reconnect: a fresh init reads exact counts and the archived set.
    state = await projection.init(store.read);
    seq = await store.headSeq();
    expect(state.accounts[0].docCount).toBe(1);
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 3,
    });
    await expectExact();
    expect(state.accounts[0].docCount).toBe(2);
  });

  it('seeds the count and the archived index from one read of the store', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [del('b')],
      cursor: 2,
    });
    const b = await store.read.byExternalId(accountId, 'b', 'note');
    await expect(store.archiveSnapshot(accountId)).resolves.toEqual({
      live: 2,
      archived: [b?.id],
    });
    // init() takes its count from that same snapshot, not a second read.
    const count = jest.spyOn(store.read, 'count');
    state = await projection.init(store.read);
    expect(count).not.toHaveBeenCalled();
    expect(state.accounts[0].docCount).toBe(2);
    count.mockRestore();
  });

  it('an update to a live document does not inflate the count', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 1,
    });
    await expectExact();
    await store.commit({
      account: accountId,
      documents: [{ ...doc('a'), markdown: 'edited' }],
      cursor: 2,
    });
    await expectExact();
    expect(state.accounts[0].docCount).toBe(1);
  });

  // #265: "new" is read off the insert row, never timestamps.
  it('an update in the same millisecond as its ingest counts once', async () => {
    frozen = '2026-02-01T00:00:00.000Z';
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 1,
    });
    await expectExact();
    await store.commit({
      account: accountId,
      documents: [{ ...doc('a'), markdown: 'enriched' }],
      cursor: 2,
    });
    await expectExact();
    expect(state.accounts[0].docCount).toBe(1);
  });

  it('a reader that catches up after the update still counts the ingest', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [{ ...doc('a'), markdown: 'edited' }],
      cursor: 2,
    });
    await expectExact();
    expect(state.accounts[0].docCount).toBe(1);
  });

  it('a child written before its parent in one batch counts once', async () => {
    // The child's insert and its re-parenting are two change rows of one
    // transaction.
    const child = {
      ...doc('child'),
      parent: { externalId: 'p', type: 'note' },
    };
    await store.commit({
      account: accountId,
      documents: [child, doc('p')],
      cursor: 1,
    });
    await expectExact();
    expect(state.accounts[0].docCount).toBe(2);
  });
});
