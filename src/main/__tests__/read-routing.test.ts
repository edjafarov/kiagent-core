import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('read routing (spec §3.3)', () => {
  it('MCP and the renderer foreground IPC use the read plane', () => {
    const main = read('main.ts');
    expect(main).toMatch(/query:\s*p\.readsFor\('mcp'\)/);
    expect(main).toMatch(
      /'search:query':\s*\(req\)\s*=>\s*p\.readsFor\('renderer'\)\.search\(/,
    );
    expect(main).toMatch(
      /'docs:get':\s*\(\{ id \}\)\s*=>\s*p\.readsFor\('renderer'\)\.document\(/,
    );
    expect(main).toMatch(
      /'docs:children':\s*\(\{ id \}\)\s*=>\s*p\.readsFor\('renderer'\)\.children\(/,
    );
    expect(main).not.toMatch(/p\.store\.read\.(search|document|children)\b/);
  });

  it('the extension slice, engine, evidence, outbound and factory reset stay on the writer', () => {
    for (const rel of [
      'platform/extension-platform.ts',
      'core/engine/engine.ts',
      'core/engine/message-evidence.ts',
      'outbound/service.ts',
      'factory-reset.ts',
    ]) {
      expect(read(rel)).not.toMatch(/\breadsFor\b|\.reads\b/);
    }
    expect(read('platform/extension-platform.ts')).toMatch(
      /withAccountTypes\(deps\.store\.read/,
    );
  });
});

describe('query_sql routing', () => {
  it('the app hands the MCP server the killable runner; the server never opens a handle itself', () => {
    expect(read('main.ts')).toMatch(/sqlExecutor:\s*createSqlRunner\(/);
    expect(read('core/mcp/server.ts')).not.toMatch(/new Database\(/);
    expect(read('core/mcp/server.ts')).not.toMatch(/better-sqlite3/);
  });
});
