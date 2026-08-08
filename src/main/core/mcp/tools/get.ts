/**
 * `get` — fetches documents by id, projecting the internal `Document` into
 * the snake_case wire shape (`McpDocument`) MCP clients see. `id`/`ids`
 * batch semantics: an array in, an order-preserving array out with `null`
 * per miss.
 */
import type { Document, DocumentId, Query } from '@shared/contracts';

export const getDescription = `Fetch a document by id; returns full markdown body, \`source_url\`, and metadata. Use after \`search\` when snippets aren't enough.
\`source_url\` is a deep link back to the original (a \`file://\` absolute path for local files, the app's web link for cloud sources; null when the source has none). Every document has a url — when presenting documents to the user, link each one, not just the first; if url is empty or non-http, cite by title and date.
Batch mode: pass \`ids\` (array of document ids) to fetch several documents in one round-trip. Returns an array in the same order, with \`null\` for ids that don't exist.`;

export const getInputSchema = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'single document id. Mutually exclusive with `ids`.',
    },
    ids: {
      type: 'array',
      items: { type: 'string' },
      description:
        'batch: array of document ids. Mutually exclusive with `id`.',
    },
  },
} as const;

export interface McpDocument {
  id: string;
  source: string;
  type: string;
  title: string | null;
  markdown: string | null;
  metadata: unknown;
  source_url: string | null;
  content_hash: string | null;
  parent_id: string | null;
  created_at: string | null;
}

function toMcpDoc(d: Document, sourceOf: Map<string, string>): McpDocument {
  return {
    id: d.id,
    source: sourceOf.get(d.accountId) ?? 'unknown',
    type: d.type,
    title: d.title,
    markdown: d.markdown,
    metadata: d.metadata,
    source_url: d.url ?? null,
    content_hash: d.contentHash,
    parent_id: d.parentId,
    created_at: d.createdAt,
  };
}

export function makeGetTool(query: Query) {
  return async function get(args: Record<string, unknown>): Promise<unknown> {
    const a = args as { id?: string; ids?: string[] };

    if (Array.isArray(a.ids)) {
      if (a.id != null) throw new Error('pass either `id` or `ids` — not both');
      const accounts = await query.accounts();
      const sourceOf = new Map(
        accounts.map((acc) => [acc.id as string, acc.source]),
      );
      const docs = await Promise.all(
        a.ids.map((id) => query.document(id as DocumentId)),
      );
      return docs.map((d) => (d ? toMcpDoc(d, sourceOf) : null));
    }

    if (a.id == null) throw new Error('missing `id` (or `ids` for batch mode)');
    const doc = await query.document(a.id as DocumentId);
    if (!doc) return null;
    const accounts = await query.accounts();
    const sourceOf = new Map(
      accounts.map((acc) => [acc.id as string, acc.source]),
    );
    return toMcpDoc(doc, sourceOf);
  };
}
