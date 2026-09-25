/**
 * `get_related` — the Document model represents thread messages and
 * attachments the same way: as child documents (`parentId`) resolved
 * in-transaction by the engine, so one `children` relation covers both.
 * `parent` uses `Query.document` twice, exposing the other half of the same
 * parent/child edge. Results are projected into the same snake_case summary
 * shape `get`/`search` use (`get.ts:29-55`) — bounded and paged, since a
 * 200-message thread's full bodies would blow the response budget; callers
 * that need a full body follow up with `get`.
 */
import type { Document, DocumentId, Query } from '@shared/contracts';

export const GET_RELATED_RELATIONS = ['children', 'parent'] as const;
export type GetRelatedRelation = (typeof GET_RELATED_RELATIONS)[number];

export const getRelatedDescription = `Return summaries of records related to a given document id, paged with \`limit\`/\`offset\`.
Relations:
  children — child documents of a document (an email thread's individual messages, a document's attachments)
  parent   — the single parent document, if any (a 0-or-1 array)
\`children\` is ordered oldest-first and returns at most \`limit\` rows — if you receive exactly \`limit\` rows, fetch the next page with \`offset\`.
Returns one summary per row: id, source, type, title, source_url, parent_id, created_at, snippet (markdown truncated to 280 chars, or null) — no \`markdown\` body. Use \`get\` for full bodies.
Use after \`get\` or \`search\` to drill into a parent/child relationship.`;

export const getRelatedInputSchema = {
  type: 'object',
  properties: {
    document_id: { type: 'string' },
    relation: { type: 'string', enum: [...GET_RELATED_RELATIONS] },
    limit: {
      type: 'number',
      description: 'max results for `children` (default 50, max 200)',
    },
    offset: {
      type: 'number',
      description: 'skip this many `children` results (default 0)',
    },
  },
  required: ['document_id', 'relation'],
} as const;

export interface GetRelatedSummary {
  id: string;
  source: string;
  type: string;
  title: string | null;
  source_url: string | null;
  parent_id: string | null;
  created_at: string | null;
  snippet: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const SNIPPET_MAX_CHARS = 280;

function resolveLimit(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LIMIT;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

function resolveOffset(raw: unknown): number {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function toSummary(
  d: Document,
  sourceOf: Map<string, string>,
): GetRelatedSummary {
  return {
    id: d.id,
    source: sourceOf.get(d.accountId) ?? 'unknown',
    type: d.type,
    title: d.title,
    source_url: d.url ?? null,
    parent_id: d.parentId,
    created_at: d.createdAt,
    snippet: d.markdown ? d.markdown.slice(0, SNIPPET_MAX_CHARS) : null,
  };
}

export function makeGetRelatedTool(query: Query) {
  return async function getRelated(
    args: Record<string, unknown>,
  ): Promise<GetRelatedSummary[]> {
    const a = args as {
      document_id: string;
      relation: string;
      limit?: unknown;
      offset?: unknown;
    };
    const id = a.document_id as DocumentId;
    const accounts = await query.accounts();
    const sourceOf = new Map(
      accounts.map((acc) => [acc.id as string, acc.source]),
    );

    if (a.relation === 'children') {
      const limit = resolveLimit(a.limit);
      const offset = resolveOffset(a.offset);
      const children = await query.children(id);
      return children
        .slice(offset, offset + limit)
        .map((d) => toSummary(d, sourceOf));
    }
    if (a.relation === 'parent') {
      const doc = await query.document(id);
      if (!doc?.parentId) return [];
      const parent = await query.document(doc.parentId);
      return parent ? [toSummary(parent, sourceOf)] : [];
    }
    throw new Error(`get_related: unknown relation '${a.relation}'`);
  };
}
