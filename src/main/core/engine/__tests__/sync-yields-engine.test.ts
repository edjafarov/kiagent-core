/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  Batch,
  CommitBatch,
  DocumentInput,
  Source,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createAdmission, type Admission } from '../../admission';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine, type EngineDeps } from '../engine';

jest.setTimeout(60_000);

const noopLogs = { log: () => {} };
const idleLane = {
  processing: () => ({ enabled: true, window: 'always' as const }),
  env: () => ({ onBattery: false, userActive: false }),
  weak: () => false,
  syncing: () => false,
};
const cap1 = (): Admission =>
  createAdmission({ slots: 1, userActive: () => false, enrichment: idleLane });

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
const items = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => doc(`${prefix}${i}`));

async function waitFor(
  cond: () => Promise<boolean> | boolean,
  ms = 10_000,
): Promise<void> {
  const t0 = Date.now();
  // eslint-disable-next-line no-await-in-loop
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Yields `batches` from the one after `cursor`; optionally parks like a
 *  live watcher (holding no slot) until stopped. */
function batchSource<I = DocumentInput>(
  id: string,
  batches: Array<Batch<string, I>>,
  opts: {
    park?: boolean;
    toDocument?: (item: I) => DocumentInput | DocumentInput[] | null;
  } = {},
): Source<string, I> {
  return {
    descriptor: { id, name: id, documentTypes: ['note'], auth: 'none' },
    async connect() {
      return { identifier: `${id}@test` };
    },
    async *pull(session, cursor) {
      const start =
        cursor === null ? 0 : batches.findIndex((b) => b.cursor === cursor) + 1;
      for (const b of batches.slice(start)) yield b;
      if (opts.park)
        await new Promise<void>((resolve) =>
          session.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
    },
    toDocument: opts.toDocument ?? ((item) => item as unknown as DocumentInput),
  };
}

describe('pull loop sub-commits (#147 §3/§4)', () => {
  let dir: string;
  let store: CoreStore;
  let accountCommits: Array<Extract<CommitBatch, { account: string }>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-syncy-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    accountCommits = [];
    const real = store.commit.bind(store);
    jest.spyOn(store, 'commit').mockImplementation(async (batch) => {
      if ('account' in batch) accountCommits.push(batch);
      return real(batch);
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeEngine(
    sources: Source<string, never>[],
    extra: Partial<EngineDeps> = {},
  ) {
    return createEngine({
      store,
      sources: {
        get: (id) =>
          sources.find((s) => s.descriptor.id === id) as Source | undefined,
      },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: noopLogs,
      ...extra,
    });
  }
  const connect = (
    engine: ReturnType<typeof makeEngine>,
    source: Source<string, never>,
  ): Promise<Account> =>
    engine.connect(source as Source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
  const live = (id: string) => async () =>
    (await store.account(id))?.status === 'live';

  it('intermediate sub-commits keep the last committed cursor; only the last carries the new one', async () => {
    const source = batchSource('s', [
      {
        phase: 'backfill',
        items: items('a', 60),
        cursor: 'c1',
        estimateTotal: 120,
      },
      {
        phase: 'backfill',
        items: items('b', 60),
        cursor: 'c2',
        estimateTotal: 120,
      },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    expect(
      accountCommits.slice(0, 4).map((c) => ({
        cursor: c.cursor,
        n: c.documents.length,
        done: c.progress?.done,
      })),
    ).toEqual([
      { cursor: null, n: 50, done: 50 }, // intermediate progress is visible
      { cursor: 'c1', n: 10, done: 60 },
      { cursor: 'c1', n: 50, done: 110 },
      { cursor: 'c2', n: 10, done: 120 },
    ]);
    expect(accountCommits.slice(0, 4).map((c) => c.progress?.base)).toEqual([
      0,
      undefined,
      60,
      undefined,
    ]);
    expect(await store.read.count({ account: account.id })).toBe(120);
  });

  it('progress is replay-safe: a crash inside the second batch re-counts only that batch', async () => {
    const source = batchSource('s', [
      {
        phase: 'backfill',
        items: items('a', 60),
        cursor: 'c1',
        estimateTotal: 120,
      },
      {
        phase: 'backfill',
        items: items('b', 60),
        cursor: 'c2',
        estimateTotal: 120,
      },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const real = (store.commit as jest.Mock).getMockImplementation()!;
    let failed = false;
    (store.commit as jest.Mock).mockImplementation(
      async (batch: CommitBatch) => {
        // The second batch's FINAL sub-commit dies after its first 50 items
        // landed under cursor 'c1'.
        if ('account' in batch && batch.cursor === 'c2' && !failed) {
          failed = true;
          throw new Error('db worker died mid-batch');
        }
        return real(batch);
      },
    );
    const h = engine.run(account);
    await waitFor(
      async () => (await store.account(account.id))?.cursor === 'c2',
      15_000,
    );
    await h.stop();
    expect(failed).toBe(true);
    // The crash left { done: 110, base: 60 } under cursor 'c1'; the resume
    // seeds 60 (not max(110, 110 docs)) and replays 60 items.
    const acc = await store.account(account.id);
    expect(acc?.progress).toEqual({ done: 120, totalEstimate: 120 });
    expect(await store.read.count({ account: account.id })).toBe(120);
  });

  it('a child committed before its parent across a sub-commit boundary is linked by relink', async () => {
    const parent = { externalId: 'msg', type: 'note' };
    const children = Array.from({ length: 50 }, (_, i) =>
      doc(`att${i}`, { parent }),
    );
    const source = batchSource('s', [
      { phase: 'backfill', items: [...children, doc('msg')], cursor: 'c1' },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    expect(accountCommits[0].documents).toHaveLength(50); // children first
    const msg = await store.read.byExternalId(account.id, 'msg', 'note');
    // eslint-disable-next-line no-await-in-loop
    for (const i of [0, 49])
      expect(
        (await store.read.byExternalId(account.id, `att${i}`, 'note'))
          ?.parentId,
      ).toBe(msg!.id);
  });

  it('the 8 MiB bound counts UTF-8 bytes: CJK markdown closes a sub-commit by bytes, not code units', async () => {
    // 'あ' is 1 UTF-16 code unit but 3 UTF-8 bytes: 1 Mi chars = 3 MiB.
    const cjk = 'あ'.repeat(1024 * 1024);
    const source = batchSource('s', [
      {
        phase: 'backfill',
        items: [1, 2, 3, 4].map((n) => doc(`j${n}`, { markdown: cjk })),
        cursor: 'c1',
      },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    // 3 docs = 9 MiB ≥ 8 MiB closes the first group (by .length it would be
    // 3 Mi units and all 4 would go together).
    expect(accountCommits.slice(0, 2).map((c) => c.documents.length)).toEqual([
      3, 1,
    ]);
  });

  it('ASCII just under the bound stays in one sub-commit', async () => {
    const MiB = 1024 * 1024;
    const body = 'x'.repeat(2 * MiB - 1); // 4 docs = 8 MiB − 4 bytes
    const source = batchSource('s', [
      {
        phase: 'backfill',
        items: [1, 2, 3, 4].map((n) => doc(`k${n}`, { markdown: body })),
        cursor: 'c1',
      },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    expect(accountCommits[0].documents).toHaveLength(4);
  });

  it('one item’s outputs never split, even past the bound', async () => {
    const source = batchSource<{ n: number }>(
      's',
      [{ phase: 'backfill', items: [{ n: 60 }], cursor: 'c1' }],
      {
        toDocument: (it) =>
          Array.from({ length: it.n }, (_, i) => doc(`part${i}`)),
      },
    );
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    expect(accountCommits[0].documents).toHaveLength(60);
    expect(accountCommits[0].cursor).toBe('c1');
  });

  it('a crash between sub-commits re-pulls the batch from the old cursor, idempotently', async () => {
    const source = batchSource('s', [
      { phase: 'backfill', items: items('a', 60), cursor: 'c1' },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const real = (store.commit as jest.Mock).getMockImplementation()!;
    let failed = false;
    (store.commit as jest.Mock).mockImplementation(
      async (batch: CommitBatch) => {
        if ('account' in batch && batch.cursor === 'c1' && !failed) {
          failed = true;
          throw new Error('db worker died mid-batch');
        }
        return real(batch);
      },
    );
    const h = engine.run(account);
    await waitFor(
      async () => (await store.account(account.id))?.cursor === 'c1',
      15_000,
    );
    await h.stop();
    expect(failed).toBe(true);
    expect(await store.read.count({ account: account.id })).toBe(60);
  });

  it('a parked live source holds no slot: another account’s unit is admitted meanwhile', async () => {
    const admission = cap1();
    const a = batchSource(
      'a',
      [{ phase: 'live', items: [doc('a1')], cursor: 'a1' }],
      { park: true },
    );
    const b = batchSource(
      'b',
      [{ phase: 'live', items: [doc('b1')], cursor: 'b1' }],
      { park: true },
    );
    const engine = makeEngine([a as never, b as never], { admission });
    const accA = await connect(engine, a as never);
    const accB = await connect(engine, b as never);
    const hA = engine.run(accA);
    await waitFor(
      async () => (await store.read.count({ account: accA.id })) === 1,
    );
    const hB = engine.run(accB);
    await waitFor(
      async () => (await store.read.count({ account: accB.id })) === 1,
    );
    expect(admission.snapshot().running).toBe(0);
    await hA.stop();
    await hB.stop();
  });

  it('two accounts interleave at cap 1', async () => {
    const admission = cap1();
    const three = (p: string): Array<Batch<string, DocumentInput>> =>
      [1, 2, 3].map((n) => ({
        phase: 'backfill',
        items: [doc(`${p}${n}`)],
        cursor: `${p}${n}`,
      }));
    const a = batchSource('a', three('a'));
    const b = batchSource('b', three('b'));
    const engine = makeEngine([a as never, b as never], { admission });
    const accA = await connect(engine, a as never);
    const accB = await connect(engine, b as never);
    const hA = engine.run(accA);
    const hB = engine.run(accB);
    await waitFor(
      async () => (await live(accA.id)()) && (await live(accB.id)()),
    );
    await hA.stop();
    await hB.stop();
    const order = accountCommits
      .filter((c) => c.documents.length > 0)
      .map((c) => c.account);
    expect(new Set(order.slice(0, 3)).size).toBe(2);
  });

  it('pause while waiting for a slot resolves promptly and commits nothing', async () => {
    const admission = cap1();
    admission.foreground(); // a foreground call that never ends
    const source = batchSource('s', [
      { phase: 'backfill', items: [doc('x')], cursor: 'c1' },
    ]);
    const engine = makeEngine([source as never], { admission });
    const account = await connect(engine, source as never);
    engine.run(account);
    await waitFor(() => admission.snapshot().waiting.ingest === 1);
    const t0 = Date.now();
    await engine.pause(account.id);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(await store.read.count({ account: account.id })).toBe(0);
  });
});
