/**
 * Bearer-token fetch core with retry/backoff, ported from the legacy
 * `http-shared/bearer-fetch.ts` (kiagent-ref). Kept self-contained inside the
 * gmail source (per file-ownership rules) rather than shared, since this is
 * the only source using it in this port.
 *
 * Retains the load-bearing behaviors from legacy:
 *  - 429 / 5xx / Google-quota-403 are retried with exponential backoff
 *    (honoring `Retry-After` when present); network errors and timeouts are
 *    always retryable.
 *  - The abort signal stays armed across BOTH header and body read — fetch()
 *    resolves as soon as headers arrive, so clearing the timeout early can
 *    leave a slow body read unprotected (legacy hit multi-hour hangs this way).
 *  - Thrown HTTP-failure message format is `${errorPrefix} ${status} ${url} ${body}`
 *    — callers regex this to detect invalid-cursor conditions (see
 *    `isInvalidHistoryError` in gmail-api.ts).
 *  - 401 is NOT retried: it is thrown immediately as a SourceAuthError (same
 *    message format), which the engine maps to `status: 'needsReauth'`
 *    instead of burning its retry budget against a revoked grant.
 */
import { SourceAuthError } from '@shared/source-errors';

const MAX_ATTEMPTS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 90_000;

export interface BearerFetchOpts {
  timeoutMs?: number;
  responseType?: 'json' | 'text';
  errorPrefix: string;
  logTag?: string;
  signal?: AbortSignal;
}

function isRetryableGoogleFailure(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 401) return false;
  if (status === 403) {
    return /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(body);
  }
  return false;
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
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
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
      if (attempt < MAX_ATTEMPTS) {
        const delay =
          Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250;
        if (opts.logTag) {
          const reason =
            netError.name === 'AbortError'
              ? `timeout(${timeoutMs}ms)`
              : netError.message;
          console.warn(
            `${opts.logTag} ${reason} ${url} — retry ${attempt + 1}/${MAX_ATTEMPTS} after ${Math.round(delay)}ms`,
          );
        }
        await sleep(delay, opts.signal);
        continue;
      }
      throw netError;
    }

    const { status, body, retryAfter } = httpFail!;
    if (attempt < MAX_ATTEMPTS && isRetryableGoogleFailure(status, body)) {
      const retryAfterMs = Number(retryAfter);
      const delay =
        Number.isFinite(retryAfterMs) && retryAfterMs > 0
          ? retryAfterMs * 1000
          : Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250;
      if (opts.logTag) {
        console.warn(
          `${opts.logTag} ${status} ${url} — retry ${attempt + 1}/${MAX_ATTEMPTS} after ${Math.round(delay)}ms`,
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
