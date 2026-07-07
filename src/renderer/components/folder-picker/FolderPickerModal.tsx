import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';
import { formatCount } from './format-count';
import { coveringRoots, isUnder, toggleSelection } from './selection';
import { mutateTree, useLazyTree } from './useLazyTree';

/**
 * In-app folder-tree browser, ported from kiagent-ref's LocalFolderPicker
 * (src/renderer/components/LocalFolderPicker.tsx). Two selection modes:
 *
 * - Single-select (`multiSelect` unset): row click replaces the selection;
 *   `onConfirm` fires with exactly one path. Used by `FolderPickerField`,
 *   the generic per-field renderer for folder inputs inside multi-field
 *   schemas.
 * - Multi-select (`multiSelect`): row click toggles the folder in a
 *   selection set — and selecting a folder covers its WHOLE subtree:
 *   descendant rows render auto-checked (implied), previously-selected
 *   descendants are subsumed, and clicking an implied row is a no-op
 *   (exclusion lists are deliberately unsupported). The selection is thus
 *   always the MINIMAL covering set of top-most roots, so nested picks can
 *   never double-index the same files. Covering roots show as removable
 *   chips above the footer, with a running estimate of the total files
 *   covered (sum of the roots' recursive counts). Confirming fires
 *   `onConfirm` once with the covering root paths — `AddSourcePanel`
 *   submits that whole array as ONE connect-flow prompt answer, unioned
 *   with whatever this machine already tracks, since greenfield's
 *   local-folder source tracks every root under one shared machine account
 *   (see `existingPaths` below).
 *
 * `existingPaths` (multi-select only in practice) marks rows already
 * covered by an existing account: they render a `tracked` pill instead of a
 * checkbox and are inert to selection clicks, so the picker can't offer to
 * re-add what's already tracked. An ancestor of a tracked row stays
 * selectable — see the prop doc for why that's safe.
 */

export interface Entry {
  path: string;
  name: string;
  hasChildren: boolean;
}

/**
 * Pluggable tree backend for the picker. When omitted the modal keeps its
 * historical local-filesystem behavior (quick-links/drives tabs over the
 * `sources:list-folders` / `sources:count-files` IPC); a connect flow's
 * `folder-picker` event supplies one backed by the flow's source instead
 * (see `connect-picker-adapter.ts`). A rejected listRoots/listChildren
 * renders as an empty listing (warned, never thrown); a rejected countFiles
 * as uncounted — one bad listing must not kill the connect flow.
 */
export interface FolderPickerDataSource {
  /** Tabs shown in the mode switcher, in order; at least one. */
  modes: Array<{ key: string; label: string }>;
  listRoots(modeKey: string): Promise<Entry[]>;
  listChildren(path: string): Promise<Entry[]>;
  countFiles(path: string): Promise<{ count: number; capped: boolean } | null>;
}

/** The historical built-in tabs, rendered when no dataSource is given. */
const LOCAL_FS_MODES: Array<{ key: RootMode; label: string }> = [
  { key: 'quick', label: 'Quick links' },
  { key: 'drives', label: 'Browse from drive root…' },
];

interface FolderNode {
  path: string;
  name: string;
  depth: number;
  loaded: boolean;
  expanded: boolean;
  hasChildren: boolean;
  children: FolderNode[];
  // Recursive count of indexable files under this folder, fetched lazily as
  // rows come into view. null = not counted yet; counting = request in
  // flight; capped = the scan hit its cap ("N+ files").
  fileCount: number | null;
  counting: boolean;
  capped: boolean;
}

function toNode(e: Entry, depth: number): FolderNode {
  return {
    path: e.path,
    name: e.name,
    depth,
    loaded: false,
    expanded: false,
    hasChildren: e.hasChildren,
    children: [],
    fileCount: null,
    counting: false,
    capped: false,
  };
}

function countLabel(node: FolderNode): string | null {
  if (node.counting) return 'counting…';
  if (node.fileCount == null) return null;
  return formatCount(node.fileCount, node.capped);
}

/** Multi-select row state: explicitly selected (a covering root, has a
 *  chip), or implied (some ancestor is selected — rendered checked but
 *  dimmed, click is a no-op). */
type CheckState = 'none' | 'explicit' | 'implied';

type RootMode = 'quick' | 'drives';

