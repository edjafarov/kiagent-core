/** @jest-environment node */

import { createMarketplaceCatalog } from '../catalog';
import type { ExtensionSnapshot } from '@shared/contracts';
import type { MarketplaceListItem, PluginDetail } from '@shared/ipc';

describe('marketplace catalog', () => {
  let snapshotItems: ExtensionSnapshot[];

  const baseSnapshot = (overrides: Partial<ExtensionSnapshot> & { id: string }): ExtensionSnapshot => ({
    name: overrides.id,
    version: '1.0.0',
    origin: 'marketplace',
    enabled: true,
    status: 'activated',
    caps: [],
    sourceIds: [],
    oauthSources: [],
    ...overrides,
  });

  let listOrgPlugins: jest.Mock;
  let getDetail: jest.Mock;
  let resolveGitHubRef: jest.Mock;
  let source: {
    listOrgPlugins: jest.Mock;
    getDetail: jest.Mock;
    resolveGitHubRef: jest.Mock;
    downloadAsset: jest.Mock;
  };

  beforeEach(() => {
    snapshotItems = [];
    listOrgPlugins = jest.fn();
    getDetail = jest.fn();
    resolveGitHubRef = jest.fn();
    source = { listOrgPlugins, getDetail, resolveGitHubRef, downloadAsset: jest.fn() };
  });

  function makeCatalog() {
    return createMarketplaceCatalog({
      source: source as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      snapshot: () => snapshotItems,
    });
  }

  const widgetListing: MarketplaceListItem = {
    owner: 'acme',
    repo: 'widget',
    fullName: 'acme/widget',
    displayName: 'widget',
    description: 'a widget',
  };

  describe('list', () => {
    it('sets installedId when a snapshot has a bare-ref match', async () => {
      snapshotItems = [baseSnapshot({ id: 'installed-bare', ref: 'github:acme/widget' })];
      listOrgPlugins.mockResolvedValueOnce([widgetListing]);

      const result = await makeCatalog().list();

      expect(result).toEqual([{ ...widgetListing, installedId: 'installed-bare' }]);
    });

    it('sets installedId when a snapshot has a pinned-ref match', async () => {
      snapshotItems = [baseSnapshot({ id: 'installed-pinned', ref: 'github:acme/widget@v1.0.0' })];
      listOrgPlugins.mockResolvedValueOnce([widgetListing]);

      const result = await makeCatalog().list();

      expect(result[0].installedId).toBe('installed-pinned');
    });

    it('leaves installedId undefined for a file: ref', async () => {
      snapshotItems = [baseSnapshot({ id: 'dev-plugin', ref: 'file:/local/path' })];
      listOrgPlugins.mockResolvedValueOnce([widgetListing]);

      const result = await makeCatalog().list();

      expect(result[0].installedId).toBeUndefined();
    });

    it('leaves installedId undefined for a different repo', async () => {
      snapshotItems = [baseSnapshot({ id: 'other-plugin', ref: 'github:other/repo@v1.0.0' })];
      listOrgPlugins.mockResolvedValueOnce([widgetListing]);

      const result = await makeCatalog().list();

      expect(result[0].installedId).toBeUndefined();
    });
  });

  describe('detail', () => {
    it('decorates the listing with installedId', async () => {
      snapshotItems = [baseSnapshot({ id: 'installed-detail', ref: 'github:acme/widget@v2.0.0' })];
      const detail: PluginDetail = {
        listing: widgetListing,
        readmeMarkdown: '# hi',
        latest: null,
      };
      getDetail.mockResolvedValueOnce(detail);

      const result = await makeCatalog().detail('acme', 'widget');

      expect(getDetail).toHaveBeenCalledWith('acme', 'widget');
      expect(result).toEqual({
        listing: { ...widgetListing, installedId: 'installed-detail' },
        readmeMarkdown: '# hi',
        latest: null,
      });
    });

    it('leaves installedId undefined when nothing installed matches', async () => {
      const detail: PluginDetail = {
        listing: widgetListing,
        readmeMarkdown: '',
        latest: null,
      };
      getDetail.mockResolvedValueOnce(detail);

      const result = await makeCatalog().detail('acme', 'widget');

      expect(result.listing.installedId).toBeUndefined();
    });
  });

  describe('checkUpdates', () => {
    it('passes installed snapshots through and resolves via the source with the stripped ref', async () => {
      snapshotItems = [
        baseSnapshot({ id: 'plugin-a', version: '1.0.0', ref: 'github:acme/widget@v1.0.0' }),
      ];
      resolveGitHubRef.mockResolvedValueOnce({
        tarballUrl: 'https://example.com/v2.0.0.tgz',
        version: '2.0.0',
        tag: 'v2.0.0',
      });

      const result = await makeCatalog().checkUpdates();

      expect(resolveGitHubRef).toHaveBeenCalledWith('github:acme/widget');
      expect(result).toEqual([
        {
          id: 'plugin-a',
          installedVersion: '1.0.0',
          latestVersion: '2.0.0',
          ref: 'github:acme/widget@v1.0.0',
        },
      ]);
    });

    it('reports nothing when the source resolves no newer release', async () => {
      snapshotItems = [
        baseSnapshot({ id: 'plugin-b', version: '2.0.0', ref: 'github:acme/widget@v2.0.0' }),
      ];
      resolveGitHubRef.mockResolvedValueOnce({
        tarballUrl: 'https://example.com/v2.0.0.tgz',
        version: '2.0.0',
        tag: 'v2.0.0',
      });

      const result = await makeCatalog().checkUpdates();

      expect(result).toEqual([]);
    });

    it('skips non-github refs without calling the source', async () => {
      snapshotItems = [baseSnapshot({ id: 'dev-plugin', version: '0.0.1', ref: 'file:/local' })];

      const result = await makeCatalog().checkUpdates();

      expect(resolveGitHubRef).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    });
  });
});
