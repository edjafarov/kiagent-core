import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/**
 * Minimal structural shape the lazy-tree machinery needs from a node. The
 * picker's FolderNode adds its own fields (path, counts, etc.); the hook
 * only ever touches these three plus whatever the caller's getKey reads.
 */
export interface LazyTreeShape<N> {
  loaded: boolean;
  expanded: boolean;
  children: N[];
}

/**
 * Replace the first node matching `match` (searched depth-first through
 * `children`) with `mutate(node)`, returning a new tree. Untouched branches
 * keep their identity so React can bail out of re-rendering them.
 */
export function mutateTree<N extends { children: N[] }>(
  nodes: N[],
  match: (n: N) => boolean,
  mutate: (n: N) => N,
): N[] {
  return nodes.map((n) => {
    if (match(n)) return mutate(n);
    if (n.children.length > 0)
      return { ...n, children: mutateTree(n.children, match, mutate) } as N;
    return n;
  });
}

export interface LazyTree<N> {
  tree: N[];
  setTree: Dispatch<SetStateAction<N[]>>;
  /** Node keys whose child-list IPC call is in flight — drives chevron spinners. */
  loadingNodes: Set<string>;
  markLoading: (id: string) => void;
  unmarkLoading: (id: string) => void;
  /** Apply `mutate` to the node whose key === `key`. */
  mutate: (key: string, mutate: (n: N) => N) => void;
  /** Lazy-load-on-first-expand, then plain expand/collapse toggling. */
  toggleExpand: (node: N) => Promise<void>;
}

/**
 * Owns the tree state + loading-set + expand machinery for the folder-tree
 * picker. Parameterised only by how to key a node (`getKey`) and how to
 * fetch its children (`loadChildren`). Root population (auto-expand vs
 * loadRoots) stays in the caller because it diverges per mode.
 */
export function useLazyTree<N extends LazyTreeShape<N>>(opts: {
  getKey: (n: N) => string;
  loadChildren: (n: N) => Promise<N[]>;
  initial?: N[] | (() => N[]);
}): LazyTree<N> {
  const { getKey, loadChildren } = opts;
  const [tree, setTree] = useState<N[]>(opts.initial ?? []);
  // Expansions can overlap, hence the functional Set updates.
  const [loadingNodes, setLoadingNodes] = useState<Set<string>>(
    () => new Set(),
  );
  const markLoading = useCallback((id: string): void => {
    setLoadingNodes((prev) => new Set(prev).add(id));
  }, []);
  const unmarkLoading = useCallback((id: string): void => {
    setLoadingNodes((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const mutate = useCallback(
    (key: string, fn: (n: N) => N): void => {
      setTree((prev) => mutateTree(prev, (n) => getKey(n) === key, fn));
    },
    [getKey],
  );

  const toggleExpand = useCallback(
    async (node: N): Promise<void> => {
      const key = getKey(node);
      if (!node.loaded) {
        markLoading(key);
        try {
          const kids = await loadChildren(node);
          setTree((prev) =>
            mutateTree(
              prev,
              (n) => getKey(n) === key,
              (n) =>
                ({ ...n, loaded: true, expanded: true, children: kids }) as N,
            ),
          );
        } catch {
          // IPC rejection: leave the node collapsed so a re-click retries; a
          // resolved empty-entries response instead lands as an empty
          // expansion (loaded, zero children — no retry).
        } finally {
          unmarkLoading(key);
        }
        return;
      }
      setTree((prev) =>
        mutateTree(
          prev,
          (n) => getKey(n) === key,
          (n) => ({ ...n, expanded: !n.expanded }) as N,
        ),
      );
    },
    [getKey, loadChildren, markLoading, unmarkLoading],
  );

  return {
    tree,
    setTree,
    loadingNodes,
    markLoading,
    unmarkLoading,
    mutate,
    toggleExpand,
  };
}
