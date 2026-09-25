import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_EXCLUDE_GLOBS } from './exclude-globs';
import { decideLocalFile, isIngestible } from './ingestible';
import { resolvePathMime } from './mime';
import type { LocalFolderItem } from './to-document';

/** ~50 files per yielded Batch — matches the porting brief's chunk size. */
export const BATCH_SIZE = 50;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export interface ScannedEntry {
  absPath: string;
  stats: fs.Stats;
}

/**
 * A count-only chunk of `BATCH_SIZE` entries can still hold up to
 * `BATCH_SIZE * MAX_LOCAL_BINARY_BYTES` (~1 GiB, `@shared/file-indexability`)
 * of file bytes at once if every entry happens to be a near-cap
 * `converter`-pipeline file — the whole batch is built (bytes attached) and
 * held before it's yielded, so bounding read *concurrency* alone wouldn't
 * help. This is the second, byte-budget cap `chunkBySize` enforces alongside
 * `BATCH_SIZE`. Sized well above what an ordinary batch of ~50 everyday files
 * would cost, while keeping the worst case a small, predictable fraction of
 * memory rather than unbounded.
 */
export const MAX_BATCH_READ_BYTES = 64 * 1024 * 1024; // 64 MiB

/**
 * Bytes `buildItem` will actually read off disk for one entry — mirrors
 * `decideLocalFile`'s pipeline routing so the chunker's byte budget lines up
 * exactly with real read cost. Only the `inline-text` and `converter`
 * pipelines read bytes eagerly (see `buildItem`); `vision`/`audio` commit
 * metadata-only, and an `ignore`d entry costs 0 too (defensive — it should
 * never reach here, since `walkRoot` already filters those out).
 */
export function entryReadCost(entry: ScannedEntry): number {
  const decision = decideLocalFile(entry.absPath, entry.stats.size);
  if (decision.kind !== 'index') return 0;
  return decision.pipeline === 'inline-text' ||
    decision.pipeline === 'converter'
    ? entry.stats.size
    : 0;
}

/**
 * Greedy size-aware batching over a stream: closes the current batch before
 * adding an item that would push it past `maxCount` entries or `maxBytes` of
 * total cost. An item whose own cost already exceeds `maxBytes` still gets a
 * batch of exactly one — never dropped, just isolated so it doesn't inflate
 * whatever batch it would otherwise have landed in. Pulls from `items` only
 * as far as the batch it is filling.
 */
export async function* chunkBySize<T>(
  items: AsyncIterable<T>,
  maxCount: number,
  maxBytes: number,
  costOf: (item: T) => number,
): AsyncGenerator<T[]> {
  let batch: T[] = [];
  let batchBytes = 0;
  for await (const item of items) {
    const cost = costOf(item);
    if (
      batch.length > 0 &&
      (batch.length >= maxCount || batchBytes + cost > maxBytes)
    ) {
      yield batch;
      batch = [];
      batchBytes = 0;
    }
    batch.push(item);
    batchBytes += cost;
  }
  if (batch.length > 0) yield batch;
}

/**
 * DEFAULT_EXCLUDE_GLOBS as the walk applies them — the list itself stays the
 * one source of truth (the watcher hands it to chokidar verbatim). The rules
 * are fast-glob's, which this source used to walk with. Every glob is `**`
 * followed by one of three tails: `/NAME/**` skips a directory and everything
 * below it; `/NAME` skips a file or a directory of that name; `/*SUFFIX`
 * skips a file only (fast-glob descends into a directory called `x.tmp`).
 * Any other shape throws at load, so a new glob cannot silently stop
 * applying.
 */
function excludeRules(globs: readonly string[]) {
  const subtrees = new Set<string>();
  const names = new Set<string>();
  const suffixes: string[] = [];
  for (const glob of globs) {
    const m = /^\*\*\/(?:([^*/]+)\/\*\*|([^*/]+)|\*([^*/]+))$/.exec(glob);
    if (!m) throw new Error(`local-folder: unsupported exclude glob "${glob}"`);
    if (m[1]) subtrees.add(m[1]);
    else if (m[2]) names.add(m[2]);
    else suffixes.push(m[3]);
  }
  return {
    dir: (name: string) => subtrees.has(name) || names.has(name),
    file: (name: string) =>
      names.has(name) || suffixes.some((suffix) => name.endsWith(suffix)),
  };
}

const EXCLUDED = excludeRules(DEFAULT_EXCLUDE_GLOBS);

/** A dirent whose type the filesystem did not report (DT_UNKNOWN, e.g. some
 *  network and FUSE mounts): every predicate is false. */
