/** @jest-environment node */
import type { Cadence } from '@shared/contracts';

import {
  LEDGER_REKEY_JOB_ID,
  registerLedgerRekey,
} from '../changes-maintenance';

function harness(pages: boolean[]) {
  let job: { cadence: Cadence; run: () => Promise<void> } | null = null;
  let flag = false;
  const ledgerRekeyPage = jest.fn(async () => {
    const done = pages.shift() ?? true;
    if (done) flag = true;
    return { done, scanned: 1 };
  });
  const onDone = jest.fn();
  const yieldTurn = jest.fn(async () => {});
  const registered = registerLedgerRekey({
    store: { ledgerRekeyed: async () => flag, ledgerRekeyPage },
    scheduler: {
      register: async (id, cadence, run) => {
        if (id === LEDGER_REKEY_JOB_ID) job = { cadence, run };
      },
    },
    logs: { log: () => {} },
    onDone,
    yieldTurn,
  });
  return { registered, job: () => job!, ledgerRekeyPage, onDone, yieldTurn };
}

describe('ledger re-key job (#59 §0)', () => {
  it('is a manual job: the scheduler tick never fires it', async () => {
    const h = harness([]);
    await h.registered;
    expect(h.job().cadence).toBe('manual');
  });

  it('pages until done, yielding between pages, then fires the wake once', async () => {
    const h = harness([false, false, true]);
    await h.registered;
    await h.job().run();
    expect(h.ledgerRekeyPage).toHaveBeenCalledTimes(3);
    expect(h.yieldTurn).toHaveBeenCalledTimes(2);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it('runs once: a second run reads only the cached flag', async () => {
    const h = harness([true]);
    await h.registered;
    await h.job().run();
    await h.job().run();
    expect(h.ledgerRekeyPage).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });
});
