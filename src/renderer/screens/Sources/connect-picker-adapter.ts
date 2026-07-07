import type { FolderNode } from '@shared/contracts';
import type { RendererApi } from '@shared/ipc';
import type {
  Entry,
  FolderPickerDataSource,
} from '@renderer/components/folder-picker/FolderPickerModal';

/**
 * Bridges a connect flow's `folder-picker` event to `FolderPickerModal`'s
 * dataSource: tree reads go over the `accounts:picker-*` invokes, keyed by
 * the event's requestId.
 *
 * The modal's selection logic ('/'-separated prefix covering, chips) is pure
 * over Entry.path, so the adapter SYNTHESIZES paths from the source's opaque
 * node ids — `'/' + seg(id)` at the roots, `parentPath + '/' + seg(id)`
 * below — and keeps a path → FolderNode map to translate back. The contract
 * bans '/' in ids but NOT '\', and `isUnder` treats '\' as a separator too
 * (sibling ids `report` / `report\2024` would falsely cover each other), so
 * `seg()` percent-encodes ids into a '/'-and-'\'-free alphabet. The encoding
 * is injective; it is never decoded — confirmed paths map back to the
 * ORIGINAL FolderNode objects through `byPath`.
 */
export interface ConnectPickerAdapter {
  dataSource: FolderPickerDataSource;
  /** Map confirmed picker paths back to their FolderNodes and resolve the
   *  flow's pending pickFolders. */
  confirm(paths: string[]): Promise<void>;
  /** Reject the flow's pending pickFolders (the user dismissed the modal). */
  cancel(): Promise<void>;
}

/** Injective path-segment encoding: '%' → '%25' first, then '\' → '%5C'.
 *  Two distinct ids can never yield the same segment (classic
 *  percent-escaping — the escape char is escaped first), and a segment can
 *  never contain '/' (contract) or '\' (encoded away), so the picker's
 *  separator-based covering logic cannot false-match across siblings. */
function seg(id: string): string {
  return id.replace(/%/g, '%25').replace(/\\/g, '%5C');
}

export function createConnectPickerAdapter(
  picker: { requestId: string; modes: Array<{ key: string; label: string }> },
  invoke: RendererApi['invoke'] = (channel, payload) =>
    window.kiagent.invoke(channel, payload),
): ConnectPickerAdapter {
  const { requestId } = picker;
  const byPath = new Map<string, FolderNode>();

  const toEntries = (
    parentPath: string | null,
    nodes: FolderNode[],
  ): Entry[] => {
    const out: Entry[] = [];
    // Paths emitted by THIS listing — two siblings sharing an id would
    // collide to one path (duplicate React keys, last-wins in byPath).
    const emitted = new Set<string>();
    for (const node of nodes) {
      if (node.id === '') {
        // An empty id would synthesize a path ('/', or the parent itself
        // plus a trailing slash) that covers every sibling subtree.
        // eslint-disable-next-line no-console
        console.warn('folder picker: skipping node with empty id', node.name);
        continue;
      }
      const path =
        parentPath === null
          ? `/${seg(node.id)}`
          : `${parentPath}/${seg(node.id)}`;
      if (emitted.has(path)) {
        // eslint-disable-next-line no-console
        console.warn('folder picker: skipping duplicate sibling id', node.id);
        continue;
      }
      emitted.add(path);
      byPath.set(path, node);
      out.push({ path, name: node.name, hasChildren: node.hasChildren });
    }
    return out;
  };

  return {
    dataSource: {
      modes: picker.modes,
      async listRoots(modeKey) {
        const nodes = await invoke('accounts:picker-roots', {
          requestId,
          mode: modeKey,
        });
        return toEntries(null, nodes);
      },
      async listChildren(path) {
        const node = byPath.get(path);
        if (!node) throw new Error(`unknown picker path: ${path}`);
        const nodes = await invoke('accounts:picker-children', {
          requestId,
          id: node.id,
        });
        return toEntries(path, nodes);
      },
      async countFiles(path) {
        const node = byPath.get(path);
        if (!node) return null;
        return invoke('accounts:picker-count', { requestId, id: node.id });
      },
    },

    async confirm(paths) {
      const nodes = paths
        .map((p) => byPath.get(p))
        .filter((n): n is FolderNode => n !== undefined);
      await invoke('accounts:picker-confirm', { requestId, nodes });
    },

    async cancel() {
      await invoke('accounts:picker-cancel', { requestId });
    },
  };
}
