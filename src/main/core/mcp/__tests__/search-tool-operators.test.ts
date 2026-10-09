import type { Query } from '@shared/contracts';
import { makeSearchTool } from '../tools/search';

function stubQuery(captured: unknown[]): Query {
  return {
    accounts: async () => [
      { id: 'acc-g', source: 'gmail' },
      { id: 'acc-s', source: 'slack' },
    ],
    search: async (q: unknown) => {
      captured.push(q);
      return [];
    },
  } as unknown as Query;
}

describe('search tool operator wiring', () => {
  it('translates operators into Query.search structured fields', async () => {
    const calls: any[] = [];
    const search = makeSearchTool(stubQuery(calls));
    await search({
      query:
        'from:rkaplun@zoolatech.com label:inbox has:attachment order:newest log*',
    });
    expect(calls[0]).toMatchObject({
      text: 'log*',
      people: { from: ['rkaplun@zoolatech.com'] },
      label: ['inbox'],
      hasAttachment: true,
      orderBy: 'newest',
    });
  });

  it('operators-only query sends no text (filtered recency listing)', async () => {
    const calls: any[] = [];
    const search = makeSearchTool(stubQuery(calls));
    await search({ query: 'from:sebastian' });
    expect(calls[0].text).toBeUndefined();
    expect(calls[0].people).toEqual({ from: ['sebastian'] });
  });

  it('in: operator overrides the source JSON param and routes to that account', async () => {
    const calls: any[] = [];
    const search = makeSearchTool(stubQuery(calls));
    await search({ query: 'in:slack standup', source: 'gmail' });
    expect(calls).toHaveLength(1);
    expect(calls[0].account).toBe('acc-s');
  });

  it('type: operator overrides the type JSON param', async () => {
    const calls: any[] = [];
    const search = makeSearchTool(stubQuery(calls));
    await search({ query: 'type:email.thread x', type: 'file' });
    expect(calls[0].type).toBe('email.thread');
  });

  it('passes only the post-operator remainder as text and returns the store-built snippet as-is', async () => {
    // The store builds the snippet ('snippet' projection) from the text it is
    // given, so the operator token must never reach it; the tool just relays
    // the store's snippet.
    const calls: any[] = [];
    const search = makeSearchTool({
      accounts: async () => [{ id: 'acc-g', source: 'gmail' }],
      search: async (q: unknown) => {
        calls.push(q);
        return [
          {
            id: 'doc-1',
            title: 'Doc',
            accountId: 'acc-g',
            type: 'email.thread',
            markdown: '',
            snippet: 'This line has the **common** word we actually want.',
            url: '',
            createdAt: '2026-08-01T00:00:00Z',
            ingestedAt: '2026-08-01T00:00:00Z',
          },
        ];
      },
    } as unknown as Query);
    const hits = (await search({ query: 'from:x@y.com common' })) as any[];
    expect(calls[0]).toMatchObject({ text: 'common', project: 'snippet' });
    expect(hits[0].snippet).toBe(
      'This line has the **common** word we actually want.',
    );
  });

  it('operators work per-entry in batch mode', async () => {
    const calls: any[] = [];
    const search = makeSearchTool(stubQuery(calls));
    await search({
      queries: [{ query: 'from:a@x.com' }, { query: 'plain words' }],
    });
    expect(calls[0].people).toEqual({ from: ['a@x.com'] });
    expect(calls[1].people).toBeUndefined();
    expect(calls[1].text).toBe('plain words');
  });
});
