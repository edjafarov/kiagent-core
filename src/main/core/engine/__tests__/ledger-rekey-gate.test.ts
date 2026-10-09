/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Change, DocumentInput, Worker } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine } from '../engine';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => [],
};
const doc = (
  externalId: string,
  markdown = `body ${externalId}`,
): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: null,
});

async function waitFor(
  pred: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  }
}

describe('re-drive works the current seq (#59 §0)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-rekeygate-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const makeEngine = () =>
    createEngine({
      store,
      sources: { get: () => undefined },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (d) => d,
      logs: { log: () => {} },
    });

  const currentSeq = async (externalId: string) =>
    (
      (await db.all(`SELECT seq FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ seq: number }>
    )[0].seq;

  it('two changes of one document are fed once at the current seq; defer, restart, re-drive works it', async () => {
    const account = await store.createAccount({
      source: 'test',
      identifier: 't',
    });
    await store.commit({
      account: account.id,
      documents: [doc('a')],
      cursor: 1,
    });
    await store.commit({
      account: account.id,
      documents: [doc('a', 'edited')],
      cursor: 2,
    });
    const current = await currentSeq('a');
    const seen: number[] = [];
    const worker: Worker = {
      name: 'dup',
      version: 1,
      matches: (c: Change) =>
        c.kind === 'document' && c.document.externalId === 'a',
      async work(c) {
        seen.push(c.seq);
        return seen.length === 1 ? 'defer' : 'done';
      },
    };
    const h1 = makeEngine().attach(worker);
    await waitFor(
      async () => (await store.ledgerCounts('worker:dup:v1')).deferred === 1,
    );
    await h1.stop();

    const e2 = makeEngine(); // restart
    const h2 = e2.attach(worker);
    await e2.rerunDeferred(worker);
    await h2.stop();

    expect(seen).toEqual([current, current]);
    expect(
      await db.all(
        `SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:dup:v1'`,
      ),
    ).toEqual([{ seq: current, outcome: 'done' }]);
  });

  const preUpgrade = async () => {
    // A profile written by an older build: no marker. Must run before the
    // store's first ledgerRekeyed() call (the flag is cached once true).
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`);
  };

  it('a fresh corpus is born re-keyed', async () => {
    expect(
      await db.all(`SELECT value FROM meta WHERE key = 'ledgerRekeyed'`),
    ).toEqual([{ value: '1' }]);
    expect(await store.ledgerRekeyed()).toBe(true);
  });

  it('before the repair, rerunDeferred is a no-op that reports rekey-pending', async () => {
    await preUpgrade();
    const account = await store.createAccount({
      source: 'test',
      identifier: 't',
    });
    await store.commit({
      account: account.id,
      documents: [doc('a')],
      cursor: 1,
    });
    const s = await currentSeq('a');
    await store.ledgerRecord('worker:gate:v1', s, 0, 'deferred');
    const work = jest.fn(async () => 'done' as const);
    const worker: Worker = {
      name: 'gate',
      version: 1,
      matches: () => true,
      work,
    };
    expect(await makeEngine().rerunDeferred(worker)).toEqual({
      skipped: 'rekey-pending',
    });
    expect(work).not.toHaveBeenCalled();
    expect(
      await db.all(
        `SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:gate:v1'`,
      ),
    ).toEqual([{ seq: s, outcome: 'deferred' }]);
  });

  it('Reset all keeps the marker: an empty ledger is trivially re-keyed', async () => {
    await store.maintenance.resetAll();
    expect(
      await db.all(`SELECT value FROM meta WHERE key = 'ledgerRekeyed'`),
    ).toEqual([{ value: '1' }]);
  });

  it('a deferred seq that resolves to nothing becomes a terminal skip', async () => {
    const account = await store.createAccount({
      source: 'test',
      identifier: 't',
    });
    await store.commit({
      account: account.id,
      documents: [doc('a')],
      cursor: 1,
    });
    const s = await currentSeq('a');
    await store.ledgerRecord('worker:gone:v1', s, 0, 'deferred');
    // Archive, then purge: the document is gone for good.
    await store.commit({
      account: account.id,
      documents: [],
      deletions: [{ externalId: 'a', type: 'note' }],
      cursor: 2,
    });
    await store.commit({ purgeArchived: { before: '9999-01-01T00:00:00Z' } });
    const worker: Worker = {
      name: 'gone',
      version: 1,
      matches: () => true,
      work: async () => 'done',
    };
    await makeEngine().rerunDeferred(worker);
    expect(
      await db.all(
        `SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:gone:v1'`,
      ),
    ).toEqual([{ seq: s, outcome: 'skip' }]);
  });

  it('upgrade: an overdue re-drive before the repair is a no-op; after it, (old, deferred), (cur, skip) is retried once at cur', async () => {
    await preUpgrade();
    const account = await store.createAccount({
      source: 'test',
      identifier: 't',
    });
    await store.commit({
      account: account.id,
      documents: [doc('a')],
      cursor: 1,
    });
    const old = await currentSeq('a');
    await store.commit({
      account: account.id,
      documents: [doc('a', 'edited')],
      cursor: 2,
    });
    const cur = await currentSeq('a');
    await store.ledgerRecordMany('worker:up:v1', [
      { seq: old, attempts: 1, outcome: 'deferred' },
      { seq: cur, attempts: 0, outcome: 'skip' },
    ]);
    const seen: number[] = [];
    const worker: Worker = {
      name: 'up',
      version: 1,
      matches: () => true,
      async work(c) {
        seen.push(c.seq);
        return 'done';
      },
    };
    const engine = makeEngine();
    // Scheduler catch-up at 2 s, before the repair has run:
    expect(await engine.rerunDeferred(worker)).toEqual({
      skipped: 'rekey-pending',
    });
    expect(seen).toEqual([]);

    const { registerLedgerRekey, LEDGER_REKEY_JOB_ID } = await import(
      '../../changes-maintenance'
    );
    let run: (() => Promise<void>) | null = null;
    const onDone = jest.fn();
    await registerLedgerRekey({
      store,
      scheduler: {
        register: async (id, _c, r) => {
          if (id === LEDGER_REKEY_JOB_ID) run = r;
        },
        trigger: async () => {},
      },
      logs: { log: () => {} },
      onDone,
    });
    await run!();
    expect(onDone).toHaveBeenCalledTimes(1); // → requestLaneWake in production

    expect(await engine.rerunDeferred(worker)).toBeUndefined();
    expect(seen).toEqual([cur]);
    expect(
      await db.all(
        `SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:up:v1'`,
      ),
    ).toEqual([{ seq: cur, outcome: 'done' }]);
  });

  it('engine.project still sees a document insert row after a same-batch re-stamp (read-only projection)', async () => {
    const account = await store.createAccount({
      source: 'test',
      identifier: 'p',
    });
    const inserts: string[] = [];
    const engine = makeEngine();
    let ready = false;
    const handle = engine.project<number>(
      {
        init: async () => 0,
        apply: (n, changes) => {
          for (const c of changes)
            if (c.kind === 'document' && c.seq === c.document.ingestSeq)
              inserts.push(c.document.externalId);
          return n + changes.length;
        },
      },
      () => {
        ready = true;
      },
    );
    await waitFor(async () => ready);
    // Child before its parent: the child's insert row and its re-stamp are
    // two changes of one transaction.
    await store.commit({
      account: account.id,
      documents: [
        { ...doc('child'), parent: { externalId: 'p', type: 'note' } },
        doc('p'),
      ],
      cursor: 1,
    });
    await waitFor(async () => inserts.length === 2);
    await handle.stop();
    expect(inserts.sort()).toEqual(['child', 'p']);
  });
});
