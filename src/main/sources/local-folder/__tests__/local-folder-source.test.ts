/**
 * @jest-environment node
 *
 * fast-glob's async walker uses `setImmediate`, which jsdom (the project's
 * default jest testEnvironment) does not provide — same fix as
 * src/main/core/mcp/__tests__/server.test.ts.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  Account,
  AuthChannel,
  DocumentInput,
  Session,
} from '@shared/contracts';

import { buildItem, chunk } from '../scanner';
import {
  connect,
  fetchBytes,
  localFolderSource,
  pull,
  reconcile,
} from '../local-folder-source';
import type { LocalFolderCursor } from '../cursor';

const LEGACY_ERROR =
  'Legacy single-folder account — remove this source and re-add its folder.';

type RootsCursor = { roots: Record<string, { completedAt: string }> };

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-folder-source-'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function writeFile(dir: string, rel: string, content: string): string {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function toExternalId(abs: string): string {
  return abs.split(path.sep).join('/');
}

function makeAccount(
  paths: string[],
  config: Record<string, unknown> = {},
): Account {
  return {
    id: 'acct-local-folder-1',
    source: 'local-folder',
    identifier: 'this-machine',
    config: { paths, ...config },
    status: 'connecting',
    cursor: null,
    createdAt: new Date().toISOString(),
  };
}

function makeSession(
  paths: string[],
  signal: AbortSignal,
  watch?: boolean,
): Session {
  return {
    account: makeAccount(paths, watch === undefined ? {} : { watch }),
    signal,
    credentials: async () => null,
    log: () => {},
  };
}

function makeSessionWithConfig(
  config: Record<string, unknown>,
  signal: AbortSignal,
): Session {
  return {
    account: {
      id: 'acct-legacy',
      source: 'local-folder',
      identifier: 'this-machine',
      config,
      status: 'connecting',
      cursor: null,
      createdAt: new Date().toISOString(),
    },
    signal,
    credentials: async () => null,
    log: () => {},
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe('connect', () => {
  it('resolves multiple valid folder paths, identifier is the fixed machine constant', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    const auth: AuthChannel = {
      oauth: async () => ({}),
      showQr: () => {},
      status: () => {},
      pickFolders: async () => [],
      prompt: async () => ({ paths: [dirA, dirB] }),
    };
    const result = await connect(auth);
    expect(result.identifier).toBe('this-machine');
    expect((result.config.paths as string[]).sort()).toEqual(
      [path.resolve(dirA), path.resolve(dirB)].sort(),
    );
  });

  it('normalizes a nested path out via coveringRoots', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    const nested = path.join(dirA, 'nested');
    fs.mkdirSync(nested);
    const auth: AuthChannel = {
      oauth: async () => ({}),
      showQr: () => {},
      status: () => {},
      pickFolders: async () => [],
      prompt: async () => ({ paths: [dirA, dirB, nested] }),
    };
    const result = await connect(auth);
    expect((result.config.paths as string[]).sort()).toEqual(
      [path.resolve(dirA), path.resolve(dirB)].sort(),
    );
  });

  it('throws a clear error naming the offending nonexistent path', async () => {
    const dirA = mkTmpDir();
    const missing = path.join(
      os.tmpdir(),
      'definitely-does-not-exist-kiagent-xyz',
    );
    const auth: AuthChannel = {
      oauth: async () => ({}),
      showQr: () => {},
      status: () => {},
      pickFolders: async () => [],
      prompt: async () => ({ paths: [dirA, missing] }),
    };
    await expect(connect(auth)).rejects.toThrow(missing);
    await expect(connect(auth)).rejects.toThrow(/does not exist/);
  });

  it('throws when a prompted path is a file, not a directory', async () => {
    const dir = mkTmpDir();
    const filePath = writeFile(dir, 'not-a-dir.txt', 'x');
    const auth: AuthChannel = {
      oauth: async () => ({}),
      showQr: () => {},
      status: () => {},
      pickFolders: async () => [],
      prompt: async () => ({ paths: [filePath] }),
    };
    await expect(connect(auth)).rejects.toThrow(/not a directory/);
  });

  it('throws when no paths are prompted', async () => {
    const auth: AuthChannel = {
      oauth: async () => ({}),
      showQr: () => {},
      status: () => {},
      pickFolders: async () => [],
      prompt: async () => ({ paths: [] }),
    };
    await expect(connect(auth)).rejects.toThrow(/folder path is required/);
  });
});

describe('pull — backfill (cursor === null)', () => {
  it('walks the tree, excludes legacy junk paths, and chunks batches of 50', async () => {
    const dir = mkTmpDir();

    // Indexable files.
    writeFile(dir, 'readme.txt', 'hello plain text');
    writeFile(dir, 'notes.md', '# heading');
    writeFile(dir, 'report.csv', 'a,b\n1,2');
    writeFile(dir, 'photo.png', 'not-a-real-png-but-unsupported-mime');
    writeFile(dir, 'subdir/inner.txt', 'nested file');
    // Bulk files to force multiple ~50-file batches.
    for (let i = 0; i < 58; i += 1)
      writeFile(dir, `bulk/file-${i}.txt`, `content ${i}`);

    // Legacy exclusions (kiagent-ref exclude-globs.ts:8-17) — must NOT appear.
    writeFile(dir, '.git/HEAD', 'ref: refs/heads/main');
    writeFile(dir, 'node_modules/pkg/index.js', 'module.exports = {};');
    writeFile(dir, '.DS_Store', 'junk');
    writeFile(dir, 'Thumbs.db', 'junk');
    writeFile(dir, '.Trash/deleted.txt', 'junk');
    writeFile(dir, '.cache/tmp.bin', 'junk');
    writeFile(dir, 'scratch.tmp', 'junk');
    writeFile(dir, 'backup.swp', 'junk');

    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const batches = await collect(pull(session, null));

    // Every item-bearing batch is backfill; the trailing cursor-only live
    // batch is the status flip (see the dedicated test below).
    expect(
      batches
        .filter((b) => b.items.length > 0)
        .every((b) => b.phase === 'backfill'),
    ).toBe(true);

    const allItems = batches.flatMap((b) => b.items);
    const externalIds = allItems.map((i) => i.externalId).sort();

    // 58 bulk + readme + notes + report + photo + subdir/inner = 63
    expect(allItems).toHaveLength(63);
    expect(externalIds).toContain(toExternalId(path.join(dir, 'readme.txt')));
    expect(externalIds).toContain(
      toExternalId(path.join(dir, 'subdir/inner.txt')),
    );
    expect(externalIds.every((id) => path.isAbsolute(id))).toBe(true);
    expect(externalIds.some((p) => p.includes('.git'))).toBe(false);
    expect(externalIds.some((p) => p.includes('node_modules'))).toBe(false);
    expect(externalIds.some((p) => p.endsWith('.DS_Store'))).toBe(false);
    expect(externalIds.some((p) => p.endsWith('Thumbs.db'))).toBe(false);
    expect(externalIds.some((p) => p.includes('.Trash'))).toBe(false);
    expect(externalIds.some((p) => p.includes('.cache'))).toBe(false);
    expect(externalIds.some((p) => p.endsWith('scratch.tmp'))).toBe(false);
    expect(externalIds.some((p) => p.endsWith('backup.swp'))).toBe(false);

    // Chunking: 63 items / 50 per batch => 2 backfill batches, plus the
    // trailing status-flip live batch; every backfill batch but the last
    // keeps the whole-account cursor `null` (this is the very first root
    // ever backfilled — nothing has completed yet), only the last carries
    // this root's { completedAt }.
    expect(batches).toHaveLength(3);
    expect(batches[0].cursor).toBeNull();
    expect(batches[0].estimateTotal).toBe(63);
    const finalCursor = batches[1].cursor as RootsCursor;
    expect(finalCursor.roots[dir].completedAt).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
  });

  it('maps items to DocumentInput per the text/binary/unsupported buckets', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'readme.txt', 'plain text body');
    writeFile(dir, 'report.csv', 'a,b\n1,2\n');
    writeFile(dir, 'photo.png', 'binary-ish-but-unsupported');

    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const batches = await collect(pull(session, null));
    const items = batches.flatMap((b) => b.items);
    const byAbs = new Map(items.map((i) => [i.absPath, i]));

    const textItem = byAbs.get(path.join(dir, 'readme.txt'))!;
    const textDoc = localFolderSource.toDocument(textItem)! as DocumentInput;
    expect(textDoc.externalId).toBe(toExternalId(textItem.absPath));
    expect(path.isAbsolute(textDoc.externalId)).toBe(true);
    expect(textDoc.type).toBe('file');
    expect(textDoc.title).toBe('readme.txt');
    expect(textDoc.markdown).toBe('plain text body');
    expect(textDoc.binary).toBeUndefined();
    expect(textDoc.url).toBe(`file://${encodeURI(textItem.absPath)}`);
    expect(textDoc.metadata).toMatchObject({
      ext: 'txt',
      absPath: textItem.absPath,
    });
    expect(typeof textDoc.createdAt).toBe('string');

    const csvItem = byAbs.get(path.join(dir, 'report.csv'))!;
    const csvDoc = localFolderSource.toDocument(csvItem)! as DocumentInput;
    expect(csvDoc.markdown).toBeNull();
    expect(csvDoc.binary).toBeDefined();
    expect(csvDoc.binary?.mime).toBe('text/csv');
    expect(csvDoc.binary?.filename).toBe('report.csv');
    expect(new TextDecoder().decode(csvDoc.binary!.bytes)).toBe('a,b\n1,2\n');

    const pngItem = byAbs.get(path.join(dir, 'photo.png'))!;
    const pngDoc = localFolderSource.toDocument(pngItem)! as DocumentInput;
    expect(pngDoc.markdown).toBeNull();
    expect(pngDoc.binary).toBeUndefined();
    expect(pngDoc.metadata.ext).toBe('png');
  });

  it('yields an empty completed batch (plus the status flip) for an empty root', async () => {
    const dir = mkTmpDir();
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const batches = await collect(pull(session, null));
    expect(batches).toHaveLength(2);
    expect(batches[0].phase).toBe('backfill');
    expect(batches[0].items).toEqual([]);
    expect(batches[0].estimateTotal).toBe(0);
    const cursor = batches[0].cursor as RootsCursor;
    expect(cursor.roots[dir].completedAt).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expect(batches[1].phase).toBe('live');
    expect(batches[1].items).toEqual([]);
  });

  it('stops after backfill without watching when config.watch is false, even if not aborted', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'a.txt', 'a');
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const it = pull(session, null);
    const result = await collect(it);
    expect(result.length).toBeGreaterThan(0);
    expect(controller.signal.aborted).toBe(false); // generator ended on its own
  });
});

describe('pull — unavailable roots', () => {
  // The pull-side half of the "empty ≠ missing" guard (see reconcile's
  // sibling test below): listEntries uses fast-glob's suppressErrors, so a
  // missing/unmounted root enumerates as ZERO entries with no error. Without
  // an up-front stat, backfill would stamp a bogus { completedAt } off that
  // empty listing and the root would take the incremental path forever —
  // its pre-existing files (mtime older than the bogus watermark) would
  // never be indexed, with no recovery short of remove+re-add.
  it('throws (naming the root) when a configured root is missing at first sync — no cursor entry stamped for it', async () => {
    const dirA = mkTmpDir();
    writeFile(dirA, 'a.txt', 'a');
    const dirB = mkTmpDir();
    fs.rmSync(dirB, { recursive: true, force: true });

    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);

    const seen: { cursor: unknown }[] = [];
    let err: Error | null = null;
    try {
      for await (const b of pull(session, null)) seen.push(b);
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain(dirB);
    expect(err!.message).toMatch(/missing or unreadable/);
    // Whatever was yielded before the throw, none of it may carry a
    // watermark for the unavailable root.
    for (const b of seen) {
      const c = b.cursor as RootsCursor | null;
      expect(c?.roots?.[dirB]).toBeUndefined();
    }
  });

  it('an incremental rescan of a root that has vanished also throws instead of silently no-opping', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'a.txt', 'a');
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const backfillBatches = await collect(pull(session, null));
    const cursor = backfillBatches[backfillBatches.length - 1]
      .cursor as LocalFolderCursor;

    fs.rmSync(dir, { recursive: true, force: true });
    await expect(collect(pull(session, cursor))).rejects.toThrow(dir);
  });

  // The legitimate-empty counterpart (present-but-empty directory MUST still
  // backfill to completion and stamp { completedAt }) is covered by
  // 'yields a single empty completed batch for an empty root' above.
});

describe('pull — multi-root backfill', () => {
  it('backfills every configured root with absolute posix externalIds — a same-named file in both roots yields two distinct docs', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    writeFile(dirA, 'notes.txt', 'from A');
    writeFile(dirB, 'notes.txt', 'from B');

    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);
    const batches = await collect(pull(session, null));
    const items = batches.flatMap((b) => b.items);

    expect(items).toHaveLength(2);
    const externalIds = items.map((i) => i.externalId).sort();
    const expected = [
      toExternalId(path.join(dirA, 'notes.txt')),
      toExternalId(path.join(dirB, 'notes.txt')),
    ].sort();
    expect(externalIds).toEqual(expected);
    expect(externalIds.every((id) => path.isAbsolute(id))).toBe(true);

    const finalCursor = batches[batches.length - 1].cursor as RootsCursor;
    expect(Object.keys(finalCursor.roots).sort()).toEqual([dirA, dirB].sort());
  });

  it("every backfill batch reports the whole-account estimateTotal, not the current root's count", async () => {
    // Regression: the engine accumulates `done` across roots, so per-root
    // estimates displayed "242 / ~107 (100%)" once the second root started.
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    writeFile(dirA, 'a1.txt', 'a1');
    writeFile(dirA, 'a2.txt', 'a2');
    writeFile(dirB, 'b1.txt', 'b1');
    writeFile(dirB, 'b2.txt', 'b2');
    writeFile(dirB, 'b3.txt', 'b3');

    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);
    const batches = await collect(pull(session, null));
    const backfill = batches.filter((b) => b.phase === 'backfill');

    expect(backfill.length).toBeGreaterThanOrEqual(2); // one per root at minimum
    expect(backfill.every((b) => b.estimateTotal === 5)).toBe(true);
    expect(backfill.reduce((n, b) => n + b.items.length, 0)).toBe(5);
  });

  it("yields a trailing cursor-only live batch after backfill so status leaves 'backfilling'", async () => {
    // Regression: with watch enabled the source sits silently in the watcher
    // after backfill, so without this flip the account showed
    // "Backfilling … (100%)" forever. Quiet steady-state cycles must NOT
    // emit it (covered by the yields-nothing incremental test below).
    const dir = mkTmpDir();
    writeFile(dir, 'a.txt', 'a');
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const batches = await collect(pull(session, null));

    const last = batches[batches.length - 1];
    expect(last.phase).toBe('live');
    expect(last.items).toEqual([]);
    expect(last.estimateTotal).toBeUndefined();
    // Carries the completed cursor so the flip commit persists it verbatim.
    expect(Object.keys((last.cursor as RootsCursor).roots)).toEqual([dir]);
  });
});

describe('pull — per-root incremental rescan', () => {
  it('touching a file in one root only re-emits that root; the other root stays silent', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    writeFile(dirA, 'a.txt', 'a');
    writeFile(dirB, 'b.txt', 'b');
    // A real gap before the first backfill's watermark is captured — without
    // it, a file's on-disk mtime (filesystem-rounded) can occasionally land
    // a millisecond AHEAD of a `Date.now()` sampled a few microseconds later
    // within the same tick, which would make the incremental rescan below
    // misread this root's own untouched file as "changed". Same reasoning as
    // the existing single-root tests' `sleep(20)` before capturing `since`.
    await sleep(20);

    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);
    const backfillBatches = await collect(pull(session, null));
    const cursorAfterBackfill = backfillBatches[backfillBatches.length - 1]
      .cursor as LocalFolderCursor;

    await sleep(20);
    fs.writeFileSync(path.join(dirB, 'b.txt'), 'b updated');

    const rescanBatches = await collect(pull(session, cursorAfterBackfill));
    const items = rescanBatches.flatMap((b) => b.items);
    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe(toExternalId(path.join(dirB, 'b.txt')));
    expect(rescanBatches.every((b) => b.phase === 'live')).toBe(true);
  });

  it('a root added after an existing root already caught up backfills only itself', async () => {
    const dirA = mkTmpDir();
    writeFile(dirA, 'a.txt', 'a');
    // See the sibling test above for why a real gap is needed before the
    // first backfill's watermark is captured.
    await sleep(20);

    const controllerA = new AbortController();
    const sessionA = makeSession([dirA], controllerA.signal, false);
    const backfillBatches = await collect(pull(sessionA, null));
    const cursorAfterA = backfillBatches[backfillBatches.length - 1]
      .cursor as RootsCursor;
    expect(Object.keys(cursorAfterA.roots)).toEqual([dirA]);

    const dirB = mkTmpDir();
    writeFile(dirB, 'b.txt', 'b');
    const controllerAB = new AbortController();
    const sessionAB = makeSession([dirA, dirB], controllerAB.signal, false);
    const batches = await collect(pull(sessionAB, cursorAfterA));
    const items = batches.flatMap((b) => b.items);

    expect(items).toHaveLength(1);
    expect(items[0].externalId).toBe(toExternalId(path.join(dirB, 'b.txt')));
    expect(
      batches
        .filter((b) => b.items.length > 0)
        .every((b) => b.phase === 'backfill'),
    ).toBe(true);
    // The new root's backfill reports the WHOLE-ACCOUNT estimate (dirA's
    // 1 file + dirB's 1 file), not its own count — the engine seeds `done`
    // with the already-indexed document count, so a root-local estimate
    // would immediately read over 100%.
    const readdBackfill = batches.filter((b) => b.phase === 'backfill');
    expect(readdBackfill.length).toBeGreaterThan(0);
    expect(readdBackfill.every((b) => b.estimateTotal === 2)).toBe(true);
    const finalCursor = batches[batches.length - 1].cursor as RootsCursor;
    expect(Object.keys(finalCursor.roots).sort()).toEqual([dirA, dirB].sort());
  });

  it('drops a removed root from the cursor once another root commits a batch', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    writeFile(dirA, 'a.txt', 'a');
    writeFile(dirB, 'b.txt', 'b');

    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);
    const backfillBatches = await collect(pull(session, null));
    const cursorAfterBackfill = backfillBatches[backfillBatches.length - 1]
      .cursor as LocalFolderCursor;
    expect(
      Object.keys((cursorAfterBackfill as RootsCursor).roots).sort(),
    ).toEqual([dirA, dirB].sort());

    // dirB is removed from config; touch dirA's file so a batch actually
    // commits (nothing is yielded, and so nothing persisted, for a cycle
    // where literally no configured root changed).
    await sleep(20);
    fs.writeFileSync(path.join(dirA, 'a.txt'), 'a updated');
    const controller2 = new AbortController();
    const sessionAOnly = makeSession([dirA], controller2.signal, false);
    const batches = await collect(pull(sessionAOnly, cursorAfterBackfill));

    expect(batches.length).toBeGreaterThan(0);
    const finalCursor = batches[batches.length - 1].cursor as RootsCursor;
    expect(Object.keys(finalCursor.roots)).toEqual([dirA]);
  });

  it('persists the cursor prune immediately so a quiet cycle still drops a removed root, letting a later re-add backfill it', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    writeFile(dirA, 'a.txt', 'a');
    writeFile(dirB, 'b.txt', 'b');

    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);
    const backfillBatches = await collect(pull(session, null));
    const cursorAfterBackfill = backfillBatches[backfillBatches.length - 1]
      .cursor as LocalFolderCursor;
    expect(
      Object.keys((cursorAfterBackfill as RootsCursor).roots).sort(),
    ).toEqual([dirA, dirB].sort());

    // dirB is removed from config. dirA is QUIET this cycle (no file
    // changes at all) — the exact scenario where, pre-fix, no batch commits
    // so the prune never persists (today: `removalBatches` is empty).
    await sleep(20);
    const controllerRemove = new AbortController();
    const sessionAOnly = makeSession([dirA], controllerRemove.signal, false);
    const removalBatches = await collect(
      pull(sessionAOnly, cursorAfterBackfill),
    );

    expect(removalBatches.length).toBeGreaterThan(0);
    const cursorAfterRemoval = removalBatches[removalBatches.length - 1]
      .cursor as RootsCursor;
    expect(Object.keys(cursorAfterRemoval.roots)).toEqual([dirA]);

    // Re-add dirB. Since the prune was persisted, dirB has no cursor entry
    // at the start of this cycle, so it must take the BACKFILL path and
    // re-emit its (unchanged, old-mtime) file as an item rather than being
    // silently skipped by an incremental rescan against a stale watermark.
    const controllerReadd = new AbortController();
    const sessionAB = makeSession([dirA, dirB], controllerReadd.signal, false);
    const readdBatches = await collect(pull(sessionAB, cursorAfterRemoval));
    const items = readdBatches.flatMap((b) => b.items);
    expect(items.map((i) => i.externalId)).toContain(
      toExternalId(path.join(dirB, 'b.txt')),
    );
    expect(readdBatches.some((b) => b.phase === 'backfill')).toBe(true);
  });

  it('yields nothing when no file changed since the cursor', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'stable.txt', 'unchanged');
    await sleep(20);
    const since: LocalFolderCursor = {
      roots: { [dir]: { completedAt: new Date().toISOString() } },
    };

    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const batches = await collect(pull(session, since));
    expect(batches).toEqual([]);
  });

  it('yields only files newer than the cursor watermark, as a live-phase batch', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'old.txt', 'old content');
    await sleep(20);
    const since: LocalFolderCursor = {
      roots: { [dir]: { completedAt: new Date().toISOString() } },
    };
    await sleep(20);
    writeFile(dir, 'new.txt', 'new content');

    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const batches = await collect(pull(session, since));

    const items = batches.flatMap((b) => b.items);
    expect(items.map((i) => i.externalId)).toEqual([
      toExternalId(path.join(dir, 'new.txt')),
    ]);
    expect(batches.every((b) => b.phase === 'live')).toBe(true);
    const cursor = batches[0].cursor as RootsCursor;
    expect(
      cursor.roots[dir].completedAt >=
        (since as RootsCursor).roots[dir].completedAt,
    ).toBe(true);
  });
});

describe('buildItem — size caps become metadata-only docs', () => {
  it('drops markdown for an oversized plain-text file', async () => {
    const dir = mkTmpDir();
    const abs = writeFile(dir, 'big.txt', 'small content on disk');
    const oversizedStats = {
      size: 999_999_999,
      mtime: new Date(),
      birthtime: new Date(),
    } as fs.Stats;
    const item = await buildItem(abs, oversizedStats);
    expect(item.markdownText).toBeNull();
    expect(item.binary).toBeNull();
    expect(item.size).toBe(999_999_999);
  });

  it('drops binary bytes for an oversized parseable-binary file', async () => {
    const dir = mkTmpDir();
    const abs = writeFile(dir, 'big.csv', 'a,b');
    const oversizedStats = {
      size: 999_999_999,
      mtime: new Date(),
      birthtime: new Date(),
    } as fs.Stats;
    const item = await buildItem(abs, oversizedStats);
    expect(item.markdownText).toBeNull();
    expect(item.binary).toBeNull();
  });
});

describe('fetchBytes', () => {
  it('reads bytes for a doc under any configured root', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    const absB = writeFile(dirB, 'b.txt', 'contents-in-b');
    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);
    const doc = {
      metadata: { absPath: absB },
    } as unknown as Parameters<typeof fetchBytes>[1];
    const bytes = await fetchBytes(session, doc);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('contents-in-b');
  });

  it('refuses to read a path outside every configured root', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    const outside = mkTmpDir();
    const abs = writeFile(outside, 'secret.txt', 'nope');
    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);
    const doc = {
      metadata: { absPath: abs },
    } as unknown as Parameters<typeof fetchBytes>[1];
    expect(await fetchBytes(session, doc)).toBeNull();
  });
});

describe('reconcile', () => {
  it('yields absolute, posix ExternalRefs for every file currently on disk, across every configured root', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    writeFile(dirA, 'a.txt', '1');
    writeFile(dirA, 'sub/b.txt', '2');
    writeFile(dirA, '.git/HEAD', 'ignored');
    writeFile(dirB, 'c.txt', '3');

    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);
    const chunks = await collect(reconcile(session));
    const refs = chunks.flat();

    const expected = [
      toExternalId(path.join(dirA, 'a.txt')),
      toExternalId(path.join(dirA, 'sub/b.txt')),
      toExternalId(path.join(dirB, 'c.txt')),
    ].sort();
    expect(refs.map((r) => r.externalId).sort()).toEqual(expected);
    expect(refs.every((r) => r.type === 'file')).toBe(true);
  });

  it('throws instead of silently enumerating as empty when a configured root has been deleted', async () => {
    // This is the source-level half of the anti-mass-archival guard: the
    // engine's reconcile pass (engine.ts) archives every live document not
    // present in a COMPLETE listing — an unmounted/deleted root that
    // enumerated as empty would look identical to "this root's files are all
    // gone", wiping out a healthy account. Asserting the throw here is the
    // contract this layer owns; "docs stay live" is the engine's guarantee
    // (a partial/failed reconcile pass never diffs/archives — see engine.ts's
    // reconcilePass).
    const dir = mkTmpDir();
    writeFile(dir, 'a.txt', '1');
    fs.rmSync(dir, { recursive: true, force: true });

    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    await expect(collect(reconcile(session))).rejects.toThrow();
  });
});

describe('legacy single-folder accounts', () => {
  it('pull() fails fast with the exact legacy error for an old { path } config', async () => {
    const dir = mkTmpDir();
    const controller = new AbortController();
    const session = makeSessionWithConfig({ path: dir }, controller.signal);
    await expect(collect(pull(session, null))).rejects.toThrow(LEGACY_ERROR);
  });

  it('pull() fails fast for the original identifier-as-path shape (empty config)', async () => {
    const controller = new AbortController();
    const session = makeSessionWithConfig({}, controller.signal);
    await expect(collect(pull(session, null))).rejects.toThrow(LEGACY_ERROR);
  });

  it('reconcile() also fails fast for a legacy config', async () => {
    const dir = mkTmpDir();
    const controller = new AbortController();
    const session = makeSessionWithConfig({ path: dir }, controller.signal);
    await expect(collect(reconcile(session))).rejects.toThrow(LEGACY_ERROR);
  });

  it('fetchBytes() also fails fast for a legacy config', async () => {
    const dir = mkTmpDir();
    const abs = writeFile(dir, 'a.txt', 'x');
    const controller = new AbortController();
    const session = makeSessionWithConfig({ path: dir }, controller.signal);
    const doc = { metadata: { absPath: abs } } as unknown as Parameters<
      typeof fetchBytes
    >[1];
    await expect(fetchBytes(session, doc)).rejects.toThrow(LEGACY_ERROR);
  });
});

describe('chunk (scanner helper)', () => {
  it('splits into fixed-size groups with a partial final group', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });
});

describe('watchLoop', () => {
  it('emits add/change/unlink as live batches with absolute externalIds, advancing the per-root cursor, and closes the watcher on abort', async () => {
    class FakeWatcher extends EventEmitter {
      closed = false;

      close = jest.fn(async () => {
        this.closed = true;
      });
    }
    const fakeWatcher = new FakeWatcher();

    jest.resetModules();
    jest.doMock('chokidar', () => ({ watch: jest.fn(() => fakeWatcher) }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { watchLoop } = require('../watch') as typeof import('../watch');

    const dir = mkTmpDir();
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, true);

    const it = watchLoop([dir], session, null);

    const addPath = writeFile(dir, 'added.txt', 'hello');
    const expectedExternalId = toExternalId(addPath);
    const p1 = it.next();
    fakeWatcher.emit('add', addPath);
    const r1 = await p1;
    expect(r1.done).toBe(false);
    expect(r1.value?.phase).toBe('live');
    expect(r1.value?.deletions).toBeUndefined();
    expect(r1.value?.items).toHaveLength(1);
    expect(r1.value?.items[0].externalId).toBe(expectedExternalId);
    expect(r1.value?.items[0].markdownText).toBe('hello');
    const cursor1 = r1.value?.cursor as RootsCursor;
    expect(cursor1.roots[dir].completedAt).toEqual(
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );

    fs.writeFileSync(addPath, 'hello again');
    const p2 = it.next();
    fakeWatcher.emit('change', addPath);
    const r2 = await p2;
    expect(r2.value?.items[0].markdownText).toBe('hello again');

    fs.unlinkSync(addPath);
    const p3 = it.next();
    fakeWatcher.emit('unlink', addPath);
    const r3 = await p3;
    expect(r3.value?.items).toEqual([]);
    expect(r3.value?.deletions).toEqual([
      { externalId: expectedExternalId, type: 'file' },
    ]);

    const p4 = it.next();
    controller.abort();
    const r4 = await p4;
    expect(r4.done).toBe(true);
    expect(fakeWatcher.closed).toBe(true);

    jest.dontMock('chokidar');
    jest.resetModules();
  });
});
