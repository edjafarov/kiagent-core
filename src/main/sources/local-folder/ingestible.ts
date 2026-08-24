import path from 'node:path';

import { isTranscribableExt } from '@main/workers/audio/classify';
import { VISUAL_EXTS } from '@main/workers/vision/classify';

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
 */
export const INGESTIBLE_DENY_RE =
  /^(\.env(\..+)?|\.npmrc|\.netrc|\.git-credentials|\.htpasswd|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|jks|keystore|asc|gpg|crt|cer|der)|.*\.min\.(js|css)|.*\.map|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|composer\.lock)$/i;

/**
 * macOS's own "do not index this subtree" marker. Spotlight honours a
 * `.noindex` directory suffix, and apps use it for exactly the content we
 * should skip — the corpus that prompted this held 752 DICOM images under
 * `Horos Data/DATABASE.noindex/`. Matches at any depth.
 */
const NOINDEX_DIR_RE = /(^|\/)[^/]*\.noindex(\/|$)/i;

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
