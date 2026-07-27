import { bearerFetch } from '../bearer-fetch';

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
