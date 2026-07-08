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

import {
  BATCH_SIZE,
  MAX_BATCH_READ_BYTES,
  chunkBySize,
  countFiles,
  listEntries,
} from '../scanner';

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

// Synthetic entries — no real 20 MiB files are written to disk. `chunkBySize`
// is a pure function; a plain numeric `cost` field stands in for whatever
// `entryReadCost` would compute from a real ScannedEntry.
interface SizedEntry {
  id: number;
  cost: number;
}

function costOf(e: SizedEntry): number {
  return e.cost;
}

describe('chunkBySize', () => {
  it('never exceeds MAX_BATCH_READ_BYTES per batch or BATCH_SIZE entries per batch, and drops nothing', () => {
    const TINY = 1024; // 1 KiB — ordinary small file.
    const LARGE = 30 * 1024 * 1024; // 30 MiB — two of these alone exceed the cap.
    const entries: SizedEntry[] = [];
    let id = 0;
    // 80 tiny entries, with a handful of 30 MiB entries mixed in — enough
    // to force both a count-based split (80 > BATCH_SIZE) and byte-based
    // splits (consecutive 30 MiB entries would blow the byte budget).
    for (let i = 0; i < 80; i += 1) {
      entries.push({ id: id++, cost: TINY });
      if (i % 10 === 0) entries.push({ id: id++, cost: LARGE });
    }

    const batches = chunkBySize(
      entries,
      BATCH_SIZE,
      MAX_BATCH_READ_BYTES,
      costOf,
    );

    // Order preserved, nothing lost.
    expect(batches.flat().map((e) => e.id)).toEqual(entries.map((e) => e.id));

    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(BATCH_SIZE);
      const totalCost = batch.reduce((sum, e) => sum + costOf(e), 0);
      expect(totalCost).toBeLessThanOrEqual(MAX_BATCH_READ_BYTES);
    }
  });

  it('gives a single over-budget entry its own solo batch instead of dropping it', () => {
    const entries: SizedEntry[] = [
      { id: 1, cost: 1024 },
      { id: 2, cost: 1024 },
      { id: 3, cost: MAX_BATCH_READ_BYTES + 1 }, // exceeds the whole batch budget alone
      { id: 4, cost: 1024 },
    ];

    const batches = chunkBySize(
      entries,
      BATCH_SIZE,
      MAX_BATCH_READ_BYTES,
      costOf,
    );

    expect(batches.flat().map((e) => e.id)).toEqual([1, 2, 3, 4]);
    const soloBatch = batches.find((b) => b.some((e) => e.id === 3));
    expect(soloBatch).toEqual([{ id: 3, cost: MAX_BATCH_READ_BYTES + 1 }]);
  });

  it('splits purely on count when every entry is free (metadata-only cost 0)', () => {
    const entries: SizedEntry[] = Array.from({ length: 120 }, (_, i) => ({
      id: i,
      cost: 0,
    }));

    const batches = chunkBySize(
      entries,
      BATCH_SIZE,
      MAX_BATCH_READ_BYTES,
      costOf,
    );

    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.flat().map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it('returns an empty array for an empty input', () => {
    expect(chunkBySize([], BATCH_SIZE, MAX_BATCH_READ_BYTES, costOf)).toEqual(
      [],
    );
  });
});
