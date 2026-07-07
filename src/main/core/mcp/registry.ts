/**
 * Shared tool dispatch, wired onto the low-level `Server` underneath a
 * `McpServer` — used by BOTH the HTTP transport (one `McpServer` per session,
 * server.ts) and the stdio sibling (one `McpServer` for the process's whole
 * lifetime, ../../mcp/stdio-entry.ts) so tools cannot drift between
 * transports, mirroring kiagent-ref's register.ts.
 *
 * Bypasses the SDK's zod-based `McpServer.registerTool` on purpose:
 * `McpTool.inputSchema` is a raw JSON Schema (`unknown`), not a zod shape, and
 * reading the registry at REQUEST time (not connect time) is what lets
 * `registerTool()`'s additions/removals reach already-connected sessions —
 * each of which otherwise froze its tool list at construction.
 */
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { McpActivityRecord, McpTool } from '@shared/contracts';

import type { LogSink } from '../engine/engine';
import { summarizeCall } from './activity';

/** The live, mutable tool set. A plain Map so registerTool()/its disposer are
 *  synchronous, in-memory operations with no session bookkeeping. */
export type ToolRegistry = Map<string, McpTool>;

export function createToolRegistry(initial: McpTool[]): ToolRegistry {
  const registry: ToolRegistry = new Map();
  for (const tool of initial) registry.set(tool.name, tool);
  return registry;
}

function toolToWire(tool: McpTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
    // Not part of the MCP spec proper; rides the free-form _meta bag so a
    // consent-aware client (or a future in-app gate) can tell 'powerful'
    // tools apart from 'standard' ones without an out-of-band lookup.
    _meta: { tier: tool.tier ?? 'standard' },
  };
}

/**
 * Attach `tools/list` + `tools/call` to one session's low-level Server.
 * Every call is audited via `logSink.log('mcp.call', 'info', <tool name>,
 * {args, ok, ms})` — the ONE audit contract (LogSink doubles as the MCP call
 * log; see engine.ts's LogSink doc comment) — win or lose, so the audit trail
 * shows failed calls too (with an extra `error` field).
 *
 * onActivity receives one enriched activity record per served call (win or
 * lose) — everything except `transport`, which the caller stamps ('http' in
 * server.ts, 'stdio' in mcp/stdio-entry.ts). Optional; and best-effort by
 * contract: a throwing callback or summarizer must never fail the call it
 * records.
 */
export function attachToolHandlers(
  mcp: McpServer,
  registry: ToolRegistry,
  logSink: LogSink,
  onActivity?: (rec: Omit<McpActivityRecord, 'transport'>) => void,
): void {
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...registry.values()].map(toolToWire),
  }));

  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const started = Date.now();
    const tool = registry.get(name);

    const emit = (ok: boolean, result: unknown, error?: string): void => {
      if (!onActivity) return;
      try {
        const { summary, detail } = ok
          ? summarizeCall(name, args, result)
          : { summary: `${name} failed`, detail: undefined };
        onActivity({
          ts: new Date().toISOString(),
          client: mcp.server.getClientVersion()?.name ?? null,
          tool: name,
          ok,
          ms: Date.now() - started,
          summary,
          ...(detail && detail.length ? { detail } : {}),
          ...(error !== undefined ? { error } : {}),
        });
      } catch {
        /* the feed is best-effort — never break the call it records */
      }
    };

    if (!tool) {
      logSink.log('mcp.call', 'info', name, {
        args,
        ok: false,
        ms: Date.now() - started,
        error: 'unknown tool',
      });
      emit(false, undefined, 'unknown tool');
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool '${name}'` }],
      };
    }

    try {
      const result = await tool.call(args);
      logSink.log('mcp.call', 'info', name, {
        args,
        ok: true,
        ms: Date.now() - started,
      });
      emit(true, result);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSink.log('mcp.call', 'info', name, {
        args,
        ok: false,
        ms: Date.now() - started,
        error: message,
      });
      emit(false, undefined, message);
      // isError (not a thrown protocol error) so the calling LLM sees the
      // real message instead of a generic JSON-RPC failure.
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });
}