function typeUnknown(d: fs.Dirent): boolean {
  return !(
    d.isFile() ||
    d.isDirectory() ||
    d.isSymbolicLink() ||
    d.isFIFO() ||
    d.isSocket() ||
    d.isCharacterDevice() ||
    d.isBlockDevice()
  );
}

/**
 * Every path under `rootPath` that could be a document, depth-first and
 * pulled one at a time: the only state is the open directory handles along
 * the current path (`opendir` reads a directory a few entries at a time), so
 * memory grows with the tree's DEPTH, never its size, and nothing is read
 * ahead of the consumer. This is why the walk is not fast-glob: its stream
 * ignores backpressure and queues the whole remaining tree as soon as the
 * consumer slows down (29,999 of 30,000 entries, measured).
 *
 * Kept from the fast-glob walk it replaces (`dot: true`, `onlyFiles`,
 * `followSymbolicLinks: false`, `suppressErrors`): dotfiles are walked —
 * DEFAULT_EXCLUDE_GLOBS keeps junk out, not a dotfile ban; every symlink is
 * skipped, to a file or a directory (watch.ts's `isSymlink` says why that
 * matters); anything that is not a regular file is skipped; an unreadable or
 * vanished directory is skipped silently. Paths on Windows keep fast-glob's
 * forward slashes: `metadata.absPath` and `url` feed the content hash, and a
 * spelling change would rewrite every document once.
 *
 * Only the cheap PATH gate (`isIngestible`) applies here; `walkRoot` adds the
 * size-aware one.
 */
export async function* walkPaths(rootPath: string): AsyncGenerator<string> {
  const open: fs.Dir[] = [];
  const descend = async (dir: string): Promise<void> => {
    try {
      open.push(await fs.promises.opendir(dir));
    } catch {
      // unreadable or vanished — skipped, as suppressErrors did
    }
  };
  await descend(path.resolve(rootPath));
  try {
    while (open.length > 0) {
      const dir = open[open.length - 1];
      let dirent: fs.Dirent | null;
      try {
        // eslint-disable-next-line no-await-in-loop
        dirent = await dir.read();
      } catch {
        dirent = null; // the directory went away mid-read
      }
      if (dirent === null) {
        open.pop();
        // eslint-disable-next-line no-await-in-loop
        await dir.close().catch(() => {});
        continue;
      }
      const absPath = path.join(dir.path, dirent.name);
      let isDir = dirent.isDirectory();
      let isFile = dirent.isFile();
      if (typeUnknown(dirent)) {
        // eslint-disable-next-line no-await-in-loop
        const st = await fs.promises.lstat(absPath).catch(() => null);
        isDir = st?.isDirectory() ?? false;
        isFile = st?.isFile() ?? false;
      }
      if (isDir) {
        // eslint-disable-next-line no-await-in-loop
        if (!EXCLUDED.dir(dirent.name)) await descend(absPath);
      } else if (
        isFile &&
        !EXCLUDED.file(dirent.name) &&
        isIngestible(absPath)
      ) {
        yield path.sep === '/' ? absPath : toAbsPosix(absPath);
      }
    }
  } finally {
    // The consumer stopped early (abort, error): release what is still open.
    await Promise.allSettled(open.map((dir) => dir.close()));
  }
}

/**
 * Every indexable file under `rootPath`, with its stats, in `walkPaths`'s
 * order and just as lazily. `lstat` (the link, never its target — the walk
 * already skipped links; a path swapped for one since is dropped) supplies
 * size/mtime/ctime/birthtime for the SIZE-aware `decideLocalFile` check, so a
 * file whose extension passes but whose real on-disk size is over its
 * pipeline's cap (including the outer edge of the local PDF ladder) never
 * enters the listing at all. Sync, reconcile and `countFiles` all enumerate
 * through here, so the preview count can never drift from what a folder
 * would actually index.
 */
export async function* walkRoot(
  rootPath: string,
): AsyncGenerator<ScannedEntry> {
  for await (const absPath of walkPaths(rootPath)) {
    let stats: fs.Stats;
    try {
      // eslint-disable-next-line no-await-in-loop
      stats = await fs.promises.lstat(absPath);
    } catch {
      continue; // vanished since the directory was read
    }
    if (stats.isFile() && decideLocalFile(absPath, stats.size).kind === 'index')
      yield { absPath, stats };
  }
}

export interface FileCount {
  count: number;
  capped: boolean;
}

/**
 * Recursive file count for the folder-picker preview, through `walkRoot` —
 * the enumeration sync uses, size-aware gate included — so the number shown
 * is the number of documents adding this folder would index. Caps at `cap`
 * and stops the walk early (capped: true). Never throws — unreadable or
 * nonexistent roots count as 0.
 */
