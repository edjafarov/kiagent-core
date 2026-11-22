/** Account changes on the leader: one at a time per account, and each
 *  operation once. A copy sends an operation id with every change it relays;
 *  a transport retry of the same id gets the first run's result and runs
 *  nothing, so a repeated pause cannot undo a resume made in between. The
 *  results live in memory only: after a restart a repeat runs again. */

export const ACCOUNT_OPS_CAP = 200;
export const ACCOUNT_OPS_TTL_MS = 60 * 60_000;

export interface AccountOps {
  /** Runs `fn` after every earlier operation with the same key. A known
   *  `opId` returns the first run's result (or its failure) and runs
   *  nothing; `null` is never remembered. */
  run<T>(opId: string | null, key: string, fn: () => Promise<T>): Promise<T>;
}

export function createAccountOps(d: {
  now(): number;
  cap?: number;
  ttlMs?: number;
}): AccountOps {
  const cap = d.cap ?? ACCOUNT_OPS_CAP;
  const ttlMs = d.ttlMs ?? ACCOUNT_OPS_TTL_MS;
  const tails = new Map<string, Promise<unknown>>();
  // Insertion order is age order: the first key is the oldest.
  const results = new Map<string, { at: number; result: Promise<unknown> }>();

  const queued = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => undefined);
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return next;
  };

  return {
    run<T>(opId: string | null, key: string, fn: () => Promise<T>): Promise<T> {
      if (opId === null) return queued(key, fn);
      const known = results.get(opId);
      if (known && d.now() - known.at <= ttlMs)
        return known.result as Promise<T>;
      results.delete(opId);
      const result = queued(key, fn);
      // A remembered failure is read again later: it is never unhandled.
      result.catch(() => undefined);
      results.set(opId, { at: d.now(), result });
      while (results.size > cap) {
        const oldest = results.keys().next().value as string;
        results.delete(oldest);
      }
      return result;
    },
  };
}
