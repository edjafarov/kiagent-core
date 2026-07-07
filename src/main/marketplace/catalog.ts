import { formatGitHubRef } from './github-ref';
import { checkUpdates } from './update-check';
import type { createGitHubSource } from './github-source';
import type { ExtensionSnapshot } from '@shared/contracts';
import type { MarketplaceListItem, PluginDetail, UpdateInfo } from '@shared/ipc';

export function createMarketplaceCatalog(deps: {
  source: ReturnType<typeof createGitHubSource>;
  snapshot(): ExtensionSnapshot[];
}) {
  const installedIdFor = (owner: string, repo: string): string | undefined => {
    const bare = formatGitHubRef(owner, repo);
    return deps.snapshot().find((s) => s.ref === bare || s.ref?.startsWith(`${bare}@`))?.id;
  };
  return {
    async list(): Promise<MarketplaceListItem[]> {
      const items = await deps.source.listOrgPlugins();
      return items.map((i) => ({ ...i, installedId: installedIdFor(i.owner, i.repo) }));
    },
    async detail(owner: string, repo: string): Promise<PluginDetail> {
      const d = await deps.source.getDetail(owner, repo);
      return { ...d, listing: { ...d.listing, installedId: installedIdFor(owner, repo) } };
    },
    async checkUpdates(): Promise<UpdateInfo[]> {
      return checkUpdates({
        installed: deps.snapshot(),
        resolveLatest: (ref) => deps.source.resolveGitHubRef(ref),
      });
    },
  };
}
export type MarketplaceCatalog = ReturnType<typeof createMarketplaceCatalog>;
