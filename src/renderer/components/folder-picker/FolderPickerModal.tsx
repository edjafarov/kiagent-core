import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';
import { formatCount } from './format-count';
import {
  coveringRoots,
  isUnder,
  learnPath,
  toggleSelection,
} from './selection';
import type { SelectionMap } from './selection';
import { mutateTree, useLazyTree } from './useLazyTree';

/**
 * In-app folder-tree browser, ported from kiagent-ref's LocalFolderPicker
 * (src/renderer/components/LocalFolderPicker.tsx). Two selection modes:
 *
 * - Single-select (`multiSelect` unset): row click replaces the selection;
 *   `onConfirm` fires with exactly one folder id. Used by
 *   `FolderPickerField`, the generic per-field renderer for folder inputs
 *   inside multi-field schemas.
 * - Multi-select (`multiSelect`): row click toggles the folder in a
 *   selection set — and selecting a folder covers its WHOLE subtree:
 *   descendant rows render auto-checked (implied), previously-selected
 *   descendants are subsumed, and clicking an implied row is a no-op
 *   (exclusion lists are deliberately unsupported). The selection is thus
 *   always the MINIMAL covering set of top-most roots, so nested picks can
 *   never double-index the same files. Covering roots show as removable
 *   chips above the footer, with a running estimate of the total files
 *   covered. Confirming fires `onConfirm` once with the covering roots'
 *   IDS — never the tree paths.
 *
 * Selection is keyed by the SOURCE's durable folder id; ancestry is keyed by
 * the tree path. That split is the whole point: a manage-folders picker opens
 * pre-checked (`selected`) with roots whose rows may never be listed this
 * session, and one cloud folder listed under two mode tabs must select once.
 * The tree machinery itself (useLazyTree, counts, React keys) stays
 * path-keyed — `mutateTree` mutates EVERY matching node, so id-keying it
 * would make two rows sharing an id expand and count together.
 *
 * `selected` and `existingPaths` are independent and must not be confused:
 * `selected` roots are checked and REMOVABLE (this account's own scope);
 * `existingPaths` rows are covered by a DIFFERENT account, render a `tracked`
 * pill instead of a checkbox, and are inert to selection clicks. When a row
 * matches both, `selected` wins — see `isTracked`.
 *
 * A rejected listing renders an inline retry row, never an empty folder; and
 * a Save the owner rejects (`error`) leaves the modal mounted with the
 * selection intact (`keepOpenOnConfirm`) instead of tearing the flow down.
 */

