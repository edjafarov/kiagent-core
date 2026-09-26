// How a store listing and an installed extension find each other.
import type { ExtensionSnapshot } from '@shared/contracts';
import type { MarketplaceListItem } from '@shared/ipc';

/** Matches an installed snapshot to a catalog repo by ref: bare github ref or @-pinned. */
export function matchInstalled(
  item: MarketplaceListItem,
  extensions: ExtensionSnapshot[],
): ExtensionSnapshot | undefined {
  const bare = `github:${item.owner}/${item.repo}`;
  return extensions.find(
    (e) => e.ref === bare || e.ref?.startsWith(`${bare}@`),
  );
}

/** Strips a `@tag` pin suffix off a `github:owner/repo[@tag]` ref, e.g. to
 *  turn an installed snapshot's pinned ref back into the bare ref a fresh
 *  install-preview expects (Detail's Update fallback for a marketplace row
 *  that has dropped out of the catalog). Refs without a github: prefix pass
 *  through unchanged. */
export function bareGithubRef(ref: string): string {
  if (!ref.startsWith('github:')) return ref;
  const at = ref.indexOf('@', 'github:'.length);
  return at === -1 ? ref : ref.slice(0, at);
}

/** The brand-table id a store repo stands for: `slack-kia-connector` →
 *  `slack`, so a tile keeps its brand across install. */
export function storeBrandId(repo: string): string {
  return repo.replace(/-kia-(connector|extension|plugin)$/, '');
}

/** `github:owner/repo[@tag]` → `{ owner, repo }`; anything else → null. */
export function parseGithubRef(
  ref: string | undefined,
): { owner: string; repo: string } | null {
  if (!ref?.startsWith('github:')) return null;
  const [owner, repo] = bareGithubRef(ref).slice('github:'.length).split('/');
  return owner && repo ? { owner, repo } : null;
}
