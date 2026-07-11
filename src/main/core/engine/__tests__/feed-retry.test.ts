/**
 * Feed consumers (engine.attach / engine.project) are INFINITE consumers:
 * before this shell, one rejected store read during a DB-worker respawn
 * settled their loop forever — background workers silently halted and the
 * renderer's one live-state projection froze until app restart. These tests
 * pin the recovery contract: a DB_WORKER_CRASHED-coded store error is
 * retried with backoff from the durable cursor; anything un-coded still
 * stops the loop exactly as before.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Change, Projection, Worker } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { DB_WORKER_CRASHED } from '../../../db/worker-client';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { createEngine } from '../engine';

jest.setTimeout(20_000);

const noopLogs = { log: () => {} };

async function makeStore(dir: string): Promise<CoreStore> {
  return openStore(await openDb(path.join(dir, 'test.db')), {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });
}

function crashedError(): Error & { code: string } {
  const e = new Error('db worker crashed mid-request') as Error & {
    code: string;
  };
  e.code = DB_WORKER_CRASHED;
  return e;
}

/** Same store, but the named method rejects the first `times` calls. */
function flaky<K extends 'consumerCursor' | 'headSeq'>(
  store: CoreStore,
  method: K,
  err: Error,
  times = 1,
): CoreStore {
  let remaining = times;
  return {
    ...store,
    [method]: async (...args: unknown[]) => {
      if (remaining > 0) {
        remaining -= 1;
        throw err;
      }
      return (store[method] as (...a: unknown[]) => Promise<unknown>)(...args);
    },
  } as CoreStore;
}

async function waitUntil(
  cond: () => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const inference = {
  complete: async () => '',
  see: async () => '',
  read: async () => '',
  hear: async () => '',
};

function makeEngine(store: CoreStore) {
  return createEngine({
    store,
    sources: { get: () => undefined },
    inference,
    convert: async (i) => i,
    logs: noopLogs,
  });
}

describe('feed consumer crash recovery', () => {
  let dir: string;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-feed-retry-'));
    store = await makeStore(dir);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('attach resumes after a DB_WORKER_CRASHED store rejection', async () => {
    const seen: number[] = [];
    const worker: Worker = {
      name: 'retry-probe',
      version: 1,
      matches: (c: Change) => c.kind === 'document',
      work: async (c: Change) => {
        seen.push(c.seq);
        return 'done';
      },
    };
    // First consumerCursor read dies like an in-flight worker crash; the
    // loop must back off and resume rather than settle.
    const engine = makeEngine(flaky(store, 'consumerCursor', crashedError()));
    const account = await store.createAccount({
      source: 'test',
      identifier: 'me@example.com',
    });
    const handle = engine.attach(worker);
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'a',
          type: 'note',
          title: 'a',
          markdown: 'body',
          metadata: {},
          createdAt: null,
        },
      ],
      cursor: null,
    });
    await waitUntil(() => seen.length > 0);
    await handle.stop();
  });

  it('attach still stops permanently on an un-coded store error', async () => {
    const seen: number[] = [];
    const worker: Worker = {
      name: 'stop-probe',
      version: 1,
      matches: () => true,
      work: async (c: Change) => {
        seen.push(c.seq);
        return 'done';
      },
    };
    const engine = makeEngine(
      flaky(store, 'consumerCursor', new Error('disk exploded')),
    );
    const handle = engine.attach(worker) as ReturnType<typeof engine.attach> & {
      active(): boolean;
    };
    await waitUntil(() => !handle.active());
    expect(seen).toHaveLength(0);
    await handle.stop();
  });

  it('project re-initializes after a DB_WORKER_CRASHED store rejection', async () => {
    const diffs: number[] = [];
    const projection: Projection<number> = {
      init: async () => 0,
      apply: (state, changes) => state + changes.length,
    };
    // First headSeq (right after init) dies; the projection must re-init and
    // keep serving diffs — this is the renderer's only live-state channel.
    const engine = makeEngine(flaky(store, 'headSeq', crashedError()));
    const account = await store.createAccount({
      source: 'test',
      identifier: 'me@example.com',
    });
    const handle = engine.project(projection, (state) => {
      diffs.push(state);
    });
    await waitUntil(() => diffs.length > 0); // survived the crash: initial diff
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'a',
          type: 'note',
          title: 'a',
          markdown: 'body',
          metadata: {},
          createdAt: null,
        },
      ],
      cursor: null,
    });
    await waitUntil(() => diffs.length > 1); // feed diffs still flowing
    await handle.stop();
  });
});
