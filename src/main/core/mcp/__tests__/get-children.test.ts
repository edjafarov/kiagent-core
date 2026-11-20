import type { Account, Document, DocumentId, Query } from '@shared/contracts';

import { GET_CHILDREN_LIMIT, makeGetTool, type McpDocument } from '../tools/get';

const ACCOUNT_ID = 'acc-wa' as unknown as Account['id'];

function doc(id: string, over: Partial<Document> = {}): Document {
  return {
    id: id as unknown as DocumentId,
    accountId: ACCOUNT_ID,
    externalId: `ext-${id}`,
    type: 'file',
    title: 'voice-note.ogg',
    markdown: null,
    metadata: {},
    url: null,
    createdAt: '2026-11-20T12:37:31.000Z',
    parentId: 'day-1' as unknown as DocumentId,
    contentHash: 'h',
    seq: 1,
    archivedAt: null,
    languages: [],
    ingestedAt: '2026-11-20T12:50:00.000Z',
    updatedAt: '2026-11-20T12:50:00.000Z',
    scopeRootId: null,
    ...over,
  } as unknown as Document;
}

const DAY = doc('day-1', {
  type: 'whatsapp.chat_day',
  title: 'Theresa Dehmer — Nov 20, 2026',
  markdown: '13:37 Theresa Dehmer: [voice note 1:08]',
  parentId: null,
});

function query(children: Record<string, Document[]>): Query {
  const byId = new Map<string, Document>([[DAY.id, DAY]]);
  for (const list of Object.values(children)) for (const c of list) byId.set(c.id, c);
  return {
    accounts: async () => [{ id: ACCOUNT_ID, source: 'kia.whatsapp' } as Account],
    document: async (id: DocumentId) => byId.get(id) ?? null,
    children: async (id: DocumentId) => children[id] ?? [],
  } as unknown as Query;
}

describe('get — inlined children', () => {
  it('lists a chat day’s voice-note transcripts with a snippet', async () => {
    const transcript = `Hello. ${'Ich habe mich auch total gewundert. '.repeat(20)}`;
    const get = makeGetTool(
      query({ 'day-1': [doc('vn-1', { markdown: `  ${transcript}` }), doc('vn-2')] }),
    );
    const out = (await get({ id: 'day-1' })) as McpDocument;

    expect(out.children_total).toBe(2);
    expect(out.children).toEqual([
      {
        id: 'vn-1',
        type: 'file',
        title: 'voice-note.ogg',
        created_at: '2026-11-20T12:37:31.000Z',
        snippet: transcript.trim().slice(0, 280),
      },
      // Not transcribed yet: present, but no snippet.
      {
        id: 'vn-2',
        type: 'file',
        title: 'voice-note.ogg',
        created_at: '2026-11-20T12:37:31.000Z',
        snippet: null,
      },
    ]);
  });

  it('caps the inlined list and reports the full count', async () => {
    const many = Array.from({ length: GET_CHILDREN_LIMIT + 5 }, (_, i) =>
      doc(`m-${i}`, { markdown: `message ${i}` }),
    );
    const out = (await makeGetTool(query({ 'day-1': many }))({ id: 'day-1' })) as McpDocument;
    expect(out.children).toHaveLength(GET_CHILDREN_LIMIT);
    expect(out.children[0]!.id).toBe('m-0');
    expect(out.children_total).toBe(GET_CHILDREN_LIMIT + 5);
  });

  it('gives a childless document an empty list, in batch mode too', async () => {
    const out = (await makeGetTool(query({}))({ ids: ['day-1', 'missing'] })) as Array<McpDocument | null>;
    expect(out[0]!.children).toEqual([]);
    expect(out[0]!.children_total).toBe(0);
    expect(out[1]).toBeNull();
  });
});
