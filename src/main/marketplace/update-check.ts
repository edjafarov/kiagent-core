import semver from 'semver';
import type { UpdateInfo } from '@shared/ipc';
import { parseGitHubRef, formatGitHubRef } from './github-ref';

export async function checkUpdates(deps: {
  installed: Array<{ id: string; version: string; ref?: string }>;
  /** `version`: the newest release this app can run (null when none can);
   *  `newerVersion`: a newer release that needs a newer app. */
  resolveLatest: (
    ref: string,
  ) => Promise<{ version: string | null; newerVersion?: string } | null>;
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
    const newer = (v: string | null | undefined): v is string =>
      !!v && !!semver.valid(v) && semver.gt(v, rec.version);
    if (!latest || !semver.valid(rec.version)) continue;
    if (newer(latest.version)) {
      out.push({
        id: rec.id,
        installedVersion: rec.version,
        latestVersion: latest.version,
        ref: rec.ref,
      });
    } else if (newer(latest.newerVersion)) {
      // Nothing installable yet: the next version needs a newer app.
      out.push({
        id: rec.id,
        installedVersion: rec.version,
        latestVersion: latest.newerVersion,
        ref: rec.ref,
        needsNewerApp: true,
      });
    }
  }
  return out;
}
