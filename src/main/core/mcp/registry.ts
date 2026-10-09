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
import { runWithClient } from './transport-context';

/** The live, mutable tool set. A plain Map so registerTool()/its disposer are
 *  synchronous, in-memory operations with no session bookkeeping. */
export type ToolRegistry = Map<string, McpTool>;

/** Top-level keys holding message bodies — redacted to a length, not logged. */
const BODY_KEYS = new Set([
  'body',
  'body_markdown',
  'markdown',
  'text',
  'content',
]);
/** Top-level keys holding recipients — redacted to a count, not logged. */
const RECIPIENT_KEYS = new Set(['to', 'cc', 'bcc']);
/** Any other string/array/object value is capped at this many chars. */
const MAX_LOGGED_CHARS = 200;

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= MAX_LOGGED_CHARS) return value;
    const over = value.length - MAX_LOGGED_CHARS;
    return `${value.slice(0, MAX_LOGGED_CHARS)}…(+${over} chars)`;
  }
  if (Array.isArray(value)) {
    const size = JSON.stringify(value).length;
    return size > MAX_LOGGED_CHARS ? `[array: ${size} chars]` : value;
  }
  if (value !== null && typeof value === 'object') {
    const size = JSON.stringify(value).length;
    return size > MAX_LOGGED_CHARS ? `[object: ${size} chars]` : value;
  }
  return value; // numbers, booleans, null pass through
}

/**
 * Pure redaction for `logSink.log('mcp.call', …)` — the audit trail
 * `logs:export` hands out in bug reports, so draft bodies, recipients, and
 * full SQL/queries must not ride it verbatim. Applied to top-level keys
 * only; `emit`/`summarizeCall` (the in-app activity feed) sees raw args.
 */
export function redactArgsForLog(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (BODY_KEYS.has(key) && typeof value === 'string') {
      out[key] = `[redacted: ${value.length} chars]`;
    } else if (
      RECIPIENT_KEYS.has(key) &&
      (Array.isArray(value) || typeof value === 'string')
    ) {
      out[key] = `[${Array.isArray(value) ? value.length : 1} recipients]`;
    } else {
      out[key] = redactValue(value);
    }
  }
  return out;
}

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
 * shows failed calls too (with an extra `error` field). `args` is run through
 * `redactArgsForLog` first: this log rides `logs:export` into bug reports,
 * so bodies/recipients/oversized values never land on disk verbatim.
 *
 * onActivity receives one enriched activity record per served call (win or
 * lose) — everything except `transport`, which the caller stamps ('http' in
 * server.ts — 'remote' for the product handler —, 'stdio' in mcp/stdio-entry.ts). Optional; and best-effort by
 * contract: a throwing callback or summarizer must never fail the call it
 * records.
 */
/** Runs `fn` as foreground work (#147 §2): background units wait while any
 *  is in flight. Bound to the app's admission by startMcp; absent in the
 *  stdio sibling, which has none. */
export type Foreground = <T>(fn: () => Promise<T>) => Promise<T>;

export function attachToolHandlers(
  mcp: McpServer,
  registry: ToolRegistry,
  logSink: LogSink,
  onActivity?: (rec: Omit<McpActivityRecord, 'transport'>) => void,
  /** When set, only these tools are listed or callable on this session —
   *  a server-side fence for hosted agents, independent of the client. */
  allow?: ReadonlySet<string>,
  foreground?: Foreground,
): void {
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...registry.values()]
      .filter((t) => !allow || allow.has(t.name))
      .map(toolToWire),
  }));

  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const call = () =>
      invokeTool(
        registry,
        logSink,
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
        mcp.server.getClientVersion()?.name ?? null,
        onActivity,
        allow,
      );
    const out = await (foreground ? foreground(call) : call());
    // isError (not a thrown protocol error) so the calling LLM sees the
    // real message instead of a generic JSON-RPC failure.
    return out.ok
      ? { content: [{ type: 'text', text: JSON.stringify(out.result) }] }
      : { isError: true, content: [{ type: 'text', text: out.error }] };
  });
}

/** The result of one tool call, before any transport wraps it. */
export type ToolCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

/**
 * One tool call with every guarantee `tools/call` gives: the allow-list
 * fence, the calling client's name around the call (an Outbox draft records
 * it), the `mcp.call` audit row (win or lose, args redacted) and the
 * activity record. Shared by the MCP handler and the in-process
 * `callTool` (server.ts), so the two can't drift. The caller sets the
 * transport (`runWithTransport`) around it.
 */
export async function invokeTool(
  registry: ToolRegistry,
  logSink: LogSink,
  name: string,
  args: Record<string, unknown>,
  client: string | null,
  onActivity?: (rec: Omit<McpActivityRecord, 'transport'>) => void,
  allow?: ReadonlySet<string>,
): Promise<ToolCallOutcome> {
  const started = Date.now();
  const tool = registry.get(name);
  // Redacted up front, before the call runs: a redaction throw after
  // tool.call would report a call that already happened (e.g. send_draft)
  // as failed.
  const loggedArgs = redactArgsForLog(args);

  const emit = (ok: boolean, result: unknown, error?: string): void => {
    if (!onActivity) return;
    try {
      const { summary, detail } = ok
        ? summarizeCall(name, args, result)
        : { summary: `${name} failed`, detail: undefined };
      onActivity({
        ts: new Date().toISOString(),
        client,
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
  const fail = (logged: string, error: string): ToolCallOutcome => {
    logSink.log('mcp.call', 'info', name, {
      args: loggedArgs,
      ok: false,
      ms: Date.now() - started,
      error: logged,
    });
    emit(false, undefined, logged);
    return { ok: false, error };
  };

  if (allow && !allow.has(name))
    return fail('not allowed', `tool '${name}' is not available`);
  if (!tool) return fail('unknown tool', `unknown tool '${name}'`);

  try {
    // The tool runs inside the client's name, so what it records (an
    // outbox draft) can say which app asked.
    const result = await runWithClient(client, () => tool.call(args));
    logSink.log('mcp.call', 'info', name, {
      args: loggedArgs,
      ok: true,
      ms: Date.now() - started,
    });
    emit(true, result);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message, message);
  }
}