export async function countFiles(
  rootPath: string,
  cap = 50_000,
): Promise<FileCount> {
  let count = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for await (const _entry of walkRoot(rootPath)) {
    count += 1;
    if (count >= cap) return { count, capped: true };
  }
  return { count, capped: false };
}

/** ABSOLUTE posix-style path — this IS the document's `externalId` (see
 *  to-document.ts). Collision-free across multiple configured roots, unlike
 *  the single-root scheme's root-relative path. `watch.ts`'s deletion events
 *  must use this exact same formula. */
export function toAbsPosix(absPath: string): string {
  return absPath.split(path.sep).join('/');
}

/**
 * Build a pull() Item for one file, or `null` if it turns out this file
 * produces no document at all. Reads bytes HERE — the only place in this
 * Source allowed fs access for content — so `toDocument` stays pure/sync.
 *
 * Routes on `decideLocalFile`'s pipeline (size-aware — the same decision
 * `walkRoot` already applied at enumeration, recomputed here because a
 * watcher event calls this directly without going through `walkRoot`):
 *  - `ignore` → `null`. `unsupported` and `too-large` are no longer document
 *    outcomes — a file this policy rejects produces no row at all, not a
 *    metadata-only one.
 *  - `inline-text` → decoded inline as markdown, no engine conversion
 *    needed.
 *  - `converter` → raw bytes carried on the item for `toDocument` to attach
 *    as `DocumentInput.binary`; the ENGINE's converter does the extraction.
 *  - `vision` / `audio` → metadata-only (no eager markdown/binary): this is
 *    deliberate, not a fallback — it's how a 20-50 MiB local PDF (over the
 *    read-eagerly cap but under the outer PDF cap) and every image/audio/
 *    video candidate commit today, with the vision/audio WORKER pulling
 *    bytes back later through `fetchBytes`.
 *  - unreadable (vanished between listing and read) or NUL-byte-containing
 *    "text" (an extension that lied — see below) → `null`, same as `ignore`.
 *    A file that passed the cheap metadata gate but failed this final
 *    read/sniff must not leave a stale row behind; callers are responsible
 *    for archiving any prior document at this path when they get `null`
 *    back (see `local-folder-source.ts`'s backfill/incremental map sites and
 *    `watch.ts`'s add/change handling).
 *
 * Bytes are read EAGERLY here (not deferred to the engine's converter, the
 * way kiagent-ref's shared Converter did it) because this Source's
 * `toDocument` must stay pure/synchronous — a cap-bounded read in `pull()`
 * is the only place left to do it.
 *
 * `stats` is passed in (rather than re-stat'd here) so callers that already
 * have it from a directory walk or an fs-watch event don't pay for it twice.
 */
export async function buildItem(
  absPath: string,
  stats: fs.Stats,
): Promise<LocalFolderItem | null> {
  const decision = decideLocalFile(absPath, stats.size);
  if (decision.kind === 'ignore') return null;

  const externalId = toAbsPosix(absPath);
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mt = resolvePathMime(absPath);
  const { size } = stats;
  const mtimeIso = stats.mtime.toISOString();
  const createdIso = (
    stats.birthtime && stats.birthtime.getTime() > 0
      ? stats.birthtime
      : stats.mtime
  ).toISOString();

  let markdownText: string | null = null;
  let binary: LocalFolderItem['binary'] = null;

  try {
    if (decision.pipeline === 'inline-text') {
      const bytes = await fs.promises.readFile(absPath);
      // The text extension set routes by extension, and an extension can
      // lie: `.ts` is TypeScript almost always and an MPEG transport stream
      // occasionally. A NUL byte means this is not text, whatever it is
      // called — decoding it would push megabytes of mojibake into markdown
      // and the search index. No document is the honest answer.
      if (bytes.includes(0)) return null;
      markdownText = bytes.toString('utf-8');
    } else if (decision.pipeline === 'converter') {
      const bytes = await fs.promises.readFile(absPath);
      binary = {
        bytes: new Uint8Array(bytes),
        mime: mt,
        filename: path.basename(absPath),
      };
    }
    // `vision` / `audio`: metadata-only pending candidate, no eager read.
  } catch {
    // Vanished or unreadable between listing and read — no document rather
    // than a metadata-only fallback (see the doc comment above).
    return null;
  }

  return {
    absPath,
    externalId,
    size,
    mtimeIso,
    createdIso,
    ext,
    mime: mt,
    markdownText,
    binary,
  };
}
