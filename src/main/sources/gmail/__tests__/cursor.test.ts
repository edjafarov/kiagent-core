import type { Account, Session } from '@shared/contracts';

import { isGmailNotFoundError, type GmailCursor } from '../cursor';
import { pull } from '../gmail-source';
import type { GmailThreadItem } from '../to-document';

interface FakeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

function okJson(body: unknown): FakeResponse {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

function notFound(message = 'Requested entity was not found.'): FakeResponse {
  const bodyText = JSON.stringify({ error: { code: 404, message } });
  return {
    ok: false,
    status: 404,
    json: async () => JSON.parse(bodyText),
    text: async () => bodyText,
    headers: { get: () => null },
  };
}

function makeSession(): Session {
  const controller = new AbortController();
  const account: Account = {
    id: 'acc-1' as Account['id'],
    source: 'gmail',
    identifier: 'owner@example.com',
    config: {},
    status: 'connecting',
    cursor: null,
    createdAt: new Date().toISOString(),
  };
  return {
    account,
    signal: controller.signal,
    credentials: async () => ({ accessToken: 'test-access-token' }),
    log: () => {},
  };
}

/** Routes the mocked global fetch by URL substring, in the order given. */
function mockFetchByUrl(
  routes: Array<[substr: string, respond: () => FakeResponse]>,
) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes.find(([substr]) => url.includes(substr));
    if (!route) throw new Error(`unmocked fetch: ${url}`);
    return route[1]() as unknown as Response;
  }) as unknown as typeof fetch;
}

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('isGmailNotFoundError', () => {
  it('matches the bearerFetch 404 "not found" message shape', () => {
    const err = new Error(
      'gmail 404 https://gmail.googleapis.com/x {"error":{"message":"Requested entity was not found."}}',
    );
    expect(isGmailNotFoundError(err)).toBe(true);
  });

  it('does not match other statuses or messages', () => {
    expect(isGmailNotFoundError(new Error('gmail 500 https://x boom'))).toBe(
      false,
    );
    expect(
      isGmailNotFoundError(new Error('gmail 404 https://x some other body')),
    ).toBe(false);
    expect(isGmailNotFoundError('not an Error instance')).toBe(false);
  });
});

