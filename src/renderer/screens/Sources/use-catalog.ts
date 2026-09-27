import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MarketplaceListItem } from '@shared/ipc';
import { useAppState } from '@renderer/state/app-state';
import { buildCatalog, type CatalogTile } from './catalog';
import { useSourceDescriptors } from './sources-registry';

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

// One store listing per session, shared by every catalog on screen. A
// failed fetch is forgotten so the next mount or retry asks again; an
// install or uninstall forgets it too (invalidateCatalog).
let storeListing: Promise<MarketplaceListItem[]> | null = null;

function fetchStore(): Promise<MarketplaceListItem[]> {
  if (!storeListing) {
    const listing = window.kiagent.invoke('marketplace:list', undefined);
    storeListing = listing;
    listing.catch(() => {
      if (storeListing === listing) storeListing = null;
    });
  }
  return storeListing;
}

/** Drops the shared store listing; the next catalog mount fetches it again. */
export function invalidateCatalog(): void {
  storeListing = null;
}

/** The one catalog, loaded: sources now, the store when it answers. The
 *  provider's descriptors already leave out the policy's hidden sources. */
export function useCatalog(opts: { query?: string } = {}): CatalogState {
  const descriptors = useSourceDescriptors();
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
    fetchStore()
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
            query: opts.query,
          }),
    [descriptors, items, extensions, accountEntries, opts.query],
  );

  return {
    sources: catalog?.sources ?? null,
    store: items === null ? null : (catalog?.store ?? null),
    storeError,
    items: items ?? [],
    retryStore: loadStore,
  };
}
