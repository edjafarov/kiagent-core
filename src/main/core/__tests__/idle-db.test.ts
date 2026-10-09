/** @jest-environment node */
/**
 * #139 acceptance: over 61 s of fake time with no mutations — after boot's
 * one-shots (the primed ledger count, processingStatus.start()'s first
 * waiting count, the scheduler's 2 s catch-up incl. the re-drive probe) —
 * nothing reads work_ledger or changes.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../db/app-db';
import { createLedgerCounter } from '../processing-counter';
import { createProcessingStatus } from '../processing-status';
import { createScheduler } from '../scheduler';
import { ensureQueryIndexes } from '../store/schema';
import { openStore, type CoreStore } from '../store/store';

const C = 'worker:vision:v1';
const READERS = [
  'ledgerCountsAll',
  'ledgerCounts',
  'visualWaitingCount',
  'ledgerDeferred',
  'ledgerHasDeferred',
  'changesAt',
  'headSeq',
  'addedSince',
  'consumerCursor',
] as const;

describe('idle database (#139)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-idle-'));
    db = await openDb(path.join(dir, 'test.db'));
    ensureQueryIndexes(db._conn!);
    store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const account = await store.createAccount({
      source: 'test',
      identifier: 'me',
    });
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'img',
          type: 'file',
          title: 'img.png',
          markdown: '',
          metadata: { mime: 'image/png', sizeBytes: 50_000 },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cursor: 1,
    });
    await store.commit({ consumer: C, cursor: await store.headSeq() });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('zero ledger/changes reads over 61 idle seconds after the boot one-shots', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
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
    // The redrive cadence probe (workers/index.ts registerRedrive shape).
    await scheduler.register('worker:vision', { every: '5m' }, async () => {
      await store.ledgerHasDeferred(C);
    });
    const counter = createLedgerCounter({ store, activeConsumers: () => [C] });
    const status = createProcessingStatus({
      countWaiting: () => store.visualWaitingCount(C),
      gen: () => store.ledgerGen(),
      providers: () => [],
      activeCalls: { list: () => [], onChange: () => () => {} },
      wakeWorkers: async () => {},
      patch: () => {},
      warn: () => {},
    });

    // Boot one-shots.
    await counter.count();
    status.start();
    scheduler.start();
    const tick = setInterval(() => {
      void counter.countIfChanged();
    }, 5_000);
    await jest.advanceTimersByTimeAsync(3_000); // 2 s catch-up ran the probe

    const spies = READERS.map((m) => jest.spyOn(store, m));
    const sql: string[] = [];
    for (const m of ['all', 'run', 'batch', 'exec'] as const) {
      const orig = (db[m] as (...a: unknown[]) => Promise<unknown>).bind(db);
      jest.spyOn(db, m).mockImplementation(((...a: unknown[]) => {
        const first = a[0];
        if (typeof first === 'string') sql.push(first);
        else if (Array.isArray(first))
          for (const s of first as Array<{ sql: string }>) sql.push(s.sql);
        return orig(...a);
      }) as never);
    }

    await jest.advanceTimersByTimeAsync(61_000);
    clearInterval(tick);
    status.stop();
    scheduler.stop();

    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(sql.filter((s) => /\bwork_ledger\b|\bchanges\b/.test(s))).toEqual(
      [],
    );
  });
});
