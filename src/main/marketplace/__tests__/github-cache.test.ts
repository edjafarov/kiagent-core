/** @jest-environment node */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createGitHubCache, GitHubRateLimitError } from '../github-cache';

describe('github-cache', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-cache-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(cacheDir)) {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  describe('getJSON', () => {
    it('fresh fetch stores body and etag', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo', stars: 42 };
      const etag = '"abc123"';

      const mockFetch = jest.fn().mockResolvedValue(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: {
            ETag: etag,
            'Content-Type': 'application/json',
          },
        }),
      );

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });
      const result = await cache.getJSON(url);

      expect(result).toEqual(responseBody);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'kiagent',
        },
      });

      // Verify cache was persisted
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      expect(cached[url]).toEqual({
        etag,
        fetchedAt: expect.any(Number),
        body: responseBody,
      });
    });

    it('second call within TTL does not call fetchImpl', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo' };

      const mockFetch = jest.fn().mockResolvedValue(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const now = jest.fn();
      let currentTime = 1000;
      now.mockImplementation(() => currentTime);

      const cache = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        now,
        ttlMs: 60000, // 1 minute
      });

      // First call
      await cache.getJSON(url);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance time but stay within TTL
      currentTime = 1000 + 30000; // 30 seconds later
      const result2 = await cache.getJSON(url);

      expect(result2).toEqual(responseBody);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, not 2
    });

    it('past TTL sends If-None-Match header', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo' };
      const etag = '"abc123"';

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { ETag: etag },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 304 }));

      const now = jest.fn();
      let currentTime = 1000;
      now.mockImplementation(() => currentTime);

      const cache = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        now,
        ttlMs: 60000,
      });

      // First call
      await cache.getJSON(url);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance past TTL
      currentTime = 1000 + 70000; // 70 seconds later
      const result2 = await cache.getJSON(url);

      expect(result2).toEqual(responseBody);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenLastCalledWith(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'kiagent',
          'If-None-Match': etag,
        },
      });
    });

    it('304 response refreshes fetchedAt and returns cached body', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo' };
      const etag = '"abc123"';

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { ETag: etag },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 304 }));

      const now = jest.fn();
      let currentTime = 1000;
      now.mockImplementation(() => currentTime);

      const cache = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        now,
        ttlMs: 60000,
      });

      // First call
      await cache.getJSON(url);
      const cachedAfterFirst = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const firstFetchedAt = cachedAfterFirst[url].fetchedAt;

      // Advance past TTL
      currentTime = 1000 + 70000;
      const result = await cache.getJSON(url);

      expect(result).toEqual(responseBody);
      const cachedAfter304 = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const secondFetchedAt = cachedAfter304[url].fetchedAt;

      // fetchedAt should be updated
      expect(secondFetchedAt).toBe(1000 + 70000);
      expect(secondFetchedAt).not.toBe(firstFetchedAt);
    });

    it('429 returns stale body when cached', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo' };

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(responseBody), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 429 }));

      const now = jest.fn();
      let currentTime = 1000;
      now.mockImplementation(() => currentTime);

      const cache = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        now,
        ttlMs: 60000,
      });

      // First call - populate cache
      await cache.getJSON(url);

      // Advance past TTL
      currentTime = 1000 + 70000;
      const result = await cache.getJSON(url);

      expect(result).toEqual(responseBody);
    });

    it('429 throws GitHubRateLimitError when not cached', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';

      const mockFetch = jest
        .fn()
        .mockResolvedValue(new Response(null, { status: 429 }));

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });
      await expect(cache.getJSON(url)).rejects.toThrow(GitHubRateLimitError);
    });

    it('403 with X-RateLimit-Remaining: 0 returns stale body when cached', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo' };

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(responseBody), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(null, {
            status: 403,
            headers: { 'X-RateLimit-Remaining': '0' },
          }),
        );

      const now = jest.fn();
      let currentTime = 1000;
      now.mockImplementation(() => currentTime);

      const cache = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        now,
        ttlMs: 60000,
      });

      await cache.getJSON(url);
      currentTime = 1000 + 70000;
      const result = await cache.getJSON(url);

      expect(result).toEqual(responseBody);
    });

    it('fetch rejection returns stale body when cached', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo' };

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(responseBody), { status: 200 }),
        )
        .mockRejectedValueOnce(new Error('Network error'));

      const now = jest.fn();
      let currentTime = 1000;
      now.mockImplementation(() => currentTime);

      const cache = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        now,
        ttlMs: 60000,
      });

      await cache.getJSON(url);
      currentTime = 1000 + 70000;
      const result = await cache.getJSON(url);

      expect(result).toEqual(responseBody);
    });

    it('fetch rejection rethrows when not cached', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const error = new Error('Network error');

      const mockFetch = jest.fn().mockRejectedValue(error);
      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });

      await expect(cache.getJSON(url)).rejects.toThrow('Network error');
    });

    it('non-ok response returns stale body when cached', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo' };

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(responseBody), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 500 }));

      const now = jest.fn();
      let currentTime = 1000;
      now.mockImplementation(() => currentTime);

      const cache = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        now,
        ttlMs: 60000,
      });

      await cache.getJSON(url);
      currentTime = 1000 + 70000;
      const result = await cache.getJSON(url);

      expect(result).toEqual(responseBody);
    });

    it('non-ok response rethrows when not cached', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';

      const mockFetch = jest
        .fn()
        .mockResolvedValue(new Response(null, { status: 500 }));

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });
      await expect(cache.getJSON(url)).rejects.toThrow('GitHub 500');
    });

    it('persistence: new cache instance reads from same file within TTL', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo' };

      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(responseBody), { status: 200 }),
        );

      const now = jest.fn();
      let currentTime = 1000;
      now.mockImplementation(() => currentTime);

      // First cache instance populates
      const cache1 = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        now,
        ttlMs: 60000,
      });
      await cache1.getJSON(url);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second cache instance should read from file without fetching
      const cache2 = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        now,
        ttlMs: 60000,
      });
      currentTime = 1000 + 30000; // Still within TTL
      const result = await cache2.getJSON(url);

      expect(result).toEqual(responseBody);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Not called again
    });

    it('creates cache directory recursively', async () => {
      const cacheFile = path.join(cacheDir, 'subdir/nested/cache.json');
      const url = 'https://api.github.com/repos/owner/repo';
      const responseBody = { name: 'repo' };

      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(responseBody), { status: 200 }),
        );

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });
      await cache.getJSON(url);

      expect(fs.existsSync(cacheFile)).toBe(true);
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      expect(cached[url]).toBeDefined();
    });
  });

  describe('getText', () => {
    it('never caches - two calls make two fetches', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://raw.githubusercontent.com/owner/repo/main/README.md';
      const text = '# README';

      const mockFetch = jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(text, { status: 200 })),
        );

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });

      const result1 = await cache.getText(url);
      expect(result1).toBe(text);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const result2 = await cache.getText(url);
      expect(result2).toBe(text);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      expect(mockFetch).toHaveBeenCalledWith(url, {
        headers: { 'User-Agent': 'kiagent' },
      });
    });

    it('throws on non-ok response', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://raw.githubusercontent.com/owner/repo/main/README.md';

      const mockFetch = jest
        .fn()
        .mockResolvedValue(new Response(null, { status: 404 }));

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });
      await expect(cache.getText(url)).rejects.toThrow('GitHub 404');
    });
  });

  describe('getDataUrl', () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const asDataUrl = `data:image/png;base64,${PNG.toString('base64')}`;

    it('fresh fetch returns a data URI and caches it; second call within TTL skips fetch', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://raw.githubusercontent.com/owner/repo/HEAD/icon.png';

      const mockFetch = jest
        .fn()
        .mockResolvedValue(
          new Response(PNG, { status: 200, headers: { ETag: '"i1"' } }),
        );

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });
      expect(await cache.getDataUrl(url, 'image/png')).toBe(asDataUrl);
      expect(await cache.getDataUrl(url, 'image/png')).toBe(asDataUrl);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      expect(cached[url].body).toBe(asDataUrl);
      expect(cached[url].etag).toBe('"i1"');
    });

    it('throws when the asset exceeds maxBytes', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://raw.githubusercontent.com/owner/repo/HEAD/icon.png';

      const mockFetch = jest
        .fn()
        .mockResolvedValue(new Response(Buffer.alloc(10), { status: 200 }));

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });
      await expect(cache.getDataUrl(url, 'image/png', 4)).rejects.toThrow(
        /exceeds 4 bytes/,
      );
    });

    it('throws on non-ok response when not cached, returns stale body when cached', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://raw.githubusercontent.com/owner/repo/HEAD/icon.png';

      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(PNG, { status: 200 }))
        .mockResolvedValueOnce(new Response(null, { status: 500 }));

      const now = { t: 1_000_000 };
      const cache = createGitHubCache({
        cacheFile,
        fetchImpl: mockFetch,
        ttlMs: 1000,
        now: () => now.t,
      });
      await expect(cache.getDataUrl(url, 'image/png')).rejects.toThrow(
        'GitHub 404',
      );
      expect(await cache.getDataUrl(url, 'image/png')).toBe(asDataUrl);
      now.t += 2000; // past TTL — refetch fails, stale body served
      expect(await cache.getDataUrl(url, 'image/png')).toBe(asDataUrl);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('User-Agent header', () => {
    it('uses kiagent as User-Agent in getJSON', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://api.github.com/repos/owner/repo';

      const mockFetch = jest
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });
      await cache.getJSON(url);

      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.headers['User-Agent']).toBe('kiagent');
    });

    it('uses kiagent as User-Agent in getText', async () => {
      const cacheFile = path.join(cacheDir, 'cache.json');
      const url = 'https://raw.githubusercontent.com/owner/repo/main/file.txt';

      const mockFetch = jest
        .fn()
        .mockResolvedValue(new Response('content', { status: 200 }));

      const cache = createGitHubCache({ cacheFile, fetchImpl: mockFetch });
      await cache.getText(url);

      const callArgs = mockFetch.mock.calls[0][1];
      expect(callArgs.headers['User-Agent']).toBe('kiagent');
    });
  });
});
