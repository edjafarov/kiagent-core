/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  Batch,
  Change,
  CommitBatch,
  DocumentInput,
  Source,
  Worker,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createAdmission, type Admission } from '../../admission';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine, workerConsumerName, type EngineDeps } from '../engine';

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

describe('consumer flushes (#147 §4)', () => {
  let dir: string;
  let store: CoreStore;
  let consumerCommits: Array<Extract<CommitBatch, { consumer: string }>>;
  const MiB = 1024 * 1024;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-flush-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    consumerCommits = [];
    const real = store.commit.bind(store);
    jest.spyOn(store, 'commit').mockImplementation(async (batch) => {
      if ('consumer' in batch) consumerCommits.push(batch);
      return real(batch);
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const engineWith = (admission: Pick<Admission, 'acquire'>) =>
    createEngine({
      store,
      sources: { get: () => undefined },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (i) => i,
      logs: noopLogs,
      admission,
    });

  async function seed(
    ids: string[],
    metadata: Record<string, unknown> = { todo: true },
  ) {
    const acc = await store.createAccount({
      source: 'seed',
      identifier: 'seed',
    });
    await store.commit({
      account: acc.id,
      cursor: 1,
      documents: ids.map((x) => doc(x, { metadata })),
    });
    return acc;
  }
  const todo = (c: Change) =>
    c.kind === 'document' &&
    (c.document.metadata as { todo?: boolean }).todo === true;
  const enrichWorker = (body: string, over: Partial<Worker> = {}): Worker => ({
    name: 'bulk',
    version: 1,
    matches: todo,
    async work(change, session) {
      if (change.kind !== 'document') return 'skip';
      session.enrich({
        documentId: change.document.id,
        markdown: body,
        metadata: { todo: false },
      });
      return 'done';
    },
    ...over,
  });

  it('attach: flushes are bounded and admitted; an intermediate flush leaves the cursor unchanged', async () => {
    await seed(['d1', 'd2', 'd3', 'd4']);
    const acquire = jest.fn<
      ReturnType<Admission['acquire']>,
      Parameters<Admission['acquire']>
    >(async () => () => {});
    const engine = engineWith({ acquire });
    const worker = enrichWorker('x'.repeat(3 * MiB));
    const consumer = workerConsumerName(worker);
    const convertAcquires = () =>
      acquire.mock.calls.filter(([k]) => k === 'convert').length;
    const h = engine.attach(worker);
    // The enrich commits create new document changes; the feed consumes them
    // next, they no longer match, and their batch ends in a cursor-only flush.
    // Wait for that follow-up flush AND for the books to balance (no flush
    // in flight between its acquire and its commit).
    await waitFor(
      () =>
        consumerCommits.some(
          (c) =>
            c.cursor !== undefined &&
            !c.enrich &&
            !c.documents &&
            !c.clearAttempts,
        ) && convertAcquires() === consumerCommits.length,
    );
    const flushes = [...consumerCommits];
    const acquired = convertAcquires();
    await h.stop();
    // Exactly two flushes carry output…
    const withOutput = flushes.filter((c) => (c.enrich?.length ?? 0) > 0);
    expect(withOutput.map((c) => [c.enrich!.length, 'cursor' in c])).toEqual([
      [3, false], // 9 MiB staged ≥ 8 MiB → intermediate flush, no cursor
      [1, true], // final flush writes the cursor
    ]);
    // …and EVERY observed flush, the cursor-only follow-up included, was admitted.
    expect(flushes.length).toBeGreaterThanOrEqual(3);
    expect(acquired).toBe(flushes.length);
    expect(await store.consumerCursor(consumer)).toBeGreaterThan(0);
  });

  it('attach: the flush bound counts UTF-8 bytes of non-ASCII enrich markdown', async () => {
    await seed(['d1', 'd2', 'd3', 'd4']);
    const acquire = jest.fn<
      ReturnType<Admission['acquire']>,
      Parameters<Admission['acquire']>
    >(async () => () => {});
    // 1 Mi 'あ' = 1 Mi code units but 3 MiB of UTF-8.
    const worker = enrichWorker('あ'.repeat(MiB));
    const h = engineWith({ acquire }).attach(worker);
    await waitFor(() =>
      consumerCommits.some(
        (c) => c.cursor !== undefined && (c.enrich?.length ?? 0) > 0,
      ),
    );
    await h.stop();
    expect(
      consumerCommits
        .filter((c) => (c.enrich?.length ?? 0) > 0)
        .map((c) => c.enrich!.length),
    ).toEqual([3, 1]);
  });

  it('attach: a batch with no output still admits its final cursor commit', async () => {
    await seed(['d1', 'd2']);
    const acquire = jest.fn<
      ReturnType<Admission['acquire']>,
      Parameters<Admission['acquire']>
    >(async () => () => {});
    const worker: Worker = {
      name: 'nothing',
      version: 1,
      matches: () => false,
      work: async () => 'skip',
    };
    const consumer = workerConsumerName(worker);
    const convertAcquires = () =>
      acquire.mock.calls.filter(([k]) => k === 'convert').length;
    const h = engineWith({ acquire }).attach(worker);
    await waitFor(
      async () =>
        (await store.consumerCursor(consumer)) > 0 &&
        convertAcquires() === consumerCommits.length,
    );
    await h.stop();
    const cursorCommits = consumerCommits.filter((c) => c.cursor !== undefined);
    expect(cursorCommits.length).toBeGreaterThan(0);
    for (const c of cursorCommits)
      expect(c.documents ?? c.enrich ?? c.clearAttempts).toBeUndefined();
    expect(acquire.mock.calls.filter(([k]) => k === 'convert')).toHaveLength(
      cursorCommits.length,
    );
  });

  it('attach: the final cursor commit waits while foreground is busy', async () => {
    await seed(['d1']);
    const admission = cap1();
    const leave = admission.foreground();
    const worker: Worker = {
      name: 'nothing2',
      version: 1,
      matches: () => false,
      work: async () => 'skip',
    };
    const consumer = workerConsumerName(worker);
    const h = engineWith(admission).attach(worker);
    await new Promise((r) => setTimeout(r, 500));
    expect(await store.consumerCursor(consumer)).toBe(0);
    leave();
    await waitFor(async () => (await store.consumerCursor(consumer)) > 0);
    await h.stop();
  });

  it('stopAll aborts and drains a re-drive blocked on admission; nothing commits after it', async () => {
    const acc = await seed(['d1']);
    const worker = enrichWorker('late');
    const consumer = workerConsumerName(worker);
    const d = await store.read.byExternalId(acc.id, 'd1', 'note');
    await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    const admission = cap1();
    admission.foreground(); // never leaves: the flush waits for a slot
    const engine = engineWith(admission);
    const redrive = engine.rerunDeferred(worker);
    await waitFor(() => admission.snapshot().waiting.redrive === 1);
    const t0 = Date.now();
    await engine.stopAll();
    expect(Date.now() - t0).toBeLessThan(1_000);
    await expect(redrive).resolves.toBeUndefined();
    expect(admission.snapshot().waiting.redrive).toBe(0);
    expect(
      (await store.read.byExternalId(acc.id, 'd1', 'note'))?.markdown,
    ).toBe('body d1');
    expect((await store.ledgerCounts(consumer)).deferred).toBe(1);
  });

  it('a re-drive requested after stopAll began never starts', async () => {
    const acc = await seed(['d1']);
    const worker = enrichWorker('late');
    const consumer = workerConsumerName(worker);
    const d = await store.read.byExternalId(acc.id, 'd1', 'note');
    await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    const engine = engineWith(cap1());
    const probe = jest.spyOn(store, 'ledgerDeferred');
    const stopping = engine.stopAll(); // the scheduler's probe finishes after this
    await engine.rerunDeferred(worker);
    await stopping;
    expect(probe).not.toHaveBeenCalled();
    expect((await store.ledgerCounts(consumer)).deferred).toBe(1);
  });

  it('stopAll cancels a re-drive over a no-output backlog before it writes the ledger', async () => {
    const acc = await seed(['n1', 'n2', 'n3']);
    // Matches nothing: every entry resolves as 'skip' without any admission.
    const worker: Worker = {
      name: 'none',
      version: 1,
      matches: () => false,
      work: async () => 'skip',
    };
    const consumer = workerConsumerName(worker);
    for (const id of ['n1', 'n2', 'n3']) {
      // eslint-disable-next-line no-await-in-loop
      const d = await store.read.byExternalId(acc.id, id, 'note');
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = store.changesAt.bind(store);
    const changesAt = jest
      .spyOn(store, 'changesAt')
      .mockImplementation(async (seqs) => {
        await gate; // the page is in flight when shutdown starts
        return real(seqs);
      });
    const writes = jest.spyOn(store, 'ledgerRecordMany');
    const engine = engineWith(cap1());
    const redrive = engine.rerunDeferred(worker);
    await waitFor(() => changesAt.mock.calls.length === 1);
    const stopped = engine.stopAll();
    release();
    await stopped;
    await expect(redrive).resolves.toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
    expect((await store.ledgerCounts(consumer)).deferred).toBe(3);
  });

  it('rerunDeferred never writes the cursor: a live tail advancing 100 → 200 mid-flush ends at 200', async () => {
    await seed(['d1', 'd2']);
    const worker = enrichWorker('redriven');
    const consumer = workerConsumerName(worker);
    await store.commit({ consumer, cursor: 100 });
    for (const id of ['d1', 'd2']) {
      // eslint-disable-next-line no-await-in-loop
      const d = (await store.read.search({ text: id }))[0];
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d.seq, 1, 'deferred');
    }
    const engine = engineWith({
      acquire: async (kind) => {
        // The live tail commits its cursor while the re-drive waits for its flush.
        if (kind === 'redrive') await store.commit({ consumer, cursor: 200 });
        return () => {};
      },
    });
    await engine.rerunDeferred(worker);
    expect(await store.consumerCursor(consumer)).toBe(200);
    const redrive = consumerCommits.filter((c) => (c.enrich?.length ?? 0) > 0);
    expect(redrive.length).toBeGreaterThan(0);
    for (const c of redrive) expect('cursor' in c).toBe(false);
  });

  it('a flush waits for admission while foreground is busy', async () => {
    const acc = await seed(['d1']);
    const admission = cap1();
    const leave = admission.foreground();
    const h = engineWith(admission).attach(enrichWorker('converted body'));
    const d1 = () => store.read.byExternalId(acc.id, 'd1', 'note');
    await new Promise((r) => setTimeout(r, 500));
    expect((await d1())?.markdown).toBe('body d1');
    leave();
    await waitFor(async () => (await d1())?.markdown === 'converted body');
    await h.stop();
  });

  it('re-drive at cap 1 does not deadlock (the worker’s own admit and the flush are sequential units)', async () => {
    await seed(['d1', 'd2', 'd3']);
    const admission = cap1();
    const worker = enrichWorker('ok', {
      async work(change, session) {
        if (change.kind !== 'document') return 'skip';
        const release = await session.admit!();
        try {
          session.enrich({
            documentId: change.document.id,
            markdown: 'ok',
            metadata: { todo: false },
          });
        } finally {
          release();
        }
        return 'done';
      },
    });
    const consumer = workerConsumerName(worker);
    for (const id of ['d1', 'd2', 'd3']) {
      // eslint-disable-next-line no-await-in-loop
      const d = (await store.read.search({ text: id }))[0];
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d.seq, 1, 'deferred');
    }
    await Promise.race([
      engineWith(admission).rerunDeferred(worker),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('deadlock')), 5_000),
      ),
    ]);
    expect(admission.snapshot().running).toBe(0);
  });

  it('convert makes progress while two accounts backfill at cap 1', async () => {
    const acc = await seed(['c1'], { convertMe: true });
    const admission = cap1();
    const endless = (id: string): Source<string, DocumentInput> => ({
      descriptor: { id, name: id, documentTypes: ['note'], auth: 'none' },
      async connect() {
        return { identifier: `${id}@test` };
      },
      async *pull(session) {
        for (let i = 0; !session.signal.aborted; i += 1) {
          yield {
            phase: 'backfill',
            items: [doc(`${id}${i}`)],
            cursor: `${id}${i}`,
          };
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 10));
        }
      },
      toDocument: (item) => item,
    });
    const a = endless('a');
    const b = endless('b');
    const engine = createEngine({
      store,
      sources: {
        get: (id) =>
          (id === 'a' ? a : id === 'b' ? b : undefined) as Source | undefined,
      },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (i) => i,
      logs: noopLogs,
      admission,
    });
    const conn = (s: Source) =>
      engine.connect(s, {
        oauth: async () => ({}),
        showQr: () => {},
        prompt: async () => ({}),
        status: () => {},
        pickFolders: async () => [],
      });
    const hA = engine.run(await conn(a as Source));
    const hB = engine.run(await conn(b as Source));
    const hW = engine.attach({
      name: 'conv',
      version: 1,
      matches: (c) =>
        c.kind === 'document' &&
        (c.document.metadata as { convertMe?: boolean }).convertMe === true,
      async work(change, session) {
        if (change.kind !== 'document') return 'skip';
        const release = await session.admit!();
        try {
          session.enrich({
            documentId: change.document.id,
            markdown: 'converted',
            metadata: { convertMe: false },
          });
        } finally {
          release();
        }
        return 'done';
      },
    });
    await waitFor(
      async () =>
        (await store.read.byExternalId(acc.id, 'c1', 'note'))?.markdown ===
        'converted',
      25_000,
    );
    await Promise.all([hA.stop(), hB.stop(), hW.stop()]);
  });
});
