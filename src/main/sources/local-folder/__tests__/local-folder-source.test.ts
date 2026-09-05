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
  FolderPickerSpec,
  FolderRootSelection,
  FolderSelectionChannel,
  Session,
} from '@shared/contracts';
import { MAX_LOCAL_AUDIO_BYTES } from '@shared/file-indexability';

import { buildItem, chunk } from '../scanner';
import {
  connect,
  fetchBytes,
  localFolderSource,
  pull,
  reconcile,
} from '../local-folder-source';
import type { LocalFolderCursor } from '../cursor';

const NO_ROOTS_ERROR =
  'Local-folder account has no tracked folders — remove this source and re-add its folder.';

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
    // Canonical scope, exactly the shape connect()/manageFolders() write.
    // The legacy `paths` mirror is CORE's (A-2) and deliberately absent here;
    // the pre-migration read path is covered by the makeSessionWithConfig
    // ({ paths: [dir] }) test in `canonical folderRoots config` above.
    config: {
      folderRoots: paths.map((p) => ({
        id: p,
        name: path.basename(p) || p,
      })),
      ...config,
    },
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
      id: 'acct-no-roots',
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

/** An AuthChannel whose picker returns `ids`, records every spec it was
 *  handed, and FAILS if anyone still reaches for the deleted
 *  `format:'folder-paths'` prompt fast path. */
function pickerAuth(ids: string[]): {
  auth: AuthChannel;
  specs: FolderPickerSpec[];
} {
  const specs: FolderPickerSpec[] = [];
  const auth: AuthChannel = {
    oauth: async () => ({}),
    showQr: () => {},
    status: () => {},
    prompt: async () => {
      throw new Error('local-folder must not use auth.prompt any more');
    },
    pickFolders: async (spec) => {
      specs.push(spec);
      return ids.map((id) => ({
        id,
        name: path.basename(id) || id,
        hasChildren: false,
      }));
    },
  };
  return { auth, specs };
}

describe('connect', () => {
  it('opens the shared picker with the local tabs and an empty connect selection', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    const { auth, specs } = pickerAuth([dirA, dirB]);
    const result = await connect(auth);

    expect(specs).toHaveLength(1);
    expect(specs[0].purpose).toBe('connect');
    expect(specs[0].selected).toEqual([]);
    expect(specs[0].multiSelect).toBe(true);
    expect(specs[0].modes).toEqual([
      { key: 'quick', label: 'Quick links' },
      { key: 'drives', label: 'Browse from drive root…' },
    ]);

    expect(result.identifier).toBe('this-machine');
    expect(
      (result.config.folderRoots as FolderRootSelection[])
        .map((r) => r.id)
        .sort(),
    ).toEqual([path.resolve(dirA), path.resolve(dirB)].sort());
  });

  it('normalizes a nested path out via coveringRoots', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    const nested = path.join(dirA, 'nested');
    fs.mkdirSync(nested);
    const { auth } = pickerAuth([dirA, dirB, nested]);
    const result = await connect(auth);
    expect(
      (result.config.folderRoots as FolderRootSelection[])
        .map((r) => r.id)
        .sort(),
    ).toEqual([path.resolve(dirA), path.resolve(dirB)].sort());
  });

  it('throws a clear error naming the offending nonexistent path', async () => {
    const dirA = mkTmpDir();
    const missing = path.join(
      os.tmpdir(),
      'definitely-does-not-exist-kiagent-xyz',
    );
    const { auth } = pickerAuth([dirA, missing]);
    await expect(connect(auth)).rejects.toThrow(missing);
    await expect(connect(auth)).rejects.toThrow(/does not exist/);
  });

  it('throws when a picked path is a file, not a directory', async () => {
    const dir = mkTmpDir();
    const filePath = writeFile(dir, 'not-a-dir.txt', 'x');
    const { auth } = pickerAuth([filePath]);
    await expect(connect(auth)).rejects.toThrow(/not a directory/);
  });

  it('throws when nothing is picked', async () => {
    const { auth } = pickerAuth([]);
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
    // The vision worker's classifier and the store's pending-OCR stat key on
    // this trio — a local image must carry the same metadata shape as a mail
    // attachment, not just ext/absPath.
    expect(pngDoc.metadata).toMatchObject({
      ext: 'png',
      mime: 'image/png',
      filename: 'photo.png',
      sizeBytes: pngItem.size,
    });
    expect(textDoc.metadata).toMatchObject({
      mime: 'text/plain',
      filename: 'readme.txt',
      sizeBytes: textItem.size,
    });
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

describe('pull — strict indexability policy', () => {
  it('emits only files with an indexing pipeline; archives and unknown extensions are absent, with zero reads for either', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'notes.txt', '0123456789');
    writeFile(dir, 'report.pdf', '%PDF-1.4 fixture');
    writeFile(dir, 'meeting.mp3', '0123456789');
    writeFile(dir, 'movie.mp4', '0123456789');
    writeFile(dir, 'backup.zip', '0123456789');
    // 26 MiB sparse file — an archive is ignored at every size, so this must
    // never be read regardless of the byte-budget chunker's caps.
    const hugeZip = path.join(dir, 'huge.zip');
    const fd = fs.openSync(hugeZip, 'w');
    fs.ftruncateSync(fd, 26 * 1024 * 1024);
    fs.closeSync(fd);
    writeFile(dir, 'unknown.scache', '0123456789');

    const readFileSpy = jest.spyOn(fs.promises, 'readFile');
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const batches = await collect(pull(session, null));
    const items = batches.flatMap((b) => b.items);
    const names = items.map((i) => path.basename(i.absPath)).sort();

    expect(names).toEqual(
      ['meeting.mp3', 'movie.mp4', 'notes.txt', 'report.pdf'].sort(),
    );

    const readPaths = readFileSpy.mock.calls.map((c) => String(c[0]));
    expect(readPaths.some((p) => p.endsWith('backup.zip'))).toBe(false);
    expect(readPaths.some((p) => p.endsWith('huge.zip'))).toBe(false);
    expect(readPaths.some((p) => p.endsWith('unknown.scache'))).toBe(false);

    readFileSpy.mockRestore();
  });
});

