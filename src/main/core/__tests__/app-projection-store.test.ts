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

// A strictly advancing clock: the projection's "new document" heuristic is
// ingestedAt === updatedAt, so two real writes landing in the same
// millisecond would read as two new documents (a known, separate limit).
let tick = 0;
const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
  now: () => {
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
      archivedIds: (account) => store.archivedIds(account),
    });
    state = await projection.init(store.read);
    seq = await store.headSeq();
  });

  afterEach(async () => {
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
});