export interface FolderPickerModalProps {
  /** Default false — current single-select behavior, `onConfirm` with one path. */
  multiSelect?: boolean;
  /** Paths already tracked by an existing account (e.g. the local-folder
   *  machine account's current `config.paths`) — a row equal to or under any
   *  of these renders a `tracked` pill instead of a checkbox, is inert to
   *  selection clicks, and is excluded from chips/confirm/the files estimate
   *  (it can never enter `checked`). An ANCESTOR of a tracked path stays
   *  selectable normally — the caller's union+re-normalize against the
   *  existing paths is what makes re-covering an already-tracked descendant
   *  safe, not anything here. Default `[]`, matching every caller that
   *  doesn't yet track anything for this source. */
  existingPaths?: string[];
  /** Serve the folder tree from these callbacks instead of the local
   *  filesystem IPC. Omitted = exactly the historical behavior. */
  dataSource?: FolderPickerDataSource;
  onConfirm: (paths: string[]) => void;
  onClose: () => void;
}

export function FolderPickerModal({
  multiSelect = false,
  existingPaths = [],
  dataSource,
  onConfirm,
  onClose,
}: FolderPickerModalProps): React.ReactElement {
  const [mode, setMode] = useState<string>(
    () => dataSource?.modes[0]?.key ?? 'quick',
  );
  // Read through a ref by the load callbacks so a parent that re-creates the
  // dataSource object per render can't churn callback identities (which
  // would re-fire the initial-roots effect on every render).
  const dataSourceRef = useRef(dataSource);
  dataSourceRef.current = dataSource;
  const [selected, setSelected] = useState<string | null>(null);
  // Display name of the single-select row — a dataSource picker's paths are
  // synthetic opaque-id strings, so the footer shows this instead.
  const [selectedName, setSelectedName] = useState<string | null>(null);
  // Multi-select mode only: path -> display name, so the chip tray doesn't
  // need to re-derive a name from the path string.
  const [checked, setChecked] = useState<Map<string, string>>(new Map());
  // Paths we've already kicked a file-count request for, so the count effect
  // fires exactly once per visible folder. Cleared when the root set is swapped.
  const counted = useRef<Set<string>>(new Set());
  // Resolved recursive counts by path, independent of the tree nodes they
  // were fetched for — the footer's selected-files estimate reads from here
  // so it survives mode switches (which rebuild the tree) and quick-link
  // roots that also appear as children elsewhere. Never cleared: a folder's
  // count doesn't change because the root list was reloaded.
  const countCache = useRef<Map<string, { count: number; capped: boolean }>>(new Map());
  // Paths whose count request SETTLED without a number (spec has no count /
  // the folder is unreadable). Distinguishes "no estimate will ever come"
  // from "still counting" so the footer never claims counting… forever for
  // a source without counts.
  const uncountable = useRef<Set<string>>(new Set());
  // Generation counter for root loads: rapid mode toggling can leave two
  // loads in flight, and whichever resolved last used to win setTree even if
  // it belonged to the abandoned mode. Bumped at the start of every loadRoots;
  // a load only commits its result if no newer load has started since.
  const loadGen = useRef(0);

  const loadChildren = useCallback(
    async (node: FolderNode): Promise<FolderNode[]> => {
      const ds = dataSourceRef.current;
      if (ds) {
        try {
          const entries = await ds.listChildren(node.path);
          return entries.map((e) => toNode(e, node.depth + 1));
        } catch (err) {
          // A source-served listing may fail (network, revoked token…) —
          // show the node as empty rather than killing the picker/connect
          // flow.
          // eslint-disable-next-line no-console
          console.warn('folder picker: listing children failed', err);
          return [];
        }
      }
      const res = await window.kiagent.invoke('sources:list-folders', {
        path: node.path,
      });
      return res.entries.map((e) => toNode(e, node.depth + 1));
    },
    [],
  );

  const {
    tree,
    setTree,
    loadingNodes,
    markLoading,
    unmarkLoading,
    toggleExpand,
  } = useLazyTree<FolderNode>({
    getKey: (n) => n.path,
    loadChildren,
  });

  const loadRoots = useCallback(
    async (modeKey: string) => {
      loadGen.current += 1;
      const gen = loadGen.current;
      // Clear the old roots up front so the loading row (rather than a stale
      // tree) is what shows while the new root list is in flight.
      counted.current.clear();
      setTree([]);
      markLoading(modeKey);
      try {
        const ds = dataSourceRef.current;
        const entries = ds
          ? await ds.listRoots(modeKey)
          : (
              await window.kiagent.invoke('sources:list-folders', {
                special: modeKey as RootMode,
              })
            ).entries;
        // A newer load started while we were awaiting — let it win.
        if (gen !== loadGen.current) return;
        setTree(entries.map((e) => toNode(e, 0)));
      } catch (err) {
        // ignore — the user can retry via the mode buttons
        if (dataSourceRef.current) {
          // eslint-disable-next-line no-console
          console.warn('folder picker: listing roots failed', err);
        }
      } finally {
        unmarkLoading(modeKey);
      }
    },
    [markLoading, unmarkLoading, setTree],
  );

  // The first tab to populate — `mode`'s initial value; never re-fires on
  // mode switches (switchMode drives those loads itself).
  const initialModeRef = useRef(mode);
  useEffect(() => {
    void loadRoots(initialModeRef.current);
  }, [loadRoots]);

  // Lazily count indexable files under each visible folder. Runs whenever the
  // tree changes (initial load, expand, mode switch); the `counted` guard means
  // each folder is requested once. Counts run async in the main process, so the
  // tree stays responsive — rows show "counting…" then the number.
  const fetchCount = useCallback(
    async (p: string) => {
      setTree((prev) =>
        mutateTree(
          prev,
          (n) => n.path === p,
          (n) => ({ ...n, counting: true }),
        ),
      );
      const ds = dataSourceRef.current;
      const res = ds
        ? await ds.countFiles(p).catch(() => null)
        : await window.kiagent
            .invoke('sources:count-files', { path: p })
            .catch(() => null);
      if (res)
        countCache.current.set(p, { count: res.count, capped: res.capped });
      else uncountable.current.add(p);
      setTree((prev) =>
        mutateTree(
          prev,
          (n) => n.path === p,
          (n) => ({
            ...n,
            counting: false,
            fileCount: res ? res.count : null,
            capped: res ? res.capped : false,
          }),
        ),
      );
    },
    [setTree],
  );

  useEffect(() => {
    const walk = (nodes: FolderNode[]): void => {
      for (const n of nodes) {
        if (!counted.current.has(n.path)) {
          counted.current.add(n.path);
          void fetchCount(n.path);
        }
        if (n.children.length > 0) walk(n.children);
      }
    };
    walk(tree);
  }, [tree, fetchCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function switchMode(next: string): void {
    setMode(next);
    setSelected(null);
    setSelectedName(null);
    void loadRoots(next);
  }

  function toggleChecked(node: FolderNode): void {
    setChecked((prev) => toggleSelection(prev, node.path, node.name));
  }

  function removeChecked(path: string): void {
    setChecked((prev) => {
      const next = new Map(prev);
      next.delete(path);
      return next;
    });
  }

  /** True when `path` is covered by an already-tracked root — see the
   *  `existingPaths` prop doc for what that means for the row. */
  function isTracked(path: string): boolean {
    return existingPaths.some((root) => isUnder(path, root));
  }

  function handleRowSelect(node: FolderNode): void {
    if (isTracked(node.path)) return; // tracked rows are inert to selection
    if (multiSelect) toggleChecked(node);
    else {
      setSelected(node.path);
      setSelectedName(node.name);
    }
  }

  function confirmSelect(): void {
    if (multiSelect) {
      if (checked.size === 0) return;
      // toggleChecked keeps the map an antichain (no path is an ancestor of
      // another), but re-normalize defensively — an overlapping pair here
      // would double-index the same files as two accounts.
      onConfirm(coveringRoots([...checked.keys()]));
    } else {
      if (!selected) return;
      onConfirm([selected]);
    }
    onClose();
  }

  const checkState = (path: string): CheckState => {
    if (!multiSelect) return path === selected ? 'explicit' : 'none';
    if (checked.has(path)) return 'explicit';
    for (const root of checked.keys()) {
      if (isUnder(path, root)) return 'implied';
    }
    return 'none';
  };

  // Root-level list still in flight and nothing loaded yet — show one loading
  // row in the tree area so the modal isn't silent while the roots load.
  const initialLoading = loadingNodes.has(mode) && tree.length === 0;

  // Estimated files covered by the selection: sum of the covering roots'
  // recursive counts (countCache — the same numbers the rows show). Roots
  // whose count is still in flight make the total a floor, which is exactly
  // what formatCount's capped form ("N+ files") already expresses. Roots
  // that settled WITHOUT a count (uncountable — e.g. the source has no
  // count callback) contribute nothing; when every checked root is
  // uncountable there is no estimate at all rather than a perpetual
  // "counting…".
  let knownTotal = 0;
  let anyCapped = false;
  let countedRoots = 0;
  let pending = 0;
  let unavailable = 0;
  if (multiSelect) {
    for (const p of checked.keys()) {
      const c = countCache.current.get(p);
      if (c) {
        countedRoots += 1;
        knownTotal += c.count;
        if (c.capped) anyCapped = true;
      } else if (uncountable.current.has(p)) unavailable += 1;
      else pending += 1;
    }
  }
  const filesEstimate =
    pending > 0 && knownTotal === 0
      ? 'counting…'
      : countedRoots === 0 && pending === 0
        ? null // every root settled countless — no estimate to show
        : formatCount(knownTotal, anyCapped || pending > 0 || unavailable > 0);

  const selectedCount = `${checked.size} ${checked.size === 1 ? 'folder' : 'folders'} selected`;
  const footerSummary = multiSelect
    ? checked.size === 0
      ? 'No folders selected'
      : filesEstimate === null
        ? selectedCount
        : `${selectedCount} · ${filesEstimate}`
    : selected === null
      ? 'No folder selected'
      : dataSource
        ? (selectedName ?? selected)
        : selected;
  const footerDisabled = multiSelect ? checked.size === 0 : !selected;
  const footerLabel = multiSelect
    ? `Add ${checked.size} ${checked.size === 1 ? 'folder' : 'folders'}`
    : 'Select folder';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Choose a folder"
      onClick={onClose}
      className="fp-backdrop"
    >
      <div onClick={(e) => e.stopPropagation()} className="tray-pop fp-modal">
        <header className="fp-head">
          <h3 className="fp-title">Choose a folder</h3>
          <button
            type="button"
            className="btn ghost sm icon-only"
            aria-label="close"
            onClick={onClose}
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className="fp-modeswitch">
          {(dataSource?.modes ?? LOCAL_FS_MODES).map((m) => (
            <button
              key={m.key}
              type="button"
              className={`btn sm${mode === m.key ? ' primary' : ''}`}
              onClick={() => switchMode(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className="fp-tree">
          {initialLoading && (
            <div className="fp-row depth-0">
              <span className="busy">
                <span className="spinner" />
                Loading folders…
              </span>
            </div>
          )}
          {tree.map((root) => (
            <TreeRow
              key={root.path}
              node={root}
              multiSelect={multiSelect}
              checkState={checkState}
              isTracked={isTracked}
              loadingNodes={loadingNodes}
              onSelect={handleRowSelect}
              onToggleExpand={toggleExpand}
            />
          ))}
        </div>

        {multiSelect && checked.size > 0 && (
          <div className="fp-chip-tray">
            {[...checked.entries()].map(([path, name]) => (
              <span key={path} className="fp-chip" title={path}>
                <span className="leaf">{name}</span>
                <button
                  type="button"
                  className="x"
                  aria-label={`remove ${name} from selection`}
                  onClick={() => removeChecked(path)}
                >
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        <footer className="fp-footer">
          <span className="fp-summary t-meta">{footerSummary}</span>
          <button type="button" className="btn sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary sm"
            disabled={footerDisabled}
            onClick={confirmSelect}
          >
            {footerLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

function TreeRow(props: {
  node: FolderNode;
  multiSelect: boolean;
  checkState: (path: string) => CheckState;
  isTracked: (path: string) => boolean;
  loadingNodes: Set<string>;
  onSelect: (node: FolderNode) => void;
  onToggleExpand: (n: FolderNode) => Promise<void>;
}): React.ReactElement {
  const {
    node,
    multiSelect,
    checkState,
    isTracked,
    loadingNodes,
    onSelect,
    onToggleExpand,
  } = props;
  const state = checkState(node.path);
  const tracked = isTracked(node.path);
  const checked = state !== 'none';
  const isLoading = loadingNodes.has(node.path);
  const label = countLabel(node);
  return (
    <>
      <div
        className={`fp-row depth-${node.depth}${state === 'explicit' ? ' selected' : ''}${tracked ? ' tracked' : ''}`}
        title={
          tracked
            ? 'Already tracked by an existing account'
            : state === 'implied'
              ? 'Included via a selected parent folder'
              : undefined
        }
        onClick={() => onSelect(node)}
      >
        <button
          type="button"
          className="fp-chev"
          aria-label={node.expanded ? `collapse ${node.name}` : `expand ${node.name}`}
          disabled={!node.hasChildren}
          onClick={(e) => {
            e.stopPropagation();
            void onToggleExpand(node);
          }}
        >
          {isLoading ? (
            <span className="spinner" />
          ) : (
            node.hasChildren && (
              <Icon name={node.expanded ? 'chev-down' : 'chev-right'} size={12} />
            )
          )}
        </button>
        {multiSelect &&
          (tracked ? (
            <span className="fp-tracked-pill">tracked</span>
          ) : (
            <span
              className={`fp-cb${checked ? ' checked' : ''}${state === 'implied' ? ' implied' : ''}`}
              aria-hidden="true"
            >
              {checked && <Icon name="check" size={10} />}
            </span>
          ))}
        <Icon name="folder" size={13} />
        <span className="fp-name">{node.name}</span>
        {label && <span className="fp-count">{label}</span>}
      </div>
      {node.expanded &&
        node.children.map((c) => (
          <TreeRow
            key={c.path}
            node={c}
            multiSelect={multiSelect}
            checkState={checkState}
            isTracked={isTracked}
            loadingNodes={loadingNodes}
            onSelect={onSelect}
            onToggleExpand={onToggleExpand}
          />
        ))}
    </>
  );
}
