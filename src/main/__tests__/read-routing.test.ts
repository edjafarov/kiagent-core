import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('read routing (spec §3.3)', () => {
  // #147: the renderer reads also run as foreground work (inForeground).
  it('MCP and the renderer foreground IPC use the read plane', () => {
    const main = read('main.ts');
    expect(main).toMatch(/query:\s*p\.readsFor\('mcp'\)/);
    expect(main).toMatch(
      /'search:query':\s*\(req\)\s*=>\s*inForeground\(\s*p\.admission,\s*\(\)\s*=>\s*p\.readsFor\('renderer'\)\.search\(/,
    );
    expect(main).toMatch(
      /'docs:get':\s*\(\{ id \}\)\s*=>\s*inForeground\(\s*p\.admission,\s*\(\)\s*=>\s*p\.readsFor\('renderer'\)\.document\(/,
    );
    expect(main).toMatch(
      /'docs:children':\s*\(\{ id \}\)\s*=>\s*inForeground\(\s*p\.admission,\s*\(\)\s*=>\s*p\.readsFor\('renderer'\)\.children\(/,
    );
    expect(main).not.toMatch(/p\.store\.read\.(search|document|children)\b/);
  });

  it('the extension slice, engine, evidence, outbound and factory reset stay on the writer', () => {
    for (const rel of ['core/engine/message-evidence.ts', 'outbound/service.ts', 'factory-reset.ts']) {
      expect(read(rel)).not.toMatch(/\breadsFor\b|\.reads\b/);
    }
    // d39a2d0b: the extension platform hands an extension's interactive reads
    // (`deps.reads`) to the read worker and keeps every bulk page on the
    // writer — the ONE place it names `reads`, and the two pages it pins back.
    const platform = read('platform/extension-platform.ts');
    expect(platform).not.toMatch(/\breadsFor\b/);
    expect(platform.match(/\.reads\b/g)).toEqual(['.reads', '.reads']);
    expect(platform).toMatch(/documentPage: deps\.store\.read\.documentPage/);
    expect(platform).toMatch(/seedPage: deps\.store\.read\.seedPage/);
    // #59 §3a: the ONE engine read off the writer is a new consumer's seed
    // paging (spec: on the read worker, never behind ingest). Everything
    // else in the engine stays on the writer.
    const engine = read('core/engine/engine.ts');
    expect(engine).not.toMatch(/\breadsFor\b/);
    expect(engine.match(/\.reads\b/g)).toEqual(['.reads']);
    expect(engine).toMatch(/const reads = deps\.reads \?\? store\.read;/);
    expect(engine.match(/\breads\.\w+/g)).toEqual(['reads.seedPage']);
    // The fallback when no read worker is wired stays the writer's reads.
    expect(platform).toMatch(/withAccountTypes\(\s*deps\.reads\s*\?[\s\S]{0,200}?:\s*deps\.store\.read\b/);
  });
});

describe('query_sql routing', () => {
  it('the app hands the MCP server the killable runner; the server never opens a handle itself', () => {
    expect(read('main.ts')).toMatch(/sqlExecutor:\s*createSqlRunner\(/);
    expect(read('core/mcp/server.ts')).not.toMatch(/new Database\(/);
    expect(read('core/mcp/server.ts')).not.toMatch(/better-sqlite3/);
  });
});
