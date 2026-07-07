import semver from 'semver';
import { parseGitHubRef, formatGitHubRef } from './github-ref';
import type { UpdateInfo } from '@shared/ipc';

export async function checkUpdates(deps: {
  installed: Array<{ id: string; version: string; ref?: string }>;
  resolveLatest: (ref: string) => Promise<{ version: string } | null>;
}): Promise<UpdateInfo[]> {
  const out: UpdateInfo[] = [];
  for (const rec of deps.installed) {
    if (!rec.ref?.startsWith('github:')) continue;
    // Installed refs are PINNED (`github:owner/repo@tag`). Resolve the LATEST
    // release for the repo, not the pinned tag — `resolveGitHubRef` honors an
    // `@tag`, so a pinned ref would resolve to its own version and never report
    // an update. Strip the tag to the bare `github:owner/repo` first.
    const parsed = parseGitHubRef(rec.ref);
    const repoRef = parsed
      ? formatGitHubRef(parsed.owner, parsed.repo)
      : rec.ref;
    const latest = await deps.resolveLatest(repoRef).catch(() => null);
    if (
      latest &&
      semver.valid(latest.version) &&
      semver.valid(rec.version) &&
      semver.gt(latest.version, rec.version)
    ) {
      out.push({
        id: rec.id,
        installedVersion: rec.version,
        latestVersion: latest.version,
        ref: rec.ref,
      });
    }
  }
  return out;
}
