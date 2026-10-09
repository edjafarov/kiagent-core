/**
 * The processing panel's ledger totals, counted only when something that can
 * move them happened (#139). The 5 s publisher used to run ledgerCountsAll
 * (three statements, one an O(ledger) walk) on every tick, idle or not.
 */
import type { CoreStore, LedgerCounts } from './store/store';

export type LedgerTotals = LedgerCounts & { pending: number };

export function createLedgerCounter(deps: {
  store: Pick<CoreStore, 'ledgerGen' | 'ledgerCountsAll'>;
  activeConsumers: () => string[];
}): {
  /** Count now (boot's one-shot) and remember the generation it saw. */
  count(): Promise<LedgerTotals>;
  /** Count only if the generation or the active consumer set moved since
   *  the last successful count; null otherwise. */
  countIfChanged(): Promise<LedgerTotals | null>;
} {
  let lastKey: string | null = null;
  const keyNow = (): string =>
    `${deps.store.ledgerGen()}|${[...deps.activeConsumers()].sort().join(',')}`;
  const count = async (): Promise<LedgerTotals> => {
    // Read BEFORE the query: a write landing during it is counted next tick.
    const key = keyNow();
    const all = await deps.store.ledgerCountsAll(deps.activeConsumers());
    lastKey = key;
    return all;
  };
  return {
    count,
    async countIfChanged() {
      if (keyNow() === lastKey) return null;
      return count();
    },
  };
}
