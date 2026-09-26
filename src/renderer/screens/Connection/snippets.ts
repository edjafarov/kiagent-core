/**
 * Manual-setup snippets for the local server. The key and containers match
 * what `clients.ts` writes itself (SERVER_KEY, VS Code's `servers`), so a
 * hand-pasted entry looks exactly like a one-click one. Loopback needs no
 * auth header — the bind is the auth. Claude Desktop and Codex are
 * stdio-only (they launch this app's binary) and get no snippet here.
 */
const KEY = 'KIAgent';

export type SnippetKind = 'json' | 'claude-code' | 'vscode';

export function localUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

export function buildSnippet(kind: SnippetKind, url: string): string {
  switch (kind) {
    case 'json':
      return JSON.stringify({ mcpServers: { [KEY]: { url } } }, null, 2);
    case 'claude-code':
      return `claude mcp add --transport http ${KEY} ${url}`;
    case 'vscode':
      return JSON.stringify(
        { servers: { [KEY]: { type: 'http', url } } },
        null,
        2,
      );
    default:
      return '';
  }
}
