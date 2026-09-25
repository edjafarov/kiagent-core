/**
 * @jest-environment node
 *
 * The walk is real fs I/O (and the parity check below runs fast-glob, whose
 * walker uses `setImmediate`), which jsdom — the project's default jest
 * testEnvironment — does not provide.
 */
import {
  MAX_LOCAL_BINARY_BYTES,
  MAX_LOCAL_PDF_BYTES,
} from '@shared/file-indexability';
import fg from 'fast-glob';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_EXCLUDE_GLOBS } from '../exclude-globs';
import { isIngestible } from '../ingestible';
import {
  BATCH_SIZE,
  MAX_BATCH_READ_BYTES,
  buildItem,
  chunkBySize,
  countFiles,
  entryReadCost,
  walkPaths,
  walkRoot,
  type ScannedEntry,
} from '../scanner';

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

const listEntries = (dir: string) => collect(walkRoot(dir));

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-folder-scanner-'));
}

function writeFile(dir: string, rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/** Files at depth 0/1/2, two dotfiles at root (one ordinary, one carrying
 *  credentials), one excluded file under node_modules/, one under .git/. */
function writeNestedTree(dir: string): void {
  writeFile(dir, 'root.txt', 'root');
  writeFile(dir, 'level1/file1.txt', 'level1');
  writeFile(dir, 'level1/level2/file2.txt', 'level2');
  writeFile(dir, '.notes.md', '# hidden but ordinary');
  writeFile(dir, '.env', 'SECRET=1');
  writeFile(dir, 'node_modules/pkg/index.js', 'module.exports = {};');
  writeFile(dir, '.git/HEAD', 'ref: refs/heads/main');
}

/** A file of exactly `size` bytes with no real content written — instant,
 *  no meaningful disk usage on a sparse-file-capable filesystem. Only the
 *  size matters to `decideLocalFile`/`entryReadCost`/`buildItem`, never the
 *  bytes, for anything past the cheap listing stage. */
function sparseFile(dir: string, rel: string, size: number): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const fd = fs.openSync(abs, 'w');
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
  return abs;
}

function toEntry(absPath: string): ScannedEntry {
  return { absPath, stats: fs.statSync(absPath) };
}

describe('entryReadCost — decision-based, not bucket-based', () => {
  it('costs real bytes for inline-text and converter pipelines, zero for vision and audio', () => {
    const dir = mkTmpDir();
    const txt = writeFile(dir, 'a.txt', 'hello world');
    const csv = writeFile(dir, 'b.csv', 'a,b\n1,2');
    const png = writeFile(dir, 'c.png', 'not-really-a-png');
    const mp3 = writeFile(dir, 'd.mp3', 'not-really-audio');

    expect(entryReadCost(toEntry(txt))).toBe(fs.statSync(txt).size);
    expect(entryReadCost(toEntry(csv))).toBe(fs.statSync(csv).size);
    expect(entryReadCost(toEntry(png))).toBe(0);
    expect(entryReadCost(toEntry(mp3))).toBe(0);
  });
});

describe('the local PDF ladder — two budgets, not one', () => {
  it('at/under the read cap: listed, full read cost, buildItem reads bytes eagerly', async () => {
    const dir = mkTmpDir();
    const p = sparseFile(dir, 'small.pdf', MAX_LOCAL_BINARY_BYTES);
    const entry = toEntry(p);

    expect(entryReadCost(entry)).toBe(MAX_LOCAL_BINARY_BYTES);
    const entries = await listEntries(dir);
    expect(entries.map((e) => e.absPath)).toEqual([p]);

    const item = await buildItem(p, entry.stats);
    expect(item).not.toBeNull();
    expect(item!.binary).not.toBeNull();
  });

  it('20-50 MiB band: still listed, zero read cost, buildItem commits metadata-only (no eager binary) for the vision worker to OCR via fetchBytes', async () => {
    const dir = mkTmpDir();
    const size = MAX_LOCAL_BINARY_BYTES + 5 * 1024 * 1024; // 25 MiB
    const p = sparseFile(dir, 'mid.pdf', size);
    const entry = toEntry(p);

    expect(entryReadCost(entry)).toBe(0);
    const entries = await listEntries(dir);
    expect(entries.map((e) => e.absPath)).toEqual([p]);

    const item = await buildItem(p, entry.stats);
    expect(item).not.toBeNull();
    expect(item!.markdownText).toBeNull();
    expect(item!.binary).toBeNull();
    expect(item!.mime).toBe('application/pdf');
  });

  it('over the outer PDF cap: absent from the walk entirely — no row, no candidate', async () => {
    const dir = mkTmpDir();
    sparseFile(dir, 'huge.pdf', MAX_LOCAL_PDF_BYTES + 1);

    const entries = await listEntries(dir);
    expect(entries).toEqual([]);
  });
});

