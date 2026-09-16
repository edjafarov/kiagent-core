import { bearerFetch, computeRetryDelayMs } from '../bearer-fetch';

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

function retryable429(retryAfterSeconds: number): FakeResponse {
  const bodyText = JSON.stringify({ error: { message: 'rate limited' } });
  return {
    ok: false,
    status: 429,
    json: async () => JSON.parse(bodyText),
    text: async () => bodyText,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'retry-after' ? String(retryAfterSeconds) : null,
    },
  };
}

describe('bearerFetch retry/backoff', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects promptly when the signal aborts during a Retry-After backoff wait, instead of waiting out the full delay', async () => {
    // A large Retry-After forces a multi-second backoff wait; the abort
    // (fired after a short real delay below) must cut that wait short —
    // without the fix this test would need to wait out the full delay.
    const fetchMock = jest.fn(
      async () => retryable429(30) as unknown as Response,
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 20);

    await expect(
      bearerFetch('https://example.test/x', async () => 'tok', {
        errorPrefix: 'gmail',
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);

    expect(Date.now() - started).toBeLessThan(1000);
    // Only the first attempt's fetch should have gone out — the retry that
    // would have followed the 30s backoff never happens.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('happy path: returns parsed JSON on a 200 with no retries', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => '{"ok":true}',
      headers: { get: () => null },
    })) as unknown as typeof fetch;

    const result = await bearerFetch<{ ok: boolean }>(
      'https://example.test/x',
      async () => 'tok',
      { errorPrefix: 'gmail' },
    );
    expect(result).toEqual({ ok: true });
  });

  it('401 throws immediately, auth-coded, with the regex-able message format intact', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'Invalid Credentials',
      headers: { get: () => null },
    })) as unknown as typeof fetch;
    global.fetch = fetchMock as never;

    const failure = await bearerFetch(
      'https://example.test/x',
      async () => 'tok',
      { errorPrefix: 'gmail' },
    ).then(
      () => {
        throw new Error('expected 401 to reject');
      },
      (e: Error & { code?: string }) => e,
    );
    // code 'auth' → the engine maps this to status 'needsReauth', no retries.
    expect(failure.code).toBe('auth');
    // `${errorPrefix} ${status} ${url} ${body}` — cursor.ts regexes this.
    expect(failure.message).toBe(
      'gmail 401 https://example.test/x Invalid Credentials',
    );
    expect(fetchMock as unknown as jest.Mock).toHaveBeenCalledTimes(1); // never retried
  });

  it('passes method, body, and content-type through', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ done: true }),
      text: async () => '{"done":true}',
      headers: { get: () => null },
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    await bearerFetch('https://x/y', async () => 'tok', {
      errorPrefix: 'gmail',
      method: 'POST',
      body: '{"a":1}',
      contentType: 'application/json',
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('maxAttempts 1 never retries a retryable failure', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
      headers: { get: () => null },
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      bearerFetch('https://x/y', async () => 'tok', {
        errorPrefix: 'gmail',
        method: 'POST',
        body: '{}',
        maxAttempts: 1,
      }),
    ).rejects.toThrow(/gmail 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retryOn overrides the default classifier: a default-retryable 500 with retryOn returning false throws immediately', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
      headers: { get: () => null },
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      bearerFetch('https://x/y', async () => 'tok', {
        errorPrefix: 'gmail',
        retryOn: () => false,
      }),
    ).rejects.toThrow(/gmail 500/);
    // The default classifier would have retried a 500 — retryOn overrode it.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retryOn can retry a failure the default classifier genuinely rejects, then resolve once the retried attempt succeeds', async () => {
    // A 403 without a quota/rate-limit marker in the body is NOT retryable
    // under the default classifier (isRetryableGoogleFailure only retries
    // 403 when the body matches rateLimitExceeded/userRateLimitExceeded/
    // quotaExceeded) — so this body genuinely proves retryOn widens what
    // gets retried, rather than merely restating the default's own verdict.
    const failBody = 'transient upstream hiccup';
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({}),
        text: async () => failBody,
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: 1 }),
        text: async () => '{"ok":1}',
        headers: { get: () => null },
      });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await bearerFetch<{ ok: number }>(
      'https://x/y',
      async () => 'tok',
      {
        errorPrefix: 'gmail',
        retryOn: (status, body) => status === 403 && /hiccup/.test(body),
      },
    );

    expect(result).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retryNetErrors: false throws a network error immediately, without retrying', async () => {
    const fetchMock = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      bearerFetch('https://x/y', async () => 'tok', {
        errorPrefix: 'gmail',
        retryNetErrors: false,
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maxRetryDelayMs caps a huge Retry-After so the wait stays bounded, not the full 3600s', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(retryable429(3600) as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
        text: async () => '{"ok":true}',
        headers: { get: () => null },
      } as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;

    const started = Date.now();
    const result = await bearerFetch<{ ok: boolean }>(
      'https://example.test/x',
      async () => 'tok',
      { errorPrefix: 'gmail', maxRetryDelayMs: 50 },
    );

    expect(result).toEqual({ ok: true });
    // Without the cap this would wait out the full 3600s (1hr) Retry-After;
    // with it, the wait is bounded to maxRetryDelayMs (50ms) plus overhead.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('default path unchanged: a network error still retries when retryNetErrors is not set', async () => {
    const fetchMock = jest.fn(async () => {
      throw new TypeError('fetch failed');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      bearerFetch('https://x/y', async () => 'tok', {
        errorPrefix: 'gmail',
        // Bound the retry loop so this test doesn't wait out the full
        // default backoff chain (guards the default, not maxAttempts).
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('computeRetryDelayMs — quota backoff', () => {
  // The real body Gmail returns for a per-user rate quota. The classifier
  // matches on errors[].reason — the prose "Quota exceeded" in `message`
  // deliberately does not match, so a fixture without `reason` would be
  // classified as a plain non-retryable 403 and prove nothing.
  const QUOTA_MESSAGE =
    "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'.";
  const QUOTA_BODY = JSON.stringify({
    error: {
      code: 403,
      message: QUOTA_MESSAGE,
      errors: [
        {
          message: QUOTA_MESSAGE,
          domain: 'usageLimits',
          reason: 'rateLimitExceeded',
        },
      ],
      status: 'RESOURCE_EXHAUSTED',
    },
  });

  it('waits out a full quota window, which the exponential ramp never reaches', () => {
    // attempt 0-3 is the whole budget under MAX_ATTEMPTS. Every one of them
    // must clear a minute; before the fix the ramp topped out at 8s, so the
    // entire budget burned inside the window that rejected it.
    for (const attempt of [0, 1, 2, 3]) {
      const delay = computeRetryDelayMs(attempt, 403, QUOTA_BODY, null);
      expect(delay).toBeGreaterThanOrEqual(60_000);
    }
  });

  it('leaves non-quota failures on the short exponential ramp', () => {
    // A 500 is not a quota problem — making it wait a minute would turn a
    // blip into a stall.
    expect(computeRetryDelayMs(0, 500, 'boom', null)).toBeLessThan(2_000);
    expect(computeRetryDelayMs(3, 500, 'boom', null)).toBeLessThan(10_000);
  });

  it('does not treat a non-quota 403 as a quota failure', () => {
    // Body has no quota marker, so this 403 is not retryable at all; if it
    // still reaches the delay path it must not get the long floor.
    expect(computeRetryDelayMs(0, 403, 'forbidden', null)).toBeLessThan(2_000);
  });

  it('lets Retry-After win over the quota floor — the server said when', () => {
    // 5s Retry-After on a quota body: obey the server rather than imposing a
    // longer wait of our own.
    expect(computeRetryDelayMs(0, 403, QUOTA_BODY, '5')).toBe(5_000);
  });

  it('still honours maxRetryDelayMs, so user-facing waits stay bounded', () => {
    expect(computeRetryDelayMs(0, 403, QUOTA_BODY, null, 50)).toBe(50);
  });

  it('jitters the quota wait so parallel fetches do not return in lockstep', () => {
    // A chunk's worth of rejections resuming at the same instant would
    // re-exhaust the window immediately.
    const delays = new Set(
      Array.from({ length: 20 }, () =>
        computeRetryDelayMs(0, 403, QUOTA_BODY, null),
      ),
    );
    expect(delays.size).toBeGreaterThan(1);
  });
});
