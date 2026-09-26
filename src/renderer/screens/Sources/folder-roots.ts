import type { Account, FolderRootSelection } from '@shared/contracts';

/**
 * The canonical folder scope of ANY folder-scoped source — `config.folderRoots`
 * (`FolderRootSelection[]`), written by the v3 migration and by every
 * `applyFolderScope` commit. Replaces the old `trackedFolderPaths`, which read
 * the local-folder-only `config.paths`. Legacy mirrors (`paths` for
 * local-folder, `roots` for the cloud connectors) are deliberately NOT read
 * here: core owns them (A-2) and they exist for one release train so an
 * un-updated installed connector keeps working (R1). The renderer must never
 * make them load-bearing.
 *
 * `name` is display-only; a root is identified by `id` alone. An entry whose
 * `id` is missing or empty is dropped rather than rendered as a nameless row a
 * user could Remove; a missing `name` falls back to the id so a partially
 * migrated config still renders something addressable.
 */
export function folderRoots(account: Account): FolderRootSelection[] {
  const raw = account.config?.folderRoots;
  if (!Array.isArray(raw)) return [];
  const out: FolderRootSelection[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || id === '') continue;
    out.push({
      id,
      name: typeof name === 'string' && name !== '' ? name : id,
    });
  }
  return out;
}
