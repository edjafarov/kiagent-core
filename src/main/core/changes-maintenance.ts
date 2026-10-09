/**
 * Changes-log maintenance (#59): the one-shot ledger re-key repair (§0) and,
 * from Task 17, the `changes` prune job (§3b). Lifted out of `bootCore` (which
 * needs a real DB worker) so cadence, gating and paging are unit-testable —
 * the same shape as `registerArchiveSweep`.
 */
import { setImmediate as nextEventLoopTurn } from 'timers/promises';

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