describe('gmail pull() cursor transitions (fetch mocked — no live API calls)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('null cursor -> backfill captures historyId, drains one page, flips to delta, then does a live sweep', async () => {
    mockFetchByUrl([
      [
        '/profile',
        () =>
          okJson({
            emailAddress: 'owner@example.com',
            historyId: '1000',
            threadsTotal: 42,
          }),
      ],
      [
        '/threads?',
        () =>
          okJson({
            threads: [{ id: 't1' }, { id: 't2' }],
            // Deliberately different from the profile's threadsTotal: the
            // per-page resultSizeEstimate must NOT be used as the backfill
            // total (it's a per-page guess, wildly off for big mailboxes).
            resultSizeEstimate: 2,
          }),
      ],
      [
        '/threads/t1',
        () => okJson({ id: 't1', messages: [minimalMessage('t1', '1')] }),
      ],
      [
        '/threads/t2',
        () => okJson({ id: 't2', messages: [minimalMessage('t2', '1')] }),
      ],
      ['/history?', () => okJson({ history: [], historyId: '1000' })],
    ]);

    const batches = await drain(pull(makeSession(), null));
    expect(batches).toHaveLength(2);

    const [backfillBatch, liveBatch] = batches;
    expect(backfillBatch.phase).toBe('backfill');
    expect(
      backfillBatch.items.map((i: GmailThreadItem) => i.id).sort(),
    ).toEqual(['t1', 't2']);
    expect(backfillBatch.cursor).toEqual<GmailCursor>({
      mode: 'backfill',
      pageToken: null,
      historyId: '1000',
    });
    expect(backfillBatch.estimateTotal).toBe(42);

    expect(liveBatch.phase).toBe('live');
    expect(liveBatch.items).toEqual([]);
    expect(liveBatch.cursor).toEqual<GmailCursor>({
      mode: 'delta',
      historyId: '1000',
    });
  });

  it('resumes backfill from a saved pageToken WITHOUT re-capturing historyId', async () => {
    const fetchSpy = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // The resume path re-fetches the profile for threadsTotal (the
      // progress estimate) ONLY — returning a different historyId here
      // proves the saved cursor's watermark is what gets persisted.
      if (url.includes('/profile'))
        return okJson({
          emailAddress: 'owner@example.com',
          historyId: '9999',
          threadsTotal: 7,
        }) as unknown as Response;
      if (url.includes('/threads?')) {
        expect(url).toContain('pageToken=PAGE2');
        return okJson({ threads: [{ id: 't3' }] }) as unknown as Response;
      }
      if (url.includes('/threads/t3'))
        return okJson({
          id: 't3',
          messages: [minimalMessage('t3', '1')],
        }) as unknown as Response;
      if (url.includes('/history?'))
        return okJson({ history: [], historyId: '500' }) as unknown as Response;
      throw new Error(`unmocked fetch: ${url}`);
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const resumeCursor: GmailCursor = {
      mode: 'backfill',
      pageToken: 'PAGE2',
      historyId: '500',
    };
    const batches = await drain(pull(makeSession(), resumeCursor));

    expect(batches[0].phase).toBe('backfill');
    expect(batches[0].items.map((i: GmailThreadItem) => i.id)).toEqual(['t3']);
    expect(batches[0].estimateTotal).toBe(7);
    expect(batches[0].cursor).toEqual<GmailCursor>({
      mode: 'backfill',
      pageToken: null,
      historyId: '500',
    });
    expect(batches[1].cursor).toEqual<GmailCursor>({
      mode: 'delta',
      historyId: '500',
    });
  });

  it('delta sweep resolves messagesAdded/messagesDeleted into items + Batch.deletions', async () => {
    mockFetchByUrl([
      [
        '/history?',
        () =>
          okJson({
            historyId: '43',
            history: [
              { messagesAdded: [{ message: { threadId: 'updated1' } }] },
              { messagesDeleted: [{ message: { threadId: 'gone1' } }] },
            ],
          }),
      ],
      [
        '/threads/updated1',
        () =>
          okJson({
            id: 'updated1',
            messages: [minimalMessage('updated1', '1')],
          }),
      ],
      ['/threads/gone1', () => notFound()],
    ]);

    const cursor: GmailCursor = { mode: 'delta', historyId: '42' };
    const batches = await drain(pull(makeSession(), cursor));

    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch.phase).toBe('live');
    expect(batch.items.map((i: GmailThreadItem) => i.id)).toEqual(['updated1']);
    expect(batch.deletions).toEqual([
      { externalId: 'gone1', type: 'email.thread' },
    ]);
    expect(batch.cursor).toEqual<GmailCursor>({
      mode: 'delta',
      historyId: '43',
    });
  });

  it('falls back to a fresh backfill when history.list 404s with an expired watermark', async () => {
    mockFetchByUrl([
      ['/history?', () => notFound()],
      [
        '/profile',
        () => okJson({ emailAddress: 'owner@example.com', historyId: '777' }),
      ],
    ]);

    const cursor: GmailCursor = { mode: 'delta', historyId: '42' };
    const batches = await drain(pull(makeSession(), cursor));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({
      phase: 'backfill',
      items: [],
      cursor: { mode: 'backfill', pageToken: null, historyId: '777' },
    });
  });

  it('propagates a non-404 delta failure instead of silently resetting the cursor', async () => {
    // 400 is not in bearerFetch's retryable set (unlike 429/5xx/some 403s), so
    // this throws immediately with no backoff delay to wait out in the test.
    mockFetchByUrl([
      [
        '/history?',
        () => ({
          ok: false,
          status: 400,
          json: async () => ({ error: 'bad request' }),
          text: async () => 'bad request',
          headers: { get: () => null },
        }),
      ],
    ]);

    const cursor: GmailCursor = { mode: 'delta', historyId: '42' };
    await expect(drain(pull(makeSession(), cursor))).rejects.toThrow(
      /gmail 400/,
    );
  });
});

function minimalMessage(threadId: string, id: string) {
  return {
    id,
    threadId,
    labelIds: ['INBOX'],
    internalDate: '1704106800000',
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'To', value: 'Bob <bob@example.com>' },
        { name: 'Subject', value: `Thread ${threadId}` },
        { name: 'Message-ID', value: `<${id}@example.com>` },
      ],
      body: { data: Buffer.from('hello').toString('base64url'), size: 5 },
    },
  };
}
