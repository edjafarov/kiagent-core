import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  Batch,
  Change,
  DocumentInput,
  Source,
  Worker,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { createEngine, RECONCILE_STAGE_BATCH, REDRIVE_PAGE } from '../engine';

const noopLogs = { log: () => {} };

async function makeStore(dir: string): Promise<CoreStore> {
  return openStore(await openDb(path.join(dir, 'test.db')), {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });
}

function doc(
  externalId: string,
  markdown = `body ${externalId}`,
): DocumentInput {
  return {
    externalId,
    type: 'note',
    title: externalId,
    markdown,
    metadata: {},
    createdAt: null,
  };
}

/** Two backfill pages, then done — with resume support via numeric cursor. */
function fakeSource(): Source<number, DocumentInput> {
  return {
    descriptor: {
      id: 'fake',
      name: 'Fake',
      documentTypes: ['note'],
      auth: 'none',
    },
    async connect() {
      return { identifier: 'fake@test' };
    },
    async *pull(_session, cursor) {
      const pages: Array<Batch<number, DocumentInput>> = [
        {
          phase: 'backfill',
          items: [doc('a'), doc('b')],
          cursor: 1,
          estimateTotal: 3,
        },
        { phase: 'live', items: [doc('c')], cursor: 2 },
      ];
      for (const page of pages.slice(cursor ?? 0)) yield page;
    },
    toDocument: (item) => item,
  };
}

