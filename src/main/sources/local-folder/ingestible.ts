import path from 'node:path';

import {
  decideFileIndexing,
  SENSITIVE_BASENAME_RE,
  type FileIndexDecision,
} from '@shared/file-indexability';

import { resolvePathMime } from './mime';

/**
 * Files this source refuses to ingest no matter how readable they are.
 *
 * Two groups, both matched against the BASENAME:
 *  - credential material. The type allowlist below admits plain text broadly,
 *    and `.env` / `id_ed25519` / `*.pem` are plain text — without this they
 *    would be decoded into a searchable corpus and answerable by the
 *    assistant. Excluding them is worth more than the search hit they'd add.
 *  - build and dependency lock noise, which is text, enormous, and answers no
 *    question a person asks.
 *
 * `.noindex` is handled separately (as part of `decideFileIndexing`) because
 * it is a DIRECTORY marker, not a filename.
 *
 * Canonical definition moved to `@shared/file-indexability`'s
 * `SENSITIVE_BASENAME_RE`; re-exported here under the name `ingestible.test.ts`
 * imports.
 */
export const INGESTIBLE_DENY_RE = SENSITIVE_BASENAME_RE;

/**
 * The local-folder adapter onto the canonical `decideFileIndexing` policy:
 * fills in the `profile: 'local-folder'` candidate shape from a bare path
 * (+ optional size), so every caller in this source shares ONE decision
 * function instead of restating sensitive-file, archive, image, text and
 * audio/video rules here.
 *
 * `sizeBytes` is OPTIONAL and, when omitted, admits size-capped categories
 * provisionally (unknown size is never treated as over any cap) — callers
 * that only have a path (the coarse enumeration-time / watcher pre-filter)
 * get the coarse answer; callers that also have `fs.Stats` (listEntries,
 * buildItem, fetchBytes) get the size-aware one, including the local PDF's
 * two-budget ladder (see `@shared/file-indexability`'s `decideFileIndexing`
 * step 5).
 */
export function decideLocalFile(
  absPath: string,
  sizeBytes?: number,
): FileIndexDecision {
  return decideFileIndexing({
    profile: 'local-folder',
    filename: path.basename(absPath),
    mime: resolvePathMime(absPath),
    sizeBytes,
    path: absPath,
  });
}

/**
 * The local-folder ingestion allowlist: is this path something a pipeline can
 * actually turn into text? Cheap, PATH-ONLY (no size) — the enumeration-time
 * and watcher-event pre-filter; a size-capped category that turns out
 * oversized still passes here and is caught later by the size-aware
 * `decideLocalFile` call in `listEntries`/`buildItem`/`fetchBytes`.
 *
 * Before this gate existed the source ingested EVERY file, and anything
 * unparseable became a metadata-only document — title and path, no content.
 * On a real 8,900-document account that was 80% of the corpus: 5,624 shader
 * cache files from one game, 752 DICOM scans, archives, game saves, GIS
 * sidecars. Every one cost a row, an FTS entry, a vision-worker candidacy,
 * and a line in every reconcile diff, and none could ever answer a query.
 *
 * ⚠️ This predicate MUST be applied everywhere the source enumerates files —
 * `listEntries`, `countFiles`, and the watcher's events — or the watcher and
 * scanner disagree about what exists and reconcile diffs a corpus against a
 * listing that never contained it. That exact divergence (via a symlink
 * cycle, not a type filter) is what produced two out-of-memory crashes; see
 * watch.ts's `isSymlink`.
 */
export function isIngestible(absPath: string): boolean {
  return decideLocalFile(absPath).kind === 'index';
}
