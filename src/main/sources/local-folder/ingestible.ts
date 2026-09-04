import path from 'node:path';

import { isTranscribableExt } from '@main/workers/audio/classify';
import { VISUAL_EXTS } from '@main/workers/vision/classify';
import {
  NOINDEX_DIR_RE,
  SENSITIVE_BASENAME_RE,
} from '@shared/file-indexability';

import { classifyPath } from './mime';

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
 * `.noindex` is handled separately (see `isIngestible`) because it is a
 * DIRECTORY marker, not a filename.
 *
 * Canonical definition moved to `@shared/file-indexability`'s
 * `SENSITIVE_BASENAME_RE`; re-exported here under the name `ingestible.test.ts`
 * imports.
 */
export const INGESTIBLE_DENY_RE = SENSITIVE_BASENAME_RE;

// `NOINDEX_DIR_RE` — macOS's own "do not index this subtree" marker
// (Spotlight honours a `.noindex` directory suffix; matches at any depth) —
// moves as-is from `@shared/file-indexability`, imported above.

/**
 * The local-folder ingestion allowlist: is this path something a pipeline can
 * actually turn into text?
 *
 * Before this gate existed the source ingested EVERY file, and anything
 * unparseable became a metadata-only document — title and path, no content.
 * On a real 8,900-document account that was 80% of the corpus: 5,624 shader
 * cache files from one game, 752 DICOM scans, archives, game saves, GIS
 * sidecars. Every one cost a row, an FTS entry, a vision-worker candidacy,
 * and a line in every reconcile diff, and none could ever answer a query.
 *
 * The three accepted classes are DERIVED, never restated:
 *  - `classifyPath` — decoded inline, or parsed by the engine converter
 *  - `VISUAL_EXTS`  — the vision worker's own list (OCR/VLM)
 *  - `isTranscribableExt` — the audio worker's own list (ASR)
 * so a format added to any pipeline becomes ingestible here with no edit.
 *
 * ⚠️ This predicate MUST be applied everywhere the source enumerates files —
 * `listEntries`, `countFiles`, and the watcher's events — or the watcher and
 * scanner disagree about what exists and reconcile diffs a corpus against a
 * listing that never contained it. That exact divergence (via a symlink
 * cycle, not a type filter) is what produced two out-of-memory crashes; see
 * watch.ts's `isSymlink`.
 */
export function isIngestible(absPath: string): boolean {
  const posix = absPath.split(path.sep).join('/');
  if (NOINDEX_DIR_RE.test(posix)) return false;

  const base = posix.slice(posix.lastIndexOf('/') + 1);
  if (INGESTIBLE_DENY_RE.test(base)) return false;

  // An extensionless file (Makefile, LICENSE) is not guessed at: reading it to
  // sniff would defeat the point of a cheap enumeration-time gate.
  const ext = path.extname(base).slice(1).toLowerCase();
  if (!ext) return false;

  if (classifyPath(posix) !== 'unsupported') return true;
  if ((VISUAL_EXTS as readonly string[]).includes(ext)) return true;
  return isTranscribableExt(ext);
}
