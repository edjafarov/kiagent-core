/**
 * Local-only snippet builder for the Manual setup disclosure.
 *
 * The legacy renderer's `screens/Mcp/snippets.ts` (kiagent-ref) built a
 * per-client (`claude-desktop`/`vscode`/`claude-code`/`local`/`custom`)
 * snippet keyed by `MCP_SERVER_KEY` and could include a bearer-auth header
 * for a remote transport. The current `@shared/ipc` contract only exposes a
 * bare loopback HTTP transport (`mcp:info` → `{port, clients}`) with no
 * bearer — the loopback bind IS the auth (see
 * `src/main/core/mcp/server.ts`'s client registry, which writes a bare
 * `{url}`/`{type:'http', url}` entry, no `Authorization` header) — and no
 * channel exposing the stdio launch descriptor (command/args/env) that
 * `mcpStdio.js` needs, so only the generic HTTP/JSON snippet can be built
 * here. See `ManualSetup`'s stdio note for that gap.
 */
export function buildLocalHttpSnippet(port: number): string {
  return JSON.stringify({ url: `http://127.0.0.1:${port}/mcp` }, null, 2);
}
