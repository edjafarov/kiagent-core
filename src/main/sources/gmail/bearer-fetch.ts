/**
 * Bearer-token fetch core with retry/backoff, ported from the legacy
 * `http-shared/bearer-fetch.ts` (kiagent-ref). Kept self-contained inside the
 * gmail source (per file-ownership rules) rather than shared, since this is
 * the only source using it in this port.
 *
 * Retains the load-bearing behaviors from legacy:
 *  - 429 / 5xx / Google-quota-403 are retried with exponential backoff
 *    (honoring `Retry-After` when present); network errors and timeouts are
 *    always retryable (defaults — see retryOn/retryNetErrors for
 *    non-idempotent callers). A quota-403 additionally waits out a full
 *    quota window, which the exponential ramp alone never reaches
 *    (computeRetryDelayMs).
 *  - The abort signal stays armed across BOTH header and body read — fetch()
 *    resolves as soon as headers arrive, so clearing the timeout early can
 *    leave a slow body read unprotected (legacy hit multi-hour hangs this way).
 *  - Thrown HTTP-failure message format is `${errorPrefix} ${status} ${url} ${body}`
 *    — callers regex this to detect invalid-cursor conditions (see
 *    `isInvalidHistoryError` in gmail-api.ts).
 *  - 401 is NOT retried (defaults — see retryOn/retryNetErrors for
 *    non-idempotent callers): it is thrown immediately as a SourceAuthError
 *    (same message format), which the engine maps to `status: 'needsReauth'`
 *    instead of burning its retry budget against a revoked grant.
 */
import { SourceAuthError } from '@shared/source-errors';

const MAX_ATTEMPTS = 4;
/** Google's per-user Gmail quotas are enforced over a rolling one-minute
 *  window; a quota rejection has to outlast it. See computeRetryDelayMs. */
const QUOTA_WINDOW_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

export interface BearerFetchOpts {
  timeoutMs?: number;
  responseType?: 'json' | 'text';
  errorPrefix: string;
  logTag?: string;
  signal?: AbortSignal;
  /** HTTP method; default GET. */
  method?: string;
  /** Request body — a STRING (reusable across retry attempts, never a stream). */
  body?: string;
  /** content-type header, set only when body is present. */
  contentType?: string;
  /** Total attempts including the first (1 = try once, never retry);
   *  default 5. Pass 1 for non-idempotent calls (send) — a retried send
   *  can double-deliver. */
  maxAttempts?: number;
  /** Override the default HTTP-failure retry classifier
   *  (isRetryableGoogleFailure). Non-idempotent calls pass a stricter
   *  predicate that only matches proven request-rejections. */
  retryOn?: (status: number, body: string) => boolean;
  /** Retry network errors / timeouts (default true). Pass false for
   *  non-idempotent calls — a timed-out request may have been processed. */
  retryNetErrors?: boolean;
  /** Ceiling on ANY single retry delay, including Retry-After-driven ones;
   *  default: no extra cap beyond the exponential branch's built-in 60s.
   *  Pass for user-facing waits. */
  maxRetryDelayMs?: number;
}

/** Google reports a per-user rate quota as a 403 whose body names the metric,
 *  e.g. "Quota exceeded for quota metric 'Total Query Cost' and limit
 *  'Units per minute per user'". */
const QUOTA_BODY_RE = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i;

function isQuotaFailure(status: number, body: string): boolean {
  return status === 403 && QUOTA_BODY_RE.test(body);
}

function isRetryableGoogleFailure(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 401) return false;
  if (status === 403) return QUOTA_BODY_RE.test(body);
  return false;
}

/**
 * Delay before the next attempt.
 *
 * Retry-After is the server stating exactly when to return, so it wins
 * outright. Otherwise the usual exponential ramp applies — except for a quota
 * rejection, which gets a floor of a full quota window.
 *
 * That floor is the point of this function. Those per-user limits are enforced
 * over a rolling minute, while the exponential branch only reaches 2^3 = 8s
 * within MAX_ATTEMPTS, so without a floor every attempt lands inside the same
 * window as the rejection that triggered it and the entire retry budget burns
 * against a limit that was never going to reset. Worse, rejected requests
 * still cost quota, so retrying inside the window sustains the exhaustion
 * rather than waiting it out — which is how a backfill ends up looping on 403s
 * until it is restarted.
 *
 * Exported for tests: the floor is a minute, so asserting on it through real
 * timers is not practical.
 */
