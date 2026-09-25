import type { Account, Document, DocumentId, Query } from '@shared/contracts';

import { makeGetRelatedTool } from '../tools/get-related';

const ACCOUNT_ID = 'acc-1' as unknown as Account['id'];

const ACCOUNTS: Account[] = [
  { id: ACCOUNT_ID, source: 'gmail', identifier: 'me@example.com' } as Account,
];

function doc(id: string, over: Partial<Document> = {}): Document {
  return {
    id: id as unknown as DocumentId,
    accountId: ACCOUNT_ID,
    externalId: `ext-${id}`,
    type: 'email.message',
    title: `Subject ${id}`,
    markdown: 'x'.repeat(500),
    metadata: {},
    url: `https://mail.google.com/${id}`,
    createdAt: '2026-01-01T00:00:00Z',
    parentId: 'thread-1' as unknown as DocumentId,
    contentHash: 'hash',
    seq: 1,
    archivedAt: null,
    languages: [],
    ingestedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    scopeRootId: null,
    ...over,
  } as unknown as Document;
}

const THREAD_CHILDREN: Document[] = [doc('msg-1'), doc('msg-2'), doc('msg-3')];

function fakeQuery(overrides: Partial<Query> = {}): Query {
  return {
    async document() {
      return null;
    },
    async children() {
      return THREAD_CHILDREN;
    },
    async byExternalId() {
      return null;
    },
    async search() {
      return [];
    },
    async count() {
      return 0;
    },
    async countBy() {
      return [];
    },
    async accounts() {
      return ACCOUNTS;
    },
    ...overrides,
  };
}

describe('makeGetRelatedTool', () => {
  it('returns snake_case summaries with no markdown key', async () => {
    const getRelated = makeGetRelatedTool(fakeQuery());
    const out = (await getRelated({
      document_id: 'thread-1',
      relation: 'children',
    })) as unknown as Array<Record<string, unknown>>;

    expect(out).toHaveLength(3);
    for (const row of out) {
      expect(row).not.toHaveProperty('markdown');
      expect(row).not.toHaveProperty('metadata');
      expect(row).not.toHaveProperty('content_hash');
      expect(row).not.toHaveProperty('accountId');
      expect(row).not.toHaveProperty('parentId');
      expect(row).not.toHaveProperty('createdAt');
      expect(Object.keys(row).sort()).toEqual(
        [
          'created_at',
          'id',
          'parent_id',
          'snippet',
          'source',
          'source_url',
          'title',
          'type',
        ].sort(),
      );
    }
    expect(out[0].source).toBe('gmail');
    expect(out[0].source_url).toBe('https://mail.google.com/msg-1');
  });

  it('truncates snippet to 280 chars, or null when there is no markdown', async () => {
    const getRelated = makeGetRelatedTool(
      fakeQuery({
        async children() {
          return [
            doc('short', { markdown: 'hi' }),
            doc('none', { markdown: null }),
          ];
        },
      }),
    );
    const out = (await getRelated({
      document_id: 'thread-1',
      relation: 'children',
    })) as unknown as Array<{ snippet: string | null }>;

    expect(out[0].snippet).toBe('hi');
    expect(out[1].snippet).toBeNull();

    const getRelatedLong = makeGetRelatedTool(fakeQuery());
    const long = (await getRelatedLong({
      document_id: 'thread-1',
      relation: 'children',
    })) as unknown as Array<{ snippet: string | null }>;
    for (const row of long) {
      expect((row.snippet as string).length).toBeLessThanOrEqual(280);
    }
  });

  it('limit/offset slice the children', async () => {
    const getRelated = makeGetRelatedTool(fakeQuery());
    const out = (await getRelated({
      document_id: 'thread-1',
      relation: 'children',
      limit: 2,
      offset: 1,
    })) as Array<{ id: string }>;

    expect(out.map((r) => r.id)).toEqual(['msg-2', 'msg-3']);
  });

  it('clamps a limit of 1000 down to 200', async () => {
    const manyChildren = Array.from({ length: 250 }, (_, i) => doc(`m${i}`));
    const getRelated = makeGetRelatedTool(
      fakeQuery({
        async children() {
          return manyChildren;
        },
      }),
    );
    const out = (await getRelated({
      document_id: 'thread-1',
      relation: 'children',
      limit: 1000,
    })) as unknown[];

    expect(out).toHaveLength(200);
  });

  it('defaults to a limit of 50 when unspecified', async () => {
    const manyChildren = Array.from({ length: 80 }, (_, i) => doc(`m${i}`));
    const getRelated = makeGetRelatedTool(
      fakeQuery({
        async children() {
          return manyChildren;
        },
      }),
    );
    const out = (await getRelated({
      document_id: 'thread-1',
      relation: 'children',
    })) as unknown[];

    expect(out).toHaveLength(50);
  });

  it('clamps a limit of 0 up to 1, not the default', async () => {
    const getRelated = makeGetRelatedTool(fakeQuery());
    const out = (await getRelated({
      document_id: 'thread-1',
      relation: 'children',
      limit: 0,
    })) as unknown[];

    expect(out).toHaveLength(1);
  });

  it('parent returns the summary shape, and [] when there is no parent', async () => {
    const parentDoc = doc('thread-1', {
      type: 'email.thread',
      title: 'Thread subject',
      parentId: null,
    });
    const childDoc = doc('msg-1', {
      parentId: 'thread-1' as unknown as DocumentId,
    });
    const getRelated = makeGetRelatedTool(
      fakeQuery({
        async document(id) {
          if ((id as unknown as string) === 'msg-1') return childDoc;
          if ((id as unknown as string) === 'thread-1') return parentDoc;
          return null;
        },
      }),
    );

    const out = (await getRelated({
      document_id: 'msg-1',
      relation: 'parent',
    })) as unknown as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('markdown');
    expect(out[0].type).toBe('email.thread');
    expect(out[0].title).toBe('Thread subject');

    const noParentDoc = doc('orphan', { parentId: null });
    const getRelatedNoParent = makeGetRelatedTool(
      fakeQuery({
        async document(id) {
          return (id as unknown as string) === 'orphan' ? noParentDoc : null;
        },
      }),
    );
    const empty = await getRelatedNoParent({
      document_id: 'orphan',
      relation: 'parent',
    });
    expect(empty).toEqual([]);
  });
});
