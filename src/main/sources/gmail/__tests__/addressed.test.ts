/** @jest-environment node */
import { listAddressedTo } from '../addressed';

const session = (fetchMap: Record<string, unknown>) => {
  const calls: string[] = [];
  global.fetch = (async (url: string) => {
    calls.push(url);
    const key = Object.keys(fetchMap).find((k) => url.includes(k));
    if (!key) throw new Error(`unmocked ${url}`);
    const body = fetchMap[key];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      headers: { get: () => null },
    };
  }) as unknown as typeof fetch;
  return {
    calls,
    s: {
      account: { id: 'a', identifier: 'me@gmail.com' },
      signal: new AbortController().signal,
      credentials: async () => ({
        accessToken: 't',
        expiresAt: Date.now() + 3600_000,
      }),
      log: () => {},
    } as never,
  };
};
const hdr = (h: Record<string, string>) =>
  Object.entries(h).map(([name, value]) => ({ name, value }));

test('lists sent and non-sent rows; full body only for SENT', async () => {
  const { s, calls } = session({
    '/messages?': { messages: [{ id: 'm1' }, { id: 'm2' }] },
    '/messages/m1?format=metadata': {
      id: 'm1',
      threadId: 't1',
      labelIds: ['SENT', 'INBOX'],
      internalDate: '1000',
      payload: {
        headers: hdr({
          From: 'Me <me@gmail.com>',
          To: 'me+kia@gmail.com',
          Subject: 'Prep Sarah',
          'Message-ID': '<q1@x>',
        }),
      },
    },
    '/messages/m1?format=full': {
      id: 'm1',
      threadId: 't1',
      labelIds: ['SENT'],
      payload: {
        mimeType: 'text/plain',
        body: {
          data: Buffer.from('Prepare me for Sarah').toString('base64url'),
        },
        headers: hdr({
          From: 'me@gmail.com',
          To: 'me+kia@gmail.com',
          'Message-ID': '<q1@x>',
        }),
      },
    },
    '/messages/m2?format=metadata': {
      id: 'm2',
      threadId: 't2',
      labelIds: ['SPAM'],
      internalDate: '2000',
      payload: {
        headers: hdr({
          From: 'evil@x.com',
          To: 'me+kia@gmail.com',
          Subject: 'hi',
          'Message-ID': '<e@x>',
        }),
      },
    },
  });
  const rows = await listAddressedTo(s, {
    toAddress: 'me+kia@gmail.com',
    since: 0,
  });
  expect(calls[0]).toContain('q=to%3Ame%2Bkia%40gmail.com+after%3A0');
  expect(calls[0]).toContain('includeSpamTrash=true');
  expect(rows).toEqual([
    expect.objectContaining({
      providerId: 'm1',
      sent: true,
      from: 'me@gmail.com',
      text: 'Prepare me for Sarah',
      providerThreadId: 't1',
      messageId: '<q1@x>',
    }),
    expect.objectContaining({
      providerId: 'm2',
      sent: false,
      from: 'evil@x.com',
      text: '',
    }),
  ]);
  expect(calls.some((u) => u.includes('/messages/m2?format=full'))).toBe(false);
});

test('flags own channel and automated mail', async () => {
  const { s } = session({
    '/messages?': { messages: [{ id: 'm3' }] },
    '/messages/m3?format=metadata': {
      id: 'm3',
      threadId: 't3',
      labelIds: ['SENT'],
      internalDate: '3000',
      payload: {
        headers: hdr({
          From: 'me@gmail.com',
          To: 'me+kia@gmail.com',
          'X-Kia-Channel': 'owner',
          'Auto-Submitted': 'auto-replied',
          'Message-ID': '<a@kia.local>',
        }),
      },
    },
    '/messages/m3?format=full': {
      id: 'm3',
      labelIds: ['SENT'],
      payload: { mimeType: 'text/plain', body: { data: '' }, headers: [] },
    },
  });
  const [r] = await listAddressedTo(s, {
    toAddress: 'me+kia@gmail.com',
    since: 0,
  });
  expect(r).toMatchObject({ ownChannel: true, automated: true });
});

test('HTML-only sent mail yields plain text, quotes kept', async () => {
  const html = '<p>Prep me</p><blockquote>&gt; old</blockquote>';
  const { s } = session({
    '/messages?': { messages: [{ id: 'h1' }] },
    '/messages/h1?format=metadata': {
      id: 'h1',
      labelIds: ['SENT'],
      internalDate: '10',
      payload: {
        headers: hdr({ From: 'me@gmail.com', To: 'me+kia@gmail.com' }),
      },
    },
    '/messages/h1?format=full': {
      id: 'h1',
      labelIds: ['SENT'],
      payload: {
        mimeType: 'text/html',
        body: { data: Buffer.from(html).toString('base64url') },
      },
    },
  });
  const [r] = await listAddressedTo(s, {
    toAddress: 'me+kia@gmail.com',
    since: 0,
  });
  expect(r.text).toContain('Prep me');
  expect(r.text).toContain('old');
});

test('pages through nextPageToken and drops rows older than the window', async () => {
  let page = 0;
  global.fetch = (async (url: string) => {
    const json = url.includes('/messages?')
      ? page++ === 0
        ? { messages: [{ id: 'a' }], nextPageToken: 'P2' }
        : { messages: [{ id: 'b' }] }
      : {
          id: url.includes('/a?') ? 'a' : 'b',
          threadId: 't',
          labelIds: ['INBOX'],
          internalDate: url.includes('/a?') ? '5000' : '500',
          payload: {
            headers: [
              { name: 'From', value: 'x@y.com' },
              { name: 'To', value: 'me+kia@gmail.com' },
            ],
          },
        };
    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => '',
      headers: { get: () => null },
    };
  }) as unknown as typeof fetch;
  const s = {
    account: { id: 'a' },
    signal: new AbortController().signal,
    credentials: async () => ({
      accessToken: 't',
      expiresAt: Date.now() + 3600_000,
    }),
    log: () => {},
  } as never;
  const rows = await listAddressedTo(s, {
    toAddress: 'me+kia@gmail.com',
    since: 0,
    auditSince: 1000,
  });
  expect(page).toBe(2);
  expect(rows.map((r) => r.providerId)).toEqual(['a']); // b (500) is before auditSince
});
