/**
 * Pure folder-path covering-set logic, shared by the renderer's multi-select
 * folder picker (`folder-picker/selection.ts`) and the main-process
 * local-folder source (multi-root config normalization/containment checks).
 * Originally extracted from `FolderPickerModal` for the picker's
 * overlap/double-indexing invariants — moved here so the source can reuse
 * the exact same logic instead of duplicating it.
 */

/** True when `p` is `root` itself or lives anywhere under it. Separator-aware
 *  ("/Users/ed" must not cover "/Users/edjafarov"); handles both / and \ so
 *  drive roots like "C:\" work too. Case-sensitive and does no path
 *  normalization — callers pass paths already resolved by the main process. */
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
