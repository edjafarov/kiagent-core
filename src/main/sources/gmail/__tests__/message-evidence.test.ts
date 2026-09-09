import type { Account, AccountId, Document, Session } from '@shared/contracts';

import { gmailSource } from '../gmail-source';

function session(): Session {
  const account: Account = {
    id: 'gmail-account' as AccountId,
    source: 'gmail',
    identifier: 'owner@example.com',
    config: {},
    status: 'live',
    cursor: null,
    createdAt: new Date(0).toISOString(),
  };
  return {
    account,
    signal: new AbortController().signal,
    async credentials() {
      return { accessToken: 'fixture-token' };
    },
    log: () => {},
  };
}

function document(): Document {
  return {
    id: 'doc-1' as never,
    accountId: 'gmail-account' as AccountId,
    externalId: 'thread-1',
    type: 'email.thread',
    title: 'Fixture thread',
    markdown: null,
    metadata: {},
    createdAt: new Date(0).toISOString(),
    contentHash: 'hash-1',
    seq: 1,
    archivedAt: null,
    languages: [],
    ingestedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    parentId: null,
    scopeRootId: null,
  };
}

function message(id: string, from: string, internalDate: string, body: string) {
  return {
    id,
    threadId: 'thread-1',
    internalDate,
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: 'owner@example.com' },
        { name: 'Subject', value: 'Fixture' },
        { name: 'Message-ID', value: `<${id}@example.com>` },
      ],
      body: { data: Buffer.from(body).toString('base64url') },
    },
  };
}

describe('gmail readMessageEvidence', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('filters exact normalized authors, returns latest matches, clamps limit, and does not touch cursors', async () => {
    let calls = 0;
    global.fetch = (async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'thread-1',
          messages: [
            message(
              'old',
              'Alex Example <Alex@Example.com>',
              '1700000000000',
              'old',
            ),
            message('bob', 'Bob <bob@example.com>', '1800000000000', 'bob'),
            message(
              'new',
              'alex@example.com',
              '1900000000000',
              'new\n--\nAlex\nTitle',
            ),
            message('newer', 'alex@example.com', '2000000000000', 'newer'),
          ],
        }),
      } as Response;
    }) as typeof fetch;

    const before = session().account.cursor;
    const rows = await gmailSource.readMessageEvidence!(session(), document(), {
      authors: ['  ALEX@example.com  '],
      limit: 99,
    });

    expect(calls).toBe(1);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.author === 'alex@example.com')).toBe(true);
    expect(rows.map((row) => row.messageKey)).toEqual([
      '<newer@example.com>',
      '<new@example.com>',
      '<old@example.com>',
    ]);
    expect(before).toBeNull();
  });

  it('returns no rows when the remote thread no longer exists', async () => {
    global.fetch = (async () =>
      ({
        ok: false,
        status: 404,
        text: async () => 'Requested entity was not found',
        headers: { get: () => null },
      }) as unknown as Response) as typeof fetch;
    await expect(
      gmailSource.readMessageEvidence!(session(), document(), {
        authors: ['alex@example.com'],
        limit: 3,
      }),
    ).resolves.toEqual([]);
  });
});
