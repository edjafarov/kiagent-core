/**
 * Pure row-building model for the Marketplace list pane, extracted so the
 * catalog/installed merge, filter, and search semantics have unit coverage
 * independent of React/DOM (precedent: folder-picker/selection.ts).
 */
import type { ExtensionSnapshot } from '@shared/contracts';
import type { MarketplaceListItem, UpdateInfo } from '@shared/ipc';

export type MarketplaceFilter = 'all' | 'official' | 'installed';

export interface MarketplaceRow {
  key: string; // 'gh:owner/repo' | 'ext:<id>'
  title: string;
  subtitle: string; // catalog description, or 'v1.2.3[ · dev install]' (suffix only when origin is 'dev')
  /** Repo-fetched icon, falling back to the installed snapshot's — absent
   *  renders the letter glyph. */
  iconDataUrl?: string;
  catalog?: MarketplaceListItem;
  installed?: ExtensionSnapshot; // live AppState match (source of truth for installed-ness)
  updateAvailable: boolean;
}

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

/** Catalog rows first (org order), then installed-but-not-in-catalog rows (dev installs).
 *  filter: 'official' = catalog rows only; 'installed' = rows with `installed`;
 *  query: case-insensitive substring on title. */
export function buildRows(
  items: MarketplaceListItem[],
  extensions: ExtensionSnapshot[],
  updates: UpdateInfo[],
  filter: MarketplaceFilter,
  query: string,
): MarketplaceRow[] {
  const updateIds = new Set(updates.map((u) => u.id));
  const matchedIds = new Set<string>();

  const catalogRows: MarketplaceRow[] = items.map((item) => {
    const installed = matchInstalled(item, extensions);
    if (installed) matchedIds.add(installed.id);
    return {
      key: `gh:${item.owner}/${item.repo}`,
      title: item.displayName,
      subtitle: item.description,
      iconDataUrl: item.iconDataUrl ?? installed?.iconDataUrl,
      catalog: item,
      installed,
      updateAvailable: installed != null && updateIds.has(installed.id),
    };
  });

  const installedOnlyRows: MarketplaceRow[] = extensions
    .filter((e) => !matchedIds.has(e.id))
    .map((e) => ({
      key: `ext:${e.id}`,
      title: e.name,
      // "dev install" is a claim about *how the extension got here*, so it
      // must key off the snapshot's own origin, not off catalog absence —
      // a marketplace-origin extension whose repo dropped out of the
      // catalog (e.g. topic removed) is still a marketplace install.
      subtitle:
        e.origin === 'dev' ? `v${e.version} · dev install` : `v${e.version}`,
      iconDataUrl: e.iconDataUrl,
      installed: e,
      updateAvailable: updateIds.has(e.id),
    }));

  let rows = [...catalogRows, ...installedOnlyRows];

  if (filter === 'official') {
    rows = rows.filter((r) => r.catalog !== undefined);
  } else if (filter === 'installed') {
    rows = rows.filter((r) => r.installed !== undefined);
  }

  const q = query.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => r.title.toLowerCase().includes(q));
  }

  return rows;
}
