/** SQL for versioning vault rows (alpha-cent spec 7.8, step 2). Only a leader
 *  stamps: a row saved there gets `(epoch, max(n) + 1)` of its own epoch, so a
 *  newer value always sorts above an older one, across takeovers too. */
export const TRACKING = `((SELECT tracking FROM sync_state) = 1)`;

export const STAMP_EPOCH = `(SELECT CASE WHEN s.tracking = 1 THEN s.epoch ELSE 0 END FROM sync_state s)`;

export const STAMP_N = `(SELECT CASE WHEN s.tracking = 1
    THEN coalesce((SELECT max(v.n) FROM vault v WHERE v.epoch = s.epoch), 0) + 1
    ELSE 0 END FROM sync_state s)`;

/** `(epoch, n)` order, as a SQL condition for "the first is newer". */
export const NEWER = (a: string, b: string): string =>
  `(${a}.epoch > ${b}.epoch OR (${a}.epoch = ${b}.epoch AND ${a}.n > ${b}.n))`;
