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
