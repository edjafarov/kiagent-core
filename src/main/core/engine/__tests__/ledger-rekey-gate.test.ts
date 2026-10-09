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
});
