/** @jest-environment node */
import {
  fetchAddressedAttachment,
  filenameParam,
  listAddressedTo,
} from '../addressed';

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

describe('attachments', () => {
  const DOCX =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const meta = (id: string, labels: string[]) => ({
    id,
    threadId: 't',
    labelIds: labels,
    internalDate: '5000',
    payload: {
      headers: hdr({ From: 'me@gmail.com', To: 'me+kia@gmail.com' }),
    },
  });
  const part = (
    partId: string,
    mimeType: string,
    filename: string,
    size: number,
    disposition: string,
  ) => ({
    partId,
    mimeType,
    filename,
    headers: hdr({
      'Content-Disposition': `${disposition}; filename="${filename}"`,
    }),
    body: { attachmentId: `att-${partId}-rotating`, size },
  });

  test('lists attachments of a sent message', async () => {
    const { s } = session({
      '/messages?': { messages: [{ id: 'm1' }] },
      '/messages/m1?format=metadata': meta('m1', ['SENT']),
      '/messages/m1?format=full': {
        id: 'm1',
        labelIds: ['SENT'],
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            {
              partId: '0',
              mimeType: 'text/plain',
              body: { data: Buffer.from('see attached').toString('base64url') },
            },
            part('1', DOCX, 'MG Vertrag.docx', 46000, 'attachment'),
            part('2', 'image/png', 'logo.png', 3000, 'inline'),
            part('3', 'application/pdf', 'Scan.pdf', 120000, 'inline'),
          ],
        },
      },
    });
    const [row] = await listAddressedTo(s, {
      toAddress: 'me+kia@gmail.com',
      since: 0,
    });
    expect(row.text).toBe('see attached');
    expect(row.attachments).toEqual([
      {
        id: '1',
        filename: 'MG Vertrag.docx',
        mime: DOCX,
        size: 46000,
        inline: false,
      },
      // inline images under 8 KB (signature logos) are omitted
      {
        id: '3',
        filename: 'Scan.pdf',
        mime: 'application/pdf',
        size: 120000,
        inline: true,
      },
    ]);
  });

  test('lists named parts served inline in body.data', async () => {
    const { s } = session({
      '/messages?': { messages: [{ id: 'm3' }] },
      '/messages/m3?format=metadata': meta('m3', ['SENT']),
      '/messages/m3?format=full': {
        id: 'm3',
        labelIds: ['SENT'],
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            {
              partId: '1',
              mimeType: 'text/csv',
              filename: 'small.csv',
              headers: hdr({ 'Content-Disposition': 'attachment' }),
              body: { data: Buffer.from('a,b').toString('base64url'), size: 3 },
            },
          ],
        },
      },
    });
    const [row] = await listAddressedTo(s, {
      toAddress: 'me+kia@gmail.com',
      since: 0,
    });
    expect(row.attachments).toEqual([
      {
        id: '1',
        filename: 'small.csv',
        mime: 'text/csv',
        size: 3,
        inline: false,
      },
    ]);
  });

  test('non-sent rows carry no attachments', async () => {
    const { s, calls } = session({
      '/messages?': { messages: [{ id: 'm2' }] },
      '/messages/m2?format=metadata': meta('m2', ['INBOX']),
    });
    const [row] = await listAddressedTo(s, {
      toAddress: 'me+kia@gmail.com',
      since: 0,
    });
    expect(row.attachments).toEqual([]);
    expect(calls.some((u) => u.includes('format=full'))).toBe(false);
  });
});

describe('fetchAddressedAttachment', () => {
  const full = (labels: string[], size = 5) => ({
    id: 'm1',
    labelIds: labels,
    payload: {
      mimeType: 'multipart/mixed',
      parts: [
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'a.pdf',
          body: { attachmentId: 'rot-1', size },
        },
      ],
    },
  });

  test('returns the bytes of a sent message part (resolving the rotating id)', async () => {
    const { s, calls } = session({
      '/messages/m1?format=full': full(['SENT']),
      '/messages/m1/attachments/rot-1': {
        size: 5,
        data: Buffer.from('hello').toString('base64url'),
      },
    });
    const bytes = await fetchAddressedAttachment(s, 'm1', '1', {
      maxBytes: 100,
    });
    expect(Buffer.from(bytes).toString()).toBe('hello');
    expect(calls.some((u) => u.includes('/attachments/rot-1'))).toBe(true);
  });

  test('refuses a message not in Sent', async () => {
    const { s, calls } = session({
      '/messages/m1?format=full': full(['INBOX']),
    });
    await expect(
      fetchAddressedAttachment(s, 'm1', '1', { maxBytes: 100 }),
    ).rejects.toThrow('not a sent message');
    expect(calls.some((u) => u.includes('/attachments/'))).toBe(false);
  });

  test('refuses a part over the cap before downloading', async () => {
    const { s, calls } = session({
      '/messages/m1?format=full': full(['SENT'], 500),
    });
    await expect(
      fetchAddressedAttachment(s, 'm1', '1', { maxBytes: 100 }),
    ).rejects.toThrow('too large');
    expect(calls.some((u) => u.includes('/attachments/'))).toBe(false);
  });
});

describe('filenameParam', () => {
  test('decodes RFC 2231 extended names', () => {
    expect(filenameParam("attachment; filename*=UTF-8''Pr%C3%BCfung.txt")).toBe(
      'Prüfung.txt',
    );
    expect(filenameParam('attachment; filename="plain name.pdf"')).toBe(
      'plain name.pdf',
    );
  });
});

test('fetchAddressedAttachment decodes a part served in body.data', async () => {
  const { s, calls } = session({
    '/messages/m1?format=full': {
      id: 'm1',
      labelIds: ['SENT'],
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            partId: '1',
            mimeType: 'text/csv',
            filename: 'small.csv',
            body: { data: Buffer.from('a,b').toString('base64url'), size: 3 },
          },
        ],
      },
    },
  });
  const bytes = await fetchAddressedAttachment(s, 'm1', '1', { maxBytes: 10 });
  expect(Buffer.from(bytes).toString()).toBe('a,b');
  expect(calls.some((u) => u.includes('/attachments/'))).toBe(false);
});