describe('engine', () => {
  let dir: string;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-engine-'));
    store = await makeStore(dir);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeEngine(source: Source) {
    return createEngine({
      store,
      sources: {
        get: (id) => (id === source.descriptor.id ? source : undefined),
      },
      inference: {
        complete: async () => 'summary!',
        see: async () => 'seen',
        read: async () => 'read!',
        hear: async () => 'heard!',
      },
      convert: async (input) => input,
      logs: noopLogs,
    });
  }

  it('connect + run: pulls to completion, persists cursor and status', async () => {
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });

    const handle = engine.run(account);
    await handle.stop(); // stop() awaits the run loop; fake source ends fast
    // stop() aborts — re-run from persisted cursor to make sure resume works
    const handle2 = engine.run(account);
    await new Promise((r) => {
      setTimeout(r, 300);
    });
    await handle2.stop();

    const acc = await store.account(account.id);
    expect(acc?.cursor).toBe(2);
    expect(await store.read.count({ account: account.id })).toBe(3);
  });

  it('run: backfill progress accumulates across batches instead of resetting per batch', async () => {
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'fake@test' };
      },
      async *pull(_session, cursor) {
        const pages: Array<Batch<number, DocumentInput>> = [
          {
            phase: 'backfill',
            items: [doc('a'), doc('b')],
            cursor: 1,
            estimateTotal: 5,
          },
          {
            phase: 'backfill',
            items: [doc('c'), doc('d'), doc('e')],
            cursor: 2,
            estimateTotal: 5,
          },
        ];
        for (const page of pages.slice(cursor ?? 0)) yield page;
      },
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });

    const handle = engine.run(account);
    // Poll until the pull loop has committed the final cursor (the fake
    // source is synchronous-fast, but stop() aborts — don't race it).
    for (let i = 0; i < 40; i += 1) {
      if ((await store.account(account.id))?.cursor === 2) break;
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    }
    await handle.stop();

    const acc = await store.account(account.id);
    expect(acc?.cursor).toBe(2);
    // done = 2 items + 3 items, NOT the last batch's 3.
    expect(acc?.progress).toEqual({ done: 5, totalEstimate: 5 });
  });

  it('run: resumed backfill seeds progress from the stored doc count when the persisted counter is stale', async () => {
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'fake@test' };
      },
      async *pull(_session, cursor) {
        const pages: Array<Batch<number, DocumentInput>> = [
          {
            phase: 'backfill',
            items: [doc('a'), doc('b')],
            cursor: 1,
            estimateTotal: 7,
          },
          {
            phase: 'backfill',
            items: [doc('c'), doc('d'), doc('e')],
            cursor: 2,
            estimateTotal: 7,
          },
        ];
        for (const page of pages.slice(cursor ?? 0)) yield page;
      },
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    // Simulate an account mid-backfill from a build that never accumulated
    // the counter: 4 documents in the store, cursor past page one, but a
    // stale per-batch progress.done of 2.
    await store.commit({
      account: account.id,
      documents: [doc('w'), doc('x'), doc('y'), doc('z')],
      cursor: 1,
      progress: { done: 2, totalEstimate: 7 },
    });

    const handle = engine.run(account);
    for (let i = 0; i < 40; i += 1) {
      if ((await store.account(account.id))?.cursor === 2) break;
      await new Promise((r) => {
        setTimeout(r, 50);
      });
    }
    await handle.stop();

    const acc = await store.account(account.id);
    expect(acc?.cursor).toBe(2);
    // Seeded from max(stale done = 2, stored docs = 4), then page two's
    // 3 items: 4 + 3 = 7 — not 2 + 3.
    expect(acc?.progress).toEqual({ done: 7, totalEstimate: 7 });
  });

  it('attach: worker consumes the feed, emits documents, records outcomes', async () => {
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    await store.commit({
      account: account.id,
      documents: [doc('x'), doc('y'), doc('poison')],
      cursor: 1,
    });

    const worked: string[] = [];
    const worker: Worker = {
      name: 'summarizer',
      version: 1,
      maxAttempts: 2,
      matches: (c: Change) =>
        c.kind === 'document' && c.document.type === 'note',
      async work(change, session) {
        if (change.kind !== 'document') return 'skip';
        worked.push(change.document.externalId);
        if (change.document.externalId === 'poison') throw new Error('boom');
        if (change.document.externalId === 'y') return 'defer';
        session.emit({
          externalId: `summary:${change.document.externalId}`,
          type: 'summary',
          title: null,
          markdown: await session.inference('summarize'),
          metadata: {},
          createdAt: null,
        });
        return 'done';
      },
    };

    const handle = engine.attach(worker);
    // Wait until the worker has chewed through the backlog (incl. retries).
    await new Promise((r) => {
      setTimeout(r, 4_500);
    });
    const stats = await handle.stats();
    await handle.stop();

    expect(worked).toContain('x');
    expect(stats.done).toBe(1); // x
    expect(stats.deferred).toBe(1); // y
    expect(stats.failed).toBe(1); // poison, after 2 attempts
    expect(await store.read.count({ type: 'summary' })).toBe(1);
    // Cursor advanced PAST the poison document — it cannot stall the feed.
    expect(
      await store.consumerCursor('worker:summarizer:v1'),
    ).toBeGreaterThanOrEqual((await store.headSeq()) - 1);
  }, 15_000);

  it('remove: one cascade — documents, vault, tombstone in feed', async () => {
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({ accessToken: 'tok' }),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    await store.commit({
      account: account.id,
      documents: [doc('a')],
      cursor: 1,
    });
    await engine.remove(account.id);
    expect(await store.account(account.id)).toBeNull();
    expect(await store.read.count({ includeArchived: true })).toBe(0);
  });

  it('project: init from Query, apply folds feed changes', async () => {
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });

    const states: number[] = [];
    const handle = engine.project(
      {
        async init(read) {
          return { count: await read.count({}) };
        },
        apply(state, changes) {
          const added = changes.filter(
            (c) => c.kind === 'document' && c.document.archivedAt === null,
          ).length;
          return { count: state.count + added };
        },
      },
      (s) => states.push(s.count),
    );

    await new Promise((r) => {
      setTimeout(r, 200);
    });
    await store.commit({
      account: account.id,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    await handle.stop();

    expect(states[0]).toBe(0);
    expect(states[states.length - 1]).toBe(2);
  });

  it('worker session: read/see route to the plane, enrich commits with the cursor', async () => {
    // fake inference recording lanes
    const calls: string[] = [];
    const inference = {
      complete: async () => 'c',
      see: async (_i: Uint8Array, prompt: string, _opts?: any) => {
        calls.push(`see:${prompt}`);
        return 'described';
      },
      read: async (_i: Uint8Array, _opts?: any) => {
        calls.push('read');
        return 'ocr text';
      },
      hear: async () => 'transcript',
    };
    const engine = createEngine({
      store,
      sources: { get: () => undefined },
      inference,
      convert: async (d: DocumentInput) => d,
      logs: noopLogs,
    });
    const account = await store.createAccount({
      source: 'test',
      identifier: 'x',
    });
    const worker: Worker = {
      name: 'vision',
      version: 1,
      matches: (ch) =>
        ch.kind === 'document' && ch.document.externalId === 'scan',
      async work(ch, session) {
        if (ch.kind !== 'document') return 'skip';
        // enrich feeds a change for the SAME doc back into the feed — skip
        // our own write-back or the worker re-triggers itself forever.
        if (ch.document.markdown === 'enriched body') return 'skip';
        await session.read(new Uint8Array([1]));
        await session.see(new Uint8Array([1]), 'describe');
        session.enrich({
          documentId: ch.document.id,
          markdown: 'enriched body',
        });
        return 'done';
      },
    };
    const handle = engine.attach(worker);
    await store.commit({
      account: account.id,
      documents: [doc('scan')],
      cursor: 1,
    });
    await waitFor(async () => {
      const d = await store.read.byExternalId(account.id, 'scan', 'note');
      return d?.markdown === 'enriched body';
    }, 5000);
    expect(calls).toEqual(['read', 'see:describe']);
    await handle.stop();
  });

  it('workOne: session accumulators reset per attempt — a failed attempt does not double-commit', async () => {
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    await store.commit({
      account: account.id,
      documents: [doc('x')],
      cursor: 1,
    });
    const before = await store.headSeq();

    let attempts = 0;
    const worker: Worker = {
      name: 'flaky-enricher',
      version: 1,
      maxAttempts: 2,
      // Match only the pristine doc: the enrich write-back re-enters the
      // feed and must not re-trigger the worker.
      matches: (c: Change) =>
        c.kind === 'document' && c.document.markdown === 'body x',
      async work(change, session) {
        if (change.kind !== 'document') return 'skip';
        attempts += 1;
        session.enrich({
          documentId: change.document.id,
          markdown: `attempt ${attempts}`,
        });
        if (attempts === 1) throw new Error('boom');
        return 'done';
      },
    };

    const handle = engine.attach(worker);
    await waitFor(async () => {
      const d = await store.read.byExternalId(account.id, 'x', 'note');
      return d?.markdown === 'attempt 2';
    }, 8_000);
    await handle.stop();

    // The failed attempt-1 enrich must not survive into the successful
    // attempt-2 commit — exactly one enrich lands, i.e. exactly one new
    // document change beyond the initial commit.
    expect((await store.headSeq()) - before).toBe(1);
  }, 12_000);

  it('rerunDeferred: a deferred doc that gained markdown is not re-worked; ledger entry resolves', async () => {
    const engine = createEngine({
      store,
      sources: { get: () => undefined },
      inference: {
        complete: async () => 'c',
        see: async () => 's',
        read: async () => 'r',
        hear: async () => 'h',
      },
      convert: async (d: DocumentInput) => d,
      logs: noopLogs,
    });
    const account = await store.createAccount({
      source: 'test',
      identifier: 'x',
    });

    let workCalls = 0;
    const worker: Worker = {
      name: 'vision',
      version: 1,
      schedule: { every: '30m' },
      // The two-pass shape: a doc is a candidate only while it lacks real
      // markdown. Once enriched it must no longer match.
      matches: (c: Change) =>
        c.kind === 'document' && (c.document.markdown ?? '').trim().length < 16,
      async work(c, session) {
        workCalls += 1;
        if (c.kind !== 'document') return 'skip';
        session.enrich({
          documentId: c.document.id,
          markdown: 'OCR OVERWRITE',
        });
        return 'done';
      },
    };
    const consumer = 'worker:vision:v1';

    // Commit a text-poor doc, capture its change seq, mark it deferred.
    await store.commit({
      account: account.id,
      documents: [doc('scan', '')],
      cursor: 1,
    });
    const scan = await store.read.byExternalId(account.id, 'scan', 'note');
    const deferredSeq = scan!.seq;
    await store.ledgerRecord(consumer, deferredSeq, 1, 'deferred');
    expect(await store.ledgerDeferred(consumer, 0, 10)).toEqual([deferredSeq]);

    // The doc gains real markdown before the re-drive (another path enriched
    // it). changesAt() materializes the CURRENT doc, so it no longer matches.
    await store.commit({
      consumer,
      cursor: await store.consumerCursor(consumer),
      enrich: [
        {
          documentId: scan!.id,
          markdown: 'real rich markdown that is plenty long',
        },
      ],
    });

    await engine.rerunDeferred(worker);

    expect(workCalls).toBe(0); // matches() re-checked → worker never ran
    expect(await store.ledgerDeferred(consumer, 0, 10)).toEqual([]); // deferred entry resolved
    const after = await store.read.byExternalId(account.id, 'scan', 'note');
    expect(after?.markdown).toBe('real rich markdown that is plenty long'); // not clobbered
  });

  it('rerunDeferred: pages the backlog — never materializes the whole deferred set at once', async () => {
    // REGRESSION (main-process OOM, 2026-08-24): rerunDeferred used to call
    // store.ledgerDeferred() unbounded and hand every seq to changesAt(),
    // materializing one full Document per deferred entry into a single array.
    // With a 2.1M-entry backlog that array measured ~2 GB and pinned the main
    // heap for the whole loop — the app died at the first 30m re-drive tick.
    // The loop must consume the backlog one bounded page at a time.
    const account = await store.createAccount({
      source: 'test',
      identifier: 'p',
    });
    const consumer = 'worker:vision:v1';
    const total = REDRIVE_PAGE + 7;

    await store.commit({
      account: account.id,
      documents: Array.from({ length: total }, (_, i) => doc(`scan-${i}`, '')),
      cursor: 1,
    });
    for (let i = 0; i < total; i += 1) {
      const d = await store.read.byExternalId(account.id, `scan-${i}`, 'note');
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    }

    const pageSizes: number[] = [];
    const spy: CoreStore = {
      ...store,
      changesAt: async (seqs) => {
        pageSizes.push(seqs.length);
        return store.changesAt(seqs);
      },
    };

    const engine = createEngine({
      store: spy,
      sources: { get: () => undefined },
      inference: {
        complete: async () => 'c',
        see: async () => 's',
        read: async () => 'r',
        hear: async () => 'h',
      },
      convert: async (d: DocumentInput) => d,
      logs: noopLogs,
    });

    const worker: Worker = {
      name: 'vision',
      version: 1,
      schedule: { every: '30m' },
      matches: () => false, // every entry resolves terminally to 'skip'
      work: async () => 'skip',
    };

    await engine.rerunDeferred(worker);

    expect(pageSizes.length).toBeGreaterThan(1); // actually paged
    expect(Math.max(...pageSizes)).toBeLessThanOrEqual(REDRIVE_PAGE);
    // and the whole backlog still drained
    expect(await store.ledgerDeferred(consumer, 0, total + 1)).toEqual([]);
  }, 30_000);

  it('rerunDeferred: batches the terminal skips instead of one write per entry', async () => {
    // The same 2.1M backlog also issued 2.1M single-row ledgerRecord calls,
    // each a separate round trip through the DB worker bridge.
    const account = await store.createAccount({
      source: 'test',
      identifier: 'b',
    });
    const consumer = 'worker:vision:v1';
    const total = 40;

    await store.commit({
      account: account.id,
      documents: Array.from({ length: total }, (_, i) => doc(`b-${i}`, '')),
      cursor: 1,
    });
    for (let i = 0; i < total; i += 1) {
      const d = await store.read.byExternalId(account.id, `b-${i}`, 'note');
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    }

    let singleWrites = 0;
    const spy: CoreStore = {
      ...store,
      ledgerRecord: async (...args) => {
        singleWrites += 1;
        return store.ledgerRecord(...args);
      },
    };

    const engine = createEngine({
      store: spy,
      sources: { get: () => undefined },
      inference: {
        complete: async () => 'c',
        see: async () => 's',
        read: async () => 'r',
        hear: async () => 'h',
      },
      convert: async (d: DocumentInput) => d,
      logs: noopLogs,
    });

    await engine.rerunDeferred({
      name: 'vision',
      version: 1,
      schedule: { every: '30m' },
      matches: () => false,
      work: async () => 'skip',
    } as Worker);

    expect(singleWrites).toBe(0); // batched, not one-per-entry
    expect(await store.ledgerDeferred(consumer, 0, total + 1)).toEqual([]);
  }, 30_000);

  it('rerunDeferred: a page whose commit fails leaves its entries deferred, not done (#63)', async () => {
    // REGRESSION: workOne recorded each entry's ledger outcome right after
    // worker.work, but the re-drive commits the page's output only at the end
    // of the page. The ledger row is the re-drive's only driver (no cursor),
    // so a quit/crash in between left entries 'done' whose OCR/ASR output
    // never landed — and nothing ever re-selected them.
    const account = await store.createAccount({
      source: 'test',
      identifier: 'c',
    });
    const consumer = 'worker:vision:v1';
    await store.commit({
      account: account.id,
      documents: [doc('c-0', ''), doc('c-1', '')],
      cursor: 1,
    });
    const seqs: number[] = [];
    for (const id of ['c-0', 'c-1']) {
      // eslint-disable-next-line no-await-in-loop
      const d = await store.read.byExternalId(account.id, id, 'note');
      seqs.push(d!.seq);
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    }

    const crashing: CoreStore = {
      ...store,
      commit: async () => {
        throw new Error('commit boom');
      },
    };
    const engine = createEngine({
      store: crashing,
      sources: { get: () => undefined },
      inference: {
        complete: async () => 'c',
        see: async () => 's',
        read: async () => 'r',
        hear: async () => 'h',
      },
      convert: async (d: DocumentInput) => d,
      logs: noopLogs,
    });

    await expect(
      engine.rerunDeferred({
        name: 'vision',
        version: 1,
        schedule: { every: '30m' },
        matches: (c: Change) =>
          c.kind === 'document' &&
          (c.document.markdown ?? '').trim().length < 16,
        async work(c, session) {
          if (c.kind !== 'document') return 'skip';
          session.enrich({ documentId: c.document.id, markdown: 'OCR text' });
          return 'done'; // the worker now succeeds
        },
      }),
    ).rejects.toThrow('commit boom');

    expect(await store.ledgerDeferred(consumer, 0, 10)).toEqual(seqs);
    expect((await store.ledgerCounts(consumer)).done).toBe(0);
  });

  it('rerunDeferred: records the page ledger in one write, after the page commit', async () => {
    const account = await store.createAccount({
      source: 'test',
      identifier: 'h',
    });
    const consumer = 'worker:vision:v1';
    await store.commit({
      account: account.id,
      documents: [
        doc('scan', ''),
        doc('rich', 'real rich markdown that is plenty long'),
      ],
      cursor: 1,
    });
    for (const id of ['scan', 'rich']) {
      // eslint-disable-next-line no-await-in-loop
      const d = await store.read.byExternalId(account.id, id, 'note');
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    }

    const calls: string[] = [];
    const spy: CoreStore = {
      ...store,
      commit: async (batch) => {
        calls.push('commit');
        return store.commit(batch);
      },
      ledgerRecord: async (...args) => {
        calls.push('ledgerRecord');
        return store.ledgerRecord(...args);
      },
      ledgerRecordMany: async (...args) => {
        calls.push('ledgerRecordMany');
        return store.ledgerRecordMany(...args);
      },
    };
    const engine = createEngine({
      store: spy,
      sources: { get: () => undefined },
      inference: {
        complete: async () => 'c',
        see: async () => 's',
        read: async () => 'r',
        hear: async () => 'h',
      },
      convert: async (d: DocumentInput) => d,
      logs: noopLogs,
    });

    await engine.rerunDeferred({
      name: 'vision',
      version: 1,
      schedule: { every: '30m' },
      matches: (c: Change) =>
        c.kind === 'document' && (c.document.markdown ?? '').trim().length < 16,
      async work(c, session) {
        if (c.kind !== 'document') return 'skip';
        session.enrich({ documentId: c.document.id, markdown: 'OCR text' });
        return 'done';
      },
    });

    // The worked entry and the no-longer-matching skip share one write, and
    // it lands only once the page's output is durable.
    expect(calls).toEqual(['commit', 'ledgerRecordMany']);
    expect(await store.ledgerDeferred(consumer, 0, 10)).toEqual([]);
    const counts = await store.ledgerCounts(consumer);
    expect(counts.done).toBe(1);
    expect(counts.skip).toBe(1);
    const scan = await store.read.byExternalId(account.id, 'scan', 'note');
    expect(scan?.markdown).toBe('OCR text');
  });

  it('workOne: a failed final attempt commits no partial emit/enrich', async () => {
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    await store.commit({
      account: account.id,
      documents: [doc('x')],
      cursor: 1,
    });
    const before = await store.headSeq();

    const worker: Worker = {
      name: 'always-fails',
      version: 1,
      maxAttempts: 2,
      matches: (c: Change) =>
        c.kind === 'document' && c.document.markdown === 'body x',
      async work(change, session) {
        if (change.kind !== 'document') return 'skip';
        // Produce output on EVERY attempt, then throw — the last attempt's
        // partial emit/enrich must not survive into the commit.
        session.emit({
          externalId: `emitted:${change.document.externalId}`,
          type: 'summary',
          title: null,
          markdown: 'partial',
          metadata: {},
          createdAt: null,
        });
        session.enrich({
          documentId: change.document.id,
          markdown: 'partial enrich',
        });
        throw new Error('always boom');
      },
    };

    const handle = engine.attach(worker);
    await waitFor(
      async () =>
        (await store.ledgerCounts('worker:always-fails:v1')).failed === 1,
      10_000,
    );
    await handle.stop();

    // Nothing partial landed: no emitted summary doc, no enrich change — so
    // the head seq is unchanged (the consumer commit carried no documents).
    expect(await store.headSeq()).toBe(before);
    expect(await store.read.count({ type: 'summary' })).toBe(0);
    const x = await store.read.byExternalId(account.id, 'x', 'note');
    expect(x?.markdown).toBe('body x'); // enrich did not clobber it
  }, 15_000);

  it('workOne: a dangling async emit from a failed attempt does not pollute the retry that succeeds', async () => {
    // Regression: emitted/enriched/session used to be created ONCE outside
    // the retry loop and cleared with `.length = 0` per attempt. Workers are
    // third-party extension code — if attempt 1 leaves a dangling background
    // task (an un-awaited setTimeout/promise) that calls session.emit() while
    // attempt 2 is already accumulating (i.e. after the clear), that late
    // call used to land in the SAME array attempt 2 returns. Each attempt
    // must get its own session/array so a late call from a dead attempt
    // writes into an array nothing ever reads. The test replays attempt 1's
    // captured session mid-attempt-2 — deterministically after any clearing —
    // rather than racing a real timer against the retry backoff.
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    await store.commit({
      account: account.id,
      documents: [doc('x')],
      cursor: 1,
    });

    let attempts = 0;
    let firstSession: Parameters<Worker['work']>[1] | null = null;
    const worker: Worker = {
      name: 'dangling-emitter',
      version: 1,
      maxAttempts: 2,
      matches: (c: Change) =>
        c.kind === 'document' && c.document.markdown === 'body x',
      async work(change, session) {
        if (change.kind !== 'document') return 'skip';
        attempts += 1;
        if (attempts === 1) {
          // Keep a reference to this attempt's session, as a dangling
          // background task spawned here would.
          firstSession = session;
          throw new Error('boom');
        }
        // The "dangling task from attempt 1" resolves now, mid-attempt-2:
        // it emits through the session binding it captured before throwing.
        firstSession!.emit({
          externalId: 'dangling-from-attempt-1',
          type: 'summary',
          title: null,
          markdown: 'should never be committed',
          metadata: {},
          createdAt: null,
        });
        session.emit({
          externalId: 'summary:x',
          type: 'summary',
          title: null,
          markdown: 'attempt 2 output',
          metadata: {},
          createdAt: null,
        });
        return 'done';
      },
    };

    const handle = engine.attach(worker);
    await waitFor(
      async () =>
        (await store.ledgerCounts('worker:dangling-emitter:v1')).done === 1,
      10_000,
    );
    await handle.stop();

    expect(attempts).toBe(2);
    // Only attempt 2's doc is committed — the dangling attempt-1 emit landed
    // in an orphaned array and was never returned/committed. (Worker
    // emissions land under a synthetic per-consumer account, not the source
    // account, so query by type rather than store.read.byExternalId.)
    const summaries = await store.read.search({ type: 'summary' });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].externalId).toBe('summary:x');
    expect(summaries[0].markdown).toBe('attempt 2 output');
  }, 15_000);

  it('connect: re-Adding a folder-scoped account WITHOUT a picker keeps its folder selection; a picker connect replaces it', async () => {
    let usePicker = false;
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'scoped',
        name: 'Scoped',
        documentTypes: ['note'],
        auth: 'none',
        folderScope: true,
      },
      async connect(auth) {
        const picked = usePicker
          ? await auth.pickFolders({
              modes: [{ key: 'm', label: 'M' }],
              roots: async () => [],
              children: async () => [],
            })
          : [{ id: 'mail', name: 'All mail' }];
        return {
          identifier: 'me@test',
          config: {
            tenant: usePicker ? 'b' : 'a',
            folderRoots: picked.map((n) => ({ id: n.id, name: n.name })),
          },
        };
      },
      async *pull() {},
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const auth = {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [
        { id: 'P', name: 'Picked', hasChildren: false },
      ],
    };
    const first = await engine.connect(source, auth);
    // The user widened the scope in Manage.
    const widened = [
      { id: 'mail', name: 'All mail' },
      { id: 'TRASH', name: 'Trash' },
    ];
    await store.applyFolderScope({
      accountId: first.id,
      expectedConfigJson: JSON.stringify(first.config),
      config: { ...first.config, folderRoots: widened },
      cursor: null,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [],
      archiveRefs: [],
    } as never);

    const again = await engine.connect(source, auth);
    expect(again.id).toBe(first.id);
    // Scope survives; the rest of the fresh config still wins.
    expect(again.config).toEqual({ tenant: 'a', folderRoots: widened });

    usePicker = true;
    const picked = await engine.connect(source, auth);
    expect(picked.config).toEqual({
      tenant: 'b',
      folderRoots: [{ id: 'P', name: 'Picked' }],
    });
  });

  it('connect: re-Adding a LEGACY (undeclared) folder-scoped account without a picker keeps it undeclared', async () => {
    // MS365 has no reauthenticate: an expired token says "remove and add it
    // again". Adding without removing must not turn connect's defaults into
    // a declared scope — the next reconcile would archive everything outside
    // them under a full allowance.
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'scoped',
        name: 'Scoped',
        documentTypes: ['note'],
        auth: 'none',
        folderScope: true,
      },
      async connect() {
        return {
          identifier: 'me@test',
          config: {
            tenantKind: 'work',
            folderRoots: [{ id: 'inbox', name: 'Inbox' }],
          },
        };
      },
      async *pull() {},
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const legacy = await store.createAccount({
      source: 'scoped',
      identifier: 'me@test',
      config: { tenantKind: 'work' },
      status: 'connecting',
    });
    const again = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    expect(again.id).toBe(legacy.id);
    expect(again.config).toEqual({ tenantKind: 'work' });
  });

  it('connect: reconnecting an existing (source, identifier) upserts the account, stops the old running loop, no duplicate', async () => {
    let attempt = 0;
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        attempt += 1;
        return { identifier: 'fake@test', config: { attempt } };
      },
      // A never-ending live source: stays running until explicitly stopped.
      async *pull(_session, cursor) {
        for (;;) {
          yield {
            phase: 'live' as const,
            items: [],
            cursor: (cursor ?? 0) + 1,
          };
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => {
            setTimeout(r, 20);
          });
        }
      },
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const auth = {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    };

    const account1 = await engine.connect(source, auth);
    expect(account1.config).toEqual({ attempt: 1 });
    const handle1 = engine.run(account1);
    await waitFor(
      async () => (await store.account(account1.id))?.status === 'live',
    );

    // Reconnecting the SAME identifier while the account is still syncing
    // must not throw (no UNIQUE constraint) and must stop the old loop.
    const account2 = await engine.connect(source, auth);
    expect(account2.id).toBe(account1.id); // same account — not a duplicate row
    expect(account2.config).toEqual({ attempt: 2 }); // latest config wins
    expect(handle1.status).toBe('paused'); // old loop stopped by connect()

    const rows = (await store.read.accounts()).filter(
      (a) => a.source === 'fake',
    );
    expect(rows).toHaveLength(1);

    const handle2 = engine.run(account2);
    await waitFor(
      async () => (await store.account(account2.id))?.status === 'live',
    );
    await handle2.stop();
  });

  it('run: repeated re-runs never leave two pull loops running concurrently', async () => {
    // Regression: handle.stop() used to delete the running-map entry
    // unconditionally. A re-run (cadence tick, sync-now) replaces the map
    // entry with its own handle BEFORE awaiting prev.stop() — so the old
    // handle's delete removed the NEW entry, and the run after that found
    // no prev to stop and started a second concurrent loop. For a source
    // like WhatsApp that means two sockets on the same session creds.
    let active = 0;
    let maxActive = 0;
    let starts = 0;
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'fake@test' };
      },
      // Never-ending abort-aware pull, like a realtime socket source —
      // deliberately produces no batches, only blocks until aborted.
      // eslint-disable-next-line require-yield
      async *pull(session) {
        active += 1;
        starts += 1;
        maxActive = Math.max(maxActive, active);
        try {
          await new Promise<void>((resolve) => {
            if (session.signal.aborted) {
              resolve();
              return;
            }
            session.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        } finally {
          active -= 1;
        }
      },
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });

    engine.run(account);
    await waitFor(async () => starts === 1);
    engine.run(account); // replaces loop 1
    await waitFor(async () => starts === 2 && active === 1);
    const handle3 = engine.run(account); // must replace loop 2, not join it
    await waitFor(async () => starts === 3);
    expect(maxActive).toBe(1);
    await handle3.stop();
  });

  it('isRunning: false before run, after a finite pull completes, and after stop()', async () => {
    // A finished loop stays in the running map until stop() — isRunning must
    // report the LOOP's liveness, not map membership, or cadence ticks would
    // never re-pull a batch source again.
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });

    expect(engine.isRunning(account.id)).toBe(false);
    engine.run(account);
    // Fake source ends fast: wait for the natural finish, no stop() involved.
    await waitFor(async () => (await store.account(account.id))?.cursor === 2);
    await waitFor(async () => !engine.isRunning(account.id));

    const handle = engine.run(account);
    await handle.stop();
    expect(engine.isRunning(account.id)).toBe(false);
  });

  it('isRunning: stays true for a live source whose pull never ends (cadence must not replace it)', async () => {
    // The start-if-idle cadence tick keys off this: a live source holding a
    // socket keeps yielding forever, and isRunning=true is what stops the
    // tick from tearing the connection down for a fresh login every 15m.
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'fake@test' };
      },
      async *pull(session) {
        yield { phase: 'live', items: [doc('a')], cursor: 1 } as Batch<
          number,
          DocumentInput
        >;
        await new Promise<void>((resolve) => {
          if (session.signal.aborted) {
            resolve();
            return;
          }
          session.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
      },
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });

    const handle = engine.run(account);
    // First batch committed and the pull is parked on its socket — still running.
    await waitFor(
      async () => (await store.account(account.id))?.status === 'live',
    );
    expect(engine.isRunning(account.id)).toBe(true);
    await handle.stop();
    expect(engine.isRunning(account.id)).toBe(false);
  });

  it('run: a retry re-resolves the source from the registry (extension respawn swaps the proxy)', async () => {
    // Regression: run() captured the source once. When an extension host
    // crashes mid-pull, its respawn registers a FRESH proxy — the captured
    // one is bound to the dead child's endpoint and fails every retry with
    // 'endpoint disposed'.
    const good = fakeSource();
    const dead: Source<number, DocumentInput> = {
      descriptor: good.descriptor,
      async connect() {
        return { identifier: 'fake@test' };
      },
      // eslint-disable-next-line require-yield
      async *pull(): AsyncGenerator<Batch<number, DocumentInput>> {
        throw new Error('endpoint disposed');
      },
      toDocument: (item) => item,
    };
    let gets = 0;
    const engine = createEngine({
      store,
      sources: {
        get: (id) => {
          if (id !== 'fake') return undefined;
          gets += 1;
          // Initial capture + first attempt see the dead proxy; the retry
          // must pick up the replacement.
          return gets <= 2 ? dead : good;
        },
      },
      inference: {
        complete: async () => 'summary!',
        see: async () => 'seen',
        read: async () => 'read!',
        hear: async () => 'heard!',
      },
      convert: async (input) => input,
      logs: noopLogs,
    });
    const account = await engine.connect(good, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });

    const handle = engine.run(account);
    // First retry backs off ~2s; well before the 5-retry give-up (~30s).
    await waitFor(
      async () => (await store.account(account.id))?.cursor === 2,
      8000,
    );
    expect(await store.read.count({ account: account.id })).toBe(3);
    await handle.stop();
  }, 15000);

  it('updateConfig: when no loop is running, persists config without starting one', async () => {
    const account = await store.createAccount({
      source: 'test',
      identifier: 'x',
    });
    const engine = makeEngine(fakeSource());

    await engine.updateConfig(account.id, { roots: ['/a'] });

    const acc = await store.account(account.id);
    expect(acc?.config).toEqual({ roots: ['/a'] });
    expect(acc?.status).toBe('connecting'); // unchanged — no loop was started
  });

  it('updateConfig: a paused account is NOT restarted — config persists, the pause survives', async () => {
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    const handle = engine.run(account);
    // Let the finite source finish naturally: only stop() deletes the
    // running-map entry, so after a natural completion it survives — exactly
    // the state a mid-life account is in when the user hits pause.
    await waitFor(async () => (await store.account(account.id))?.cursor === 2);

    // Pause the way main.ts accounts:pause does — a status-only commit that
    // does NOT stop the handle.
    const paused = await store.account(account.id);
    await store.commit({
      account: account.id,
      documents: [],
      cursor: paused!.cursor,
      status: 'paused',
    });

    await engine.updateConfig(account.id, { roots: ['/p'] });
    // Give a wrongly-restarted loop time to run and flip status back to live.
    await new Promise((r) => {
      setTimeout(r, 300);
    });

    const after = await store.account(account.id);
    expect(after?.config).toEqual({ roots: ['/p'] }); // persisted
    expect(after?.status).toBe('paused'); // NOT silently resumed
    await handle.stop();
  });

  it('pause during an ACTIVE backfill stops the loop — status stays paused, no further batches', async () => {
    // Unlike the updateConfig test above — which pauses only AFTER a finite
    // source has finished pulling — this pauses while the source is still
    // producing batches. A status-only 'paused' commit (the old accounts:pause)
    // did not stop the loop, so its next batch commit flipped the status back
    // to 'backfilling'/'live' — the account silently resumed. engine.pause()
    // must abort the loop first, so the pause sticks and no further batch lands.
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'fake@test' };
      },
      async *pull(_session, cursor) {
        const pages: Array<Batch<number, DocumentInput>> = [
          { phase: 'backfill', items: [doc('a')], cursor: 1, estimateTotal: 2 },
          { phase: 'backfill', items: [doc('b')], cursor: 2, estimateTotal: 2 },
        ];
        const remaining = pages.slice(cursor ?? 0);
        if (remaining[0]) yield remaining[0];
        // Suspend mid-backfill so the test can pause between batches.
        await gate;
        if (remaining[1]) yield remaining[1];
      },
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    // Start the sync loop; engine.pause() below stops it (no cleanup handle
    // needed).
    engine.run(account);
    // Wait until batch 1 landed — the account is now actively backfilling.
    await waitFor(
      async () => (await store.account(account.id))?.status === 'backfilling',
    );

    // Pause via the engine (what accounts:pause now delegates to). Start it,
    // then release the gate so the aborted pull generator can unwind — the same
    // start/release/await ordering the tail-race test below uses so stop()'s
    // teardown never deadlocks on the gate.
    const pausing = engine.pause(account.id);
    releaseGate!();
    await pausing;

    // Give a wrongly-alive loop ample time to pull batch 2 and overwrite status.
    await new Promise((r) => {
      setTimeout(r, 300);
    });

    const after = await store.account(account.id);
    expect(after?.status).toBe('paused'); // stays paused — loop was stopped
    expect(after?.cursor).toBe(1); // batch 2 was never pulled
    expect(await store.read.byExternalId(account.id, 'b', 'note')).toBeNull();
  });

  it('a supervisor restart inside the pause stop-to-commit window is refused — the pause sticks', async () => {
    // The cadence tick doubles as a loop supervisor: not running + committed
    // status not 'paused' → it (re)starts the loop. engine.pause() stops the
    // loop BEFORE committing 'paused', and that commit is worker-RPC-based —
    // it can queue behind other accounts' batches. Inside that window the
    // tick's two reads are both stale (isRunning=false, status still
    // 'backfilling'), so it would resurrect the loop the user just paused,
    // whose batch commits then overwrite 'paused' — the v0.45.0 bug through a
    // different door. run() must refuse via the pause intent (window open)
    // and via the committed status (tick read stale status BEFORE the commit
    // landed, called run() after the intent cleared).
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'fake@test' };
      },
      async *pull(_session, cursor) {
        const pages: Array<Batch<number, DocumentInput>> = [
          { phase: 'backfill', items: [doc('a')], cursor: 1, estimateTotal: 2 },
          { phase: 'backfill', items: [doc('b')], cursor: 2, estimateTotal: 2 },
        ];
        const remaining = pages.slice(cursor ?? 0);
        if (remaining[0]) yield remaining[0];
        // Suspend mid-backfill so the test can pause between batches.
        await gate;
        if (remaining[1]) yield remaining[1];
      },
      toDocument: (item) => item,
    };
    // Hold the 'paused' status commit in flight to force the stop-to-commit
    // window open deterministically (in production it's the DB worker's RPC
    // queue that stretches it).
    let signalPausedCommitInFlight!: () => void;
    const pausedCommitInFlight = new Promise<void>((resolve) => {
      signalPausedCommitInFlight = resolve;
    });
    let releasePausedCommit!: () => void;
    const pausedCommitGate = new Promise<void>((resolve) => {
      releasePausedCommit = resolve;
    });
    const gatedStore: CoreStore = {
      ...store,
      async commit(batch) {
        if ('status' in batch && batch.status === 'paused') {
          signalPausedCommitInFlight();
          await pausedCommitGate;
        }
        return store.commit(batch);
      },
    };
    const engine = createEngine({
      store: gatedStore,
      sources: { get: (id) => (id === 'fake' ? source : undefined) },
      inference: {
        complete: async () => 'summary!',
        see: async () => 'seen',
        read: async () => 'read!',
        hear: async () => 'heard!',
      },
      convert: async (input) => input,
      logs: noopLogs,
    });
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    engine.run(account);
    await waitFor(
      async () => (await store.account(account.id))?.status === 'backfilling',
    );

    // Pause, release the pull gate so the aborted generator can unwind, then
    // wait until stop() has settled and the 'paused' commit is IN FLIGHT —
    // exactly the window the tick fires into.
    const pausing = engine.pause(account.id);
    releaseGate!();
    await pausedCommitInFlight;

    // The tick's exact start path (boot.ts runAccount cadence job): both of
    // its reads are stale inside the window.
    expect(engine.isRunning(account.id)).toBe(false);
    const fresh = await store.account(account.id);
    expect(fresh?.status).toBe('backfilling'); // stale — the TOCTOU read
    if (fresh && fresh.status !== 'paused') engine.run(fresh); // refused

    // Let the pause finish (commit lands, intent clears).
    releasePausedCommit!();
    await pausing;

    // Second door: a tick that read the stale 'backfilling' BEFORE the commit
    // landed but reaches run() only after the intent cleared. The loop-entry
    // committed-status recheck must refuse it.
    engine.run(fresh!);

    // A resurrected loop would pull batch 2 (its gate is already open) and
    // overwrite 'paused' — give it ample time to prove it can't.
    await new Promise((r) => {
      setTimeout(r, 300);
    });

    const after = await store.account(account.id);
    expect(after?.status).toBe('paused'); // never resurrected
    expect(after?.cursor).toBe(1); // batch 2 was never pulled
    expect(await store.read.byExternalId(account.id, 'b', 'note')).toBeNull();
  });

  it('run() on an account whose committed status is paused refuses to start — sync-now cannot undo a pause', async () => {
    const source = fakeSource();
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    // Idle-account pause: no loop is running, so this is the plain
    // status-only 'paused' commit.
    await engine.pause(account.id);
    expect((await store.account(account.id))?.status).toBe('paused');

    // Sync-now style start with a STALE caller copy (its status read predates
    // the pause). The loop re-reads the committed status at entry and must
    // refuse — only an explicit resume may start a paused account.
    engine.run({ ...account, status: 'connecting' });
    await new Promise((r) => {
      setTimeout(r, 300);
    });

    const after = await store.account(account.id);
    expect(after?.status).toBe('paused');
    expect(await store.read.count({ account: account.id })).toBe(0); // no pull
  });

  it('explicit resume after pause starts the loop again and finishes the backfill', async () => {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'fake@test' };
      },
      async *pull(_session, cursor) {
        const pages: Array<Batch<number, DocumentInput>> = [
          { phase: 'backfill', items: [doc('a')], cursor: 1, estimateTotal: 2 },
          { phase: 'backfill', items: [doc('b')], cursor: 2, estimateTotal: 2 },
        ];
        const remaining = pages.slice(cursor ?? 0);
        if (remaining[0]) yield remaining[0];
        // Suspend mid-backfill so the test can pause between batches.
        await gate;
        if (remaining[1]) yield remaining[1];
      },
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    engine.run(account);
    await waitFor(
      async () => (await store.account(account.id))?.status === 'backfilling',
    );
    const pausing = engine.pause(account.id);
    releaseGate!();
    await pausing;
    expect((await store.account(account.id))?.status).toBe('paused');

    // Explicit user resume — the ONE door back in. engine.resume clears the
    // pause intent and commits 'connecting' (what accounts:resume does before
    // runAccount), so run()'s guards pass and the backfill completes from the
    // persisted cursor.
    const resumed = await engine.resume(account.id);
    expect(resumed?.status).toBe('connecting');
    const handle = engine.run(resumed!);
    await waitFor(async () => (await store.account(account.id))?.cursor === 2);
    expect(
      await store.read.byExternalId(account.id, 'b', 'note'),
    ).not.toBeNull();
    await handle.stop();
  });

  it('updateConfig: while a loop is running, persists config and restarts it (old handle stopped)', async () => {
    const source: Source<number, DocumentInput> = {
      descriptor: {
        id: 'fake',
        name: 'Fake',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'fake@test', config: { roots: ['/a'] } };
      },
      // A never-ending live source: stays running until explicitly stopped.
      async *pull(_session, cursor) {
        for (;;) {
          yield {
            phase: 'live' as const,
            items: [],
            cursor: (cursor ?? 0) + 1,
          };
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => {
            setTimeout(r, 20);
          });
        }
      },
      toDocument: (item) => item,
    };
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    const handle1 = engine.run(account);
    await waitFor(
      async () => (await store.account(account.id))?.status === 'live',
    );

    await engine.updateConfig(account.id, { roots: ['/a', '/b'] });

    expect(handle1.status).toBe('paused'); // old loop was stopped
    const acc = await store.account(account.id);
    expect(acc?.config).toEqual({ roots: ['/a', '/b'] }); // persisted

    // A fresh loop took over — cursor keeps advancing past the restart point.
    const cursorAtRestart = acc?.cursor as number;
    await waitFor(async () => {
      const fresh = await store.account(account.id);
      return (
        typeof fresh?.cursor === 'number' && fresh.cursor > cursorAtRestart
      );
    });

    await engine.remove(account.id); // stop the fresh loop, clean up
  });

  it('toDocument returning an array commits every document, parent first', async () => {
    const source: Source<number, string> = {
      descriptor: {
        id: 'multi',
        name: 'Multi',
        documentTypes: ['note', 'attachment'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'multi@test' };
      },
      async *pull() {
        yield { phase: 'live' as const, items: ['t1'], cursor: 1 };
      },
      toDocument: (id) => [
        doc(id),
        {
          ...doc(`${id}/att`),
          type: 'attachment',
          parent: { externalId: id, type: 'note' },
        },
      ],
    };
    const engine = makeEngine(source);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });

    const handle = engine.run(account);
    await waitFor(
      async () => (await store.read.count({ account: account.id })) === 2,
    );
    await handle.stop();

    const child = await store.read.byExternalId(
      account.id,
      't1/att',
      'attachment',
    );
    const parent = await store.read.byExternalId(account.id, 't1', 'note');
    expect(child?.parentId).toBe(parent?.id); // resolved in the same tx
  });

  describe('reconcile', () => {
    /** A pull() that never yields — stands in for a perpetual source (imap's
     *  live poll loop, local-folder's watchLoop) sitting quietly between
     *  upstream events. Using it lets these tests pre-seed documents directly
     *  and observe reconcile's fire-and-forget pass in isolation, with no
     *  OTHER commit racing it for the `error` field. `reconcile` is supplied
     *  per-test via `overrides`. */
    function hangingSource(
      overrides: Pick<Source<number, DocumentInput>, 'reconcile'>,
    ): Source<number, DocumentInput> {
      return {
        descriptor: {
          id: 'fake-reconcile',
          name: 'FakeReconcile',
          documentTypes: ['note'],
          auth: 'none',
        },
        async connect() {
          return { identifier: 'fake-reconcile@test' };
        },
        // Never yields — stands in for a perpetual source's live phase
        // sitting quietly between upstream events (see the doc comment
        // above).
        // eslint-disable-next-line require-yield
        async *pull() {
          await new Promise<never>(() => {});
        },
        toDocument: (item) => item,
        ...overrides,
      };
    }

    async function seedThreeDocs(
      source: Source<number, DocumentInput>,
    ): Promise<{ engine: ReturnType<typeof makeEngine>; account: Account }> {
      const engine = makeEngine(source);
      const account = await engine.connect(source, {
        oauth: async () => ({}),
        showQr: () => {},
        prompt: async () => ({}),
        status: () => {},
        pickFolders: async () => [],
      });
      await store.commit({
        account: account.id,
        documents: [doc('a'), doc('b'), doc('c')],
        cursor: 1,
      });
      return { engine, account };
    }

    it('archives documents no longer listed by reconcile; a second cycle is idempotent', async () => {
      const source = hangingSource({
        async *reconcile() {
          yield [
            { externalId: 'a', type: 'note' },
            { externalId: 'b', type: 'note' },
          ];
        },
      });
      const { engine, account } = await seedThreeDocs(source);

      const handle = engine.run(account);
      await waitFor(async () => {
        const c = await store.read.byExternalId(account.id, 'c', 'note');
        return c?.archivedAt != null;
      });
      await handle.stop();

      const a = await store.read.byExternalId(account.id, 'a', 'note');
      const b = await store.read.byExternalId(account.id, 'b', 'note');
      const c = await store.read.byExternalId(account.id, 'c', 'note');
      expect(a?.archivedAt).toBeNull();
      expect(b?.archivedAt).toBeNull();
      expect(c?.archivedAt).not.toBeNull(); // unlisted — archived
      expect(await store.read.search({ account: account.id })).toHaveLength(2);
      expect(
        await store.read.search({ account: account.id, includeArchived: true }),
      ).toHaveLength(3);

      // Second cycle (e.g. a cadence restart): re-running must not error and
      // must leave the already-archived doc exactly as it is.
      const handle2 = engine.run(account);
      await new Promise((r) => {
        setTimeout(r, 300);
      });
      await handle2.stop();

      const cAfter = await store.read.byExternalId(account.id, 'c', 'note');
      expect(cAfter?.archivedAt).toBe(c?.archivedAt); // unchanged — idempotent
      const accAfter = await store.account(account.id);
      expect(accAfter?.lastError).toBeFalsy();
    });

    // The invariant two production OOMs were bought with: NOTHING whose size
    // scales with the account may sit on this thread. A 3.7M-document
    // local-folder root (the watcher walking a symlink cycle) first killed
    // the DB worker with an unpaged live-ref read, then — once that was
    // paged — killed the MAIN process with the `deletions[]`/`listed[]` the
    // pass built here instead. Reconcile now stages the listing in bounded
    // batches and reads back only counts.
    it('holds no per-account structure on the caller: listing is staged in bounded batches and live refs are never read', async () => {
      const HUGE = 25_000;
      const source = hangingSource({
        // ONE oversized page — a connector is free to yield whatever it
        // likes, so the re-chunking has to happen on our side.
        async *reconcile() {
          yield Array.from({ length: HUGE }, (_, i) => ({
            externalId: `doc-${i}`,
            type: 'note',
          }));
        },
      });
      const { engine, account } = await seedThreeDocs(source);

      const liveRefs = jest.spyOn(store, 'liveRefs');
      const staged = jest.spyOn(store, 'reconcileStage');

      const handle = engine.run(account);
      await waitFor(async () => {
        const c = await store.read.byExternalId(account.id, 'c', 'note');
        return c?.archivedAt != null;
      });
      await handle.stop();

      // The whole listing got there...
      expect(
        staged.mock.calls.reduce((n, [, refs]) => n + refs.length, 0),
      ).toBe(HUGE);
      // ...but never more than a batch at a time, and never via liveRefs.
      expect(staged.mock.calls.length).toBeGreaterThan(1);
      for (const [, refs] of staged.mock.calls) {
        expect(refs.length).toBeLessThanOrEqual(RECONCILE_STAGE_BATCH);
      }
      expect(liveRefs).not.toHaveBeenCalled();

      liveRefs.mockRestore();
      staged.mockRestore();
    });

    // Staging is a connection-scoped TEMP table, so a DB-worker restart
    // between the drain and the diff empties it — and the worker DOES restart
    // ("db worker closed" appears in production logs). A pass that tallied
    // what it staged locally would insist the listing was fine while the diff
    // reported every document missing, and for an account under the
    // mass-archive floor it would archive the lot. The listing count must come
    // from the same read as the diff.
    it('a listing lost with the DB worker refuses instead of archiving the account', async () => {
      const source = hangingSource({
        async *reconcile() {
          yield [{ externalId: 'a', type: 'note' }];
        },
      });
      const engine = makeEngine(source);
      const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);

      // The staged listing evaporated; the diff sees nothing listed and so
      // everything missing — exactly what a restarted worker reports.
      const diff = jest
        .spyOn(store, 'reconcileDiff')
        .mockResolvedValue({ listedCount: 0, liveCount: 3, deletionCount: 3 });
      const archive = jest.spyOn(store, 'reconcileArchive');

      const handle = engine.run(account);
      await waitFor(async () => {
        const acc = await store.account(account.id);
        return Boolean(acc?.lastError);
      });
      await handle.stop();

      expect(await store.account(account.id)).toMatchObject({
        lastError: expect.stringMatching(/listing came back empty/),
      });
      expect(archive).not.toHaveBeenCalled();
      for (const id of ['a', 'b', 'c']) {
        expect(
          (await store.read.byExternalId(account.id, id, 'note'))?.archivedAt,
        ).toBeNull();
      }

      diff.mockRestore();
      archive.mockRestore();
    });

    // Spec §5.8: staging that vanishes mid-pass surfaces as a thrown
    // "reconcile staging lost" from the store. Wherever it lands — a stage
    // call during the drain, or the diff itself — the pass must end with an
    // account error and nothing archived.
    it('staging lost during the drain archives nothing and surfaces an error', async () => {
      const source = hangingSource({
        async *reconcile() {
          yield [{ externalId: 'a', type: 'note' }];
          yield [{ externalId: 'b', type: 'note' }];
        },
      });
      const engine = makeEngine(source);
      const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);
      const stage = jest
        .spyOn(store, 'reconcileStage')
        .mockRejectedValue(
          new Error(`reconcile staging lost for ${account.id} — restarted`),
        );
      const archive = jest.spyOn(store, 'reconcileArchive');
      const handle = engine.run(account);
      await waitFor(async () => !!(await store.account(account.id))?.lastError);
      await handle.stop();
      expect((await store.account(account.id))?.lastError).toMatch(
        /reconcile staging lost/,
      );
      expect(archive).not.toHaveBeenCalled();
      expect(await store.read.count({ account: account.id })).toBe(3);
      stage.mockRestore();
      archive.mockRestore();
    });

    it('staging lost at the diff archives nothing and surfaces an error', async () => {
      const source = hangingSource({
        async *reconcile() {
          yield [{ externalId: 'a', type: 'note' }];
        },
      });
      const engine = makeEngine(source);
      const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);
      const diff = jest
        .spyOn(store, 'reconcileDiff')
        .mockRejectedValue(
          new Error(`reconcile staging lost for ${account.id} — restarted`),
        );
      const archive = jest.spyOn(store, 'reconcileArchive');
      const handle = engine.run(account);
      await waitFor(async () => !!(await store.account(account.id))?.lastError);
      await handle.stop();
      expect((await store.account(account.id))?.lastError).toMatch(
        /reconcile staging lost/,
      );
      expect(archive).not.toHaveBeenCalled();
      expect(await store.read.count({ account: account.id })).toBe(3);
      diff.mockRestore();
      archive.mockRestore();
    });

    it('reconcile that throws surfaces an error like other sync failures, but archives nothing', async () => {
      const source = hangingSource({
        // Always throws before any yield — a fixed AsyncIterable<ExternalRef[]>
        // return type still requires this to be written as a generator.
        // eslint-disable-next-line require-yield
        async *reconcile() {
          throw new Error('reconcile boom');
        },
      });
      const { engine, account } = await seedThreeDocs(source);

      const handle = engine.run(account);
      await waitFor(async () => {
        const acc = await store.account(account.id);
        return !!acc?.lastError;
      });
      await handle.stop();

      const acc = await store.account(account.id);
      expect(acc?.lastError).toMatch(/reconcile/i);
      const a = await store.read.byExternalId(account.id, 'a', 'note');
      const b = await store.read.byExternalId(account.id, 'b', 'note');
      const c = await store.read.byExternalId(account.id, 'c', 'note');
      expect(a?.archivedAt).toBeNull();
      expect(b?.archivedAt).toBeNull();
      expect(c?.archivedAt).toBeNull(); // nothing archived off a failed listing
    });

    it('reconcile aborted mid-stream: the partial listing is discarded, nothing archived', async () => {
      let releaseGate: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let sawFirstPage = false;
      const source = hangingSource({
        async *reconcile(session) {
          yield [{ externalId: 'a', type: 'note' }];
          sawFirstPage = true;
          await gate;
          // Real sources (local-folder, imap) check this between yields too —
          // the engine's own abortable() wrapper is a second, defensive layer.
          if (session.signal.aborted) return;
          yield [{ externalId: 'b', type: 'note' }];
        },
      });
      const { engine, account } = await seedThreeDocs(source);

      const handle = engine.run(account);
      await waitFor(async () => sawFirstPage);
      const stopped = handle.stop();
      releaseGate?.();
      await stopped;

      expect(handle.status).toBe('paused'); // Task 1's abort semantics preserved
      const acc = await store.account(account.id);
      expect(acc?.lastError).toBeFalsy();
      const a = await store.read.byExternalId(account.id, 'a', 'note');
      const b = await store.read.byExternalId(account.id, 'b', 'note');
      const c = await store.read.byExternalId(account.id, 'c', 'note');
      expect(a?.archivedAt).toBeNull();
      expect(b?.archivedAt).toBeNull();
      expect(c?.archivedAt).toBeNull(); // only 'a' was listed before the abort — no diff taken
    });

    /** Seed WITHOUT engine.connect — connect grants a one-shot mass-archive
     *  allowance (a re-connect legitimately re-scopes an account), and these
     *  breaker tests need the allowance absent. */
    async function seedDocsDirect(
      engine: ReturnType<typeof makeEngine>,
      source: Source<number, DocumentInput>,
      externalIds: string[],
    ): Promise<Account> {
      const account = await store.createAccount({
        source: source.descriptor.id,
        identifier: 'breaker@test',
      });
      await store.commit({
        account: account.id,
        documents: externalIds.map((id) => doc(id)),
        cursor: 1,
      });
      return account;
    }

    /** §5.3: a folder-scoped account whose config declares no scope (a
     *  legacy MS365/Gmail account before its first Save) has nothing to
     *  reconcile against — its enumeration is the connector's default, not a
     *  declared set — so the engine never runs a pass for it. */
    function scopeSkipSource(folderScope: boolean) {
      const pulled = jest.fn();
      const reconciled = jest.fn();
      const base = hangingSource({
        async *reconcile() {
          reconciled();
          yield [];
        },
      });
      const source: Source<number, DocumentInput> = {
        ...base,
        descriptor: {
          ...base.descriptor,
          ...(folderScope ? { folderScope: true } : {}),
        },
        // eslint-disable-next-line require-yield
        async *pull() {
          pulled();
          await new Promise<never>(() => {});
        },
      };
      return { source, pulled, reconciled };
    }

    async function seedWithConfig(
      source: Source<number, DocumentInput>,
      config: Record<string, unknown>,
    ): Promise<Account> {
      const account = await store.createAccount({
        source: source.descriptor.id,
        identifier: 'skip@test',
        config,
      });
      await store.commit({
        account: account.id,
        documents: [doc('a'), doc('b'), doc('c')],
        cursor: 1,
      });
      return account;
    }

    it('skip rule: a folder-scoped account that declares no scope never reconciles', async () => {
      const { source, pulled, reconciled } = scopeSkipSource(true);
      const engine = makeEngine(source);
      const account = await seedWithConfig(source, {});

      const handle = engine.run(account);
      await waitFor(async () => pulled.mock.calls.length > 0);
      await new Promise((r) => setTimeout(r, 50));
      await handle.stop();

      expect(reconciled).not.toHaveBeenCalled();
      expect((await store.account(account.id))?.lastError).toBeFalsy();
    });

    it('skip rule control: a folder-scoped account with Drive-style roots DOES reconcile', async () => {
      const { source, reconciled } = scopeSkipSource(true);
      const engine = makeEngine(source);
      const account = await seedWithConfig(source, {
        roots: [{ rootFolderId: 'r', rootName: 'R' }],
      });

      const handle = engine.run(account);
      await waitFor(async () => !!(await store.account(account.id))?.lastError);
      await handle.stop();

      expect(reconciled).toHaveBeenCalled();
      expect((await store.account(account.id))?.lastError).toMatch(
        /listing came back empty/,
      );
    });

    it('skip rule control: a source without folderScope reconciles with an empty config', async () => {
      const { source, reconciled } = scopeSkipSource(false);
      const engine = makeEngine(source);
      const account = await seedWithConfig(source, {});

      const handle = engine.run(account);
      await waitFor(async () => !!(await store.account(account.id))?.lastError);
      await handle.stop();

      expect(reconciled).toHaveBeenCalled();
    });

    it('refuses to archive off an EMPTY listing over a non-empty corpus', async () => {
      // The "silently empty listing" class: imap resolving zero mailboxes,
      // an unmounted drive slipping past a source guard. Never normal churn.
      const source = hangingSource({
        async *reconcile() {
          yield [];
        },
      });
      const engine = makeEngine(source);
      const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);

      const handle = engine.run(account);
      await waitFor(async () => !!(await store.account(account.id))?.lastError);
      await handle.stop();

      const acc = await store.account(account.id);
      expect(acc?.lastError).toMatch(/refusing to archive 3 of 3/);
      expect(acc?.lastError).toMatch(/listing came back empty/);
      for (const id of ['a', 'b', 'c']) {
        const d = await store.read.byExternalId(account.id, id, 'note');
        expect(d?.archivedAt).toBeNull();
      }
    });

    it('refuses a >50% shrinkage over the 100-doc floor (mass-archive breaker)', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `d${i}`);
      const source = hangingSource({
        async *reconcile() {
          // Lists only 30 of 150 — the shape of a key-scheme drift or a
          // partial-listing bug, not plausible upstream churn.
          yield ids
            .slice(0, 30)
            .map((externalId) => ({ externalId, type: 'note' }));
        },
      });
      const engine = makeEngine(source);
      const account = await seedDocsDirect(engine, source, ids);

      const handle = engine.run(account);
      await waitFor(async () => !!(await store.account(account.id))?.lastError);
      await handle.stop();

      expect((await store.account(account.id))?.lastError).toMatch(
        /refusing to archive 120 of 150/,
      );
      // Nothing archived: every live doc still visible to default search.
      expect(await store.read.count({ account: account.id })).toBe(150);
    });

    it('a config change lets the next pass through the breaker (root removal / re-scope)', async () => {
      const ids = Array.from({ length: 150 }, (_, i) => `d${i}`);
      const source = hangingSource({
        async *reconcile() {
          yield ids
            .slice(0, 30)
            .map((externalId) => ({ externalId, type: 'note' }));
        },
      });
      const engine = makeEngine(source);
      const account = await seedDocsDirect(engine, source, ids);

      // The documented escape hatch: re-saving the account's settings.
      await engine.updateConfig(account.id, { rescoped: true });

      const handle = engine.run(account);
      await waitFor(
        async () => (await store.read.count({ account: account.id })) === 30,
      );
      await handle.stop();

      expect((await store.account(account.id))?.lastError).toBeFalsy();
      expect(
        await store.read.count({ account: account.id, includeArchived: true }),
      ).toBe(150); // archived, not purged
    });

    it('a document pull() commits WHILE reconcile is still draining is not archived (TOCTOU guard)', async () => {
      let releaseReconcileGate: (() => void) | undefined;
      const reconcileGate = new Promise<void>((resolve) => {
        releaseReconcileGate = resolve;
      });
      const source: Source<number, DocumentInput> = {
        descriptor: {
          id: 'fake-toctou',
          name: 'FakeTOCTOU',
          documentTypes: ['note'],
          auth: 'none',
        },
        async connect() {
          return { identifier: 'fake-toctou@test' };
        },
        async *pull() {
          // Commits 'b' — brand new, something reconcile's already-taken
          // snapshot (below) has no way of knowing about — then goes quiet.
          yield { phase: 'live' as const, items: [doc('b')], cursor: 1 };
          await new Promise<never>(() => {});
        },
        toDocument: (item) => item,
        async *reconcile() {
          // Snapshot only ever saw 'a'. Held open past pull()'s commit of
          // 'b' via the gate, so liveRefs() below is read only AFTER 'b'
          // exists — the exact window a naive (non-startSeq-guarded) diff
          // would misread as "'b' is live but unlisted, archive it".
          yield [{ externalId: 'a', type: 'note' }];
          await reconcileGate;
        },
      };
      const engine = makeEngine(source);
      const account = await engine.connect(source, {
        oauth: async () => ({}),
        showQr: () => {},
        prompt: async () => ({}),
        status: () => {},
        pickFolders: async () => [],
      });
      await store.commit({
        account: account.id,
        documents: [doc('a')],
        cursor: 1,
      });

      const handle = engine.run(account);
      await waitFor(
        async () =>
          (await store.read.byExternalId(account.id, 'b', 'note')) !== null,
      );
      releaseReconcileGate?.();
      // Give reconcile time to resume, finish its (now stale) drain, and
      // commit its diff — without the startSeq guard this is exactly when
      // 'b' would get archived.
      await new Promise((r) => {
        setTimeout(r, 300);
      });
      await handle.stop();

      const a = await store.read.byExternalId(account.id, 'a', 'note');
      const b = await store.read.byExternalId(account.id, 'b', 'note');
      expect(a?.archivedAt).toBeNull(); // listed — stays live
      expect(b?.archivedAt).toBeNull(); // committed mid-drain — must NOT be archived
    });

    it('abort landing while a naturally-completed cycle awaits its still-running reconcile pass does not resurrect status to live', async () => {
      let releaseReconcileGate: (() => void) | undefined;
      const reconcileGate = new Promise<void>((resolve) => {
        releaseReconcileGate = resolve;
      });
      let reconcileStarted = false;
      const source: Source<number, DocumentInput> = {
        descriptor: {
          id: 'fake-tail-race',
          name: 'FakeTailRace',
          documentTypes: ['note'],
          auth: 'none',
        },
        async connect() {
          return { identifier: 'fake-tail-race@test' };
        },
        async *pull() {
          // One batch, then the generator ends — this is what drives the
          // engine into its natural "Pull stream ended cleanly" tail-commit
          // branch, exactly where the fix under test lives.
          yield { phase: 'live' as const, items: [], cursor: 1 };
        },
        toDocument: (item) => item,
        // eslint-disable-next-line require-yield -- nothing to list in this test
        async *reconcile() {
          reconcileStarted = true;
          await reconcileGate;
        },
      };
      const engine = makeEngine(source);
      const account = await engine.connect(source, {
        oauth: async () => ({}),
        showQr: () => {},
        prompt: async () => ({}),
        status: () => {},
        pickFolders: async () => [],
      });

      const handle = engine.run(account);
      await waitFor(async () => reconcileStarted);
      // reconcileStarted fires synchronously at the very top of this cycle,
      // before pull()'s one-batch loop even begins — a real-time margin
      // (unlike a microtask-counting race) guarantees pull() has ALSO
      // finished its (tiny, synchronous) work and the run loop is now
      // sitting at `await reconciling` in the tail-commit branch by the time
      // stop() lands.
      await new Promise((r) => {
        setTimeout(r, 100);
      });
      const stopped = handle.stop();
      releaseReconcileGate?.();
      await stopped;

      expect(handle.status).toBe('paused'); // must not flip back to 'live'
    });

    // alpha-cent#181: reconcile and pull share the account's `error` field.
    // Reconcile's failure must survive the successful pull batches that land
    // after it in the same cycle — and perpetual sources (imap, local-folder)
    // never reach the post-loop commit that would otherwise sort it out.
    describe('error ownership (alpha-cent#181)', () => {
      /** A live pull() that yields one batch per `release()`, forever. */
      function gatedPullSource(
        overrides: Pick<Source<number, DocumentInput>, 'reconcile'>,
      ) {
        let allowed = 0;
        let wake: (() => void) | undefined;
        const base = hangingSource(overrides);
        const source: Source<number, DocumentInput> = {
          ...base,
          async *pull(_session, cursor) {
            let n = cursor ?? 0;
            let yielded = 0;
            for (;;) {
              while (yielded >= allowed) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
              }
              yielded += 1;
              n += 1;
              yield { phase: 'live', items: [doc(`p${n}`)], cursor: n };
            }
          },
        };
        return {
          source,
          release(batches = 1) {
            allowed += batches;
            wake?.();
          },
        };
      }

      const emptyListing = {
        // eslint-disable-next-line require-yield
        async *reconcile() {},
      };

      it('a pull batch after a reconcile failure does not clear it', async () => {
        const { source, release } = gatedPullSource(emptyListing);
        const engine = makeEngine(source);
        const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);

        const handle = engine.run(account);
        await waitFor(
          async () => !!(await store.account(account.id))?.lastError,
        );
        release();
        await waitFor(
          async () =>
            !!(await store.read.byExternalId(account.id, 'p2', 'note')),
        );
        const acc = await store.account(account.id);
        await handle.stop();

        expect(acc?.cursor).toBe(2);
        expect(acc?.lastError).toMatch(/listing came back empty/);
      });

      it('a reconcile failure survives several later pull batches', async () => {
        const { source, release } = gatedPullSource(emptyListing);
        const engine = makeEngine(source);
        const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);

        const handle = engine.run(account);
        await waitFor(
          async () => !!(await store.account(account.id))?.lastError,
        );
        for (let i = 2; i <= 4; i += 1) {
          release();
          // eslint-disable-next-line no-await-in-loop
          await waitFor(
            async () =>
              !!(await store.read.byExternalId(account.id, `p${i}`, 'note')),
          );
        }
        const acc = await store.account(account.id);
        await handle.stop();

        expect(acc?.cursor).toBe(4);
        expect(acc?.lastError).toMatch(/listing came back empty/);
      });

      it('a reconcile pass with nothing to archive clears its own earlier failure', async () => {
        const source = hangingSource({
          async *reconcile() {
            yield ['a', 'b', 'c'].map((externalId) => ({
              externalId,
              type: 'note',
            }));
          },
        });
        const engine = makeEngine(source);
        const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);
        await store.setAccountStatus(account.id, {
          error: 'reconcile: the listing came back empty',
        });

        const handle = engine.run(account);
        await waitFor(
          async () => !(await store.account(account.id))?.lastError,
        );
        await handle.stop();

        expect((await store.account(account.id))?.lastError).toBeFalsy();
      });

      it("a reconcile pass with nothing to archive leaves pull's own failure in place", async () => {
        // Last cycle's pull failed; this cycle's pass is healthy before pull
        // has done anything. The failure is pull's to clear, not the pass's.
        const source = hangingSource({
          async *reconcile() {
            yield ['a', 'b', 'c'].map((externalId) => ({
              externalId,
              type: 'note',
            }));
          },
        });
        const engine = makeEngine(source);
        const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);
        await store.setAccountStatus(account.id, {
          status: 'error',
          error: 'token revoked upstream',
        });
        const recorded = jest.spyOn(store, 'setAccountStatus');

        const handle = engine.run(account);
        await waitFor(async () => recorded.mock.calls.length > 0);
        await recorded.mock.results[0].value;
        await handle.stop();
        recorded.mockRestore();

        expect((await store.account(account.id))?.lastError).toBe(
          'token revoked upstream',
        );
      });

      it("a good pull batch clears last cycle's pull failure while a pass is still running", async () => {
        let releasePass: (() => void) | undefined;
        const passGate = new Promise<void>((resolve) => {
          releasePass = resolve;
        });
        const { source, release } = gatedPullSource({
          // eslint-disable-next-line require-yield
          async *reconcile() {
            await passGate;
          },
        });
        const engine = makeEngine(source);
        const account = await seedDocsDirect(engine, source, ['a']);
        await store.setAccountStatus(account.id, {
          status: 'error',
          error: 'token revoked upstream',
        });

        const handle = engine.run(account);
        release();
        await waitFor(
          async () =>
            !!(await store.read.byExternalId(account.id, 'p2', 'note')),
        );
        const acc = await store.account(account.id);
        const stopped = handle.stop();
        releasePass?.();
        await stopped;

        expect(acc?.lastError).toBeFalsy();
      });

      it('recording the reconcile outcome never rewrites the cursor', async () => {
        // A pull batch advancing the cursor between reconcile's read of the
        // account and its write used to be rolled back by that write — here
        // the read is made stale on purpose.
        const source = hangingSource(emptyListing);
        const engine = makeEngine(source);
        const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);
        await store.commit({ account: account.id, documents: [], cursor: 5 });
        const realAccount = store.account.bind(store);
        const stale = jest
          .spyOn(store, 'account')
          .mockImplementation(async (id) => {
            const acc = await realAccount(id);
            return acc && { ...acc, cursor: 1 };
          });

        const handle = engine.run(account);
        await waitFor(async () => !!(await realAccount(account.id))?.lastError);
        await handle.stop();
        stale.mockRestore();

        expect((await store.account(account.id))?.cursor).toBe(5);
      });

      it('an aborted reconcile pass leaves an earlier failure in place', async () => {
        let releaseGate: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        let sawFirstPage = false;
        const source = hangingSource({
          async *reconcile() {
            yield [{ externalId: 'a', type: 'note' }];
            sawFirstPage = true;
            await gate;
          },
        });
        const engine = makeEngine(source);
        const account = await seedDocsDirect(engine, source, ['a', 'b', 'c']);
        await store.setAccountStatus(account.id, {
          error: 'reconcile: earlier failure',
        });

        const handle = engine.run(account);
        await waitFor(async () => sawFirstPage);
        const stopped = handle.stop();
        releaseGate?.();
        await stopped;

        expect((await store.account(account.id))?.lastError).toBe(
          'reconcile: earlier failure',
        );
      });

      it('a source without reconcile still clears a stale error on its next good batch', async () => {
        const base = gatedPullSource(emptyListing);
        const source: Source<number, DocumentInput> = {
          ...base.source,
          reconcile: undefined,
        };
        const engine = makeEngine(source);
        const account = await seedDocsDirect(engine, source, ['a']);
        await store.setAccountStatus(account.id, { error: 'old pull failure' });

        const handle = engine.run(account);
        base.release();
        await waitFor(
          async () =>
            !!(await store.read.byExternalId(account.id, 'p2', 'note')),
        );
        const acc = await store.account(account.id);
        await handle.stop();

        expect(acc?.lastError).toBeFalsy();
      });

      it('a folder-scoped account that runs no pass (undeclared) still clears a stale error', async () => {
        const base = gatedPullSource(emptyListing);
        const source: Source<number, DocumentInput> = {
          ...base.source,
          descriptor: { ...base.source.descriptor, folderScope: true },
        };
        const engine = makeEngine(source);
        const account = await seedWithConfig(source, {});
        await store.setAccountStatus(account.id, { error: 'old pull failure' });

        const handle = engine.run(account);
        base.release();
        await waitFor(
          async () =>
            !!(await store.read.byExternalId(account.id, 'p2', 'note')),
        );
        const acc = await store.account(account.id);
        await handle.stop();

        expect(acc?.lastError).toBeFalsy();
      });
    });
  });
});

async function waitFor(cond: () => Promise<boolean>, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