describe('buildItem — over-cap files are excluded entirely (no metadata-only doc)', () => {
  it('returns null for an oversized plain-text file rather than a doc with dropped markdown', async () => {
    const dir = mkTmpDir();
    const abs = writeFile(dir, 'big.txt', 'small content on disk');
    const oversizedStats = {
      size: 999_999_999,
      mtime: new Date(),
      birthtime: new Date(),
    } as fs.Stats;
    const item = await buildItem(abs, oversizedStats);
    expect(item).toBeNull();
  });

  it('returns null for an oversized parseable-binary file rather than a doc with dropped bytes', async () => {
    const dir = mkTmpDir();
    const abs = writeFile(dir, 'big.csv', 'a,b');
    const oversizedStats = {
      size: 999_999_999,
      mtime: new Date(),
      birthtime: new Date(),
    } as fs.Stats;
    const item = await buildItem(abs, oversizedStats);
    expect(item).toBeNull();
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

  it('rechecks the pipeline cap at fetch time — an mp3 grown past MAX_LOCAL_AUDIO_BYTES is refused, never read', async () => {
    const dir = mkTmpDir();
    const abs = writeFile(dir, 'meeting.mp3', 'small audio-shaped content');
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const doc = {
      metadata: { absPath: abs },
    } as unknown as Parameters<typeof fetchBytes>[1];

    // Under cap: bytes come back as usual.
    expect(await fetchBytes(session, doc)).not.toBeNull();

    // Grow past MAX_LOCAL_AUDIO_BYTES — sparse, no real disk write.
    const fd = fs.openSync(abs, 'r+');
    fs.ftruncateSync(fd, MAX_LOCAL_AUDIO_BYTES + 1);
    fs.closeSync(fd);

    const readFileSpy = jest.spyOn(fs.promises, 'readFile');
    expect(await fetchBytes(session, doc)).toBeNull();
    expect(readFileSpy).not.toHaveBeenCalled();
    readFileSpy.mockRestore();
  });

  it('does NOT cap a 25 MiB PDF at the local read cap — the vision pipeline still reads it for OCR', async () => {
    // This is the behavior fetchBytes must preserve: a 20-50 MiB local PDF
    // is committed metadata-only (converter cap exceeded, vision pipeline
    // applies instead), and the vision worker pulls its bytes back through
    // exactly this function. A flat cap here would silently kill that path.
    const dir = mkTmpDir();
    const abs = path.join(dir, 'mid.pdf');
    const fd = fs.openSync(abs, 'w');
    fs.ftruncateSync(fd, 25 * 1024 * 1024);
    fs.closeSync(fd);
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const doc = {
      metadata: { absPath: abs },
    } as unknown as Parameters<typeof fetchBytes>[1];

    // Avoid materializing 25 MiB of real bytes in the test process.
    const readFileSpy = jest
      .spyOn(fs.promises, 'readFile')
      .mockResolvedValue(Buffer.from('fake-pdf-bytes'));
    const bytes = await fetchBytes(session, doc);
    expect(bytes).not.toBeNull();
    expect(readFileSpy).toHaveBeenCalled();
    readFileSpy.mockRestore();
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

  it('excludes archives and unknown extensions from the ref set — no second gate, `listEntries` alone decides this', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'notes.txt', 'kept');
    writeFile(dir, 'backup.zip', 'excluded');
    writeFile(dir, 'unknown.scache', 'excluded');

    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const chunks = await collect(reconcile(session));
    const refs = chunks.flat();

    expect(refs.map((r) => r.externalId)).toEqual([
      toExternalId(path.join(dir, 'notes.txt')),
    ]);
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

describe('accounts with no tracked roots (malformed config)', () => {
  it('pull() fails fast with a permanent error when neither folderRoots nor paths is present', async () => {
    const controller = new AbortController();
    const session = makeSessionWithConfig({}, controller.signal);
    await expect(collect(pull(session, null))).rejects.toThrow(NO_ROOTS_ERROR);
  });

  it('reconcile() also fails fast', async () => {
    const controller = new AbortController();
    const session = makeSessionWithConfig({}, controller.signal);
    await expect(collect(reconcile(session))).rejects.toThrow(NO_ROOTS_ERROR);
  });

  it('fetchBytes() also fails fast', async () => {
    const dir = mkTmpDir();
    const abs = writeFile(dir, 'a.txt', 'x');
    const controller = new AbortController();
    const session = makeSessionWithConfig({}, controller.signal);
    const doc = { metadata: { absPath: abs } } as unknown as Parameters<
      typeof fetchBytes
    >[1];
    await expect(fetchBytes(session, doc)).rejects.toThrow(NO_ROOTS_ERROR);
  });
});

describe('canonical folderRoots config', () => {
  it('pulls from an account whose config carries ONLY folderRoots', async () => {
    const dir = mkTmpDir();
    writeFile(dir, 'a.txt', 'a');
    const controller = new AbortController();
    const session = makeSessionWithConfig(
      { folderRoots: [{ id: dir, name: path.basename(dir) }], watch: false },
      controller.signal,
    );
    const items = (await collect(pull(session, null))).flatMap((b) => b.items);
    expect(items.map((i) => i.externalId)).toEqual([
      toExternalId(path.join(dir, 'a.txt')),
    ]);
  });

  it('still pulls from a pre-migration account carrying only legacy paths', async () => {
    // TODO(folder-scope-train-2): delete with the mirror.
    const dir = mkTmpDir();
    writeFile(dir, 'a.txt', 'a');
    const controller = new AbortController();
    const session = makeSessionWithConfig(
      { paths: [dir], watch: false },
      controller.signal,
    );
    const items = (await collect(pull(session, null))).flatMap((b) => b.items);
    expect(items).toHaveLength(1);
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
    expect(r1.value?.items[0].scopeRootId).toBe(dir);
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

describe('watchLoop — a change event that fails the post-stat policy check', () => {
  it('indexes notes.txt, then a change event on a file grown past the text cap archives it instead of leaving a stale row', async () => {
    // NOTE ON THE BRIEF: it describes this scenario as "rename/change [the
    // file] to an ignored archive candidate". That literal case is
    // unreachable through watchLoop: onEvent's isIngestible(path) pre-filter
    // (watch.ts) denies archive EXTENSIONS unconditionally, for every event
    // kind including 'add'/'change', so a renamed-to-.zip path never even
    // reaches buildItem — emitting it would just hang this test. The
    // reachable equivalent — and the actual new code path this task adds —
    // is a file whose EXTENSION still passes that coarse pre-filter but
    // whose SIZE (only knowable after stat, which is exactly what changed)
    // now fails decideLocalFile's cap check. An oversized text file exercises
    // the identical buildItem-returns-null branch.
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MAX_LOCAL_TEXT_BYTES } =
      require('@shared/file-indexability') as typeof import('@shared/file-indexability');

    const dir = mkTmpDir();
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, true);
    const it = watchLoop([dir], session, null);

    const p = writeFile(dir, 'notes.txt', 'hello');
    const expectedExternalId = toExternalId(p);

    const p1 = it.next();
    fakeWatcher.emit('add', p);
    const r1 = await p1;
    expect(r1.value?.items).toHaveLength(1);
    expect(r1.value?.deletions).toBeUndefined();

    // Grow the SAME path past the text cap — sparse, no real disk write —
    // then re-fire the SAME path as a 'change' event.
    const fd = fs.openSync(p, 'r+');
    fs.ftruncateSync(fd, MAX_LOCAL_TEXT_BYTES + 1);
    fs.closeSync(fd);
    const p2 = it.next();
    fakeWatcher.emit('change', p);
    const r2 = await p2;
    expect(r2.value?.items).toEqual([]);
    expect(r2.value?.deletions).toEqual([
      { externalId: expectedExternalId, type: 'file' },
    ]);

    const p3 = it.next();
    controller.abort();
    await p3;

    jest.dontMock('chokidar');
    jest.resetModules();
  });
});

// The bug that cost two out-of-memory crashes. A CrossOver bottle under a
// user's Documents root symlinked `…/crossover/Documents` back to
// `~/Documents`; chokidar walked the cycle and turned ~9.9k real files into
// 3.7M documents. Reconcile then had millions of docs to archive that the
// scanner would never list again — first killing the DB worker, then the main
// process.
//
// The invariant is parity: the watcher and the scanner must enumerate the
// SAME set. chokidar's own `followSymlinks: false` does NOT provide it — it
// only reports the link instead of its target while readdirp still descends
// (on this fixture: 17 phantom adds with the option on, 32 with it off, the
// walk ending only when the OS returns ELOOP). Hence the explicit guard.
describe('watch enumeration parity (symlink cycles)', () => {
  it('enumerates exactly what the scanner lists, through a self-referential symlink', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chokidar = require('chokidar') as typeof import('chokidar');
    const { WATCH_ENUMERATION_OPTIONS } =
      require('../watch') as typeof import('../watch');
    const { listEntries } =
      require('../scanner') as typeof import('../scanner');

    const dir = mkTmpDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b');
    // The cycle: sub/loop -> the root itself.
    fs.symlinkSync(dir, path.join(dir, 'sub', 'loop'));
    // And a symlink to a FILE — the scanner drops these too, so the watcher
    // must as well, or every one becomes a document reconcile can't re-list.
    fs.symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'linkfile.txt'));

    const scanned = (await listEntries(dir))
      .map((e) => e.absPath.slice(dir.length))
      .sort();

    const watcher = chokidar.watch([dir], {
      ...WATCH_ENUMERATION_OPTIONS,
      ignoreInitial: false, // we are checking the walk itself
    });
    const seen: string[] = [];
    watcher.on('add', (p: string) => seen.push(p.slice(dir.length)));
    await new Promise<void>((resolve) => {
      watcher.on('ready', () => resolve());
    });
    await watcher.close();

    expect(seen.sort()).toEqual(scanned);
    expect(scanned).toEqual(['/a.txt', '/sub/b.txt']);
    // Belt and braces: not one path may have gone through the loop.
    expect(seen.some((p) => p.includes('loop'))).toBe(false);
  }, 20_000);
});

describe('ingestion allowlist parity (scanner vs watcher)', () => {
  /** One fixture, used by both halves: a mix of ingestible and not. */
  function mkMixedFixture(): { dir: string; ingestible: string[] } {
    const dir = mkTmpDir();
    fs.mkdirSync(path.join(dir, 'shadercache'));
    fs.mkdirSync(path.join(dir, 'Horos.noindex'));
    for (const f of [
      'notes.md',
      'report.pdf',
      'photo.jpg',
      'config.json',
      'mail.eml',
      'shadercache/000.scache',
      'shadercache/000.bin',
      'Horos.noindex/scan.jpg',
      'save.eu5',
      'archive.zip',
      '.env',
    ]) {
      fs.writeFileSync(path.join(dir, f), 'x');
    }
    return {
      dir,
      ingestible: [
        '/config.json',
        '/mail.eml',
        '/notes.md',
        '/photo.jpg',
        '/report.pdf',
      ],
    };
  }

  it('the scanner lists only ingestible files, and countFiles agrees', async () => {
    const { listEntries, countFiles } =
      require('../scanner') as typeof import('../scanner');
    const { dir, ingestible } = mkMixedFixture();

    const scanned = (await listEntries(dir))
      .map((e) => e.absPath.slice(dir.length))
      .sort();
    expect(scanned).toEqual(ingestible);

    // The add-folder preview must report the number of documents the folder
    // would actually produce — a pre-filter count would promise 11 and
    // deliver 5.
    expect((await countFiles(dir)).count).toBe(ingestible.length);
  }, 20_000);

  it('the watcher emits for exactly the files the scanner lists', async () => {
    const { listEntries } =
      require('../scanner') as typeof import('../scanner');
    const { watchLoop } = require('../watch') as typeof import('../watch');
    const { dir, ingestible } = mkMixedFixture();

    // watchLoop runs with ignoreInitial, so drive it with LIVE events: start
    // the loop over an empty dir, then create the same mix underneath it.
    const live = mkTmpDir();
    const ctl = new AbortController();
    const session = { signal: ctl.signal } as unknown as Session;
    const seen: string[] = [];
    const pump = (async () => {
      for await (const batch of watchLoop([live], session, { roots: {} })) {
        for (const item of batch.items)
          seen.push(item.externalId.slice(live.length));
      }
    })();

    await sleep(600); // chokidar's initial walk of an empty dir
    fs.mkdirSync(path.join(live, 'shadercache'));
    fs.mkdirSync(path.join(live, 'Horos.noindex'));
    for (const f of [
      'notes.md',
      'report.pdf',
      'photo.jpg',
      'config.json',
      'mail.eml',
      'shadercache/000.scache',
      'shadercache/000.bin',
      'Horos.noindex/scan.jpg',
      'save.eu5',
      'archive.zip',
      '.env',
    ]) {
      fs.writeFileSync(path.join(live, f), 'x');
    }
    await sleep(2500);
    ctl.abort();
    await pump;

    expect([...new Set(seen)].sort()).toEqual(ingestible);
    // and the scanner, walking the same tree, agrees exactly
    const scanned = (await listEntries(dir))
      .map((e) => e.absPath.slice(dir.length))
      .sort();
    expect([...new Set(seen)].sort()).toEqual(scanned);
  }, 30_000);
});

describe('manageFolders', () => {
  function channelPicking(ids: string[]): {
    channel: FolderSelectionChannel;
    specs: FolderPickerSpec[];
  } {
    const specs: FolderPickerSpec[] = [];
    return {
      specs,
      channel: {
        status: () => {},
        pickFolders: async (spec) => {
          specs.push(spec);
          return ids.map((id) => ({
            id,
            name: path.basename(id) || id,
            hasChildren: false,
          }));
        },
      },
    };
  }

  function sessionFor(account: Account): Session {
    return {
      account,
      signal: new AbortController().signal,
      credentials: async () => null,
      log: () => {},
    };
  }

  it('opens preselected with the current roots and purpose manage', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    fs.mkdirSync(path.join(dirA, 'child'));
    const session = sessionFor(makeAccount([dirA, dirB]));
    const { channel, specs } = channelPicking([dirA, dirB]);

    // The descriptor flag is what makes the Tracked folders card and
    // `accounts:start-manage-folders` reachable at all; assert it next to the
    // method it gates rather than leaving a Produces claim untested.
    expect(localFolderSource.descriptor.folderScope).toBe(true);
    expect(localFolderSource.reauthenticate).toBeUndefined();

    await localFolderSource.manageFolders!(session, channel);

    expect(specs[0].purpose).toBe('manage');
    expect(specs[0].selected).toEqual([
      { id: dirA, name: path.basename(dirA), hasChildren: true },
      { id: dirB, name: path.basename(dirB), hasChildren: false },
    ]);
  });

  it('keeps retained watermarks, drops removed roots, leaves added roots absent, and archives only the uncovered removal', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    const dirC = mkTmpDir();
    const account = makeAccount([dirA, dirB], { watch: false });
    account.cursor = {
      roots: {
        [dirA]: { completedAt: '2026-01-01T00:00:00.000Z' },
        [dirB]: { completedAt: '2026-01-02T00:00:00.000Z' },
      },
    };
    const before = JSON.stringify(account.config);
    const { channel } = channelPicking([dirA, dirC]); // B removed, C added

    const update = await localFolderSource.manageFolders!(
      sessionFor(account),
      channel,
    );

    expect(
      (update.config.folderRoots as FolderRootSelection[]).map((r) => r.id),
    ).toEqual([dirA, dirC]);
    // Unrelated config survives a scope edit. (Whether `paths` is present is
    // NOT asserted on the source's own output: A-2 makes this source silent
    // about the mirror, not a stripper of it — the two folderScopedConfig
    // unit tests in folder-roots.test.ts pin both halves of that rule.)
    expect(update.config.watch).toBe(false);

    // DECISIONS R8: dirB is removed and no retained root covers it, so its
    // scope_root_id is the ONE value applyFolderScope may archive. dirA is
    // retained and dirC is new — neither appears. B-7: dirA/dirB/dirC are the
    // fixture's own strings, so the two toEqual assertions above and here
    // pin that a root id survives the whole round trip BYTE-IDENTICAL to the
    // spelling `scope_root_id` was stamped with — no re-resolution, no
    // trailing-separator strip, no case fold at any layer.
    expect(update.archiveScopeRootIds).toEqual([dirB]);
    // DECISIONS C-1: the field exists and is optional; this source omits it.
    // C-34: core does not act on the flag in this train either way — the
    // store input no longer carries it and the engine does not forward it —
    // so the omission is both this source's intent and the effective
    // behaviour for every source.
    expect(update.archiveNullScoped).toBeUndefined();

    const cursor = update.cursor as RootsCursor;
    expect(Object.keys(cursor.roots)).toEqual([dirA]);
    expect(cursor.roots[dirA].completedAt).toBe('2026-01-01T00:00:00.000Z');

    // Persists nothing — core owns the durable write (applyFolderScope).
    expect(JSON.stringify(account.config)).toBe(before);
    expect(Object.keys((account.cursor as RootsCursor).roots).sort()).toEqual(
      [dirA, dirB].sort(),
    );
  });

  it('archives NOTHING when a removed root is still covered by a retained parent', async () => {
    // The case DECISIONS R8 exists for, end to end. The account tracks a
    // subfolder; the user widens the selection to its parent. The subfolder
    // "disappears" from folderRoots, but every one of its documents is still
    // in scope — a core-side set-difference would archive the whole subtree.
    const parent = mkTmpDir();
    const sub = path.join(parent, 'sub');
    fs.mkdirSync(sub);
    const account = makeAccount([sub], { watch: false });
    account.cursor = {
      roots: { [sub]: { completedAt: '2026-01-01T00:00:00.000Z' } },
    };
    const { channel } = channelPicking([parent]);

    const update = await localFolderSource.manageFolders!(
      sessionFor(account),
      channel,
    );

    expect(update.archiveScopeRootIds).toEqual([]);
    expect(
      (update.config.folderRoots as FolderRootSelection[]).map((r) => r.id),
    ).toEqual([parent]);
    // `parent` is a NEW key, so it is absent from the pruned cursor and the
    // next pull() backfills the whole (now wider) tree.
    expect((update.cursor as RootsCursor).roots).toEqual({});
  });

  it('the returned cursor makes the next pull backfill only the added root', async () => {
    const dirA = mkTmpDir();
    const dirC = mkTmpDir();
    writeFile(dirA, 'a.txt', 'a');
    writeFile(dirC, 'c.txt', 'c');
    await sleep(20);

    const account = makeAccount([dirA], { watch: false });
    account.cursor = {
      roots: { [dirA]: { completedAt: new Date().toISOString() } },
    };
    const { channel } = channelPicking([dirA, dirC]);
    const update = await localFolderSource.manageFolders!(
      sessionFor(account),
      channel,
    );

    const controller = new AbortController();
    const after = makeSessionWithConfig(update.config, controller.signal);
    const batches = await collect(
      pull(after, update.cursor as LocalFolderCursor),
    );
    const items = batches.flatMap((b) => b.items);

    expect(items.map((i) => i.externalId)).toEqual([
      toExternalId(path.join(dirC, 'c.txt')),
    ]);
    expect(batches.some((b) => b.phase === 'backfill')).toBe(true);
  });

  it('a newly added root does not override the strict file-indexability policy', async () => {
    // Spec invariant 15 (DECISIONS A-10). Adding a folder widens SCOPE; it
    // never widens what is ingestible. The junk types mirror the proven
    // fixture in `pull — strict indexability policy`
    // (local-folder-source.test.ts:645-677): .zip is ignored at every size,
    // .scache has no pipeline at all.
    const dirA = mkTmpDir();
    const dirC = mkTmpDir();
    writeFile(dirA, 'a.txt', 'a');
    writeFile(dirC, 'notes.txt', 'indexable');
    writeFile(dirC, 'backup.zip', '0123456789');
    writeFile(dirC, 'unknown.scache', '0123456789');
    await sleep(20);

    const account = makeAccount([dirA], { watch: false });
    account.cursor = {
      roots: { [dirA]: { completedAt: new Date().toISOString() } },
    };
    const { channel } = channelPicking([dirA, dirC]);
    const update = await localFolderSource.manageFolders!(
      sessionFor(account),
      channel,
    );

    const controller = new AbortController();
    const after = makeSessionWithConfig(update.config, controller.signal);
    const items = (
      await collect(pull(after, update.cursor as LocalFolderCursor))
    ).flatMap((b) => b.items);

    expect(items.map((i) => i.externalId)).toEqual([
      toExternalId(path.join(dirC, 'notes.txt')),
    ]);
  });

  it('refuses an empty selection', async () => {
    const dirA = mkTmpDir();
    const { channel } = channelPicking([]);
    await expect(
      localFolderSource.manageFolders!(
        sessionFor(makeAccount([dirA])),
        channel,
      ),
    ).rejects.toThrow(/folder path is required/);
  });

  it('refuses a root that has vanished from disk', async () => {
    const dirA = mkTmpDir();
    const gone = path.join(dirA, 'gone');
    const { channel } = channelPicking([dirA, gone]);
    await expect(
      localFolderSource.manageFolders!(
        sessionFor(makeAccount([dirA])),
        channel,
      ),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('scopeRootId attribution', () => {
  it('stamps every backfilled item with its own configured root, and toDocument carries it', async () => {
    const dirA = mkTmpDir();
    const dirB = mkTmpDir();
    writeFile(dirA, 'a.txt', 'a');
    writeFile(dirB, 'b.txt', 'b');
    const controller = new AbortController();
    const session = makeSession([dirA, dirB], controller.signal, false);

    const items = (await collect(pull(session, null))).flatMap((b) => b.items);
    const byName = new Map(items.map((i) => [path.basename(i.absPath), i]));

    expect(byName.get('a.txt')!.scopeRootId).toBe(dirA);
    expect(byName.get('b.txt')!.scopeRootId).toBe(dirB);

    const doc = localFolderSource.toDocument(
      byName.get('a.txt')!,
    ) as DocumentInput;
    expect(doc.scopeRootId).toBe(dirA);
    // Attribution is by the OS-NATIVE metadata.absPath prefix, never the
    // posix-ized externalId — the latter mis-matches every root on Windows.
    expect(doc.metadata.absPath).toBe(path.join(dirA, 'a.txt'));
  });

  it('stamps incrementally rescanned items too', async () => {
    const dir = mkTmpDir();
    const abs = writeFile(dir, 'a.txt', 'a');
    const controller = new AbortController();
    const session = makeSession([dir], controller.signal, false);
    const cursor: LocalFolderCursor = {
      roots: {
        [dir]: { completedAt: new Date(Date.now() - 60_000).toISOString() },
      },
    };
    fs.writeFileSync(abs, 'a updated');

    const batches = await collect(pull(session, cursor));
    const items = batches.flatMap((b) => b.items);

    expect(items).toHaveLength(1);
    expect(items[0].scopeRootId).toBe(dir);
    expect(batches.some((b) => b.phase === 'live')).toBe(true);
  });

  it('toDocument omits scopeRootId entirely when the item carries none', () => {
    const doc = localFolderSource.toDocument({
      absPath: '/tmp/x/a.txt',
      externalId: '/tmp/x/a.txt',
      size: 1,
      mtimeIso: new Date().toISOString(),
      createdIso: new Date().toISOString(),
      ext: 'txt',
      mime: 'text/plain',
      markdownText: 'a',
      binary: null,
    }) as DocumentInput;
    // Not `undefined` — ABSENT. The store writes NULL for a missing field
    // (DECISIONS R5); an explicit `scopeRootId: undefined` key would travel
    // through the worker boundary as a present-but-empty column value.
    expect('scopeRootId' in doc).toBe(false);
  });
});

describe('watchLoop — scope attribution', () => {
  it('stamps the covering root, and tolerates an event under NO root by yielding a NULL-scoped item', async () => {
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
    const outside = mkTmpDir();
    const controller = new AbortController();
    const log = jest.fn();
    const session: Session = {
      ...makeSession([dir], controller.signal, true),
      log,
    };
    const it = watchLoop([dir], session, null);

    const inside = writeFile(dir, 'inside.txt', 'in');
    const p1 = it.next();
    fakeWatcher.emit('add', inside);
    const r1 = await p1;
    expect(r1.value?.items[0].scopeRootId).toBe(dir);
    expect((r1.value?.cursor as RootsCursor).roots[dir]).toBeDefined();

    // DECISIONS R5 / watch.ts's rootOf: an event resolving under NO
    // configured root is DELIBERATELY still yielded. It must produce a
    // NULL-scoped document — never a throw (a throw lands in engine.ts's
    // per-batch loop, burns the 5-retry ladder and parks the account in
    // status 'error'), and never a warn here: the single warn
    // {accountId, source, externalId} is the engine's, at store time.
    const stray = writeFile(outside, 'stray.txt', 'out');
    const p2 = it.next();
    fakeWatcher.emit('add', stray);
    const r2 = await p2;

    expect(r2.done).toBe(false);
    expect(r2.value?.items).toHaveLength(1);
    expect(r2.value?.items[0].externalId).toBe(toExternalId(stray));
    expect(r2.value?.items[0].scopeRootId).toBeUndefined();
    const doc = localFolderSource.toDocument(
      r2.value!.items[0],
    ) as DocumentInput;
    expect('scopeRootId' in doc).toBe(false);
    // No watermark advanced: the unattributable event leaves the cursor alone.
    expect(Object.keys((r2.value?.cursor as RootsCursor).roots)).toEqual([dir]);
    expect(log).not.toHaveBeenCalled();

    const p3 = it.next();
    controller.abort();
    const r3 = await p3;
    expect(r3.done).toBe(true);
    expect(fakeWatcher.closed).toBe(true);

    jest.dontMock('chokidar');
    jest.resetModules();
  });
});
