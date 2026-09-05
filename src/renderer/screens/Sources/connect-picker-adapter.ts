import type { FolderNode } from '@shared/contracts';
import type { RendererApi } from '@shared/ipc';
import type {
  Entry,
  FolderPickerDataSource,
} from '@renderer/components/folder-picker/FolderPickerModal';

/**
 * Bridges a connect / manage-folders flow's `folder-picker` event to
 * `FolderPickerModal`'s dataSource: tree reads go over the
 * `accounts:picker-*` invokes, keyed by the event's requestId.
 *
 * SELECTION IDENTITY IS `FolderNode.id`. The synthetic path is ephemeral
 * ancestry — it exists only so the modal's separator-based covering
 * (`isUnder`) and implied-child rendering have something to work on, and it
 * is never decoded. `byId` is seeded from the event's `selected` array at
 * construction, so a root that opens PRE-CHECKED and is never expanded still
 * resolves on confirm; resolving through the path map alone dropped it
 * silently, and the transactional scope write then archived that root's
 * documents.
 *
 * `byPath` is MANY-TO-ONE: a node seeded as a preselected root sits at
 * `'/' + seg(id)`, and the same node listed later as somebody's child sits at
 * `parentPath + '/' + seg(id)`. That is harmless — byPath only ever
 * translates a path back to a node id for a tree read — but it is why the
 * modal must key its selection state by `Entry.id` and call `confirm(ids)`,
 * never by `Entry.path`.
 *
 * Paths are still synthesized for the modal — `'/' + seg(id)` at the roots,
 * `parentPath + '/' + seg(id)` below. `isUnder` treats BOTH '/' and '\' as
 * separators and ids are fully opaque (a local-folder id is an absolute
 * path), so `seg()` percent-encodes '%', '\' and '/' away and every segment
 * is separator-free.
 */
export interface ConnectPickerAdapter {
  dataSource: FolderPickerDataSource;
  /** The event's pre-checked covering set as modal rows, in event order,
   *  with the same synthesized root-level paths the tree would give them.
   *  This is the `Entry[]` the modal's `selected` prop takes: the wire
   *  carries `FolderNode[]`, and the conversion happens exactly here — this
   *  is the only FolderNode → Entry conversion point there is. */
  selected: Array<Entry & { id: string }>;
  /** The event's `expand` list, passed through UNTOUCHED to the modal's
   *  `expandIds`. Deliberately not mapped into synthetic paths: the modal
   *  matches these against listing `Entry.id`s by equality, and `seg()`ing
   *  them would break exactly that. `[]` when the source omitted it, which
   *  is every source whose ids carry no parent chain. */
  expandIds: string[];
  /** Resolve confirmed `FolderNode.id`s back to their FolderNodes and
   *  resolve the flow's pending pickFolders. */
  confirm(ids: string[]): Promise<void>;
  /** Reject the flow's pending pickFolders (the user dismissed the modal). */
  cancel(): Promise<void>;
}

/** The renderer-side shape of a `folder-picker` ConnectEvent. `multiSelect`
 *  and `purpose` are declared here although the adapter never reads them:
 *  the caller keeps ONE object per open picker and passes it to both this
 *  factory and the modal. `selected` is `contracts.FolderNode`, straight off
 *  the wire — converting it is this module's job, not the caller's. */
export interface PickerRequest {
  requestId: string;
  modes: Array<{ key: string; label: string }>;
  multiSelect?: boolean;
  purpose?: 'connect' | 'manage';
  selected?: FolderNode[];
  expand?: string[];
}

/** Injective path-segment encoding: '%' → '%25' first, then '\' → '%5C' and
 *  '/' → '%2F'. Two distinct ids can never yield the same segment (classic
 *  percent-escaping — the escape char is escaped first), and a segment can
 *  never contain '/' or '\', so the picker's separator-based covering logic
 *  cannot false-match across siblings. Encoding '/' is what makes
 *  absolute-path ids safe: local-folder roots '/Users/ed' and
 *  '/Users/ed/docs' are two independent rows, not an ancestor pair —
 *  unencoded, `isUnder` reads the second as a descendant of the first and
 *  `coveringRoots` silently drops it. */
function seg(id: string): string {
  return id.replace(/%/g, '%25').replace(/\\/g, '%5C').replace(/\//g, '%2F');
}

export function createConnectPickerAdapter(
  picker: PickerRequest,
  invoke: RendererApi['invoke'] = (channel, payload) =>
    window.kiagent.invoke(channel, payload),
): ConnectPickerAdapter {
  const { requestId } = picker;
  // Ancestry map: synthetic path → node. Used ONLY by the path-addressed
  // dataSource reads (listChildren / countFiles), never by confirm.
  const byPath = new Map<string, FolderNode>();
  // Identity map: FolderNode.id → node. Seeded below from `selected` so a
  // never-listed preselected root still resolves; a listing OVERWRITES the
  // seeded entry, because the freshly listed node carries the current
  // name/hasChildren.
  const byId = new Map<string, FolderNode>();

  const toEntries = (
    parentPath: string | null,
    nodes: FolderNode[],
  ): Array<Entry & { id: string }> => {
    const out: Array<Entry & { id: string }> = [];
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
      byId.set(node.id, node);
      out.push({
        id: node.id,
        path,
        name: node.name,
        hasChildren: node.hasChildren,
      });
    }
    return out;
  };

  // Seeding goes through toEntries, not a bare byId.set loop: the preselected
  // rows need real root-level paths in byPath too, or expanding a pre-checked
  // row that was never listed throws `unknown picker path`. It also inherits
  // the empty-id and duplicate-id guards for free.
  const selected = toEntries(null, picker.selected ?? []);

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

    selected,

    expandIds: picker.expand ?? [],

    async confirm(ids) {
      const nodes: FolderNode[] = [];
      for (const id of ids) {
        const node = byId.get(id);
        if (!node) {
          // NEVER drop silently: an unresolved id shrinks the covering set
          // the source is about to persist, and core's scope write archives
          // whatever the new set no longer covers.
          // eslint-disable-next-line no-console
          console.warn('folder picker: unknown confirmed node id', id);
          continue;
        }
        nodes.push(node);
      }
      await invoke('accounts:picker-confirm', { requestId, nodes });
    },

    async cancel() {
      await invoke('accounts:picker-cancel', { requestId });
    },
  };
}
