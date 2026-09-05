/**
 * Pure selection-set logic for the multi-select folder picker, extracted from
 * `FolderPickerModal` so the overlap/double-indexing invariants have unit
 * coverage independent of React/DOM. See `FolderPickerModal`'s module doc for
 * the user-facing behavior these functions implement.
 *
 * The map is keyed by the SOURCE's durable folder id, not by the tree path.
 * Two reasons, both load-bearing: a manage-folders picker opens with roots
 * chosen in a previous session whose rows may never be listed again (a path
 * key would silently drop them on Save, archiving their documents), and one
 * cloud folder reachable from two mode tabs gets two different synthetic
 * paths, neither a prefix of the other, so a path key selects it twice.
 *
 * Ancestry is still a PATH algorithm — `isUnder`/`coveringRoots` cannot run
 * over opaque ids — so every entry carries its tree location alongside its
 * display name. `path` is null for a preselected root whose row has not been
 * listed in this session; such an entry takes part in NO subsumption until
 * `learnPath` fills its location in. Two never-listed entries can therefore
 * overlap, which is undetectable renderer-side and acceptable: they came from
 * the source's own covering set, and the source re-normalizes what it gets
 * back.
 *
 * `isUnder`/`coveringRoots` themselves live in `src/shared/folder-paths.ts`
 * (the main-process local-folder source reuses them for multi-root
 * containment/normalization) — re-exported here so existing picker imports
 * keep working unchanged.
 */
import { coveringRoots, isUnder } from '@shared/folder-paths';

export { coveringRoots, isUnder };

/** One selected folder: its display name plus where it sits in the tree right
 *  now. `path` is null until the row is listed this session. */
export interface SelectedEntry {
  name: string;
  path: string | null;
}

/** id -> entry. The id is the source's own durable folder identity; for the
 *  built-in local-filesystem tabs it IS the absolute path. */
export type SelectionMap = Map<string, SelectedEntry>;

/** Toggle `id` in the covering-root selection map, preserving the antichain
 *  invariant over the entries whose location is known (no located path in the
 *  map is ever nested under another). */
export function toggleSelection(
  prev: SelectionMap,
  id: string,
  name: string,
  path: string,
): SelectionMap {
  if (prev.has(id)) {
    const next = new Map(prev);
    next.delete(id);
    return next;
  }
  // Already covered by a selected ancestor: the subtree is fully included,
  // and carving out descendants (exclusion lists) is deliberately
  // unsupported — no-op.
  for (const e of prev.values()) {
    if (e.path !== null && isUnder(path, e.path)) return prev;
  }
  // Selecting a folder covers its whole subtree: drop any previously selected
  // descendants so the map stays the MINIMAL covering set.
  const next = new Map(prev);
  for (const [k, e] of next) {
    if (e.path !== null && isUnder(e.path, path)) next.delete(k);
  }
  next.set(id, { name, path });
  return next;
}

/** Attach a tree location to an already-selected id the first time its row is
 *  listed, and apply the antichain rules now that its ancestry is knowable: a
 *  preselected root that turns out to sit under another selected root is
 *  dropped, and selected descendants of it are subsumed. The listing's `name`
 *  replaces the stored one — a provider label read this session is fresher
 *  than the one persisted in `folderRoots`. Returns the SAME map reference
 *  when the id is unselected or already located, so the caller's `setState`
 *  bails out instead of re-rendering. */
export function learnPath(
  prev: SelectionMap,
  id: string,
  name: string,
  path: string,
): SelectionMap {
  const entry = prev.get(id);
  if (!entry || entry.path !== null) return prev;
  for (const [k, e] of prev) {
    if (k !== id && e.path !== null && isUnder(path, e.path)) {
      const dropped = new Map(prev);
      dropped.delete(id);
      return dropped;
    }
  }
  const next = new Map(prev);
  for (const [k, e] of next) {
    if (k !== id && e.path !== null && isUnder(e.path, path)) next.delete(k);
  }
  next.set(id, { name, path });
  return next;
}
