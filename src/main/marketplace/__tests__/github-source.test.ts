/** @jest-environment node */

import { GitHubNotFoundError } from '../github-cache';
import {
  createGitHubSource,
  humanizeRepoName,
  INSTALL_SOURCE_COPY,
  InstallSourceError,
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
          displayName: 'Plugin One',
          description: 'A plugin',
        },
        {
          owner: 'bob',
          repo: 'plugin-two',
          fullName: 'bob/plugin-two',
          displayName: 'Plugin Two',
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
        displayName: 'Plugin X',
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

    it('has no latest release when no release carries a .tgz', async () => {
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

      expect(result.latest).toBeNull();
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

  describe('display names', () => {
    const manifestUrl = (repo: string) =>
      `https://raw.githubusercontent.com/kia-plugins/${repo}/HEAD/manifest.json`;
    const repoItem = (name: string) => ({
      owner: { login: 'kia-plugins' },
      name,
      full_name: `kia-plugins/${name}`,
      description: null,
    });

    /** getJSON routed by URL: the org search, then per-repo manifests. */
    function routeJSON(
      repos: string[],
      manifests: Record<string, unknown | Error>,
    ): void {
      mockCache.getJSON.mockImplementation(async (url: string) => {
        if (url.startsWith('https://api.github.com/search/')) {
          return { items: repos.map(repoItem) };
        }
        const repo = repos.find((r) => url === manifestUrl(r));
        if (repo !== undefined && repo in manifests) {
          const m = manifests[repo];
          if (m instanceof Error) throw m;
          return m;
        }
        throw new Error(`GitHub 404 ${url}`);
      });
    }

    it('titles each listing with the name its HEAD manifest.json declares', async () => {
      routeJSON(['whatsapp-kia-connector', 'ms365-kia-connector'], {
        'whatsapp-kia-connector': { id: 'kia.whatsapp', name: 'WhatsApp' },
        'ms365-kia-connector': { id: 'kia.ms365', name: '  Microsoft 365 ' },
      });
      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.listOrgPlugins();

      expect(mockCache.getJSON).toHaveBeenCalledWith(
        manifestUrl('whatsapp-kia-connector'),
      );
      expect(result.map((r) => [r.repo, r.displayName])).toEqual([
        ['whatsapp-kia-connector', 'WhatsApp'],
        ['ms365-kia-connector', 'Microsoft 365'],
      ]);
    });

    it('falls back to the readable repo name for a missing or unusable manifest name', async () => {
      const repos = [
        'google-docs-kia-connector', // 404
        'no-name-kia-connector', // manifest without name
        'numeric-kia-connector', // name not a string
        'blank-kia-connector', // whitespace only
        'long-kia-connector', // over the length cap
        'ctrl-kia-connector', // control character
        'garbage-kia-connector', // non-object body
        'offline-kia-connector', // fetch rejects
      ];
      routeJSON(repos, {
        'no-name-kia-connector': { id: 'x.y' },
        'numeric-kia-connector': { name: 42 },
        'blank-kia-connector': { name: '   ' },
        'long-kia-connector': { name: 'x'.repeat(65) },
        'ctrl-kia-connector': { name: 'Bad\nName' },
        'garbage-kia-connector': 'not json object',
        'offline-kia-connector': new Error('ENOTFOUND'),
      });
      const source = createGitHubSource({ cache: mockCache as any });
      const result = await source.listOrgPlugins();

      expect(result.map((r) => r.displayName)).toEqual([
        'Google Docs',
        'No Name',
        'Numeric',
        'Blank',
        'Long',
        'Ctrl',
        'Garbage',
        'Offline',
      ]);
    });

    it('titles the detail listing from the manifest too', async () => {
      mockCache.getJSON.mockImplementation(async (url: string) => {
        if (url === manifestUrl('hubspot-kia-connector')) {
          return { name: 'HubSpot' };
        }
        if (url.endsWith('/releases?per_page=30')) return [];
        return {
          name: 'hubspot-kia-connector',
          owner: { login: 'kia-plugins' },
          full_name: 'kia-plugins/hubspot-kia-connector',
          description: 'CRM',
        };
      });
      mockCache.getText.mockResolvedValueOnce('');
      const source = createGitHubSource({ cache: mockCache as any });
      const detail = await source.getDetail(
        'kia-plugins',
        'hubspot-kia-connector',
      );

      expect(detail.listing.displayName).toBe('HubSpot');
    });
  });

  describe('humanizeRepoName', () => {
    it.each([
      ['whatsapp-kia-connector', 'Whatsapp'],
      ['google-docs-kia-connector', 'Google Docs'],
      ['ms365-kia-connector', 'Ms365'],
      ['cool-thing-kia-plugin', 'Cool Thing'],
      ['my_ext-kia-extension', 'My Ext'],
      ['plain', 'Plain'],
      ['already-Cased', 'Already Cased'],
      ['-kia-connector', '-kia-connector'],
    ])('%s → %s', (repo, expected) => {
      expect(humanizeRepoName(repo)).toBe(expected);
    });
  });

  describe('resolveGitHubRef', () => {
    const API = 'https://api.github.com';
    const rel = (tag: string, opts: { prerelease?: boolean; tgz?: boolean } = {}) => ({
      tag_name: tag,
      name: tag,
      published_at: '2024-01-01T00:00:00Z',
      body: null,
      prerelease: opts.prerelease ?? false,
      assets:
        opts.tgz === false
          ? [{ name: 'source.zip', browser_download_url: `https://example.com/${tag}.zip` }]
          : [{ name: 'plugin.tgz', browser_download_url: `https://example.com/${tag}.tgz` }],
    });
    const repoMeta = (owner: string, name: string, id = 1) => ({
      id,
      name,
      owner: { login: owner },
      full_name: `${owner}/${name}`,
      description: null,
    });
    /** Routes API urls; anything unrouted is a GitHub 404. */
    const route = (table: Record<string, unknown>) =>
      mockCache.getJSON.mockImplementation(async (url: string) => {
        if (url in table) return table[url];
        throw new GitHubNotFoundError(`GitHub 404 ${url}`);
      });

    it('pins the canonical repository after a rename', async () => {
      route({
        [`${API}/repos/old/x`]: repoMeta('new', 'X', 7),
        [`${API}/repos/new/X/releases?per_page=30`]: [rel('v1.0.0')],
      });
      const source = createGitHubSource({ cache: mockCache as any });
      expect(await source.resolveGitHubRef('github:old/x')).toEqual({
        owner: 'new',
        repo: 'X',
        repoId: 7,
        tag: 'v1.0.0',
        version: '1.0.0',
        tarballUrl: 'https://example.com/v1.0.0.tgz',
      });
    });

    it('looks an explicit tag up directly, encoded', async () => {
      route({
        [`${API}/repos/o/r`]: repoMeta('o', 'r'),
        [`${API}/repos/o/r/releases/tags/v%2B1`]: rel('v+1', { prerelease: true }),
      });
      const source = createGitHubSource({ cache: mockCache as any });
      const r = await source.resolveGitHubRef('github:o/r@v+1');
      expect(r.tag).toBe('v+1');
      expect(r.tarballUrl).toBe('https://example.com/v+1.tgz');
    });

    it('skips a newer source-only release', async () => {
      route({
        [`${API}/repos/o/r`]: repoMeta('o', 'r'),
        [`${API}/repos/o/r/releases?per_page=30`]: [
          rel('v2.0.0', { tgz: false }),
          rel('v1.0.0'),
        ],
      });
      const source = createGitHubSource({ cache: mockCache as any });
      expect((await source.resolveGitHubRef('github:o/r')).tag).toBe('v1.0.0');
    });

    it('picks the newest stable release when unpinned', async () => {
      route({
        [`${API}/repos/o/r`]: repoMeta('o', 'r'),
        [`${API}/repos/o/r/releases?per_page=30`]: [
          rel('v3.0.0-beta', { prerelease: true }),
          rel('v2.0.0'),
          rel('v1.0.0'),
        ],
      });
      const source = createGitHubSource({ cache: mockCache as any });
      expect((await source.resolveGitHubRef('github:o/r')).tag).toBe('v2.0.0');
    });

    it.each([
      ['a missing repository', {}, 'github:o/r', 'not-found'],
      [
        'no release with a package',
        {
          [`${API}/repos/o/r`]: repoMeta('o', 'r'),
          [`${API}/repos/o/r/releases?per_page=30`]: [rel('v1.0.0', { tgz: false })],
        },
        'github:o/r',
        'no-release',
      ],
      [
        'no releases at all',
        {
          [`${API}/repos/o/r`]: repoMeta('o', 'r'),
          [`${API}/repos/o/r/releases?per_page=30`]: [],
        },
        'github:o/r',
        'no-release',
      ],
      [
        'only prereleases',
        {
          [`${API}/repos/o/r`]: repoMeta('o', 'r'),
          [`${API}/repos/o/r/releases?per_page=30`]: [rel('v1.0.0-b', { prerelease: true })],
        },
        'github:o/r',
        'no-release',
      ],
      [
        'a missing tag',
        { [`${API}/repos/o/r`]: repoMeta('o', 'r') },
        'github:o/r@v9',
        'no-release',
      ],
      [
        'a tag without a package',
        {
          [`${API}/repos/o/r`]: repoMeta('o', 'r'),
          [`${API}/repos/o/r/releases/tags/v1`]: rel('v1', { tgz: false }),
        },
        'github:o/r@v1',
        'no-release',
      ],
    ])('%s → %s', async (_name, table, ref, code) => {
      route(table as Record<string, unknown>);
      const source = createGitHubSource({ cache: mockCache as any });
      const err = await source.resolveGitHubRef(ref).catch((e) => e);
      expect(err).toBeInstanceOf(InstallSourceError);
      expect(err.code).toBe(code);
      expect(err.message).toBe(INSTALL_SOURCE_COPY[code as keyof typeof INSTALL_SOURCE_COPY]);
    });

    it('rejects a garbage ref', async () => {
      const source = createGitHubSource({ cache: mockCache as any });
      await expect(source.resolveGitHubRef('invalid:ref')).rejects.toThrow(
        'not a github ref',
      );
    });
  });

  describe('platform compatibility', () => {
    const rel = (tag: string, prerelease = false) => ({
      tag_name: tag,
      name: tag,
      published_at: '2024-01-01T00:00:00Z',
      body: null,
      prerelease,
      assets: [
        {
          name: 'plugin.tgz',
          browser_download_url: `https://example.com/${tag}.tgz`,
        },
      ],
    });
    const manifestUrl = (tag: string) =>
      `https://raw.githubusercontent.com/owner/repo/${tag}/manifest.json`;
    /** Releases for the list call; each tag's manifest declares `engines[tag]`
     *  (a missing entry = no readable manifest). */
    const serve = (releases: unknown[], engines: Record<string, string>) =>
      mockCache.getJSON.mockImplementation(async (url: string) => {
        if (url === 'https://api.github.com/repos/owner/repo')
          return { id: 3, name: 'repo', owner: { login: 'owner' } };
        if (url.endsWith('/releases?per_page=30')) return releases;
        const tagged = /\/releases\/tags\/(.+)$/.exec(url);
        if (tagged)
          return (releases as Array<{ tag_name: string }>).find(
            (r) => r.tag_name === decodeURIComponent(tagged[1]),
          );
        const tag = Object.keys(engines).find((t) => url === manifestUrl(t));
        if (tag) return { id: 'kia.x', engine: engines[tag] };
        throw new Error(`GitHub 404 ${url}`);
      });

    it('unpinned resolve skips a release that needs a newer platform', async () => {
      serve([rel('v3.0.0'), rel('v2.2.1'), rel('v2.2.0')], {
        'v3.0.0': '^2.6.0',
        'v2.2.1': '^2.1.0',
      });
      const source = createGitHubSource({
        cache: mockCache as any,
        platformApi: '2.5.0',
      });

      expect(await source.resolveGitHubRef('github:owner/repo')).toEqual({
        owner: 'owner',
        repo: 'repo',
        repoId: 3,
        tarballUrl: 'https://example.com/v2.2.1.tgz',
        version: '2.2.1',
        tag: 'v2.2.1',
      });
    });

    it('needs-newer-app when every packaged release needs a newer platform', async () => {
      serve([rel('v3.0.0')], { 'v3.0.0': '^2.6.0' });
      const source = createGitHubSource({
        cache: mockCache as any,
        platformApi: '2.5.0',
      });
      await expect(
        source.resolveGitHubRef('github:owner/repo'),
      ).rejects.toMatchObject({ code: 'needs-newer-app' });
    });

    it('latestReleases ignores releases without a package', async () => {
      const noPkg = { ...rel('v4.0.0'), assets: [] };
      serve([noPkg, rel('v2.2.1')], { 'v2.2.1': '^2.1.0' });
      const source = createGitHubSource({
        cache: mockCache as any,
        platformApi: '2.5.0',
      });
      expect(await source.latestReleases('github:owner/repo')).toEqual({
        version: '2.2.1',
      });
    });

    it('a pinned tag resolves as-is (the installer checks its engine)', async () => {
      serve([rel('v3.0.0'), rel('v2.2.1')], { 'v3.0.0': '^2.6.0' });
      const source = createGitHubSource({
        cache: mockCache as any,
        platformApi: '2.5.0',
      });

      expect(
        (await source.resolveGitHubRef('github:owner/repo@v3.0.0'))?.version,
      ).toBe('3.0.0');
    });

    it('latestReleases reports the runnable release and a newer one this app cannot run', async () => {
      serve([rel('v3.0.0'), rel('v2.2.1')], {
        'v3.0.0': '^2.6.0',
        'v2.2.1': '^2.1.0',
      });
      const source = createGitHubSource({
        cache: mockCache as any,
        platformApi: '2.5.0',
      });

      expect(await source.latestReleases('github:owner/repo')).toEqual({
        version: '2.2.1',
        newerVersion: '3.0.0',
      });
    });

    it('latestReleases has no runnable version when every release needs a newer platform', async () => {
      serve([rel('v3.0.0')], { 'v3.0.0': '^2.6.0' });
      const source = createGitHubSource({
        cache: mockCache as any,
        platformApi: '2.5.0',
      });

      expect(await source.latestReleases('github:owner/repo')).toEqual({
        version: null,
        newerVersion: '3.0.0',
      });
    });

    it('a release whose manifest cannot be read counts as runnable', async () => {
      serve([rel('v3.0.0'), rel('v2.2.1')], { 'v2.2.1': '^2.1.0' });
      const source = createGitHubSource({
        cache: mockCache as any,
        platformApi: '2.5.0',
      });

      expect(await source.latestReleases('github:owner/repo')).toEqual({
        version: '3.0.0',
      });
    });

    it('the detail page offers the newest runnable release', async () => {
      mockCache.getJSON.mockImplementation(async (url: string) => {
        if (url === 'https://api.github.com/repos/owner/repo')
          return {
            name: 'repo',
            owner: { login: 'owner' },
            full_name: 'owner/repo',
            description: null,
          };
        if (url.endsWith('/releases?per_page=30'))
          return [rel('v3.0.0'), rel('v2.2.1')];
        if (url === manifestUrl('v3.0.0')) return { engine: '^2.6.0' };
        if (url === manifestUrl('v2.2.1')) return { engine: '^2.1.0' };
        throw new Error(`GitHub 404 ${url}`);
      });
      mockCache.getText.mockResolvedValue('');
      const source = createGitHubSource({
        cache: mockCache as any,
        platformApi: '2.5.0',
      });

      expect((await source.getDetail('owner', 'repo')).latest?.version).toBe(
        '2.2.1',
      );
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

    it('should throw when content-length declares more than the 200 MiB download cap, without buffering the (tiny, lying) body', async () => {
      const mockFetch = jest.fn().mockResolvedValueOnce({
        ok: true,
        // Lies: declares far more than the tiny body actually returned, so
        // the test never has to allocate anything close to the real cap.
        headers: {
          get: (name: string) =>
            name === 'content-length' ? String(250 * 1024 * 1024) : null,
        },
        arrayBuffer: jest.fn().mockResolvedValueOnce(new ArrayBuffer(5)),
      });

      const source = createGitHubSource({
        cache: mockCache as any,
        fetchImpl: mockFetch,
      });

      await expect(
        source.downloadAsset('https://example.com/plugin.tgz'),
      ).rejects.toThrow(/200 MiB/);
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
