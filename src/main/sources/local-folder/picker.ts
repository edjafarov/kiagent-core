/**
 * local-folder's `FolderPickerSpec` — a thin wrapper over `tree.ts`'s browsing
 * functions plus `scanner.ts`'s `countFiles`, so the local source reaches the
 * SHARED picker through the same contract as Drive/OneDrive instead of the
 * `auth.prompt({format:'folder-paths'})` fast path (spec-reality-diff A9).
 * Runs in the main process — local-folder is in-process, so these callbacks
 * are invoked directly by the connect broker, never over the extension RPC.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  FolderNode,
  FolderPickerSpec,
  FolderRootSelection,
} from '@shared/contracts';

import { countFiles } from './scanner';
import { hasSubdir, listChildren, listDrives, quickLinks } from './tree';

/** Byte-for-byte the tabs the shipped modal renders for the local filesystem
 *  (`FolderPickerModal.tsx:61-64`'s `LOCAL_FS_MODES`). */
export const LOCAL_FOLDER_PICKER_MODES: Array<{ key: string; label: string }> =
  [
    { key: 'quick', label: 'Quick links' },
    { key: 'drives', label: 'Browse from drive root…' },
  ];

function toNode(e: {
  path: string;
  name: string;
  hasChildren: boolean;
}): FolderNode {
  return { id: e.path, name: e.name, hasChildren: e.hasChildren };
}

/**
 * The account's current roots as picker nodes for `FolderPickerSpec.selected`.
 * `hasChildren` is PROBED, not assumed, so a selected root stays expandable;
 * an unreadable or since-deleted root probes `false` and is still returned —
 * removing a vanished root is the main reason to open Manage folders.
 */
export async function selectionNodes(
  roots: readonly FolderRootSelection[],
): Promise<FolderNode[]> {
  return Promise.all(
    roots.map(async (r) => ({
      id: r.id,
      name: r.name,
      hasChildren: await hasSubdir(r.id),
    })),
  );
}

export function folderPickerSpec(opts: {
  selected: FolderNode[];
  purpose: 'connect' | 'manage';
}): FolderPickerSpec {
  return {
    modes: LOCAL_FOLDER_PICKER_MODES,
    multiSelect: true,
    selected: opts.selected,
    purpose: opts.purpose,
    roots: async (modeKey) =>
      (modeKey === 'drives' ? await listDrives() : await quickLinks()).map(
        toNode,
      ),
    children: async (id) => (await listChildren(path.resolve(id))).map(toNode),
    // Mirrors `main.ts:404-413`'s `sources:count-files` guard: a non-directory
    // or an unreadable path is UNCOUNTED (null), never a zero count.
    count: async (id) => {
      const resolved = path.resolve(id);
      try {
        if (!(await fs.stat(resolved)).isDirectory()) return null;
      } catch {
        return null;
      }
      return countFiles(resolved);
    },
  };
}
