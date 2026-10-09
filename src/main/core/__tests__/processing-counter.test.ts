/** @jest-environment node */
import { createLedgerCounter, type LedgerTotals } from '../processing-counter';

const ZERO: LedgerTotals = {
  done: 0,
  skip: 0,
  failed: 0,
  deferred: 0,
  pending: 0,
};

function harness() {
  let gen = 0;
  let active = ['worker:a:v1'];
  let gate: Promise<void> | null = null;
  let fail = false;
  const ledgerCountsAll = jest.fn(async () => {
    if (gate) await gate;
    if (fail) throw new Error('db down');
    return ZERO;
  });
  const counter = createLedgerCounter({
    store: { ledgerGen: () => gen, ledgerCountsAll },
    activeConsumers: () => active,
  });
  return {
    counter,
    ledgerCountsAll,
    bump: () => {
      gen += 1;
    },
    setActive: (a: string[]) => {
      active = a;
    },
    hold: () => {
      let release!: () => void;
      gate = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        gate = null;
        release();
      };
    },
    setFail: (f: boolean) => {
      fail = f;
    },
  };
}

describe('ledger counter (#139)', () => {
  it('counts once, then skips until the generation moves', async () => {
    const h = harness();
    expect(await h.counter.count()).toEqual(ZERO);
    expect(await h.counter.countIfChanged()).toBeNull();
    h.bump();
    expect(await h.counter.countIfChanged()).toEqual(ZERO);
    expect(h.ledgerCountsAll).toHaveBeenCalledTimes(2);
  });

  it('a write landing during an in-flight count is counted on the next tick', async () => {
    const h = harness();
    const release = h.hold();
    const first = h.counter.countIfChanged();
    h.bump(); // mutation while the query runs
    release();
    await first;
    expect(await h.counter.countIfChanged()).not.toBeNull();
    expect(await h.counter.countIfChanged()).toBeNull();
    expect(h.ledgerCountsAll).toHaveBeenCalledTimes(2);
  });

  it('a change in the active consumer set recounts', async () => {
    const h = harness();
    await h.counter.count();
    h.setActive(['worker:a:v1', 'worker:b:v1']);
    expect(await h.counter.countIfChanged()).not.toBeNull();
  });

  it('a failed count is retried on the next tick', async () => {
    const h = harness();
    h.setFail(true);
    await expect(h.counter.countIfChanged()).rejects.toThrow('db down');
    h.setFail(false);
    expect(await h.counter.countIfChanged()).toEqual(ZERO);
  });
});
