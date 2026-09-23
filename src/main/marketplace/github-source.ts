import semver from 'semver';
import { MAX_ICON_BYTES } from '@main/platform/manifest';
import type { MarketplaceListItem, PluginDetail } from '@shared/ipc';
import { parseGitHubRef } from './github-ref';
import type { createGitHubCache } from './github-cache';

export const MARKETPLACE_ORG = 'kia-plugins';
export const PLUGIN_TOPIC = 'kia-plugin';
const API = 'https://api.github.com';

type Cache = ReturnType<typeof createGitHubCache>;

interface GhRelease {
  tag_name: string;
  name: string;
  published_at: string;
  body: string | null;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

interface GhRepo {
  name: string;
  owner: { login: string };
  full_name: string;
  description: string | null;
}

function toVersion(tag: string): string {
  return semver.valid(semver.coerce(tag)) ?? '0.0.0';
}

/**
 * Release-asset downloads are fetched from GitHub as part of the
 * marketplace install flow — a malicious or misconfigured release must not
 * be able to buffer an unbounded blob in the main process. 200 MiB
 * comfortably covers legitimate plugin tarballs.
 */
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024; // 200 MiB

/**
 * Reads `res`'s body up to `maxBytes`, throwing a descriptive error the
 * moment that's exceeded. Checked against `content-length` up front (fail
 * fast), then again against the running total while streaming — a
 * `content-length` header can lie or be absent, so it can't be trusted
 * alone. `deps.fetchImpl` is injectable for tests, so `res` may be a fake
 * lacking `.headers`/`.body`: falls back to `arrayBuffer()` + a length
 * check in that case.
 */
async function readBoundedBuffer(
  res: {
    headers?: { get(name: string): string | null };
    body?: ReadableStream<Uint8Array> | null;
    arrayBuffer(): Promise<ArrayBuffer>;
  },
  maxBytes: number,
): Promise<Buffer> {
  const limit = `${Math.floor(maxBytes / (1024 * 1024))} MiB`;
  const declared = res.headers?.get('content-length');
  if (declared && Number(declared) > maxBytes) {
    throw new Error(`downloadAsset: response exceeds the ${limit} limit`);
  }
  if (!res.body) {
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new Error(`downloadAsset: response exceeds the ${limit} limit`);
    }
    return Buffer.from(buf);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the transfer too — without cancel() the stream keeps
        // pulling bytes until GC even though we've already given up.
        await reader.cancel();
        throw new Error(`downloadAsset: response exceeds the ${limit} limit`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks, total);
}

function tgzAsset(r: GhRelease): string | null {
  return (
    r.assets.find((a) => a.name.endsWith('.tgz'))?.browser_download_url ?? null
  );
}

interface ReleaseInfo {
  tag: string;
  version: string;
  publishedAt: string;
  tarballUrl: string | null;
  prerelease: boolean;
}

function toReleaseInfo(r: GhRelease): ReleaseInfo {
  return {
    tag: r.tag_name,
    version: toVersion(r.tag_name),
    publishedAt: r.published_at,
    tarballUrl: tgzAsset(r),
    prerelease: r.prerelease,
  };
}

/** Repo-name suffixes that only say "this is a KIAgent plugin" — noise in
 *  a Marketplace title (e.g. `whatsapp-kia-connector`). */
const REPO_NOISE_SUFFIX = /-kia-(?:connector|plugin|extension)$/i;

/**
 * Fallback title when a repo's manifest can't supply one:
 * `google-docs-kia-connector` → `Google Docs`. Never returns '' — a repo
 * name that is nothing but noise is kept as-is.
 */
export function humanizeRepoName(repo: string): string {
  const words = repo
    .replace(REPO_NOISE_SUFFIX, '')
    .split(/[-_\s]+/)
    .filter(Boolean);
  if (words.length === 0) return repo;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const MAX_DISPLAY_NAME = 64;

/** A manifest `name` usable as a title: a non-empty single-line string of
 *  bounded length (the manifest is untrusted repo content). */
function manifestName(manifest: unknown): string | undefined {
  const name = (manifest as { name?: unknown } | null)?.name;
  if (typeof name !== 'string') return undefined;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME)
    return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
  return trimmed;
}

export function createGitHubSource(deps: {
  cache: Cache;
  org?: string;
  topic?: string;
  fetchImpl?: typeof fetch;
}) {
  const org = deps.org ?? MARKETPLACE_ORG;
  const topic = deps.topic ?? PLUGIN_TOPIC;

  /** Pre-install icon: the conventional root-level icon.png at HEAD (the
   *  package's manifest-declared path isn't knowable without fetching the
   *  manifest, so the marketplace convention is the fixed path). Missing/
   *  oversized/unfetchable → undefined, letter-glyph fallback in the UI. */
  function fetchIconDataUrl(
    owner: string,
    repo: string,
  ): Promise<string | undefined> {
    return deps.cache
      .getDataUrl(
        `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/icon.png`,
        'image/png',
        MAX_ICON_BYTES,
      )
      .catch(() => undefined);
  }

  /** Pre-install title: the `name` the extension declares in the
   *  root-level manifest.json at HEAD (the same name an installed copy
   *  shows), else the repo name made readable. Fetched through the cache
   *  like the icon; raw.githubusercontent.com is not API-rate-limited. */
  async function resolveDisplayName(
    owner: string,
    repo: string,
  ): Promise<string> {
    let name: string | undefined;
    try {
      name = manifestName(
        await deps.cache.getJSON<unknown>(
          `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/manifest.json`,
        ),
      );
    } catch {
      // No manifest at HEAD, not JSON, or offline — the repo name will do.
    }
    return name ?? humanizeRepoName(repo);
  }

  async function listOrgPlugins(): Promise<MarketplaceListItem[]> {
    const data = await deps.cache.getJSON<{ items: GhRepo[] }>(
      `${API}/search/repositories?q=org:${org}+topic:${topic}&per_page=100`,
    );
    return Promise.all(
      (data.items ?? []).map(async (r) => {
        const [displayName, iconDataUrl] = await Promise.all([
          resolveDisplayName(r.owner.login, r.name),
          fetchIconDataUrl(r.owner.login, r.name),
        ]);
        return {
          owner: r.owner.login,
          repo: r.name,
          fullName: r.full_name,
          displayName,
          description: r.description ?? '',
          iconDataUrl,
        };
      }),
    );
  }

  async function listReleases(
    owner: string,
    repo: string,
  ): Promise<ReleaseInfo[]> {
    const rels = await deps.cache.getJSON<GhRelease[]>(
      `${API}/repos/${owner}/${repo}/releases?per_page=30`,
    );
    return rels.map(toReleaseInfo);
  }

  async function getDetail(owner: string, repo: string): Promise<PluginDetail> {
    const [repoMeta, releases, readmeMarkdown, iconDataUrl, displayName] =
      await Promise.all([
        deps.cache.getJSON<GhRepo>(`${API}/repos/${owner}/${repo}`),
        listReleases(owner, repo),
        deps.cache
          .getText(
            `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
          )
          .catch(() => ''),
        fetchIconDataUrl(owner, repo),
        resolveDisplayName(owner, repo),
      ]);
    return {
      listing: {
        owner,
        repo,
        fullName: repoMeta.full_name,
        displayName,
        description: repoMeta.description ?? '',
        iconDataUrl,
      },
      readmeMarkdown,
      latest: releases.find((r) => !r.prerelease) ?? null,
    };
  }

  async function resolveGitHubRef(
    ref: string,
  ): Promise<{ tarballUrl: string; version: string; tag: string } | null> {
    const parsed = parseGitHubRef(ref);
    if (!parsed) return null;
    const releases = await listReleases(parsed.owner, parsed.repo);
    const pick = parsed.tag
      ? releases.find((r) => r.tag === parsed.tag)
      : releases.find((r) => !r.prerelease);
    if (!pick || !pick.tarballUrl) return null;
    return {
      tarballUrl: pick.tarballUrl,
      version: pick.version,
      tag: pick.tag,
    };
  }

  async function downloadAsset(url: string): Promise<Buffer> {
    const fetchFn = deps.fetchImpl ?? fetch;
    const r = await fetchFn(url, {
      headers: { 'User-Agent': 'kiagent', Accept: 'application/octet-stream' },
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`download failed: ${r.status} ${url}`);
    return readBoundedBuffer(r, MAX_DOWNLOAD_BYTES);
  }

  return { listOrgPlugins, getDetail, resolveGitHubRef, downloadAsset };
}
