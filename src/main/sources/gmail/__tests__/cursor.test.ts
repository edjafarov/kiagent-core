import type { Account, Session } from '@shared/contracts';

import {
  bucketTask,
  initialTasks,
  isGmailNotFoundError,
  migrateGmailCursor,
  type GmailCursor,
} from '../cursor';
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

function makeSession(config: Record<string, unknown> = {}): Session {
  const controller = new AbortController();
  const account: Account = {
    id: 'acc-1' as Account['id'],
    source: 'gmail',
    identifier: 'owner@example.com',
    config,
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

describe('cursor v2', () => {
  it('migrates v1 cursors and passes v2 / null through', () => {
    expect(
      migrateGmailCursor({ mode: 'backfill', pageToken: 'P', historyId: '1' }),
    ).toEqual({ v: 2, historyId: '1', tasks: [{ q: null, pageToken: 'P' }] });
    expect(migrateGmailCursor({ mode: 'delta', historyId: '2' })).toEqual({
      v: 2,
      historyId: '2',
      tasks: [],
    });
    const v2: GmailCursor = { v: 2, historyId: '3', tasks: [] };
    expect(migrateGmailCursor(v2)).toBe(v2);
    expect(migrateGmailCursor(null)).toBeNull();
  });

  it('initialTasks: the full scope, then one query per selected opt-in bucket', () => {
    expect(initialTasks(new Set(['mail']))).toEqual([
      { q: null, pageToken: null },
    ]);
    expect(initialTasks(new Set(['mail', 'SPAM', 'TRASH']))).toEqual([
      { q: null, pageToken: null },
      { q: 'in:trash', pageToken: null },
      { q: 'in:spam', pageToken: null },
    ]);
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
    // The only task finished on its last page: the queue is empty.
    expect(backfillBatch.cursor).toEqual<GmailCursor>({
      v: 2,
      historyId: '1000',
      tasks: [],
    });
    expect(backfillBatch.estimateTotal).toBe(42);

    expect(liveBatch.phase).toBe('live');
    expect(liveBatch.items).toEqual([]);
    expect(liveBatch.cursor).toEqual<GmailCursor>({
      v: 2,
      historyId: '1000',
      tasks: [],
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

    // A LEGACY v1 cursor persisted before the upgrade.
    const resumeCursor = {
      mode: 'backfill',
      pageToken: 'PAGE2',
      historyId: '500',
    } as never;
    const batches = await drain(pull(makeSession(), resumeCursor));

    expect(batches[0].phase).toBe('backfill');
    expect(batches[0].items.map((i: GmailThreadItem) => i.id)).toEqual(['t3']);
    expect(batches[0].estimateTotal).toBe(7);
    expect(batches[0].cursor).toEqual<GmailCursor>({
      v: 2,
      historyId: '500',
      tasks: [],
    });
    expect(batches[1].cursor).toEqual<GmailCursor>({
      v: 2,
      historyId: '500',
      tasks: [],
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

    const cursor: GmailCursor = { v: 2, historyId: '42', tasks: [] };
    const batches = await drain(pull(makeSession(), cursor));

    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch.phase).toBe('live');
    expect(batch.items.map((i: GmailThreadItem) => i.id)).toEqual(['updated1']);
    expect(batch.deletions).toEqual([
      { externalId: 'gone1', type: 'email.thread' },
    ]);
    expect(batch.cursor).toEqual<GmailCursor>({
      v: 2,
      historyId: '43',
      tasks: [],
    });
  });

  it('delta sweep chunks >25 affected threads: intermediates hold the OLD historyId, the final batch advances it and carries deletions', async () => {
    // 30 affected threads (one hard-deleted) → two batches of 25 + 5. A
    // mid-sweep failure after batch 1 committed must re-sweep from the OLD
    // watermark — an early advance would permanently skip batch 2's threads.
    const threadIds = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const routes: Array<[string, () => FakeResponse]> = [
      [
        '/history?',
        () =>
          okJson({
            historyId: '99',
            history: threadIds.map((id) => ({
              messagesAdded: [{ message: { threadId: id } }],
            })),
          }),
      ],
      // The trailing `?` disambiguates substring routes (t2 vs t20 etc.).
      ...threadIds
        .filter((id) => id !== 't7')
        .map((id): [string, () => FakeResponse] => [
          `/threads/${id}?`,
          () => okJson({ id, messages: [minimalMessage(id, '1')] }),
        ]),
      ['/threads/t7?', () => notFound()],
    ];
    mockFetchByUrl(routes);

    const cursor: GmailCursor = { v: 2, historyId: '42', tasks: [] };
    const batches = await drain(pull(makeSession(), cursor));

    expect(batches).toHaveLength(2);
    // t7 (hard-deleted) sits in the first chunk: its deletion is HELD BACK
    // until the final batch, where it commits atomically with the advanced
    // watermark.
    expect(batches[0].items).toHaveLength(24);
    expect(batches[0].deletions).toBeUndefined();
    // The intermediate batch must NOT advance the watermark.
    expect(batches[0].cursor).toEqual<GmailCursor>({
      v: 2,
      historyId: '42',
      tasks: [],
    });
    expect(batches[1].items).toHaveLength(5);
    expect(batches[1].deletions).toEqual([
      { externalId: 't7', type: 'email.thread' },
    ]);
    expect(batches[1].cursor).toEqual<GmailCursor>({
      v: 2,
      historyId: '99',
      tasks: [],
    });
    // Every affected thread was either re-fetched or reported deleted.
    const seen = batches.flatMap((b) =>
      b.items.map((i: GmailThreadItem) => i.id),
    );
    expect(new Set(seen).size).toBe(29);
  });

  it('falls back to a fresh backfill when history.list 404s with an expired watermark', async () => {
    mockFetchByUrl([
      ['/history?', () => notFound()],
      [
        '/profile',
        () => okJson({ emailAddress: 'owner@example.com', historyId: '777' }),
      ],
    ]);

    const cursor: GmailCursor = { v: 2, historyId: '42', tasks: [] };
    const batches = await drain(pull(makeSession(), cursor));

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual({
      phase: 'backfill',
      items: [],
      cursor: {
        v: 2,
        historyId: '777',
        tasks: [{ q: null, pageToken: null }],
      },
    });
  });

  it('works the task queue in order, then sweeps history from the shared watermark', async () => {
    const urls: string[] = [];
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/profile'))
        return okJson({ historyId: '9', threadsTotal: 5 }) as never;
      if (url.includes('/threads?')) {
        const q = new URL(url).searchParams.get('q');
        const token = new URL(url).searchParams.get('pageToken');
        if (q === null && token === 'p')
          return okJson({
            threads: [{ id: 'a' }],
            nextPageToken: 'p2',
          }) as never;
        if (q === null && token === 'p2')
          return okJson({ threads: [{ id: 'b' }] }) as never;
        if (q === 'in:trash' && token === null)
          return okJson({ threads: [] }) as never;
        throw new Error(`unexpected listing: ${url}`);
      }
      const t = url.match(/threads\/(\w+)\?/);
      if (t)
        return okJson({
          id: t[1],
          messages: [minimalMessage(t[1], '1')],
        }) as never;
      if (url.includes('/history?')) {
        expect(url).toContain('startHistoryId=h');
        return okJson({ history: [], historyId: 'h' }) as never;
      }
      throw new Error(`unmocked fetch: ${url}`);
    }) as unknown as typeof fetch;

    const trash = bucketTask('TRASH');
    const batches = await drain(
      pull(makeSession(), {
        v: 2,
        historyId: 'h',
        tasks: [{ q: null, pageToken: 'p' }, trash],
      }),
    );
    expect(batches.map((b) => [b.phase, b.cursor])).toEqual([
      // page p done → the task advances to p2, trash still queued
      [
        'backfill',
        { v: 2, historyId: 'h', tasks: [{ q: null, pageToken: 'p2' }, trash] },
      ],
      // the full task's last page → dropped from the queue
      ['backfill', { v: 2, historyId: 'h', tasks: [trash] }],
      // an EMPTY listing still yields, so the finished task is persisted
      ['backfill', { v: 2, historyId: 'h', tasks: [] }],
      ['live', { v: 2, historyId: 'h', tasks: [] }],
    ]);
    expect(batches[0].estimateTotal).toBe(5);
    const listings = urls.filter((u) => u.includes('/threads?'));
    expect(
      listings.map((u) => new URL(u).searchParams.get('includeSpamTrash')),
    ).toEqual([null, null, 'true']);
  });

  it('a null cursor with Trash selected queues the full task, then in:trash', async () => {
    mockFetchByUrl([
      ['/profile', () => okJson({ historyId: '5', threadsTotal: 0 })],
      ['/threads?', () => okJson({ threads: [] })],
      ['/history?', () => okJson({ history: [], historyId: '5' })],
    ]);
    const batches = await drain(
      pull(
        makeSession({
          folderRoots: [
            { id: 'mail', name: 'All mail' },
            { id: 'TRASH', name: 'Trash' },
          ],
        }),
        null,
      ),
    );
    expect(batches[0].cursor).toEqual({
      v: 2,
      historyId: '5',
      tasks: [bucketTask('TRASH')],
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

    const cursor: GmailCursor = { v: 2, historyId: '42', tasks: [] };
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
