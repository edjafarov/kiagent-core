/** @jest-environment node */

import {
  createGitHubSource,
  MARKETPLACE_ORG,
  PLUGIN_TOPIC,
} from '../github-source';

describe('github-source', () => {
  let mockCache: {
    getJSON: jest.Mock;
    getText: jest.Mock;
    getDataUrl: jest.Mock;
  };

  beforeEach(() => {
    mockCache = {
      getJSON: jest.fn(),
      getText: jest.fn(),
      // Default: no icon.png in the repo — listings fall back to no icon.
      getDataUrl: jest.fn().mockRejectedValue(new Error('GitHub 404')),
    };
  });

  describe('listOrgPlugins', () => {
    it('should hit the exact search URL and map items', async () => {
      const mockRepos = {
        items: [
          {
            owner: { login: 'alice' },
            name: 'plugin-one',
            full_name: 'alice/plugin-one',
            description: 'A plugin',
            topics: ['kia-plugin'],
          },
          {
            owner: { login: 'bob' },
            name: 'plugin-two',
            full_name: 'bob/plugin-two',
            description: null,
            topics: [],
          },
        ],
      };
      mockCache.getJSON.mockResolvedValueOnce(mockRepos);

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.listOrgPlugins();

      expect(mockCache.getJSON).toHaveBeenCalledWith(
        `https://api.github.com/search/repositories?q=org:${MARKETPLACE_ORG}+topic:${PLUGIN_TOPIC}&per_page=100`,
      );
      expect(result).toEqual([
        {
          owner: 'alice',
          repo: 'plugin-one',
          fullName: 'alice/plugin-one',
          displayName: 'plugin-one',
          description: 'A plugin',
        },
        {
          owner: 'bob',
          repo: 'plugin-two',
          fullName: 'bob/plugin-two',
          displayName: 'plugin-two',
          description: '',
        },
      ]);
    });

    it('should fetch each repo root icon.png as a data URI, absent on failure', async () => {
      const mockRepos = {
        items: [
          {
            owner: { login: 'alice' },
            name: 'plugin-one',
            full_name: 'alice/plugin-one',
            description: 'A plugin',
            topics: ['kia-plugin'],
          },
          {
            owner: { login: 'bob' },
            name: 'plugin-two',
            full_name: 'bob/plugin-two',
            description: null,
            topics: [],
          },
        ],
      };
      mockCache.getJSON.mockResolvedValueOnce(mockRepos);
      mockCache.getDataUrl
        .mockResolvedValueOnce('data:image/png;base64,AAAA')
        .mockRejectedValueOnce(new Error('GitHub 404'));

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.listOrgPlugins();

      expect(mockCache.getDataUrl).toHaveBeenCalledWith(
        'https://raw.githubusercontent.com/alice/plugin-one/HEAD/icon.png',
        'image/png',
        expect.any(Number),
      );
      expect(result[0].iconDataUrl).toBe('data:image/png;base64,AAAA');
      expect(result[1].iconDataUrl).toBeUndefined();
    });

    it('should handle custom org and topic', async () => {
      mockCache.getJSON.mockResolvedValueOnce({ items: [] });

      const source = createGitHubSource({
        cache: mockCache as any,
        org: 'custom-org',
        topic: 'custom-topic',
      });
      await source.listOrgPlugins();

      expect(mockCache.getJSON).toHaveBeenCalledWith(
        'https://api.github.com/search/repositories?q=org:custom-org+topic:custom-topic&per_page=100',
      );
    });
  });

  describe('getDetail', () => {
    it('should return README and latest (skipping prereleases)', async () => {
      const repoMeta = {
        name: 'plugin-x',
        owner: { login: 'owner' },
        full_name: 'owner/plugin-x',
        description: 'A great plugin',
        topics: ['kia-plugin'],
      };
      const releases = [
        {
          tag_name: 'v3.0.0-beta',
          name: 'v3.0.0-beta',
          published_at: '2024-03-01T00:00:00Z',
          body: 'Beta notes',
          prerelease: true,
          assets: [
            {
              name: 'plugin-x-3.0.0-beta.tgz',
              browser_download_url: 'https://example.com/v3.0.0-beta.tgz',
            },
          ],
        },
        {
          tag_name: 'v2.0.0',
          name: 'v2.0.0',
          published_at: '2024-02-01T00:00:00Z',
          body: 'Release notes',
          prerelease: false,
          assets: [
            {
              name: 'plugin-x-2.0.0.tgz',
              browser_download_url: 'https://example.com/v2.0.0.tgz',
            },
          ],
        },
        {
          tag_name: 'v1.0.0',
          name: 'v1.0.0',
          published_at: '2024-01-01T00:00:00Z',
          body: 'Initial release',
          prerelease: false,
          assets: [
            {
              name: 'plugin-x-1.0.0.tgz',
              browser_download_url: 'https://example.com/v1.0.0.tgz',
            },
          ],
        },
      ];

      mockCache.getJSON
        .mockResolvedValueOnce(repoMeta) // getDetail -> repoMeta
        .mockResolvedValueOnce(releases); // listReleases
      mockCache.getText.mockResolvedValueOnce('# Plugin X\n\nAwesome plugin');
      mockCache.getDataUrl.mockResolvedValueOnce('data:image/png;base64,BBBB');

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.getDetail('owner', 'plugin-x');

      expect(result.listing).toEqual({
        owner: 'owner',
        repo: 'plugin-x',
        fullName: 'owner/plugin-x',
        displayName: 'plugin-x',
        description: 'A great plugin',
        iconDataUrl: 'data:image/png;base64,BBBB',
      });
      expect(result.readmeMarkdown).toBe('# Plugin X\n\nAwesome plugin');
      expect(result.latest).toEqual({
        tag: 'v2.0.0',
        version: '2.0.0',
        publishedAt: '2024-02-01T00:00:00Z',
        tarballUrl: 'https://example.com/v2.0.0.tgz',
        prerelease: false,
      });
    });

    it('should return latest: null when only prereleases exist', async () => {
      const repoMeta = {
        name: 'plugin-beta',
        owner: { login: 'owner' },
        full_name: 'owner/plugin-beta',
        description: 'Beta plugin',
      };
      const releases = [
        {
          tag_name: 'v2.0.0-beta',
          name: 'v2.0.0-beta',
          published_at: '2024-02-01T00:00:00Z',
          body: null,
          prerelease: true,
          assets: [
            {
              name: 'plugin-beta-2.0.0-beta.tgz',
              browser_download_url: 'https://example.com/v2.0.0-beta.tgz',
            },
          ],
        },
        {
          tag_name: 'v1.0.0-alpha',
          name: 'v1.0.0-alpha',
          published_at: '2024-01-01T00:00:00Z',
          body: null,
          prerelease: true,
          assets: [
            {
              name: 'plugin-beta-1.0.0-alpha.tgz',
              browser_download_url: 'https://example.com/v1.0.0-alpha.tgz',
            },
          ],
        },
      ];

      mockCache.getJSON
        .mockResolvedValueOnce(repoMeta)
        .mockResolvedValueOnce(releases);
      mockCache.getText.mockResolvedValueOnce('Beta only');

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.getDetail('owner', 'plugin-beta');

      expect(result.latest).toBeNull();
    });

    it('should return latest.tarballUrl: null when no .tgz asset', async () => {
      const repoMeta = {
        name: 'plugin-noasset',
        owner: { login: 'owner' },
        full_name: 'owner/plugin-noasset',
        description: 'No asset plugin',
      };
      const releases = [
        {
          tag_name: 'v1.0.0',
          name: 'v1.0.0',
          published_at: '2024-01-01T00:00:00Z',
          body: null,
          prerelease: false,
          assets: [
            {
              name: 'plugin-noasset-1.0.0.zip',
              browser_download_url: 'https://example.com/v1.0.0.zip',
            },
          ],
        },
      ];

      mockCache.getJSON
        .mockResolvedValueOnce(repoMeta)
        .mockResolvedValueOnce(releases);
      mockCache.getText.mockResolvedValueOnce('');

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.getDetail('owner', 'plugin-noasset');

      expect(result.latest).toEqual({
        tag: 'v1.0.0',
        version: '1.0.0',
        publishedAt: '2024-01-01T00:00:00Z',
        tarballUrl: null,
        prerelease: false,
      });
    });

    it('should return empty README when fetch fails', async () => {
      const repoMeta = {
        name: 'plugin-noreadme',
        owner: { login: 'owner' },
        full_name: 'owner/plugin-noreadme',
        description: 'No readme plugin',
      };
      const releases = [
        {
          tag_name: 'v1.0.0',
          name: 'v1.0.0',
          published_at: '2024-01-01T00:00:00Z',
          body: null,
          prerelease: false,
          assets: [
            {
              name: 'plugin.tgz',
              browser_download_url: 'https://example.com/v1.0.0.tgz',
            },
          ],
        },
      ];

      mockCache.getJSON
        .mockResolvedValueOnce(repoMeta)
        .mockResolvedValueOnce(releases);
      mockCache.getText.mockRejectedValueOnce(new Error('404'));

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.getDetail('owner', 'plugin-noreadme');

      expect(result.readmeMarkdown).toBe('');
    });
  });

  describe('resolveGitHubRef', () => {
    it('should pick pinned tag when @tag is specified', async () => {
      const releases = [
        {
          tag_name: 'v2.0.0',
          name: 'v2.0.0',
          published_at: '2024-02-01T00:00:00Z',
          body: null,
          prerelease: false,
          assets: [
            {
              name: 'plugin.tgz',
              browser_download_url: 'https://example.com/v2.0.0.tgz',
            },
          ],
        },
        {
          tag_name: 'v1.0.0',
          name: 'v1.0.0',
          published_at: '2024-01-01T00:00:00Z',
          body: null,
          prerelease: false,
          assets: [
            {
              name: 'plugin.tgz',
              browser_download_url: 'https://example.com/v1.0.0.tgz',
            },
          ],
        },
      ];

      mockCache.getJSON.mockResolvedValueOnce(releases);

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.resolveGitHubRef('github:owner/repo@v1.0.0');

      expect(result).toEqual({
        tarballUrl: 'https://example.com/v1.0.0.tgz',
        version: '1.0.0',
        tag: 'v1.0.0',
      });
    });

    it('should resolve pinned prerelease tag even though unpinned would skip it', async () => {
      const releases = [
        {
          tag_name: 'v3.0.0-beta',
          name: 'v3.0.0-beta',
          published_at: '2024-03-01T00:00:00Z',
          body: null,
          prerelease: true,
          assets: [
            {
              name: 'plugin.tgz',
              browser_download_url: 'https://example.com/v3.0.0-beta.tgz',
            },
          ],
        },
        {
          tag_name: 'v2.0.0',
          name: 'v2.0.0',
          published_at: '2024-02-01T00:00:00Z',
          body: null,
          prerelease: false,
          assets: [
            {
              name: 'plugin.tgz',
              browser_download_url: 'https://example.com/v2.0.0.tgz',
            },
          ],
        },
      ];

      // Pinned to prerelease should resolve it
      mockCache.getJSON.mockResolvedValueOnce(releases);

      let source = createGitHubSource({ cache: mockCache as any });
      let result = await source.resolveGitHubRef(
        'github:owner/repo@v3.0.0-beta',
      );

      expect(result).toEqual({
        tarballUrl: 'https://example.com/v3.0.0-beta.tgz',
        version: '3.0.0',
        tag: 'v3.0.0-beta',
      });

      // Unpinned should still resolve to stable v2.0.0
      mockCache.getJSON.mockResolvedValueOnce(releases);

      source = createGitHubSource({ cache: mockCache as any });
      result = await source.resolveGitHubRef('github:owner/repo');

      expect(result).toEqual({
        tarballUrl: 'https://example.com/v2.0.0.tgz',
        version: '2.0.0',
        tag: 'v2.0.0',
      });
    });

    it('should pick latest non-prerelease when unpinned', async () => {
      const releases = [
        {
          tag_name: 'v3.0.0-beta',
          name: 'v3.0.0-beta',
          published_at: '2024-03-01T00:00:00Z',
          body: null,
          prerelease: true,
          assets: [
            {
              name: 'plugin.tgz',
              browser_download_url: 'https://example.com/v3.0.0-beta.tgz',
            },
          ],
        },
        {
          tag_name: 'v2.0.0',
          name: 'v2.0.0',
          published_at: '2024-02-01T00:00:00Z',
          body: null,
          prerelease: false,
          assets: [
            {
              name: 'plugin.tgz',
              browser_download_url: 'https://example.com/v2.0.0.tgz',
            },
          ],
        },
        {
          tag_name: 'v1.0.0',
          name: 'v1.0.0',
          published_at: '2024-01-01T00:00:00Z',
          body: null,
          prerelease: false,
          assets: [
            {
              name: 'plugin.tgz',
              browser_download_url: 'https://example.com/v1.0.0.tgz',
            },
          ],
        },
      ];

      mockCache.getJSON.mockResolvedValueOnce(releases);

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.resolveGitHubRef('github:owner/repo');

      expect(result).toEqual({
        tarballUrl: 'https://example.com/v2.0.0.tgz',
        version: '2.0.0',
        tag: 'v2.0.0',
      });
    });

    it('should return null for garbage refs', async () => {
      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.resolveGitHubRef('invalid:ref');

      expect(result).toBeNull();
    });

    it('should return null when no installable release (only prereleases)', async () => {
      const releases = [
        {
          tag_name: 'v1.0.0-beta',
          name: 'v1.0.0-beta',
          published_at: '2024-01-01T00:00:00Z',
          body: null,
          prerelease: true,
          assets: [
            {
              name: 'plugin.tgz',
              browser_download_url: 'https://example.com/v1.0.0-beta.tgz',
            },
          ],
        },
      ];

      mockCache.getJSON.mockResolvedValueOnce(releases);

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.resolveGitHubRef('github:owner/repo');

      expect(result).toBeNull();
    });

    it('should return null when no tarballUrl', async () => {
      const releases = [
        {
          tag_name: 'v1.0.0',
          name: 'v1.0.0',
          published_at: '2024-01-01T00:00:00Z',
          body: null,
          prerelease: false,
          assets: [],
        },
      ];

      mockCache.getJSON.mockResolvedValueOnce(releases);

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.resolveGitHubRef('github:owner/repo@v1.0.0');

      expect(result).toBeNull();
    });

    it('should return null when unpinned and no releases', async () => {
      mockCache.getJSON.mockResolvedValueOnce([]);

      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.resolveGitHubRef('github:owner/repo');

      expect(result).toBeNull();
    });
  });

  describe('downloadAsset', () => {
    it('should return buffer when status is ok', async () => {
      const mockFetch = jest.fn();
      const arrayBuffer = new ArrayBuffer(5);
      const view = new Uint8Array(arrayBuffer);
      view[0] = 72; // H
      view[1] = 101; // e
      view[2] = 108; // l
      view[3] = 108; // l
      view[4] = 111; // o

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: jest.fn().mockResolvedValueOnce(arrayBuffer),
      });

      const source = createGitHubSource({
        cache: mockCache as any,
        fetchImpl: mockFetch,
      });
      const result = await source.downloadAsset(
        'https://example.com/plugin.tgz',
      );

      expect(mockFetch).toHaveBeenCalledWith('https://example.com/plugin.tgz', {
        headers: {
          'User-Agent': 'kiagent',
          Accept: 'application/octet-stream',
        },
        redirect: 'follow',
      });
      expect(result).toEqual(Buffer.from([72, 101, 108, 108, 111]));
    });

    it('should throw error when status is not ok', async () => {
      const mockFetch = jest.fn();
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const source = createGitHubSource({
        cache: mockCache as any,
        fetchImpl: mockFetch,
      });

      await expect(
        source.downloadAsset('https://example.com/plugin.tgz'),
      ).rejects.toThrow(/download failed: 404/);
    });
  });
});
