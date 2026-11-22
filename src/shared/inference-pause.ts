/** Why the platform did not give an inference call an answer, or null when
 *  the error is an ordinary failure.
 *
 *  It classifies; it does not promise the call never executed (a call lent to
 *  another device that timed out also surfaces as `LaneClosedError`).
 *
 *  - `lane-closed`, `model-changed`: scheduling. Retry later; never the
 *    caller's failure.
 *  - `no-provider`: nothing can run this kind right now. What to do about it
 *    (wait, fall back, give up) is the caller's policy.
 *
 *  Matches by `name`, never `instanceof`: errors cross the extension RPC
 *  boundary, and class identity does not survive that trip. */
export type InferencePause = 'lane-closed' | 'model-changed' | 'no-provider';

const BY_NAME: Record<string, InferencePause> = {
  LaneClosedError: 'lane-closed',
  ModelChangedError: 'model-changed',
  NoProviderError: 'no-provider',
};

export function inferencePause(err: unknown): InferencePause | null {
  if (err === null || typeof err !== 'object') return null;
  const { name } = err as { name?: unknown };
  if (typeof name !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(BY_NAME, name)
    ? BY_NAME[name]
    : null;
}
