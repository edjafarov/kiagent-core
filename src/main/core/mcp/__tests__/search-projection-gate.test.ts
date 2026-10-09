import fs from 'fs';
import path from 'path';

const toolsDir = path.join(__dirname, '..', 'tools');

describe('MCP tools never ask Query.search for full bodies', () => {
  const files = fs
    .readdirSync(toolsDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ f, src: fs.readFileSync(path.join(toolsDir, f), 'utf8') }))
    .filter(({ src }) => /\bquery\.search\(/.test(src));

  it('finds the two search call sites', () => {
    expect(files.map((x) => x.f).sort()).toEqual([
      'digital-memory-info.ts',
      'search.ts',
    ]);
  });

  it.each(files.map((x) => [x.f, x.src]))(
    '%s passes an explicit project other than full',
    (_f, src) => {
      expect(src).toMatch(/project:\s*'(snippet|metadata)'/);
      expect(src).not.toMatch(/project:\s*'full'/);
    },
  );
});
