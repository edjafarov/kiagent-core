/**
 * The built-in MCP tool set — a straight port of kiagent-ref's
 * src/main/mcp/register.ts tool dictionary (minus `query_sql`/`get_schema`;
 * see server.ts), rebuilt against `Query` instead of raw SQL. Every tool here
 * is `tier: 'standard'` — and for the read tools the reach is bounded by
 * whatever `Query` already exposes, nothing more. `send_draft` is the one
 * exception: it performs an irreversible external side effect, bounded
 * instead by the user's consent observed in chat plus the per-account hourly
 * rate limit (see outbound/service.ts).
 */
import type { McpTool, Query } from '@shared/contracts';
import type { OutboundToolApi } from '@main/outbound/service';

import { countDescription, countInputSchema, makeCountTool } from './count';
import {
  digitalMemoryInfoDescription,
  digitalMemoryInfoInputSchema,
  makeDigitalMemoryInfoTool,
} from './digital-memory-info';
import {
  draftMessageDescription,
  draftMessageInputSchema,
  makeDraftMessageTool,
} from './draft-message';
import {
  draftReplyDescription,
  draftReplyInputSchema,
  makeDraftReplyTool,
} from './draft-reply';
import { getDescription, getInputSchema, makeGetTool } from './get';
import {
  getRelatedDescription,
  getRelatedInputSchema,
  makeGetRelatedTool,
} from './get-related';
import {
  listOutboxDescription,
  listOutboxInputSchema,
  makeListOutboxTool,
} from './list-outbox';
import { makeSearchTool, searchDescription, searchInputSchema } from './search';
import {
  makeSendDraftTool,
  sendDraftDescription,
  sendDraftInputSchema,
} from './send-draft';

/** When no outbound service exists on this transport (a stdio sibling with
 *  no proxy), the tools still register — the tool LIST must not drift
 *  between transports — but every call explains the situation. */
const unavailableOutbound: OutboundToolApi = {
  draftReply: unavailable,
  draftMessage: unavailable,
  listOutbox: unavailable,
  sendDraft: unavailable,
};
async function unavailable(): Promise<never> {
  throw new Error(
    'Outbound drafting is unavailable on this transport right now — the ' +
      'KIAgent app must be running; its HTTP MCP server handles drafts.',
  );
}

export function buildBuiltinTools(
  query: Query,
  outbound?: OutboundToolApi,
): McpTool[] {
  const out = outbound ?? unavailableOutbound;
  const digitalMemoryInfo = makeDigitalMemoryInfoTool(query);
  return [
    {
      name: 'search',
      description: searchDescription,
      inputSchema: searchInputSchema,
      tier: 'standard',
      call: makeSearchTool(query),
    },
    {
      name: 'get',
      description: getDescription,
      inputSchema: getInputSchema,
      tier: 'standard',
      call: makeGetTool(query),
    },
    {
      name: 'count',
      description: countDescription,
      inputSchema: countInputSchema,
      tier: 'standard',
      call: makeCountTool(query),
    },
    {
      name: 'get_related',
      description: getRelatedDescription,
      inputSchema: getRelatedInputSchema,
      tier: 'standard',
      call: makeGetRelatedTool(query),
    },
    {
      name: 'digital_memory_info',
      description: digitalMemoryInfoDescription,
      inputSchema: digitalMemoryInfoInputSchema,
      tier: 'standard',
      call: async () => digitalMemoryInfo(),
    },
    {
      name: 'draft_reply',
      description: draftReplyDescription,
      inputSchema: draftReplyInputSchema,
      tier: 'standard',
      call: makeDraftReplyTool(out),
    },
    {
      name: 'draft_message',
      description: draftMessageDescription,
      inputSchema: draftMessageInputSchema,
      tier: 'standard',
      call: makeDraftMessageTool(out),
    },
    {
      name: 'list_outbox',
      description: listOutboxDescription,
      inputSchema: listOutboxInputSchema,
      tier: 'standard',
      call: makeListOutboxTool(out),
    },
    {
      name: 'send_draft',
      description: sendDraftDescription,
      inputSchema: sendDraftInputSchema,
      tier: 'standard',
      call: makeSendDraftTool(out),
    },
  ];
}

export type { SearchArgs, SearchHit } from './search';
export type { LegacyDocument } from './get';
export type { CountGroupBy } from './count';
export type { GetRelatedRelation } from './get-related';
export type { DigitalMemoryAccount } from './digital-memory-info';
