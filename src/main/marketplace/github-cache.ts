import fs from 'fs';
import path from 'path';

export class GitHubRateLimitError extends Error {}

interface Entry {
  etag?: string;
  fetchedAt: number;
  body: unknown;
}

export interface GitHubCacheDeps {
  cacheFile: string;
  ttlMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

export function createGitHubCache(deps: GitHubCacheDeps) {
  const ttl = deps.ttlMs ?? 5 * 60_000;
  const now = deps.now ?? (() => Date.now());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const store: Record<string, Entry> = load();

  function load(): Record<string, Entry> {
    try {
      return JSON.parse(fs.readFileSync(deps.cacheFile, 'utf8'));
    } catch {
      return {};
    }
  }
  function persist(): void {
    fs.mkdirSync(path.dirname(deps.cacheFile), { recursive: true });
    fs.writeFileSync(deps.cacheFile, JSON.stringify(store));
  }

  async function getJSON<T>(url: string): Promise<T> {
    const hit = store[url];
    if (hit && now() - hit.fetchedAt < ttl) return hit.body as T;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kiagent',
    };
    if (hit?.etag) headers['If-None-Match'] = hit.etag;
    let r: Response;
    try {
      r = await fetchImpl(url, { headers });
    } catch (e) {
      if (hit) return hit.body as T;
      throw e;
    }
    if (r.status === 304 && hit) {
      hit.fetchedAt = now();
      persist();
      return hit.body as T;
    }
    if (r.status === 403 || r.status === 429) {
      if (r.headers.get('X-RateLimit-Remaining') === '0' || r.status === 429) {
        if (hit) return hit.body as T;
        throw new GitHubRateLimitError(`GitHub rate limit: ${url}`);
      }
    }
    if (!r.ok) {
      if (hit) return hit.body as T;
      throw new Error(`GitHub ${r.status} ${url}`);
    }
    const body = (await r.json()) as T;
    store[url] = {
      etag: r.headers.get('ETag') ?? undefined,
      fetchedAt: now(),
      body,
    };
    persist();
    return body;
  }

  async function getText(url: string): Promise<string> {
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'kiagent' } });
    if (!r.ok) throw new Error(`GitHub ${r.status} ${url}`);
    return r.text();
  }

  /** Small binary asset (extension icons) as a data URI, cached with the
   *  same TTL/stale-on-error semantics as getJSON — the body stored is the
   *  data-URI string itself, so the JSON cache file stays one flat map. */
  async function getDataUrl(
    url: string,
    contentType: string,
    maxBytes?: number,
  ): Promise<string> {
    const hit = store[url];
    if (hit && now() - hit.fetchedAt < ttl) return hit.body as string;
    const headers: Record<string, string> = { 'User-Agent': 'kiagent' };
    if (hit?.etag) headers['If-None-Match'] = hit.etag;
    let r: Response;
    try {
      r = await fetchImpl(url, { headers });
    } catch (e) {
      if (hit) return hit.body as string;
      throw e;
    }
    if (r.status === 304 && hit) {
      hit.fetchedAt = now();
      persist();
      return hit.body as string;
    }
    if (!r.ok) {
      if (hit) return hit.body as string;
      throw new Error(`GitHub ${r.status} ${url}`);
    }
    const bytes = Buffer.from(await r.arrayBuffer());
    if (maxBytes !== undefined && bytes.length > maxBytes) {
      throw new Error(`asset exceeds ${maxBytes} bytes: ${url}`);
    }
    const body = `data:${contentType};base64,${bytes.toString('base64')}`;
    store[url] = {
      etag: r.headers.get('ETag') ?? undefined,
      fetchedAt: now(),
      body,
    };
    persist();
    return body;
  }

  return { getJSON, getText, getDataUrl };
}
