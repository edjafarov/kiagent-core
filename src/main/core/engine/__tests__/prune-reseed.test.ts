/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  Change,
  DocumentInput,
  Worker,
} from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import {
  pruneChangesOnce,
  registerChangesPrune,
} from '../../changes-maintenance';
import { createScheduler } from '../../scheduler';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine } from '../engine';

const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: null,
});
const T = Date.parse('2026-10-09T12:00:00.000Z');

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 8_000) {
  const until = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  }
}

describe('pruning the changes log (#59 §3b)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let clock = T;

  beforeEach(async () => {
    clock = T - 72 * 3_600_000;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prune-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
      now: () => new Date(clock).toISOString(),
    });
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me' })
    ).id;
    // Old history: eight documents, each updated once (≥ 16 document changes).
    for (const x of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      // eslint-disable-next-line no-await-in-loop
      await store.commit({
        account: accountId,
        documents: [doc(x)],
        cursor: x,
      });
      // eslint-disable-next-line no-await-in-loop
      await store.commit({
        account: accountId,
        documents: [{ ...doc(x), markdown: `v2 ${x}` }],
        cursor: x,
      });
    }
    clock = T - 3_600_000; // recent history
    await store.commit({
      account: accountId,
      documents: [doc('recent')],
      cursor: 'r',
    });
    clock = T;
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
  const minSeq = async () => store.minChangeSeq();
  const prune = (over: Partial<Parameters<typeof pruneChangesOnce>[0]> = {}) =>
    pruneChangesOnce({
      store,
      activeConsumers: () => ['worker:live:v1'],
      now: () => new Date(T),
      yieldTurn: async () => {},
      ...over,
    });
  const notes = (name: string, worked: string[]): Worker => ({
    name,
    version: 1,
    matches: (c: Change) =>
      c.kind === 'document' &&
      !c.document.archivedAt &&
      !(name in c.document.metadata),
    async work(c, session) {
      if (c.kind !== 'document') return 'skip';
      worked.push(c.document.externalId);
      session.enrich({ documentId: c.document.id, metadata: { [name]: true } });
      return 'done';
    },
  });

  it('deletes a contiguous prefix below min(floor, 48 h cutoff, head) and keeps the rest', async () => {
    await store.commit({
      consumer: 'worker:live:v1',
      cursor: await store.headSeq(),
    });
    const cutoff = await store.firstChangeSeqAt(
      new Date(T - 48 * 3_600_000).toISOString(),
    );
    const keptBefore = await db.all(
      `SELECT seq FROM changes WHERE seq >= ? ORDER BY seq`,
      [cutoff],
    );
    const r = await prune();
    expect(r).toMatchObject({ limit: cutoff });
    expect(await minSeq()).toBe(cutoff);
    expect(await db.all(`SELECT seq FROM changes ORDER BY seq`)).toEqual(
      keptBefore,
    );
    expect(await store.changesFloor()).toBe(cutoff);
  });

  it('keeps the head row when everything is older than 48 h', async () => {
    clock = T + 72 * 3_600_000;
    const head = await store.headSeq();
    await store.commit({ consumer: 'worker:live:v1', cursor: head });
    await prune({ now: () => new Date(clock) });
    expect(await db.all(`SELECT seq FROM changes`)).toEqual([{ seq: head }]);
    expect(await store.headSeq()).toBe(head);
  });

  it('interrupted after batch 1: the floor is already published, a returning consumer re-seeds, the next run finishes', async () => {
    await store.commit({
      consumer: 'worker:live:v1',
      cursor: await store.headSeq(),
    });
    await store.commit({ consumer: 'worker:back:v1', cursor: 2 });
    let n = 0;
    const killing = {
      ...store,
      deleteChangesRange: async (a: number, b: number) => {
        n += 1;
        if (n === 2) throw new Error('killed');
        return store.deleteChangesRange(a, b);
      },
    };
    await expect(prune({ store: killing, batch: 4 })).rejects.toThrow('killed');
    const limit = (await store.changesFloor())!;
    expect(limit).toBeGreaterThan(5);
    expect(await minSeq()).toBeLessThan(limit); // garbage below the floor

    const worked: string[] = [];
    const h = makeEngine().attach(notes('back', worked));
    await waitFor(
      async () =>
        (await store.consumerRow('seed:worker:back:v1')) === null &&
        worked.length === 9,
    );
    await h.stop();
    expect([...worked].sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
      'h',
      'recent',
    ]);

    await prune({ batch: 4 });
    expect(await minSeq()).toBeGreaterThanOrEqual(limit);
  });

  it('an attach between the floor publish and the deletes re-seeds', async () => {
    await store.commit({ consumer: 'worker:mid:v1', cursor: 3 });
    await store.publishChangesFloor(10); // deletes not yet run
    const worked: string[] = [];
    const h = makeEngine().attach(notes('mid', worked));
    await waitFor(
      async () =>
        (await store.consumerRow('seed:worker:mid:v1')) === null &&
        worked.length === 9,
    );
    await h.stop();
    expect(worked).toHaveLength(9);
  });

  it('a returning cursor inside the deleted range re-seeds', async () => {
    await store.commit({
      consumer: 'worker:live:v1',
      cursor: await store.headSeq(),
    });
    await store.commit({ consumer: 'worker:gone:v1', cursor: 2 });
    await prune();
    const worked: string[] = [];
    const h = makeEngine().attach(notes('gone', worked));
    await waitFor(
      async () =>
        (await store.consumerRow('seed:worker:gone:v1')) === null &&
        worked.length === 9,
    );
    await h.stop();
    expect(worked).toHaveLength(9);
  });

  it('re-drive (and an audio-style deferral) survive the repair and a prune', async () => {
    const m = (
      (await db.all(
        `SELECT seq FROM documents WHERE external_id = 'a'`,
      )) as Array<{ seq: number }>
    )[0].seq;
    await store.ledgerRecord('worker:hear:v2', m, 0, 'deferred');
    while (!(await store.ledgerRekeyPage()).done) {
      // already re-keyed on a fresh corpus; pages to the marker anyway
    }
    await store.commit({
      consumer: 'worker:live:v1',
      cursor: await store.headSeq(),
    });
    await prune({ now: () => new Date(T + 72 * 3_600_000) });
    expect(await db.all(`SELECT 1 FROM changes WHERE seq = ?`, [m])).toEqual(
      [],
    );
    const worker: Worker = {
      name: 'hear',
      version: 2,
      matches: () => true,
      work: async () => 'done',
    };
    await makeEngine().rerunDeferred(worker);
    expect(
      await db.all(
        `SELECT outcome FROM work_ledger WHERE consumer = 'worker:hear:v2' AND seq = ?`,
        [m],
      ),
    ).toEqual([{ outcome: 'done' }]);
  });

  it('addedSince keeps its 24 h answer across a prune', async () => {
    await store.commit({
      consumer: 'worker:live:v1',
      cursor: await store.headSeq(),
    });
    const since = new Date(T - 24 * 3_600_000).toISOString();
    const before = await store.addedSince(since);
    await prune();
    expect(await store.addedSince(since)).toEqual(before);
    expect(before).toEqual([{ accountId, count: 1 }]);
  });

  it('pruning does not run at boot (durable row says it just ran)', async () => {
    const scheduler = createScheduler(
      store,
      () => ({
        onBattery: false,
        thermal: 'nominal',
        appFocus: 'hidden',
        userActive: false,
      }),
      { log: () => {} },
    );
    await registerChangesPrune({
      store,
      scheduler,
      logs: { log: () => {} },
      activeConsumers: () => ['worker:live:v1'],
      now: () => new Date(T),
      setTimer: () => {},
    });
    const row = (await store.scheduleAll()).find(
      (r) => r.jobId === 'maintenance:prune-changes',
    )!;
    expect(Date.parse(row.nextRun!)).toBeGreaterThanOrEqual(
      T + 6 * 3_600_000 - 1_000,
    );
  });
});