export interface Entry {
  /** The source's DURABLE identity for this folder — what the selection is
   *  keyed by and what `onConfirm` emits. For the built-in local-filesystem
   *  tabs it IS `path`; for a dataSource picker it is the provider's opaque
   *  folder id, while `path` is the adapter's synthetic tree location. */
  id: string;
  /** Where the row sits in the tree. Addresses the tree backend
   *  (`listChildren`/`countFiles`) and carries ancestry for the covering-set
   *  rules; NOT an identity. */
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
 * renders an inline retry row (warned, never thrown past the modal) — it must
 * never masquerade as an empty folder, because an empty folder reads as "the
 * user has nothing here". A rejected countFiles renders as uncounted; one bad
 * count must not block selection.
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
  id: string;
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
    id: e.id,
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
  /** Paths already tracked by a DIFFERENT account (e.g. the local-folder
   *  machine account's current `config.paths`) — a row equal to or under any
   *  of these renders a `tracked` pill instead of a checkbox, is inert to
   *  selection clicks, and is excluded from chips/confirm/the files estimate.
   *  An ANCESTOR of a tracked path stays selectable normally.
   *
   *  This is the OPPOSITE of `selected`: tracked means "cannot be chosen",
   *  selected means "already chosen, and removable". The two are independent
   *  props, and when a row matches BOTH, `selected` wins — it is this
   *  account's own current scope (see `isTracked`). Only the selected row
   *  itself escapes; a descendant of it that is also tracked stays inert.
   *  Default `[]`. */
  existingPaths?: string[];
  /** Pre-checked and REMOVABLE roots — the account's complete current
   *  covering set, for a manage-folders picker. Only `id` and `name` are
   *  read: `path` is the caller's synthetic guess at a tree location for a
   *  folder that may sit anywhere under any mode tab, and trusting it would
   *  be a false ancestry claim, so an entry is seeded location-less and
   *  learns its real path from the listing. Keying by id is what lets a root
   *  whose row is never listed this session survive Save; path-keying dropped
   *  exactly those (the archival-by-omission hazard). Seeded ONCE on mount:
   *  every caller that needs a different set REMOUNTS the modal
   *  (`AddSourcePanel` already keys it on the picker requestId), so there is
   *  deliberately no prop-sync effect to fight the user's edits. Default
   *  `[]`. */
  selected?: Entry[];
  /** Copy and the empty-selection line only — never behavior. `'manage'` is
   *  the Tracked-folders edit; `'connect'`/omitted is the add flow. Ignored
   *  in single-select mode, which has no folder-set semantics. */
  purpose?: 'connect' | 'manage';
  /** A message from the OWNER about a Save it rejected — a folder that no
   *  longer exists, a stale scope, a failed commit. Rendered inline above the
   *  footer with the selection left exactly as the user built it (DECISIONS
   *  A-8: a validation failure must never tear the picker down). Null or
   *  omitted renders nothing. */
  error?: string | null;
  /** A confirm is in flight: the primary action is disabled and reads
   *  "Saving…". Purely presentational — the owner decides what Cancel or
   *  Escape mean while it is true. */
  saving?: boolean;
  /** Leave the modal mounted after `onConfirm` instead of calling `onClose`.
   *  The owner then owns the close: it unmounts on success, or keeps the
   *  picker up with `error` set. Deliberately its OWN prop rather than
   *  something derived from `purpose`, which the frozen contract fixes as
   *  copy-only. Default false — every historical caller closes on confirm. */
  keepOpenOnConfirm?: boolean;
  /** Serve the folder tree from these callbacks instead of the local
   *  filesystem IPC. Omitted = exactly the historical behavior. */
  dataSource?: FolderPickerDataSource;
  /** Folder IDS to open already-expanded, so the rows in `selected` are
   *  visible the moment the picker opens instead of collapsed behind a
   *  quick-link root. Matched against listing ids by EQUALITY — never
   *  decoded, never compared with `isUnder`. The ids are the SOURCE's
   *  (`FolderPickerSpec.expand`), because ancestry is the source's to know:
   *  a dataSource picker's ids are opaque here, so a source that cannot walk
   *  its own parent chain omits the list and the tree opens collapsed, which
   *  is the historical behavior. Applies to every mode tab, not just the
   *  first. Default `[]`. */
  expandIds?: string[];
  /** Fires with the selected folders' IDS — for a dataSource picker the
   *  source's opaque folder ids, for the local-filesystem tabs the absolute
   *  paths (there, id IS path). Never the synthetic tree paths. */
  onConfirm: (ids: string[]) => void;
  onClose: () => void;
}

