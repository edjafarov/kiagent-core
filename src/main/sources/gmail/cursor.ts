/**
 * Gmail's persisted Cursor shape.
 *
 * - `backfill`: paginating threads.list. `pageToken: null` means "first
 *   page" (resumed from a saved cursor, not "start over" — the historyId
 *   watermark was already captured at the START of the backfill so the
 *   later delta loop begins from the same point regardless of how many
 *   restarts happened mid-backfill; mirrors legacy backfill.ts).
 * - `delta`: steady-state history.list polling from `historyId`.
 */
export type GmailCursor =
  | { mode: 'backfill'; pageToken: string | null; historyId: string }
  | { mode: 'delta'; historyId: string };

/**
 * Detects Gmail's 404 "Requested entity was not found" failure — thrown by
 * bearerFetch in the load-bearing `${errorPrefix} ${status} ${url} ${body}`
 * format. This is the SAME message Gmail returns both when a history
 * watermark has expired (history.list) and when an individual thread has
 * been deleted upstream (threads.get) — legacy regexed the identical text
 * for both cases (gmail/delta.ts). Callers disambiguate by which call this
 * followed, not by the message itself.
 */
export function isGmailNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /^gmail 404\b/.test(msg) && /Requested entity was not found/i.test(msg)
  );
}
