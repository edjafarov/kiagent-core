import fs from 'node:fs';
import path from 'node:path';

import fg from 'fast-glob';
import type { Entry } from 'fast-glob';

import { DEFAULT_EXCLUDE_GLOBS } from './exclude-globs';
import { classifyMime, resolveMime } from './mime';
import type { LocalFolderItem } from './to-document';

/** ~50 files per yielded Batch — matches the porting brief's chunk size. */
export const BATCH_SIZE = 50;

/**
 * Plain-text files (decoded inline as markdown by `buildItem`) larger than
 * this become metadata-only docs instead of being loaded into memory.
 *
 * DEVIATION: kiagent-ref had no read-time cap at the connector layer — it
 * always `readFile`d the whole file and let the shared Converter enforce
 * format-specific caps downstream (e.g. its PDF handler's own 8 MiB cap,
 * kiagent-ref src/main/converter/handlers/pdf.ts:8). Because this Source's
 * `toDocument` must stay pure/synchronous, bytes have to be read eagerly in
 * `pull()` — so a cap is needed here to bound memory per batch. Sized well
 * above ordinary text/config/source files.
 */
export const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Same rationale as MAX_INLINE_TEXT_BYTES; sized generously above legacy's
 *  PDF-specific 8 MiB cap since it also has to cover docx/xlsx/csv/html. */
export const MAX_BINARY_READ_BYTES = 20 * 1024 * 1024; // 20 MiB

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface ScannedEntry {
  absPath: string;
  stats: fs.Stats;
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
 * of a second per-file `fs.stat` round trip.
 */
export async function listEntries(rootPath: string): Promise<ScannedEntry[]> {
  const entries = (await fg(['**/*'], {
    ...ENUMERATION_OPTIONS,
    cwd: rootPath,
    absolute: true,
    stats: true,
  })) as Entry[];
  return entries.map((e) => ({ absPath: e.path, stats: e.stats as fs.Stats }));
}

export interface FileCount {
  count: number;
  capped: boolean;
}

/**
 * Streamed recursive file count for the folder-picker preview. Uses the
 * same enumeration rules as sync, so the number shown is the number of
 * documents adding this folder would index. Caps at `cap` and aborts the
 * walk early (capped: true). Never throws — unreadable/nonexistent roots
 * count as 0 (ENUMERATION_OPTIONS.suppressErrors handles that).
 */
export async function countFiles(rootPath: string, cap = 50_000): Promise<FileCount> {
  let count = 0;
  const stream = fg.stream(['**/*'], { ...ENUMERATION_OPTIONS, cwd: rootPath });
  for await (const entry of stream) {
    void entry;
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
 * Build a pull() Item for one file. Reads bytes HERE — the only place in this
 * Source allowed fs access for content — so `toDocument` stays pure/sync:
 *  - plain-text mimes (text/plain, text/markdown) → decoded inline as
 *    markdown, no engine conversion needed.
 *  - parseable binary mimes (html/pdf/docx/xlsx/csv) → raw bytes carried on
 *    the item for `toDocument` to attach as `DocumentInput.binary`; the
 *    ENGINE's converter does the extraction.
 *  - anything else, or anything over its size cap → metadata-only (no
 *    markdown, no binary) — still a real document, matching kiagent-ref's
 *    behavior of always creating a doc (extraction_status: 'unsupported' —
 *    kiagent-ref scanner.ts:170-208), just without wasting a read on bytes
 *    the engine couldn't use anyway.
 *
 * `stats` is passed in (rather than re-stat'd here) so callers that already
 * have it from a directory walk or an fs-watch event don't pay for it twice.
 */
export async function buildItem(absPath: string, stats: fs.Stats): Promise<LocalFolderItem> {
  const externalId = toAbsPosix(absPath);
  const ext = path.extname(absPath).slice(1).toLowerCase();
  const mt = resolveMime(absPath);
  const bucket = classifyMime(mt);
  const size = stats.size;
  const mtimeIso = stats.mtime.toISOString();
  const createdIso = (
    stats.birthtime && stats.birthtime.getTime() > 0 ? stats.birthtime : stats.mtime
  ).toISOString();

  let markdownText: string | null = null;
  let binary: LocalFolderItem['binary'] = null;

  try {
    if (bucket === 'text' && size <= MAX_INLINE_TEXT_BYTES) {
      markdownText = await fs.promises.readFile(absPath, 'utf-8');
    } else if (bucket === 'binary' && size <= MAX_BINARY_READ_BYTES) {
      const bytes = await fs.promises.readFile(absPath);
      binary = { bytes: new Uint8Array(bytes), mime: mt, filename: path.basename(absPath) };
    }
  } catch {
    // Vanished or unreadable between listing and read — fall back to a
    // metadata-only doc rather than failing the whole batch.
  }

  return { absPath, externalId, size, mtimeIso, createdIso, ext, markdownText, binary };
}