export function computeRetryDelayMs(
  attempt: number,
  status: number,
  body: string,
  retryAfter: string | null,
  maxRetryDelayMs?: number,
): number {
  const retryAfterMs = Number(retryAfter);
  const serverDirected = Number.isFinite(retryAfterMs) && retryAfterMs > 0;
  let delay = serverDirected
    ? retryAfterMs * 1000
    : Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250;
  if (!serverDirected && isQuotaFailure(status, body)) {
    // Jittered so a chunk's worth of parallel fetches, all rejected at once,
    // do not return in lockstep and re-exhaust the window immediately.
    delay = Math.max(delay, QUOTA_WINDOW_MS + Math.random() * 5_000);
  }
  if (maxRetryDelayMs !== undefined) delay = Math.min(delay, maxRetryDelayMs);
  return delay;
}

/**
 * Backoff sleep that races the delay against `signal` aborting, so a stop/
 * reconnect during a (possibly Retry-After-driven, up to 60s+) backoff wait
 * doesn't hang the caller for the rest of the delay. Throws `Error('aborted')`
 * on abort, matching the check at the top of bearerFetch's loop. Always clears
 * the timer and removes the abort listener, on every path, so nothing leaks.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('aborted');
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(new Error('aborted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(resolve, ms);
    });
  } finally {
    clearTimeout(timer!);
    signal?.removeEventListener('abort', onAbort!);
  }
}

export async function bearerFetch<T>(
  url: string,
  getToken: () => Promise<string>,
  opts: BearerFetchOpts,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const responseType = opts.responseType ?? 'json';
  // `opts.maxAttempts` counts TOTAL attempts (1 = try once, never retry) —
  // one fewer than the loop's own retry-permission threshold, which counts
  // retries-remaining-after-this-one. Falling back to MAX_ATTEMPTS here
  // (rather than MAX_ATTEMPTS - 1) keeps existing GET callers byte-for-byte
  // unchanged.
  const attemptCap =
    opts.maxAttempts !== undefined ? opts.maxAttempts - 1 : MAX_ATTEMPTS;
  for (let attempt = 0; ; attempt += 1) {
    if (opts.signal?.aborted) throw new Error('aborted');
    const token = await getToken();
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
    const handle = setTimeout(() => controller.abort(), timeoutMs);

    let parsed: T | undefined;
    let httpFail:
      | { status: number; body: string; retryAfter: string | null }
      | undefined;
    let netError: Error | undefined;
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
      };
      if (opts.body !== undefined && opts.contentType) {
        headers['content-type'] = opts.contentType;
      }
      const r = await fetch(url, {
        method: opts.method,
        body: opts.body,
        headers,
        signal: controller.signal,
      });
      if (r.ok) {
        parsed =
          responseType === 'json'
            ? ((await r.json()) as T)
            : ((await r.text()) as unknown as T);
      } else {
        httpFail = {
          status: r.status,
          body: await r.text(),
          retryAfter: r.headers.get('retry-after'),
        };
      }
    } catch (e) {
      netError = e as Error;
    } finally {
      clearTimeout(handle);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (parsed !== undefined) return parsed;

    if (netError) {
      if (opts.signal?.aborted) throw netError;
      if (opts.retryNetErrors === false) throw netError;
      if (attempt < attemptCap) {
        let delay = Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250;
        if (opts.maxRetryDelayMs !== undefined) {
          delay = Math.min(delay, opts.maxRetryDelayMs);
        }
        if (opts.logTag) {
          const reason =
            netError.name === 'AbortError'
              ? `timeout(${timeoutMs}ms)`
              : netError.message;
          console.warn(
            `${opts.logTag} ${reason} ${url} — retry ${attempt + 1}/${attemptCap} after ${Math.round(delay)}ms`,
          );
        }
        await sleep(delay, opts.signal);
        continue;
      }
      throw netError;
    }

    const { status, body, retryAfter } = httpFail!;
    const retryable = (opts.retryOn ?? isRetryableGoogleFailure)(status, body);
    if (attempt < attemptCap && retryable) {
      const delay = computeRetryDelayMs(
        attempt,
        status,
        body,
        retryAfter,
        opts.maxRetryDelayMs,
      );
      if (opts.logTag) {
        // Name the quota case: an unexplained minute-long pause reads as a
        // hung sync, and the 403 body is the only thing that says which limit
        // was hit.
        const why = isQuotaFailure(status, body)
          ? ' (quota — waiting out the window)'
          : '';
        console.warn(
          `${opts.logTag} ${status} ${url} — retry ${attempt + 1}/${attemptCap} after ${Math.round(delay)}ms${why}`,
        );
      }
      await sleep(delay, opts.signal);
      continue;
    }
    // 401 (and any other non-retryable status) surfaces immediately here.
    // The message format is identical either way — cursor.ts regexes it.
    const message = `${opts.errorPrefix} ${status} ${url} ${body}`;
    throw status === 401 ? new SourceAuthError(message) : new Error(message);
  }
}
