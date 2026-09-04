import fs from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';
import type { Entry } from 'fast-glob';

import { DEFAULT_EXCLUDE_GLOBS } from './exclude-globs';
import { decideLocalFile } from './ingestible';
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
 * never reach here, since `listEntries` already filters those out).
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
 * Greedy size-aware batching: closes the current batch before adding an
 * item that would push it past `maxCount` entries or `maxBytes` of total
 * cost. An item whose own cost already exceeds `maxBytes` still gets a
 * batch of exactly one — never dropped, just isolated so it doesn't inflate
 * whatever batch it would otherwise have landed in.
 */
export function chunkBySize<T>(
  items: readonly T[],
  maxCount: number,
  maxBytes: number,
  costOf: (item: T) => number,
): T[][] {
  const out: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  for (const item of items) {
    const cost = costOf(item);
    if (
      batch.length > 0 &&
      (batch.length >= maxCount || batchBytes + cost > maxBytes)
    ) {
      out.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(item);
    batchBytes += cost;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/** One source of truth for what the local-folder source enumerates. Shared
 *  by `listEntries` (sync) and `countFiles` (the add-source preview) so the
 *  displayed count can never drift from what a folder would actually index. */
const ENUMERATION_OPTIONS = {
  ignore: DEFAULT_EXCLUDE_GLOBS,
  dot: true,
  onlyFiles: true,
  suppressErrors: true,
  followSymbolicLinks: false,
} as const;

/**
 * List every indexable file under `rootPath`: recursive, dotfiles included
 * (`dot: true`, matching kiagent-ref scanner.ts:41 — DEFAULT_EXCLUDE_GLOBS is
 * what actually keeps junk out, not a dotfile blanket ban), symlinks not
 * followed. `stats: true` gets size/mtime/birthtime in the same walk instead
 * of a second per-file `fs.stat` round trip — and, as of this filter, feeds
 * the SIZE-aware `decideLocalFile` check, so a file whose extension/mime
 * passes but whose real on-disk size is over its pipeline's cap (including
 * the outer edge of the local PDF ladder) never enters the listing at all.
 */
export async function listEntries(rootPath: string): Promise<ScannedEntry[]> {
  const entries = (await fg(['**/*'], {
    ...ENUMERATION_OPTIONS,
    cwd: rootPath,
    absolute: true,
    stats: true,
  })) as Entry[];
  return entries
    .filter(
      (e) =>
        decideLocalFile(e.path, (e.stats as fs.Stats).size).kind === 'index',
    )
    .map((e) => ({ absPath: e.path, stats: e.stats as fs.Stats }));
}

export interface FileCount {
  count: number;
  capped: boolean;
}

/**
 * Streamed recursive file count for the folder-picker preview. Uses the
 * same enumeration rules as sync (including the size-aware gate — `stats:
 * true` on the stream too), so the number shown is the number of documents
 * adding this folder would index. Caps at `cap` and aborts the walk early
 * (capped: true). Never throws — unreadable/nonexistent roots count as 0
 * (ENUMERATION_OPTIONS.suppressErrors handles that).
 */
export async function countFiles(
  rootPath: string,
  cap = 50_000,
): Promise<FileCount> {
  let count = 0;
  const stream = fg.stream(['**/*'], {
    ...ENUMERATION_OPTIONS,
    cwd: rootPath,
    absolute: true,
    stats: true,
  });
  for await (const raw of stream) {
    const entry = raw as unknown as Entry;
    // Same gate as listEntries: the preview must promise the number of
    // documents this folder will actually produce, not the file count.
    if (decideLocalFile(entry.path, entry.stats?.size).kind !== 'index')
      continue;
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
 * `listEntries` already applied at enumeration, recomputed here because a
 * watcher event calls this directly without going through `listEntries`):
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
