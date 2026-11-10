import type { Query } from '@shared/contracts';

import { makeGetRelatedTool } from '../tools/get-related';
import { makeGetTool } from '../tools/get';
import { makeSearchTool } from '../tools/search';

const doc = (over: Record<string, unknown> = {}) => ({
  id: 'd1',
  accountId: 'a-shared',
  externalId: 'sorted/Tax/a.pdf',
  type: 'file',
  title: 'a.pdf',
  markdown: 'text',
  metadata: {},
  contentHash: 'h',
  parentId: null,
  createdAt: '2026-01-01T00:00:00Z',
  ingestedAt: '2026-01-01T00:00:00Z',
  snippet: 'text',
  url: undefined,
  ...over,
});
const query = (d: ReturnType<typeof doc>, source = 'shared-folder'): Query =>
  ({
    accounts: async () => [{ id: 'a-shared', source }],
    document: async () => d,
    search: async () => [d],
    children: async () => [d],
  }) as unknown as Query;
const resolver = async (x: { accountId: string; externalId: string }) =>
  x.accountId === 'a-shared' ? `/Users/me/Sorted/${x.externalId.slice('sorted/'.length)}` : null;

it('a shared-folder document gets the file:// link of the file on this Mac', async () => {
  const url = 'file:///Users/me/Sorted/Tax/a.pdf';
  expect(((await makeGetTool(query(doc()), resolver)({ id: 'd1' })) as { source_url: string }).source_url).toBe(url);
  const hits = (await makeSearchTool(query(doc()), resolver)({ query: 'a' })) as { source_url: string }[];
  expect(hits[0].source_url).toBe(url);
  const related = (await makeGetRelatedTool(query(doc()), resolver)({ document_id: 'd1', relation: 'children' })) as {
    source_url: string;
  }[];
  expect(related[0].source_url).toBe(url);
});

it('spaces and accents are escaped as for local files', async () => {
  const d = doc({ externalId: 'sorted/Steuer 2025/Bescheid ä.pdf' });
  const r = async () => '/Users/me/Sorted/Steuer 2025/Bescheid ä.pdf';
  const got = (await makeGetTool(query(d), r)({ id: 'd1' })) as { source_url: string };
  expect(got.source_url).toBe(`file://${encodeURI('/Users/me/Sorted/Steuer 2025/Bescheid ä.pdf')}`);
});

it('a document that has its own url keeps it; other sources are untouched; nothing resolves to null/empty', async () => {
  const own = doc({ url: 'https://example.com/x' });
  expect(((await makeGetTool(query(own), resolver)({ id: 'd1' })) as { source_url: string }).source_url).toBe(
    'https://example.com/x',
  );
  const gmail = query(doc(), 'gmail');
  expect(((await makeGetTool(gmail, resolver)({ id: 'd1' })) as { source_url: string | null }).source_url).toBeNull();
  const none = async () => null;
  expect(((await makeGetTool(query(doc()), none)({ id: 'd1' })) as { source_url: string | null }).source_url).toBeNull();
  expect(((await makeGetTool(query(doc()))({ id: 'd1' })) as { source_url: string | null }).source_url).toBeNull();
  const hits = (await makeSearchTool(query(doc()), none)({ query: 'a' })) as { source_url: string }[];
  expect(hits[0].source_url).toBe('');
});

it('a resolver that throws gives no link instead of failing the tool', async () => {
  const boom = async (): Promise<string | null> => {
    throw new Error('boom');
  };
  expect(((await makeGetTool(query(doc()), boom)({ id: 'd1' })) as { source_url: string | null }).source_url).toBeNull();
});
