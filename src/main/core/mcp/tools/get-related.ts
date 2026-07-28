/**
 * `get_related` — the Document model represents thread messages and
 * attachments the same way: as child documents (`parentId`) resolved
 * in-transaction by the engine, so one `children` relation covers both.
 * `parent` uses `Query.document` twice, exposing the other half of the same
 * parent/child edge.
 */
import type { Document, DocumentId, Query } from '@shared/contracts';

export const GET_RELATED_RELATIONS = ['children', 'parent'] as const;
export type GetRelatedRelation = (typeof GET_RELATED_RELATIONS)[number];

export const getRelatedDescription = `Return records related to a given document id.
Relations:
  children — child documents of a document (an email thread's individual messages, a document's attachments)
  parent   — the single parent document, if any
Use after \`get\` or \`search\` to drill into a parent/child relationship.`;

export const getRelatedInputSchema = {
  type: 'object',
  properties: {
    document_id: { type: 'string' },
    relation: { type: 'string', enum: [...GET_RELATED_RELATIONS] },
  },
  required: ['document_id', 'relation'],
} as const;

export function makeGetRelatedTool(query: Query) {
  return async function getRelated(
    args: Record<string, unknown>,
  ): Promise<Document[]> {
    const a = args as { document_id: string; relation: string };
    const id = a.document_id as DocumentId;

    if (a.relation === 'children') {
      return query.children(id);
    }
    if (a.relation === 'parent') {
      const doc = await query.document(id);
      if (!doc?.parentId) return [];
      const parent = await query.document(doc.parentId);
      return parent ? [parent] : [];
    }
    throw new Error(`get_related: unknown relation '${a.relation}'`);
  };
}
