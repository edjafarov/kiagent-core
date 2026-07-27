/**
 * Minimal transient-failure retry for non-HTTP senders (SMTP). Mirrors
 * bearerFetch's backoff (1s/2s/4s + jitter, spec §1) without its HTTP
 * machinery. `isTransient` must ONLY match failures that prove the
 * message was never accepted — anything ambiguous propagates on the
 * first throw.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: {
    isTransient: (err: unknown) => boolean;
    /** Total attempts including the first; default 4. */
    maxAttempts?: number;
    /** Test seam; defaults to real setTimeout sleep. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts - 1 || !opts.isTransient(err)) throw err;
      await sleep(Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250);
    }
  }
}
