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

  async function listOrgPlugins(): Promise<MarketplaceListItem[]> {
    const data = await deps.cache.getJSON<{ items: GhRepo[] }>(
      `${API}/search/repositories?q=org:${org}+topic:${topic}&per_page=100`,
    );
    return Promise.all(
      (data.items ?? []).map(async (r) => ({
        owner: r.owner.login,
        repo: r.name,
        fullName: r.full_name,
        displayName: r.name,
        description: r.description ?? '',
        iconDataUrl: await fetchIconDataUrl(r.owner.login, r.name),
      })),
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
    const [repoMeta, releases, readmeMarkdown, iconDataUrl] = await Promise.all(
      [
        deps.cache.getJSON<GhRepo>(`${API}/repos/${owner}/${repo}`),
        listReleases(owner, repo),
        deps.cache
          .getText(
            `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`,
          )
          .catch(() => ''),
        fetchIconDataUrl(owner, repo),
      ],
    );
    return {
      listing: {
        owner,
        repo,
        fullName: repoMeta.full_name,
        displayName: repoMeta.name,
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
    return Buffer.from(await r.arrayBuffer());
  }

  return { listOrgPlugins, getDetail, resolveGitHubRef, downloadAsset };
}
