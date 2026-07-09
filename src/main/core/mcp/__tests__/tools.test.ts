import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, Document, DocumentInput } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { buildBuiltinTools } from '../tools';
import type { SearchHit } from '../tools/search';
import type { LegacyDocument } from '../tools/get';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

function doc(
  externalId: string,
  over: Partial<DocumentInput> = {},
): DocumentInput {
  return {
    externalId,
    type: 'email.message',
    title: `Subject ${externalId}`,
    markdown: `Body of ${externalId} mentioning the quarterly budget review`,
    metadata: {},
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('mcp built-in tools', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let tools: ReturnType<typeof buildBuiltinTools>;

  const call = (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool ${name}`);
    return tool.call(args);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-mcp-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    accountId = account.id;

    await store.commit({
      account: accountId,
      documents: [
        doc('thread-1', { type: 'email.thread', title: 'Budget thread' }),
        doc('msg-1', {
          type: 'email.message',
          parent: { externalId: 'thread-1', type: 'email.thread' },
        }),
        doc('msg-2', {
          type: 'email.message',
          title: 'Unrelated',
          markdown: 'Nothing to see here',
          parent: { externalId: 'thread-1', type: 'email.thread' },
        }),
      ],
      cursor: 1,
      status: 'live',
    });

    tools = buildBuiltinTools(store.read);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('search: recency listing with no query returns everything', async () => {
    const hits = (await call('search', {})) as SearchHit[];
    expect(hits.length).toBe(3);
  });

  it('search: date filters hit the store, not a post-filter window', async () => {
    // Backfill-style commit order (newest mail first) — a limited
    // write-order window would never reach the older document.
    await store.commit({
      account: accountId,
      documents: [
        doc('recent', { title: 'Recent', createdAt: '2026-07-01T10:00:00Z' }),
        doc('lastweek', {
          title: 'Last week',
          createdAt: '2026-06-25T10:00:00Z',
        }),
      ],
      cursor: 2,
    });
    const hits = (await call('search', {
      from_date: '2026-06-23T00:00:00Z',
      to_date: '2026-06-30T00:00:00Z',
      limit: 50,
    })) as SearchHit[];
    expect(hits.map((h) => h.title)).toEqual(['Last week']);

    const listed = (await call('search', { limit: 2 })) as SearchHit[];
    expect(listed.map((h) => h.title)).toEqual(['Recent', 'Last week']);
  });

  it('search: malformed boolean query surfaces a descriptive error', async () => {
    await expect(call('search', { query: '-only-negative' })).rejects.toThrow(
      /positive term/,
    );
  });

  it('search: text query matches and filters by source/type', async () => {
    const hits = (await call('search', {
      query: 'budget',
      source: 'gmail',
      type: 'email.thread',
    })) as SearchHit[];
    expect(hits.length).toBe(1);
    expect(hits[0].title).toBe('Budget thread');
    expect(hits[0].source).toBe('gmail');
  });

  it('search: unknown source returns no results, not an error', async () => {
    const hits = (await call('search', {
      query: 'budget',
      source: 'slack',
    })) as SearchHit[];
    expect(hits).toEqual([]);
  });

  it('search: batch `queries` runs independent searches', async () => {
    const results = (await call('search', {
      queries: [{ query: 'budget' }, { type: 'email.thread' }],
    })) as SearchHit[][];
    expect(results).toHaveLength(2);
    expect(results[1][0].type).toBe('email.thread');
  });

  it('search: rejects mixing top-level filters with batch `queries`', async () => {
    await expect(call('search', { query: 'x', queries: [{}] })).rejects.toThrow(
      /either a single query/,
    );
  });

  it('get: single id maps to the legacy document shape', async () => {
    const thread = (await call('search', {
      type: 'email.thread',
    })) as SearchHit[];
    const { id } = thread[0];
    const got = (await call('get', { id })) as LegacyDocument;
    expect(got.source).toBe('gmail');
    expect(got.title).toBe('Budget thread');
    expect(got.markdown).toContain('quarterly budget review');
  });

  it('get: batch `ids` preserves order and nulls out misses', async () => {
    const all = (await call('search', {})) as SearchHit[];
    const got = (await call('get', {
      ids: [all[0].id, 'not-a-real-id'],
    })) as (LegacyDocument | null)[];
    expect(got).toHaveLength(2);
    expect(got[0]?.id).toBe(all[0].id);
    expect(got[1]).toBeNull();
  });

  it('count: totals and group_by source', async () => {
    const total = (await call('count', {})) as Array<{
      key: string;
      count: number;
    }>;
    expect(total).toEqual([{ key: 'all', count: 3 }]);

    const bySource = (await call('count', { group_by: 'source' })) as Array<{
      key: string;
      count: number;
    }>;
    expect(bySource).toEqual([{ key: 'gmail', count: 3 }]);
  });

  it('count: unsupported group_by throws a clear error instead of wrong data', async () => {
    await expect(call('count', { group_by: 'mime_type' })).rejects.toThrow(
      /requires raw SQL access/,
    );
  });

  it('get_related: attachments/children return the thread messages', async () => {
    const thread = (await call('search', {
      type: 'email.thread',
    })) as SearchHit[];
    const related = (await call('get_related', {
      document_id: thread[0].id,
      relation: 'attachments',
    })) as Document[];
    expect(related).toHaveLength(2);
  });

  it('get_related: parent resolves the other half of the same edge', async () => {
    const messages = (await call('search', {
      type: 'email.message',
    })) as SearchHit[];
    const related = (await call('get_related', {
      document_id: messages[0].id,
      relation: 'parent',
    })) as Document[];
    expect(related).toHaveLength(1);
    expect(related[0].type).toBe('email.thread');
  });

  it('digital_memory_info: reports accounts and exact by_source counts', async () => {
    const info = (await call('digital_memory_info')) as {
      accounts: Array<{ source: string; identifier: string }>;
      counts: { by_source: Array<{ key: string; count: number }> };
    };
    expect(info.accounts).toHaveLength(1);
    expect(info.accounts[0]).toMatchObject({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    expect(info.counts.by_source).toEqual([{ key: 'gmail', count: 3 }]);
  });
});
