import { isSendSafeRetry, sendGmailMessage } from '../gmail-api';

// The verbatim body Google returns for the smoke-test quota 403 (see
// SMOKE_403 in src/main/outbound/__tests__/error-copy.test.ts) — only the
// response body portion, not the `gmail 403 <url> ` prefix bearerFetch adds
// to the thrown error message.
const QUOTA_403_BODY =
  '{ "error": { "code": 403, "message": "Quota exceeded for quota metric ' +
  "'Queries' and limit 'Previous quota: Units per minute per user'\", " +
  '"errors": [ { "reason": "rateLimitExceeded", "domain": "usageLimits" } ], ' +
  '"status": "PERMISSION_DENIED" } }';

describe('isSendSafeRetry', () => {
  it('429 (any body) is send-safe — Google refused the request outright', () => {
    expect(isSendSafeRetry(429, '')).toBe(true);
  });

  it('403 with a quota/rate-limit marker is send-safe', () => {
    expect(isSendSafeRetry(403, QUOTA_403_BODY)).toBe(true);
  });

  it('403 without a quota/rate-limit marker is NOT send-safe', () => {
    expect(
      isSendSafeRetry(
        403,
        '{"error":{"status":"PERMISSION_DENIED","message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}',
      ),
    ).toBe(false);
  });

  it('500 is NOT send-safe — ambiguous, may have already delivered', () => {
    expect(isSendSafeRetry(500, 'rateLimitExceeded')).toBe(false);
  });

  it('401 is NOT send-safe, even with a quota-shaped body — must never retry a revoked grant', () => {
    expect(isSendSafeRetry(401, 'rateLimitExceeded')).toBe(false);
  });
});

describe('sendGmailMessage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts base64url raw with the thread id', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'm9', threadId: 't3' }),
      text: async () => '{"id":"m9","threadId":"t3"}',
      headers: { get: () => null },
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const auth = { credentials: async () => ({ accessToken: 'tok' }) };
    const r = await sendGmailMessage(
      auth,
      Buffer.from('From: a\r\n\r\nhi'),
      't3',
    );
    expect(r).toEqual({ id: 'm9', threadId: 't3' });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    );
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.threadId).toBe('t3');
    expect(Buffer.from(body.raw, 'base64url').toString()).toContain('hi');
  });

  it('omits threadId when none is given', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'm9', threadId: 't9' }),
      text: async () => '{"id":"m9","threadId":"t9"}',
      headers: { get: () => null },
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const auth = { credentials: async () => ({ accessToken: 'tok' }) };
    await sendGmailMessage(auth, Buffer.from('From: a\r\n\r\nhi'));

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.threadId).toBeUndefined();
    expect('threadId' in body).toBe(false);
  });

  it('does not retry a 500 — ambiguous, may have already delivered', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => 'boom',
      headers: { get: () => null },
    })) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const auth = { credentials: async () => ({ accessToken: 'tok' }) };
    await expect(
      sendGmailMessage(auth, Buffer.from('From: a\r\n\r\nhi')),
    ).rejects.toThrow(/gmail 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a quota 403 once, then resolves on the next attempt', async () => {
    // A small numeric Retry-After collapses bearerFetch's backoff wait to
    // ~1ms so this stays well inside jest's default per-test timeout.
    const quota403 = {
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => QUOTA_403_BODY,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' ? '0.001' : null,
      },
    };
    const success = {
      ok: true,
      status: 200,
      json: async () => ({ id: 'm1', threadId: 't1' }),
      text: async () => '{"id":"m1","threadId":"t1"}',
      headers: { get: () => null },
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(quota403)
      .mockResolvedValueOnce(success) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const auth = { credentials: async () => ({ accessToken: 'tok' }) };
    const r = await sendGmailMessage(auth, Buffer.from('From: a\r\n\r\nhi'));
    expect(r).toEqual({ id: 'm1', threadId: 't1' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('exhausts the attempt cap on repeated quota 403s — exactly 4 calls, then throws', async () => {
    const quota403 = {
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => QUOTA_403_BODY,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'retry-after' ? '0.001' : null,
      },
    };
    const fetchMock = jest.fn(async () => quota403) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const auth = { credentials: async () => ({ accessToken: 'tok' }) };
    const failure = await sendGmailMessage(
      auth,
      Buffer.from('From: a\r\n\r\nhi'),
    ).then(
      () => {
        throw new Error('expected the send to reject');
      },
      (e: Error) => e,
    );
    // Pin the full thrown-message shape the downstream error-copy classifier
    // depends on (see SMOKE_403 in error-copy.test.ts): the bearerFetch head
    // token plus a body that still carries the quota marker.
    expect(failure.message).toMatch(
      /^gmail 403 https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send /,
    );
    expect(failure.message).toContain('rateLimitExceeded');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry a network error — a retried send can double-deliver', async () => {
    const fetchMock = jest.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as jest.Mock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const auth = { credentials: async () => ({ accessToken: 'tok' }) };
    await expect(
      sendGmailMessage(auth, Buffer.from('From: a\r\n\r\nhi')),
    ).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the auth has no access token', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const auth = { credentials: async () => null };
    await expect(
      sendGmailMessage(auth, Buffer.from('From: a\r\n\r\nhi')),
    ).rejects.toThrow(/no credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
