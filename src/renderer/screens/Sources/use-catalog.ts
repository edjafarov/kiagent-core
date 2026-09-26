import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MarketplaceListItem } from '@shared/ipc';
import { useAppState } from '@renderer/state/app-state';
import { buildCatalog, type CatalogTile } from './catalog';
import { useSourceDescriptors, useSourcesPolicy } from './sources-registry';

export interface CatalogState {
  /** `null` while the source list loads. */
  sources: CatalogTile[] | null;
  /** `null` while the store loads; `[]` when it could not be reached. */
  store: CatalogTile[] | null;
  storeError: string | null;
  /** Every store listing, installed or not (the install sheet's copy). */
  items: readonly MarketplaceListItem[];
  retryStore: () => void;
}

/** The one catalog, loaded: sources now, the store when it answers. Reads
 *  the descriptor provider and its policy, so it lives under one. */
export function useCatalog(opts: { query?: string } = {}): CatalogState {
  const descriptors = useSourceDescriptors();
  const { hidden } = useSourcesPolicy();
  const extensions = useAppState((s) => s.extensions);
  const accountEntries = useAppState((s) => s.accounts);
  const [items, setItems] = useState<MarketplaceListItem[] | null>(null);
  const [storeError, setStoreError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loadStore = useCallback(() => {
    setStoreError(null);
    setItems(null);
    window.kiagent
      .invoke('marketplace:list', undefined)
      .then((list) => {
        if (alive.current) setItems(list);
      })
      .catch((e: unknown) => {
        if (!alive.current) return;
        setStoreError(e instanceof Error ? e.message : String(e));
        setItems([]);
      });
  }, []);
  useEffect(loadStore, [loadStore]);

  const catalog = useMemo(
    () =>
      descriptors === null
        ? null
        : buildCatalog({
            descriptors,
            items: items ?? [],
            extensions,
            accounts: accountEntries.map((e) => e.account),
            hidden,
            query: opts.query,
          }),
    [descriptors, items, extensions, accountEntries, hidden, opts.query],
  );

  return {
    sources: catalog?.sources ?? null,
    store: items === null ? null : (catalog?.store ?? null),
    storeError,
    items: items ?? [],
    retryStore: loadStore,
  };
}
