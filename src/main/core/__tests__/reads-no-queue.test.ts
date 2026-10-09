/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import {
  createWorkerEnv,
  WORKER_ENTRY,
} from '../../db/__tests__/worker-test-env';
import { openDbInWorker } from '../../db/worker-client';
import { openReads, type Reads } from '../reads';
import { openStore, type CoreStore } from '../store/store';

jest.setTimeout(120_000);

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

/** Pseudo-random unique tokens, so the FTS + trigram indexes do real work. */
function bigBody(seed: number, words: number): string {
  let x = seed;
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push(x.toString(36));
  }
  return out.join(' ');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('reads do not queue behind ingest writes (real writer + reader workers)', () => {
  const env = createWorkerEnv('no-queue');
  let dir: string;
  let writerDb: AppDb;
  let store: CoreStore;
  let plane: Reads;
  let account: AccountId;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-noqueue-'));
    const dbPath = path.join(dir, 'kiagent.db');
    writerDb = await openDbInWorker(dbPath, WORKER_ENTRY, {
      execArgv: env.execArgv,
    });
    store = openStore(writerDb, deps);
    account = (
      await store.createAccount({ source: 'test', identifier: 'me@x' })
    ).id;
    await store.commit({
      account,
      cursor: 1,
      documents: Array.from(
        { length: 200 },
        (_, i): DocumentInput => ({
          externalId: `seed${i}`,
          type: 'note',
          title: `Seed ${i}`,
          markdown: `alpha beta note ${i}`,
          metadata: { labels: ['L1'], from: `person${i % 7}@example.com` },
          createdAt: '2026-01-01T00:00:00Z',
        }),
      ),
    });
    plane = await openReads({
      dbPath,
      workerFile: WORKER_ENTRY,
      execArgv: env.execArgv,
      writer: store.read,
      weak: false,
      log: () => {},
    });
  });

  afterAll(async () => {
    await plane.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    env.cleanup();
  });

  it('serves search + document + countBy while the writer is mid-transaction; the writer path queues', async () => {
    const [seedHit] = await plane.reads.search({ text: 'alpha', limit: 1 });
    expect(seedHit).toBeDefined();

    // A real large ingest: DOCS documents x ~2.3 MB, FTS + trigram + stem views
    // in ONE transaction on the writer thread. Default 8 (~18 MB: enough to
    // span the reads on a normal machine without a heavy structured clone). If
    // this machine finishes it before the 300 ms check, raise DOCS until
    // `commitSettled === false` holds; if the suite nears its timeout or the
    // worker runs out of memory, lower it. Never weaken the assertions.
    const DOCS = 8;
    const documents = Array.from(
      { length: DOCS },
      (_, i): DocumentInput => ({
        externalId: `big${i}`,
        type: 'note',
        title: `Big ${i}`,
        markdown: bigBody(i + 1, 330_000),
        metadata: {},
        createdAt: '2026-02-01T00:00:00Z',
      }),
    );
    let commitSettled = false;
    const commitP = store.commit({ account, cursor: 2, documents }).then(() => {
      commitSettled = true;
    });
    await sleep(300); // the writer thread is now inside the transaction
    expect(commitSettled).toBe(false); // fixture big enough to span the reads

    const t0 = Date.now();
    const [hits, doc, counts] = await Promise.all([
      plane.reads.search({ text: 'alpha', limit: 5 }),
      plane.reads.document(seedHit.id),
      plane.reads.countBy({ field: 'label' }),
    ]);
    const readsMs = Date.now() - t0;
    expect(hits.length).toBeGreaterThan(0);
    expect(doc?.id).toBe(seedHit.id);
    expect(counts[0]).toMatchObject({ key: 'L1' });
    // The reader answered while the writer was still mid-transaction...
    expect(commitSettled).toBe(false);
    expect(readsMs).toBeLessThan(2_000);

    // ...whereas a read issued on the writer connection waits behind it.
    await store.read.document(seedHit.id);
    expect(commitSettled).toBe(true);
    await commitP;

    // Read-after-write: the resolved commit is visible to the very next reader call.
    const after = await plane.reads.search({ text: 'Big', limit: 5 });
    expect(after.length).toBeGreaterThan(0);
  });

  it('serves reads while the writer runs ONE long reconcile-stage transaction; the writer path queues behind it', async () => {
    const [seedHit] = await plane.reads.search({ text: 'alpha', limit: 1 });
    expect(seedHit).toBeDefined();

    // reconcileBegin/Stage are real writer procedures. ONE reconcileStage call
    // with REFS refs is ONE transaction on the writer thread; size it like the
    // ingest case: it must run for >= ~300 ms on this machine. If the first
    // `stageSettled === false` check fails the stage was too fast: raise REFS;
    // if the suite nears its timeout or the worker runs out of memory, lower it.
    // Never weaken the assertions.
    const REFS = 1_500_000;
    await store.reconcileBegin(account);
    const refs = Array.from({ length: REFS }, (_, i) => ({
      externalId: `stage-${i}`,
      type: 'note',
    }));
    let stageSettled = false;
    const stageP = store.reconcileStage(account, refs).then(() => {
      stageSettled = true;
    });
    await sleep(300); // the writer thread is now inside the stage transaction
    expect(stageSettled).toBe(false); // fixture big enough to span the reads

    const t0 = Date.now();
    const [hits, doc, counts] = await Promise.all([
      plane.reads.search({ text: 'alpha', limit: 5 }),
      plane.reads.document(seedHit.id),
      plane.reads.countBy({ field: 'label' }),
    ]);
    const readsMs = Date.now() - t0;
    expect(hits.length).toBeGreaterThan(0);
    expect(doc?.id).toBe(seedHit.id);
    expect(counts[0]).toMatchObject({ key: 'L1' });
    // The reader calls finished BEFORE the single stage transaction settled...
    expect(stageSettled).toBe(false);
    expect(readsMs).toBeLessThan(2_000);

    // ...whereas a read issued on the writer path waits behind it.
    await store.read.document(seedHit.id);
    expect(stageSettled).toBe(true);
    await stageP;
    await store.reconcileEnd(account);
  });
});
