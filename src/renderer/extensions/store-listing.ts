import type { MarketplaceListItem } from '@shared/ipc';

// One store listing per session, shared by every catalog on screen. A
// failed fetch is forgotten so the next mount or retry asks again. A
// successful install, update or uninstall forgets it too (see
// use-extension-install) — that reaches the NEXT catalog mount; a catalog
// already open keeps its list until it remounts or retries.
let storeListing: Promise<MarketplaceListItem[]> | null = null;

export function fetchStoreListing(): Promise<MarketplaceListItem[]> {
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
export function invalidateStoreListing(): void {
  storeListing = null;
}
