/**
 * `get_related` — ported from kiagent-ref's src/main/mcp/tools/get-related.ts.
 * Legacy read `thread_messages` out of a JSON blob in `metadata.messages` and
 * `attachments` via a child-document lookup. The greenfield Document model
 * represents both thread messages and attachments the same way — as child
 * documents (`parentId`) resolved in-transaction by the engine — so both
 * relations map onto `Query.children`. `parent` is a small addition (not in
 * the legacy enum) using `Query.document` twice, exposing the other half of
 * the same parent/child edge; existing callers using the legacy two values
 * are unaffected.
 */
import type { Document, DocumentId, Query } from '@shared/contracts';

export const GET_RELATED_RELATIONS = [
  'thread_messages',
  'attachments',
  'children',
  'parent',
] as const;
export type GetRelatedRelation = (typeof GET_RELATED_RELATIONS)[number];

export const getRelatedDescription = `Return records related to a given document id.
Relations:
  thread_messages — child documents of an email thread (its individual messages)
  attachments     — child documents of a document (e.g. email attachments)
  children        — alias for the above; the greenfield store models both the same way
  parent          — the single parent document, if any
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

    if (
      a.relation === 'thread_messages' ||
      a.relation === 'attachments' ||
      a.relation === 'children'
    ) {
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
