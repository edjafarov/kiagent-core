/**
 * Pure selection-set logic for the multi-select folder picker, extracted from
 * `FolderPickerModal` so the overlap/double-indexing invariants have unit
 * coverage independent of React/DOM. See `FolderPickerModal`'s module doc for
 * the user-facing behavior these functions implement.
 *
 * `isUnder`/`coveringRoots` themselves now live in `src/shared/folder-paths.ts`
 * (the main-process local-folder source reuses them for multi-root
 * containment/normalization) — re-exported here so existing picker imports
 * keep working unchanged.
 */
import { coveringRoots, isUnder } from '@shared/folder-paths';

export { coveringRoots, isUnder };

/** Toggle `path` in the covering-root selection map, preserving the
 *  antichain invariant (no path in the map is ever nested under another). */
export function toggleSelection(
  prev: Map<string, string>,
  path: string,
  name: string,
): Map<string, string> {
  if (prev.has(path)) {
    const next = new Map(prev);
    next.delete(path);
    return next;
  }
  // Already covered by a selected ancestor: the subtree is fully
  // included, and carving out descendants (exclusion lists) is
  // deliberately unsupported — no-op.
  for (const root of prev.keys()) {
    if (isUnder(path, root)) return prev;
  }
  // Selecting a folder covers its whole subtree: drop any previously
  // selected descendants so the map stays the MINIMAL covering set —
  // the "closest to root" folders confirm hands to AddSourcePanel.
  const next = new Map(prev);
  for (const root of next.keys()) {
    if (isUnder(root, path)) next.delete(root);
  }
  next.set(path, name);
  return next;
}
