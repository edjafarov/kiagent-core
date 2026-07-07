/**
 * The built-in MCP tool set — a straight port of kiagent-ref's
 * src/main/mcp/register.ts tool dictionary (minus `query_sql`/`get_schema`;
 * see server.ts), rebuilt against `Query` instead of raw SQL. Every tool here
 * is `tier: 'standard'` — the reach is bounded by whatever `Query` already
 * exposes, nothing more.
 */
import type { McpTool, Query } from '@shared/contracts';

import { countDescription, countInputSchema, makeCountTool } from './count';
import {
  digitalMemoryInfoDescription,
  digitalMemoryInfoInputSchema,
  makeDigitalMemoryInfoTool,
} from './digital-memory-info';
import { getDescription, getInputSchema, makeGetTool } from './get';
import {
  getRelatedDescription,
  getRelatedInputSchema,
  makeGetRelatedTool,
} from './get-related';
import { makeSearchTool, searchDescription, searchInputSchema } from './search';

export function buildBuiltinTools(query: Query): McpTool[] {
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
  ];
}

export type { SearchArgs, SearchHit } from './search';
export type { LegacyDocument } from './get';
export type { CountGroupBy } from './count';
export type { GetRelatedRelation } from './get-related';
export type { DigitalMemoryAccount } from './digital-memory-info';
