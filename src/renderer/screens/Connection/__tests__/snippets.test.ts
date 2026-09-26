import { MCP_SERVER_KEY } from '@shared/contracts';
import { buildSnippet, localUrl } from '../snippets';

const url = localUrl(7421);

test('the local endpoint', () => {
  expect(url).toBe('http://127.0.0.1:7421/mcp');
});

test('JSON: the mcpServers entry the one-click writer uses', () => {
  expect(JSON.parse(buildSnippet('json', url))).toEqual({
    mcpServers: { [MCP_SERVER_KEY]: { url } },
  });
});

test('Claude Code: the add command', () => {
  expect(buildSnippet('claude-code', url)).toBe(
    `claude mcp add --transport http ${MCP_SERVER_KEY} ${url}`,
  );
});

test('VS Code: servers, not mcpServers, with the http type', () => {
  expect(JSON.parse(buildSnippet('vscode', url))).toEqual({
    servers: { [MCP_SERVER_KEY]: { type: 'http', url } },
  });
});
