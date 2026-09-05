/**
 * Pure folder-path covering-set logic, shared by the renderer's multi-select
 * folder picker (`folder-picker/selection.ts`) and the main-process
 * local-folder source (multi-root config normalization/containment checks).
 * Originally extracted from `FolderPickerModal` for the picker's
 * overlap/double-indexing invariants — moved here so the source can reuse
 * the exact same logic instead of duplicating it.
 */

/**
 * Rewrite every `\` to `/` so two paths of DIFFERENT provenance can be
 * compared. Pure string work on purpose: this module is imported by the
 * renderer, so it must not pull in `node:path` (and `path.resolve` would be
 * wrong here anyway — it is cwd- and platform-dependent, and a corpus's paths
 * may have been written on another OS).
 *
 * It mirrors the idiom `scanner.ts`'s `toAbsPosix` uses
 * (`absPath.split(path.sep).join('/')`) and the one fast-glob applies to
 * every absolute entry it emits (`unixify = filepath.replace(/\\/g, '/')`,
 * `fast-glob/out/utils/path.js:29-31`) — which is exactly why it is needed:
 * on Windows a SCAN-produced `metadata.absPath` is forward-slashed while the
 * `path.resolve`d config root beside it is backslashed (C-46/D1).
 *
 * Use it ONLY where the two sides genuinely have different provenance. A pair
 * that came from the same producer is already consistent, and normalizing it
 * would widen the comparison for nothing.
 */
export function normalizePathSeparators(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True when `p` is `root` itself or lives anywhere under it. Separator-aware
 *  ("/Users/ed" must not cover "/Users/edjafarov"); handles both / and \ so
 *  drive roots like "C:\" work too. Case-sensitive and does no path
 *  normalization — callers pass paths already resolved by the main process.
 *
 *  It does NOT cross-normalize either: `isUnder('C:/x/f.txt', 'C:\\x')` is
 *  false, because a raw `startsWith` cannot see through a separator swap. That
 *  is correct for every caller whose two sides share a producer; a caller
 *  comparing MIXED provenance must pass both sides through
 *  `normalizePathSeparators` first (C-46/D1). Widening `isUnder` itself was
 *  considered and rejected — its other callers are all same-provenance, so it
 *  would be blast radius bought for nothing. */
export function isUnder(p: string, root: string): boolean {
  if (p === root) return true;
  if (!p.startsWith(root)) return false;
  if (root.endsWith('/') || root.endsWith('\\')) return true;
  const next = p.charAt(root.length);
  return next === '/' || next === '\\';
}

/** Keep only the top-most paths — drop any path nested under another in the
 *  same list. Defensive re-normalization: `toggleSelection` keeps its map an
 *  antichain, but an overlapping pair here would double-index the same files
 *  as two accounts. */
export function coveringRoots(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((r) => r !== p && isUnder(p, r)));
}
