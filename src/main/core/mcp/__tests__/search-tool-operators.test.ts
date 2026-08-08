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

function stubQueryReturning(doc: Record<string, unknown>): Query {
  return {
    accounts: async () => [{ id: 'acc-g', source: 'gmail' }],
    search: async () => [doc],
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

  it('client-built snippet extraction sees only the post-operator remainder, not the operator token', async () => {
    // The operator token `from:x@y.com` looks like it could leak into
    // extractTerms() if the tool ever fed the raw args.query instead of the
    // parsed remainder — five blank lines separate it from the real term so
    // the client-built snippet window can only include one or the other.
    const markdown = [
      'Reach out via from:x@y.com if this bounces.',
      '',
      '',
      '',
      '',
      'This line has the common word we actually want.',
    ].join('\n');
    const search = makeSearchTool(
      stubQueryReturning({
        id: 'doc-1',
        title: 'Doc',
        accountId: 'acc-g',
        type: 'email.thread',
        markdown,
        url: '',
        createdAt: '2026-08-01T00:00:00Z',
        ingestedAt: '2026-08-01T00:00:00Z',
      }),
    );
    const hits = (await search({ query: 'from:x@y.com common' })) as any[];
    expect(hits[0].snippet).toContain('**common**');
    expect(hits[0].snippet).toContain('actually want');
    expect(hits[0].snippet).not.toContain('from:x@y.com');
    expect(hits[0].snippet).not.toContain('bounces');
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
