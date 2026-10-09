/**
 * Changes-log maintenance (#59): the one-shot ledger re-key repair (§0) and,
 * from Task 17, the `changes` prune job (§3b). Lifted out of `bootCore` (which
 * needs a real DB worker) so cadence, gating and paging are unit-testable —
 * the same shape as `registerArchiveSweep`.
 */
import { setImmediate as nextEventLoopTurn } from 'timers/promises';

import type { Cadence, Seq } from '@shared/contracts';

import { nextRun } from './engine/cadence';
import type { LogSink } from './engine/engine';
import type { CoreScheduler } from './scheduler';
import type { CoreStore } from './store/store';

export const LEDGER_REKEY_JOB_ID = 'maintenance:ledger-rekey';

/** Register the paged re-key repair as a MANUAL job (the 30 s tick never
 *  fires it; main.ts triggers it once after `scheduler.start()`). Each run
 *  is a no-op once `ledgerRekeyed()` is true, so a re-trigger is free. On
 *  completion `onDone` fires — production arms the lane wake, so the
 *  re-drive the gate held back runs on the next open publisher tick. */
export async function registerLedgerRekey(deps: {
  store: Pick<CoreStore, 'ledgerRekeyed' | 'ledgerRekeyPage'>;
  scheduler: Pick<CoreScheduler, 'register'>;
  logs: LogSink;
  onDone: () => void;
  /** Between pages; default one macrotask (`setImmediate`). */
  yieldTurn?: () => Promise<void>;
}): Promise<void> {
  const yieldTurn = deps.yieldTurn ?? (() => nextEventLoopTurn());
  await deps.scheduler.register(LEDGER_REKEY_JOB_ID, 'manual', async () => {
    if (await deps.store.ledgerRekeyed()) return;
    deps.logs.log('maintenance', 'info', 'ledger re-key repair started');
    let pages = 0;
    let scanned = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const r = await deps.store.ledgerRekeyPage();
      pages += 1;
      scanned += r.scanned;
      if (r.done) break;
      // eslint-disable-next-line no-await-in-loop
      await yieldTurn();
    }
    deps.logs.log(
      'maintenance',
      'info',
      `ledger re-key repair done: ${scanned} deferred rows in ${pages} pages`,
    );
    deps.onDone();
  });
}

export const CHANGES_PRUNE_JOB_ID = 'maintenance:prune-changes';
export const CHANGES_PRUNE_CADENCE: Cadence = { every: '6h' };
/** Changes newer than this stay (addedSince reads 24 h of them). */
export const CHANGES_RETENTION_MS = 48 * 3_600_000;
/** Delete window, in seqs — one primary-key range per writer call. */
export const PRUNE_BATCH = 50_000;
/** `PRAGMA wal_checkpoint(PASSIVE)` after this many windows (and at the end). */
export const PRUNE_CHECKPOINT_EVERY = 20;
/** The first-ever run, once, this long after a boot that never pruned. */
export const FIRST_PRUNE_DELAY_MS = 10 * 60_000;

export type PruneStore = Pick<
  CoreStore,
  | 'ledgerRekeyed'
  | 'consumerFloor'
  | 'firstChangeSeqAt'
  | 'headSeq'
  | 'publishChangesFloor'
  | 'minChangeSeq'
  | 'deleteChangesRange'
  | 'walCheckpoint'
>;

export type PruneResult =
  | { skipped: 'rekey-pending' | 'no-consumers' }
  | { limit: Seq; deleted: number; batches: number };

/** One prune run (spec §3b). The deleted region is always a contiguous
 *  prefix below `limit = min(active floor, 48 h cutoff, MAX(seq))`. */
