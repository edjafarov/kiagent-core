/**
 * `get` — fetches documents by id, projecting the internal `Document` into
 * the snake_case wire shape (`McpDocument`) MCP clients see. `id`/`ids`
 * batch semantics: an array in, an order-preserving array out with `null`
 * per miss.
 */
import type { Document, DocumentId, Query } from '@shared/contracts';
import { sourceUrlOf, type LocalPathOf } from './local-path';

/** Children inlined per document. Enough for a chat day's media or a normal
 *  thread; a 200-message thread is paged through `get_related` instead. */
export const GET_CHILDREN_LIMIT = 20;
const CHILD_SNIPPET_CHARS = 280;

export const getDescription = `Fetch a document by id; returns full markdown body, \`source_url\`, and metadata. Use after \`search\` when snippets aren't enough.
\`source_url\` is a deep link back to the original (a \`file://\` absolute path for local files, the app's web link for cloud sources; null when the source has none). Every document has a url — when presenting documents to the user, link each one, not just the first; if url is empty or non-http, cite by title and date.
\`children\` lists the document's child records (an email thread's messages, attachments, a chat's voice-note transcripts and photos) — id, type, title, created_at and a short text snippet, at most ${GET_CHILDREN_LIMIT}; \`children_total\` is the full count. A snippet is only the start of the text: \`get\` the child id for its full body, and \`get_related(children)\` pages past the first ${GET_CHILDREN_LIMIT}.
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

/** A child record inlined on `get`, so a client sees attachments and
 *  transcripts without knowing to call `get_related` (2026-11-20: a chat day
 *  showed only `[voice note 1:08]` and ChatGPT answered "no transcript" while
 *  the transcripts sat in its child documents). */
export interface McpChildSummary {
  id: string;
  type: string;
  title: string | null;
  created_at: string | null;
  snippet: string | null;
}

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
  children: McpChildSummary[];
  children_total: number;
}

function toChildSummary(c: Document): McpChildSummary {
  const text = c.markdown?.trim();
  return {
    id: c.id,
    type: c.type,
    title: c.title,
    created_at: c.createdAt,
    snippet: text ? text.slice(0, CHILD_SNIPPET_CHARS) : null,
  };
}

async function toMcpDoc(
  d: Document,
  sourceOf: Map<string, string>,
  query: Query,
  localPathOf?: LocalPathOf,
): Promise<McpDocument> {
  const children = await query.children(d.id);
  return {
    id: d.id,
    source: sourceOf.get(d.accountId) ?? 'unknown',
    type: d.type,
    title: d.title,
    markdown: d.markdown,
    metadata: d.metadata,
    source_url: await sourceUrlOf(d, sourceOf.get(d.accountId), localPathOf),
    content_hash: d.contentHash,
    parent_id: d.parentId,
    created_at: d.createdAt,
    children: children.slice(0, GET_CHILDREN_LIMIT).map(toChildSummary),
    children_total: children.length,
  };
}

export function makeGetTool(query: Query, localPathOf?: LocalPathOf) {
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
      return Promise.all(
        docs.map((d) => (d ? toMcpDoc(d, sourceOf, query, localPathOf) : null)),
      );
    }

    if (a.id == null) throw new Error('missing `id` (or `ids` for batch mode)');
    const doc = await query.document(a.id as DocumentId);
    if (!doc) return null;
    const accounts = await query.accounts();
    const sourceOf = new Map(
      accounts.map((acc) => [acc.id as string, acc.source]),
    );
    return toMcpDoc(doc, sourceOf, query, localPathOf);
  };
}
