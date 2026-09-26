import { buildSnippet, localUrl } from '../snippets';

const url = localUrl(7421);

test('the local endpoint', () => {
  expect(url).toBe('http://127.0.0.1:7421/mcp');
});

test('JSON: the mcpServers entry the one-click writer uses', () => {
  expect(JSON.parse(buildSnippet('json', url))).toEqual({
    mcpServers: { KIAgent: { url } },
  });
});

test('Claude Code: the add command', () => {
  expect(buildSnippet('claude-code', url)).toBe(
    `claude mcp add --transport http KIAgent ${url}`,
  );
});

test('VS Code: servers, not mcpServers, with the http type', () => {
  expect(JSON.parse(buildSnippet('vscode', url))).toEqual({
    servers: { KIAgent: { type: 'http', url } },
  });
});
