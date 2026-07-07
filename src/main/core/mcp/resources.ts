/**
 * MCP resources: the `doc://{id}` template — ported from kiagent-ref's
 * src/main/mcp/resources.ts + register.ts's registerResources. Lets a client
 * pin/read a document by id as a first-class MCP resource (markdown body)
 * instead of round-tripping through the `get` tool.
 *
 * Legacy ids were bigints so the URI matched `doc://(\d+)`; greenfield
 * `DocumentId`s are UUIDv7 strings, so everything after `doc://` is the id.
 * Like the tools (registry.ts), handlers go on the underlying low-level
 * Server — the SDK's high-level resource helper assumes a static template
 * list at construction, and both transports attach to per-session/one-shot
 * `McpServer`s after the fact.
 */
import {
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { DocumentId, Query } from '@shared/contracts';

export function attachResourceHandlers(mcp: McpServer, query: Query): void {
  // No enumerable resources — the corpus is far too large to list; clients
  // discover ids via the `search` tool and read through the template.
  mcp.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [],
  }));

  mcp.server.setRequestHandler(
    ListResourceTemplatesRequestSchema,
    async () => ({
      resourceTemplates: [
        {
          uriTemplate: 'doc://{id}',
          name: 'Document by id',
          mimeType: 'text/markdown',
        },
      ],
    }),
  );

  mcp.server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    const m = /^doc:\/\/(.+)$/.exec(uri);
    if (!m) throw new Error(`bad resource uri: ${uri}`);
    const doc = await query.document(m[1] as DocumentId);
    if (!doc) throw new Error(`not found: ${uri}`);
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: doc.markdown ?? '' }],
    };
  });
}
