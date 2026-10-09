/** `meta` keys and `consumers` row names owned by the changes-log
 *  maintenance (#59). No imports: schema.ts, write-tx.ts, store.ts, the
 *  engine and the reset repository all read these. */

/** Set when every `deferred` ledger row is keyed on its document's CURRENT
 *  seq (spec §0). Absent ⇒ every re-drive entry point is a no-op. */
export const META_LEDGER_REKEYED = 'ledgerRekeyed';
/** Keyset position `{consumer, seq}` of the paged re-key repair. */
export const META_LEDGER_REKEY_CURSOR = 'ledgerRekeyCursor';
/** Highest `limit` any prune run published; a consumer below it re-seeds. */
export const META_CHANGES_FLOOR = 'changesFloor';
/** Progress rows of a consumer being seeded from `documents` (spec §3a). */
export const SEED_CONSUMER_PREFIX = 'seed:';

export const seedConsumerName = (consumer: string): string =>
  `${SEED_CONSUMER_PREFIX}${consumer}`;
