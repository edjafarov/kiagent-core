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
});