export async function pruneChangesOnce(deps: {
  store: PruneStore;
  activeConsumers: () => string[];
  now?: () => Date;
  batch?: number;
  yieldTurn?: () => Promise<void>;
}): Promise<PruneResult> {
  const now = deps.now ?? (() => new Date());
  const batch = deps.batch ?? PRUNE_BATCH;
  const yieldTurn = deps.yieldTurn ?? (() => nextEventLoopTurn());
  // The re-key repair resolves stale ledger rows through `changes`.
  if (!(await deps.store.ledgerRekeyed())) return { skipped: 'rekey-pending' };
  // With 3a every attached consumer has a real row. No attached worker (or
  // none with a row) is never read as "no floor".
  const floor = await deps.store.consumerFloor(deps.activeConsumers());
  if (floor === null) return { skipped: 'no-consumers' };
  const cutoffSeq = await deps.store.firstChangeSeqAt(
    new Date(now().getTime() - CHANGES_RETENTION_MS).toISOString(),
  );
  const head = await deps.store.headSeq();
  // `seq < limit` is deleted, so the head row (MAX(seq)) always survives and
  // headSeq() never regresses.
  const limit = Math.min(floor, cutoffSeq, head);
  // Publish the floor FIRST: from here on a consumer that attaches or
  // returns below it re-seeds, and a crash between windows leaves only
  // garbage below the floor, which the next run deletes.
  await deps.store.publishChangesFloor(limit);
  const min = await deps.store.minChangeSeq();
  let deleted = 0;
  let batches = 0;
  if (min !== null) {
    for (let lo = min; lo < limit; lo += batch) {
      // eslint-disable-next-line no-await-in-loop
      deleted += await deps.store.deleteChangesRange(
        lo,
        Math.min(lo + batch, limit),
      );
      batches += 1;
      if (batches % PRUNE_CHECKPOINT_EVERY === 0)
        // eslint-disable-next-line no-await-in-loop
        await deps.store.walCheckpoint();
      // eslint-disable-next-line no-await-in-loop
      await yieldTurn();
    }
  }
  await deps.store.walCheckpoint();
  return { limit, deleted, batches };
}

/** Register `maintenance:prune-changes` (every 6 h). Never at boot: on first
 *  registration the durable row is seeded as "just ran" BEFORE `register`
 *  (which keeps an existing row's lastRun/nextRun). The first-ever run is
 *  triggered once, 10 minutes in, while `meta.changesFloor` is absent. */
export async function registerChangesPrune(deps: {
  store: PruneStore &
    Pick<CoreStore, 'scheduleAll' | 'scheduleUpsert' | 'changesFloor'>;
  scheduler: Pick<CoreScheduler, 'register' | 'trigger'>;
  logs: LogSink;
  activeConsumers: () => string[];
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => void;
}): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref?.();
    });
  const existing = (await deps.store.scheduleAll()).find(
    (r) => r.jobId === CHANGES_PRUNE_JOB_ID,
  );
  if (!existing) {
    const t = now();
    await deps.store.scheduleUpsert({
      jobId: CHANGES_PRUNE_JOB_ID,
      cadence: CHANGES_PRUNE_CADENCE,
      lastRun: t.toISOString(),
      nextRun:
        nextRun(CHANGES_PRUNE_CADENCE, t.toISOString(), t)?.toISOString() ??
        null,
    });
  }
  await deps.scheduler.register(
    CHANGES_PRUNE_JOB_ID,
    CHANGES_PRUNE_CADENCE,
    async () => {
      const r = await pruneChangesOnce({
        store: deps.store,
        activeConsumers: deps.activeConsumers,
        now,
      });
      deps.logs.log(
        'maintenance',
        'info',
        'skipped' in r
          ? `changes prune skipped: ${r.skipped}`
          : `changes pruned below seq ${r.limit}: ${r.deleted} rows in ${r.batches} windows`,
      );
    },
  );
  if ((await deps.store.changesFloor()) === null)
    setTimer(() => {
      void deps.scheduler.trigger(CHANGES_PRUNE_JOB_ID);
    }, FIRST_PRUNE_DELAY_MS);
}
