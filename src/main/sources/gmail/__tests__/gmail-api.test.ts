import { sendGmailMessage } from '../gmail-api';

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

  it('never retries on failure — a retried send can double-deliver', async () => {
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
