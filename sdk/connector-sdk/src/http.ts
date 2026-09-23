/**
 * The shared HTTP retry ladder, extracted verbatim from the slack connector's
 * client (the most battle-tested of the nine): transient network/5xx failures
 * retried with exponential backoff, 429s retried on their own budget honoring
 * a clamped Retry-After.
 *
 * Deliberately generic — this module knows nothing about any API. Rate-window
 * acquisition, auth headers, envelope parsing and status classification stay in
 * each connector's client; it wraps its own per-request work in `attempt()`.
 *
 * The thrown message shapes are load-bearing (connector test suites pin them):
 *   `${label}: network error after ${n} attempts: ${msg}`
 *   `${label}: HTTP 429 after ${n} attempts`
 *   `${label}: HTTP ${status} (after ${n} attempts)`
 */

import type { PluginNetInit, PluginNetResult } from './generated/plugin-net';

/** The host `net.fetch` signature — the same type as `PluginNet['fetch']`
 *  in the generated contracts, so `host.net.fetch` and a test fake typed as
 *  `NetFetch` are assignable to each other in both directions. */
export type NetFetch = (
  url: string,
  init?: PluginNetInit,
) => Promise<PluginNetResult>;

/** The host `net.fetch` surface resolves to this shape — header keys are
 *  lowercase (built via Object.fromEntries(res.headers.entries())). */
export type HostResponse = PluginNetResult;

export interface RetryPolicy {
  /** Error-message prefix, e.g. `slack ${method}` or `notion ${path}`. */
  label: string;
  /** Network throws + 5xx share this budget (default 4; senders pass 0). */
  maxTransientRetries?: number;
  /** 429s only (default 5); independent of the transient budget. */
  maxRateLimitRetries?: number;
  /** Backoff base (default 2000 → 2s, 4s, 8s, 16s at 2^n). */
  transientBackoffMs?: number;
  retryAfterDefaultSec?: number; // default 5
  retryAfterMinSec?: number; // default 1
  retryAfterMaxSec?: number; // default 60
  sleep?: (ms: number) => Promise<void>; // default real setTimeout
  /** Caller cancellation is never retried. */
  signal?: AbortSignal;
}

/** A backfill makes tens of thousands of consecutive calls, so transient
 *  5xx/network blips are a statistical certainty over its lifetime — retry them
 *  with exponential backoff instead of aborting hours of work. */
const MAX_TRANSIENT_RETRIES = 4;
const TRANSIENT_BACKOFF_MS = 2_000; // 2s, 4s, 8s, 16s
const MAX_RATE_LIMIT_RETRIES = 5;
const RETRY_AFTER_DEFAULT_SEC = 5;
const RETRY_AFTER_MIN_SEC = 1;
const RETRY_AFTER_MAX_SEC = 60;

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function sleepWithSignal(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    return Promise.reject(error);
  }
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };
    signal.addEventListener('abort', abort, { once: true });
    sleep(ms).then(
      () => {
        signal.removeEventListener('abort', abort);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Clamped Retry-After milliseconds for a 429 (missing/non-numeric → default).
 *
 *  Retry-After may be absent or a non-numeric HTTP-date; neither must collapse
 *  into a 0ms busy-retry. Default 5s, floor 1s, cap 60s. The header key is read
 *  lowercase — the host lowercases every response header. */
export function retryAfterMs(
  headers: Record<string, string>,
  policy?: RetryPolicy,
): number {
  const raw = Number(headers['retry-after']);
  const min = policy?.retryAfterMinSec ?? RETRY_AFTER_MIN_SEC;
  const max = policy?.retryAfterMaxSec ?? RETRY_AFTER_MAX_SEC;
  const after = Number.isFinite(raw)
    ? Math.min(Math.max(min, raw), max)
    : (policy?.retryAfterDefaultSec ?? RETRY_AFTER_DEFAULT_SEC);
  return after * 1000;
}

/** Repeats attempt() until the response is neither 429 nor >=500.
 *  attempt() runs fresh each try — rate-window acquire etc. belongs inside it.
 *
 *  Every other status (2xx, 3xx, 4xx) is returned as-is: classifying them is
 *  the caller's job, since each API encodes failure differently. */
export async function requestWithRetry(
  attempt: () => Promise<HostResponse>,
  policy: RetryPolicy,
): Promise<HostResponse> {
  // `??` throughout, never `||` — 0 is a legal value for every budget.
  const maxTransient = policy.maxTransientRetries ?? MAX_TRANSIENT_RETRIES;
  const maxRateLimit = policy.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;
  const backoffMs = policy.transientBackoffMs ?? TRANSIENT_BACKOFF_MS;
  const sleep = policy.sleep ?? realSleep;

  let transient = 0;
  let rateLimited = 0;
  for (;;) {
    if (policy.signal?.aborted) {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
    let res: HostResponse;
    try {
      // eslint-disable-next-line no-await-in-loop
      res = await attempt();
    } catch (e) {
      if (
        policy.signal?.aborted ||
        (e instanceof Error &&
          (e.name === 'AbortError' || e.name === 'TimeoutError'))
      ) {
        throw e;
      }
      const msg = e instanceof Error ? e.message : String(e);
      if (transient >= maxTransient)
        throw new Error(
          `${policy.label}: network error after ${transient + 1} attempts: ${msg}`,
        );
      transient += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleepWithSignal(
        sleep,
        backoffMs * 2 ** (transient - 1),
        policy.signal,
      );
      continue;
    }
    if (res.status === 429) {
      if (rateLimited >= maxRateLimit)
        throw new Error(
          `${policy.label}: HTTP 429 after ${rateLimited + 1} attempts`,
        );
      rateLimited += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleepWithSignal(sleep, retryAfterMs(res.headers, policy), policy.signal);
      continue;
    }
    if (res.status >= 500) {
      if (transient >= maxTransient)
        throw new Error(
          `${policy.label}: HTTP ${res.status} (after ${transient + 1} attempts)`,
        );
      transient += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleepWithSignal(
        sleep,
        backoffMs * 2 ** (transient - 1),
        policy.signal,
      );
      continue;
    }
    return res;
  }
}