describe('countFiles', () => {
  it('counts a nested tree, including dotfiles and excluding junk dirs', async () => {
    const dir = mkTmpDir();
    writeNestedTree(dir);

    const result = await countFiles(dir);

    // root.txt, level1/file1.txt, level1/level2/file2.txt, .notes.md = 4.
    // node_modules/pkg/index.js and .git/HEAD are excluded as junk dirs;
    // .env is excluded as credential material (ingestible.ts) — dotfiles as
    // such are still counted, which is what .notes.md pins.
    expect(result).toEqual({ count: 4, capped: false });
  });

  it('never counts or lists credential files', async () => {
    // The allowlist admits plain text broadly, and a .env IS plain text. It
    // must still never reach a searchable corpus.
    const dir = mkTmpDir();
    writeFile(dir, 'ok.md', '# fine');
    writeFile(dir, '.env', 'SECRET=1');
    writeFile(dir, 'id_ed25519', 'PRIVATE KEY');
    writeFile(dir, 'server.pem', 'PRIVATE KEY');

    expect((await countFiles(dir)).count).toBe(1);
    expect(
      (await listEntries(dir)).map((e) => path.basename(e.absPath)),
    ).toEqual(['ok.md']);
  });

  it('caps the count and reports capped: true when the walk exceeds the cap', async () => {
    const dir = mkTmpDir();
    for (let i = 0; i < 5; i += 1)
      writeFile(dir, `file-${i}.txt`, `content ${i}`);

    const result = await countFiles(dir, 2);

    expect(result).toEqual({ count: 2, capped: true });
  });

  it('matches the walk exactly — the count can never drift from what sync would index', async () => {
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
// only batches what it is fed; a plain numeric `cost` field stands in for
// whatever `entryReadCost` would compute from a real ScannedEntry.
interface SizedEntry {
  id: number;
  cost: number;
}

function costOf(e: SizedEntry): number {
  return e.cost;
}

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  yield* items;
}

const chunks = (entries: readonly SizedEntry[]) =>
  collect(
    chunkBySize(fromArray(entries), BATCH_SIZE, MAX_BATCH_READ_BYTES, costOf),
  );

describe('chunkBySize', () => {
  it('never exceeds MAX_BATCH_READ_BYTES per batch or BATCH_SIZE entries per batch, and drops nothing', async () => {
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

    const batches = await chunks(entries);

    // Order preserved, nothing lost.
    expect(batches.flat().map((e) => e.id)).toEqual(entries.map((e) => e.id));

    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(BATCH_SIZE);
      const totalCost = batch.reduce((sum, e) => sum + costOf(e), 0);
      expect(totalCost).toBeLessThanOrEqual(MAX_BATCH_READ_BYTES);
    }
  });

  it('gives a single over-budget entry its own solo batch instead of dropping it', async () => {
    const entries: SizedEntry[] = [
      { id: 1, cost: 1024 },
      { id: 2, cost: 1024 },
      { id: 3, cost: MAX_BATCH_READ_BYTES + 1 }, // exceeds the whole batch budget alone
      { id: 4, cost: 1024 },
    ];

    const batches = await chunks(entries);

    expect(batches.flat().map((e) => e.id)).toEqual([1, 2, 3, 4]);
    const soloBatch = batches.find((b) => b.some((e) => e.id === 3));
    expect(soloBatch).toEqual([{ id: 3, cost: MAX_BATCH_READ_BYTES + 1 }]);
  });

  it('splits purely on count when every entry is free (metadata-only cost 0)', async () => {
    const entries: SizedEntry[] = Array.from({ length: 120 }, (_, i) => ({
      id: i,
      cost: 0,
    }));

    const batches = await chunks(entries);

    expect(batches.map((b) => b.length)).toEqual([50, 50, 20]);
    expect(batches.flat().map((e) => e.id)).toEqual(entries.map((e) => e.id));
  });

  it('yields nothing for an empty input', async () => {
    expect(await chunks([])).toEqual([]);
  });

  it('pulls from its input only as far as the batch it is filling', async () => {
    let pulled = 0;
    async function* source(): AsyncGenerator<SizedEntry> {
      for (let id = 0; id < 1000; id += 1) {
        pulled += 1;
        yield { id, cost: 0 };
      }
    }
    const it = chunkBySize(source(), BATCH_SIZE, MAX_BATCH_READ_BYTES, costOf);
    const first = await it.next();
    expect(first.value).toHaveLength(BATCH_SIZE);
    expect(pulled).toBe(BATCH_SIZE + 1); // the one that closed the batch
    await it.return(undefined);
  });
});

// alpha-cent#182: the walk replaced fast-glob because fast-glob's stream
// ignores backpressure. It must keep fast-glob's rules and stay lazy.
describe('the walk', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists exactly what the fast-glob walk it replaced listed', async () => {
    const dir = mkTmpDir();
    for (const rel of [
      'normal/in.txt',
      'x.tmp/in.txt', // `**/*.tmp` skips files, not directories
      'y.swp/in.txt',
      'a.tmp.d/in.txt',
      '.DS_Store/in.txt', // a static name skips a directory too
      'Thumbs.db/in.txt',
      '.git/in.txt',
      'node_modules/in.txt',
      'deep/er/node_modules/in.txt',
      '.cache/in.txt',
      '.Trash/in.txt',
      '.hidden/in.md',
      'top.tmp',
      '.x.swp',
      'Thumbs.db.txt',
      'keep.md',
    ])
      writeFile(dir, rel, 'x');
    fs.symlinkSync(path.join(dir, 'normal'), path.join(dir, 'linkdir'));
    fs.symlinkSync(path.join(dir, 'keep.md'), path.join(dir, 'link.md'));

    const fastGlob = (
      await fg(['**/*'], {
        ignore: DEFAULT_EXCLUDE_GLOBS,
        dot: true,
        onlyFiles: true,
        suppressErrors: true,
        followSymbolicLinks: false,
        cwd: dir,
        absolute: true,
      })
    )
      .map((p) => path.resolve(p))
      .filter(isIngestible)
      .sort();

    expect((await collect(walkPaths(dir))).sort()).toEqual(fastGlob);
    expect(fastGlob.map((p) => path.relative(dir, p)).sort()).toEqual(
      [
        'Thumbs.db.txt',
        '.hidden/in.md',
        'a.tmp.d/in.txt',
        'keep.md',
        'normal/in.txt',
        'x.tmp/in.txt',
        'y.swp/in.txt',
      ].sort(),
    );
  });

  it('is pulled one entry at a time: the first entry costs one stat, not the tree', async () => {
    const dir = mkTmpDir();
    for (let d = 0; d < 3; d += 1)
      for (let f = 0; f < 100; f += 1) writeFile(dir, `d${d}/f${f}.txt`, 'x');
    const lstat = jest.spyOn(fs.promises, 'lstat');
    const opendir = jest.spyOn(fs.promises, 'opendir');

    const walk = walkRoot(dir);
    expect((await walk.next()).done).toBe(false);
    expect(lstat.mock.calls.length).toBeLessThan(5);
    expect(opendir).toHaveBeenCalledTimes(2); // the root, one subdirectory
    await walk.return(undefined);
  });

  it('closes every directory it still holds open when the consumer stops early', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'a/b/c/deep.txt', 'x');
    writeFile(dir, 'a/b/c/deeper.txt', 'x');
    const real = fs.promises.opendir.bind(fs.promises);
    const opened: fs.Dir[] = [];
    jest.spyOn(fs.promises, 'opendir').mockImplementation(async (p, o) => {
      const d = await real(p, o);
      opened.push(d);
      return d;
    });

    const walk = walkPaths(dir);
    await walk.next(); // inside a/b/c: four directories open
    await walk.return(undefined);

    expect(opened).toHaveLength(4);
    // A closed Dir rejects a second close.
    await Promise.all(
      opened.map((d) =>
        expect(d.close()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' }),
      ),
    );
  });

  it('types an entry the filesystem reported as unknown by lstat', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'a.txt', 'x');
    const unknown = {
      name: 'a.txt',
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isCharacterDevice: () => false,
      isBlockDevice: () => false,
    };
    let served = false;
    jest.spyOn(fs.promises, 'opendir').mockResolvedValueOnce({
      path: dir,
      read: async () => {
        if (served) return null;
        served = true;
        return unknown;
      },
      close: async () => {},
    } as unknown as fs.Dir);

    expect(await collect(walkPaths(dir))).toEqual([path.join(dir, 'a.txt')]);
  });

  it('skips a directory it cannot read and keeps walking', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'ok/a.txt', 'x');
    writeFile(dir, 'locked/b.txt', 'x');
    fs.chmodSync(path.join(dir, 'locked'), 0o000);
    try {
      expect(await collect(walkPaths(dir))).toEqual([
        path.join(dir, 'ok', 'a.txt'),
      ]);
    } finally {
      fs.chmodSync(path.join(dir, 'locked'), 0o755);
    }
  });
});
