/**
 * @jest-environment node
 *
 * fast-glob's async walker uses `setImmediate`, which jsdom (the project's
 * default jest testEnvironment) does not provide — same fix as
 * local-folder-source.test.ts / src/main/core/mcp/__tests__/server.test.ts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { countFiles, listEntries } from '../scanner';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-folder-scanner-'));
}

function writeFile(dir: string, rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Files at depth 0/1/2, one dotfile at root, one excluded file under
 *  node_modules/, one excluded file under .git/. */
function writeNestedTree(dir: string): void {
  writeFile(dir, 'root.txt', 'root');
  writeFile(dir, 'level1/file1.txt', 'level1');
  writeFile(dir, 'level1/level2/file2.txt', 'level2');
  writeFile(dir, '.env', 'SECRET=1');
  writeFile(dir, 'node_modules/pkg/index.js', 'module.exports = {};');
  writeFile(dir, '.git/HEAD', 'ref: refs/heads/main');
}

describe('countFiles', () => {
  it('counts a nested tree, including dotfiles and excluding junk dirs', async () => {
    const dir = mkTmpDir();
    writeNestedTree(dir);

    const result = await countFiles(dir);

    // root.txt, level1/file1.txt, level1/level2/file2.txt, .env = 4.
    // node_modules/pkg/index.js and .git/HEAD are excluded.
    expect(result).toEqual({ count: 4, capped: false });
  });

  it('caps the count and reports capped: true when the walk exceeds the cap', async () => {
    const dir = mkTmpDir();
    for (let i = 0; i < 5; i += 1)
      writeFile(dir, `file-${i}.txt`, `content ${i}`);

    const result = await countFiles(dir, 2);

    expect(result).toEqual({ count: 2, capped: true });
  });

  it('matches listEntries exactly — the count can never drift from what sync would index', async () => {
    const dir = mkTmpDir();
    writeNestedTree(dir);

    const result = await countFiles(dir);
    const entries = await listEntries(dir);

    expect(result.count).toBe(entries.length);
  });

  it('resolves to a zero count instead of throwing for a nonexistent path', async () => {
    const missing = path.join(os.tmpdir(), 'kiagent-does-not-exist-xyz');

    const result = await countFiles(missing);

    expect(result).toEqual({ count: 0, capped: false });
  });
});