export function FolderPickerModal({
  multiSelect = false,
  existingPaths = [],
  selected = [],
  purpose,
  error,
  saving = false,
  keepOpenOnConfirm = false,
  dataSource,
  expandIds = [],
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
  // Read through a ref for the same reason as `dataSource`: the default `[]`
  // (and any caller that builds the array inline) has a fresh identity every
  // render, and `loadRoots` must not be re-created — the initial-roots effect
  // keys off it.
  const expandRef = useRef(expandIds);
  expandRef.current = expandIds;
  // Single-select mode only. `id` is what onConfirm emits; `name`/`path`
  // drive the footer (a dataSource picker's paths are synthetic opaque-id
  // strings, so it shows the name instead).
  const [single, setSingle] = useState<{
    id: string;
    name: string;
    path: string;
  } | null>(null);
  // Multi-select: id -> { name, tree location }. Keyed by the SOURCE's id,
  // never by the synthetic path — see selection.ts's module doc.
  const [checked, setChecked] = useState<SelectionMap>(
    () => new Map(selected.map((s) => [s.id, { name: s.name, path: null }])),
  );
  // Node paths whose child listing REJECTED — the row renders an inline
  // retry instead of pretending the folder is empty. Keyed by path, like the
  // rest of the tree machinery; cleared for the whole tree on a root reload.
  const [failedNodes, setFailedNodes] = useState<Set<string>>(() => new Set());
  // The current mode's root listing rejected and nothing is on screen.
  const [rootsFailed, setRootsFailed] = useState(false);
  // Paths we've already kicked a file-count request for, so the count effect
  // fires exactly once per visible folder. Cleared when the root set is swapped.
  const counted = useRef<Set<string>>(new Set());
  // Resolved recursive counts by path, independent of the tree nodes they
  // were fetched for — the footer's selected-files estimate reads from here
  // so it survives mode switches (which rebuild the tree) and quick-link
  // roots that also appear as children elsewhere. Never cleared: a folder's
  // count doesn't change because the root list was reloaded.
  const countCache = useRef<Map<string, { count: number; capped: boolean }>>(
    new Map(),
  );
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
      try {
        const entries = ds
          ? await ds.listChildren(node.path)
          : (
              await window.kiagent.invoke('sources:list-folders', {
                path: node.path,
              })
            ).entries.map((e) => ({ ...e, id: e.path }));
        return entries.map((e) => toNode(e, node.depth + 1));
      } catch (err) {
        // A source-served listing may fail (network, revoked token…). It must
        // NOT masquerade as an empty folder: an empty folder reads as "the
        // user has nothing here". Record the failure so the row renders an
        // inline retry, then rethrow so useLazyTree leaves the node unloaded
        // and collapsed — a Retry re-runs exactly this call.
        // eslint-disable-next-line no-console
        console.warn('folder picker: listing children failed', err);
        setFailedNodes((prev) => new Set(prev).add(node.path));
        throw err;
      }
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
      setFailedNodes(new Set());
      setRootsFailed(false);
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
            ).entries.map((e) => ({ ...e, id: e.path }));
        // A newer load started while we were awaiting — let it win.
        if (gen !== loadGen.current) return;
        const roots = entries.map((e) => toNode(e, 0));
        // Open down to the preselected roots before the tree is ever
        // painted, so the picker never flashes collapsed and then jumps.
        // `expand` holds the ANCESTOR ids the source computed; a node that
        // is not one of them returns untouched WITHOUT a listing call, so
        // this costs one `listChildren` per ancestor, never a sweep. The
        // selected rows themselves are not in the list and stay collapsed.
        const expand = new Set(expandRef.current);
        const reveal = async (node: FolderNode): Promise<FolderNode> => {
          if (!expand.has(node.id)) return node;
          let kids: FolderNode[];
          try {
            kids = await loadChildren(node);
          } catch {
            // `loadChildren` already recorded the inline-retry row for this
            // node. One unreadable ancestor must not fail the whole open:
            // leave this branch collapsed and reveal the rest.
            return node;
          }
          return {
            ...node,
            loaded: true,
            expanded: true,
            children: await Promise.all(kids.map(reveal)),
          };
        };
        const revealed =
          expand.size > 0 ? await Promise.all(roots.map(reveal)) : roots;
        // The reveal walk awaited, so re-check: a mode switch may have
        // started while it ran, and its tree must not be clobbered.
        if (gen !== loadGen.current) return;
        setTree(revealed);
      } catch (err) {
        // A newer load started while we were failing — its result, or its own
        // error, owns the tree area.
        if (gen !== loadGen.current) return;
        if (dataSourceRef.current) {
          // eslint-disable-next-line no-console
          console.warn('folder picker: listing roots failed', err);
        }
        setRootsFailed(true);
      } finally {
        unmarkLoading(modeKey);
      }
    },
    [loadChildren, markLoading, unmarkLoading, setTree],
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

  // A preselected root arrives with no tree location — its row may never be
  // listed. The first time one DOES appear in a listing, record where it sits
  // so subsumption and implied-descendant rendering can see it. `learnPath`
  // returns the same map reference when there is nothing to learn, so the
  // vast majority of these calls are a setState bail-out.
  useEffect(() => {
    const walk = (nodes: FolderNode[]): void => {
      for (const n of nodes) {
        setChecked((prev) => learnPath(prev, n.id, n.name, n.path));
        if (n.children.length > 0) walk(n.children);
      }
    };
    walk(tree);
  }, [tree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function switchMode(next: string): void {
    setMode(next);
    setSingle(null);
    void loadRoots(next);
  }

  function toggleChecked(node: FolderNode): void {
    setChecked((prev) => toggleSelection(prev, node.id, node.name, node.path));
  }

  function removeChecked(id: string): void {
    setChecked((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  }

  /** True when this row is covered by an already-tracked root AND is not
   *  itself part of this account's selection. DECISIONS A-6: `selected` and
   *  `existingPaths` are independent, and when a row matches both, `selected`
   *  wins — an account's own current root must stay checked and removable,
   *  never render as somebody else's inert `tracked` pill. Keyed by id, so it
   *  holds from the first render, before any listing has given the entry a
   *  comparable path. */
  function isTracked(node: FolderNode): boolean {
    if (checked.has(node.id)) return false;
    return existingPaths.some((root) => isUnder(node.path, root));
  }

  function handleRowSelect(node: FolderNode): void {
    if (isTracked(node)) return; // tracked rows are inert to selection
    if (multiSelect) toggleChecked(node);
    else setSingle({ id: node.id, name: node.name, path: node.path });
  }

  /** Clear a node's recorded listing failure and re-run its expansion. The
   *  node is still `loaded:false` (useLazyTree's catch left it untouched), so
   *  toggleExpand issues the child listing again rather than just flipping a
   *  chevron. */
  function retryChildren(node: FolderNode): void {
    setFailedNodes((prev) => {
      const next = new Set(prev);
      next.delete(node.path);
      return next;
    });
    void toggleExpand(node);
  }

  function confirmSelect(): void {
    if (multiSelect) {
      if (checked.size === 0) return;
      // toggleSelection/learnPath keep the LOCATED entries an antichain, but
      // re-normalize defensively — an overlapping pair here would
      // double-index the same files. Entries whose row was never listed pass
      // through untouched: their ancestry is unknowable renderer-side, and
      // they came from the source's own covering set.
      const locatedPaths = [...checked.values()]
        .map((e) => e.path)
        .filter((p): p is string => p !== null);
      const keep = new Set(coveringRoots(locatedPaths));
      onConfirm(
        [...checked]
          .filter(([, e]) => e.path === null || keep.has(e.path))
          .map(([id]) => id),
      );
    } else {
      if (!single) return;
      onConfirm([single.id]);
    }
    // A-8: when the owner keeps the modal mounted it is because the save can
    // still be REJECTED, and the selection must survive to be corrected.
    if (!keepOpenOnConfirm) onClose();
  }

  const checkState = (node: FolderNode): CheckState => {
    if (!multiSelect) return node.id === single?.id ? 'explicit' : 'none';
    if (checked.has(node.id)) return 'explicit';
    for (const e of checked.values()) {
      if (e.path !== null && isUnder(node.path, e.path)) return 'implied';
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
    for (const e of checked.values()) {
      if (e.path === null) {
        // Never listed this session: there is no path to look a count up
        // under, and the count effect only walks RENDERED rows — so this must
        // settle as unavailable rather than sitting in `pending` forever and
        // pinning the footer on "counting…".
        unavailable += 1;
        continue;
      }
      const c = countCache.current.get(e.path);
      if (c) {
        countedRoots += 1;
        knownTotal += c.count;
        if (c.capped) anyCapped = true;
      } else if (uncountable.current.has(e.path)) unavailable += 1;
      else pending += 1;
    }
  }
  const filesEstimate =
    pending > 0 && knownTotal === 0
      ? 'counting…'
      : countedRoots === 0 && pending === 0
        ? null // every root settled countless — no estimate to show
        : formatCount(knownTotal, anyCapped || pending > 0 || unavailable > 0);

  // `purpose` is copy only. Single-select has no folder-SET semantics, so it
  // keeps its historical strings regardless.
  const manage = multiSelect && purpose === 'manage';
  const title = multiSelect
    ? manage
      ? 'Manage tracked folders'
      : 'Choose folders'
    : 'Choose a folder';
  const selectedCount = `${checked.size} ${checked.size === 1 ? 'folder' : 'folders'} selected`;
  const emptyLine = manage
    ? // DECISIONS R3: the modal never lets the user save an empty set; the
      // way out is removing the source, not emptying its folder list.
      'Keep at least one folder — remove this source to stop tracking it entirely.'
    : 'No folders selected';
  const footerSummary = multiSelect
    ? checked.size === 0
      ? emptyLine
      : filesEstimate === null
        ? selectedCount
        : `${selectedCount} · ${filesEstimate}`
    : single === null
      ? 'No folder selected'
      : dataSource
        ? single.name
        : single.path;
  const footerDisabled =
    saving || (multiSelect ? checked.size === 0 : single === null);
  const footerLabel = saving
    ? 'Saving…'
    : multiSelect
      ? manage
        ? 'Save folders'
        : `Add ${checked.size} ${checked.size === 1 ? 'folder' : 'folders'}`
      : 'Select folder';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fp-backdrop"
    >
      <div onClick={(e) => e.stopPropagation()} className="tray-pop fp-modal">
        <header className="fp-head">
          <h3 className="fp-title">{title}</h3>
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
          {rootsFailed && tree.length === 0 && (
            <div className="fp-row failed depth-0">
              <span className="t-meta">Couldn’t list folders.</span>
              <button
                type="button"
                className="btn ghost sm"
                onClick={() => void loadRoots(mode)}
              >
                Retry
              </button>
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
              failedNodes={failedNodes}
              onSelect={handleRowSelect}
              onRetry={retryChildren}
              onToggleExpand={toggleExpand}
            />
          ))}
        </div>

        {multiSelect && checked.size > 0 && (
          <div className="fp-chip-tray">
            {[...checked].map(([id, e]) => (
              <span
                key={id}
                className="fp-chip"
                // A dataSource picker's path is the adapter's synthetic
                // '/'-joined encoding of provider ids — never show it.
                title={dataSource ? e.name : (e.path ?? e.name)}
              >
                <span className="leaf">{e.name}</span>
                <button
                  type="button"
                  className="x"
                  aria-label={`remove ${e.name} from selection`}
                  onClick={() => removeChecked(id)}
                >
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {error != null && error !== '' && (
          <div className="fp-notice si-error" role="alert">
            {error}
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
  checkState: (node: FolderNode) => CheckState;
  isTracked: (node: FolderNode) => boolean;
  loadingNodes: Set<string>;
  failedNodes: Set<string>;
  onSelect: (node: FolderNode) => void;
  onRetry: (node: FolderNode) => void;
  onToggleExpand: (n: FolderNode) => Promise<void>;
}): React.ReactElement {
  const {
    node,
    multiSelect,
    checkState,
    isTracked,
    loadingNodes,
    failedNodes,
    onSelect,
    onRetry,
    onToggleExpand,
  } = props;
  const state = checkState(node);
  const tracked = isTracked(node);
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
          aria-label={
            node.expanded ? `collapse ${node.name}` : `expand ${node.name}`
          }
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
              <Icon
                name={node.expanded ? 'chev-down' : 'chev-right'}
                size={12}
              />
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
      {failedNodes.has(node.path) && !node.loaded && (
        <div className={`fp-row failed depth-${node.depth + 1}`}>
          <span className="t-meta">Couldn’t list this folder.</span>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => onRetry(node)}
          >
            Retry
          </button>
        </div>
      )}
      {node.expanded &&
        node.children.map((c) => (
          <TreeRow
            key={c.path}
            node={c}
            multiSelect={multiSelect}
            checkState={checkState}
            isTracked={isTracked}
            loadingNodes={loadingNodes}
            failedNodes={failedNodes}
            onSelect={onSelect}
            onRetry={onRetry}
            onToggleExpand={onToggleExpand}
          />
        ))}
    </>
  );
}
