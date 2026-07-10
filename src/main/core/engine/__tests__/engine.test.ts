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
import { createEngine } from '../engine';

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
    expect(await store.ledgerDeferred(consumer)).toEqual([deferredSeq]);

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
    expect(await store.ledgerDeferred(consumer)).toEqual([]); // deferred entry resolved
    const after = await store.read.byExternalId(account.id, 'scan', 'note');
    expect(after?.markdown).toBe('real rich markdown that is plenty long'); // not clobbered
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
  });
});

async function waitFor(cond: () => Promise<boolean>, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
}
