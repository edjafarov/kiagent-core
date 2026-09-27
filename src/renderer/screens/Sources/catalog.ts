// The one catalog: every source you can connect now (built in, or from an
// installed extension) and every store extension not installed yet. Pure;
// the catalog page, the list's "Add more" chips and a product's first run
// all read it.
import type {
  Account,
  ExtensionSnapshot,
  SourceDescriptor,
} from '@shared/contracts';
import type { MarketplaceListItem } from '@shared/ipc';
import { sourceBrand, type Brand } from '@shared/web-ui/ui';
import { matchInstalled, storeBrandId } from '@renderer/extensions/match';
import { sourceBrandOf } from './source-brand';

const BUILT_IN_SENTENCES: Record<string, string> = {
  gmail: 'Mail, indexed and searchable',
  imap: 'Mail from any IMAP account',
  'local-folder': 'Folders you choose on this computer',
};

export type CatalogFooter =
  | { kind: 'connected'; n: number }
  | { kind: 'built-in' }
  | { kind: 'install' }
  | { kind: 'none' };

export interface CatalogTile {
  key: string;
  name: string;
  sentence: string;
  brand: Brand;
  footer: CatalogFooter;
  /** A source starts its connect flow; a store item its install. */
  start: { sourceId: string } | { item: MarketplaceListItem };
}

export interface Catalog {
  sources: CatalogTile[];
  store: CatalogTile[];
}

export function buildCatalog(input: {
  descriptors: readonly SourceDescriptor[];
  items: readonly MarketplaceListItem[];
  extensions: readonly ExtensionSnapshot[];
  accounts: readonly Pick<Account, 'source'>[];
  query?: string;
}): Catalog {
  const connected = new Map<string, number>();
  for (const a of input.accounts)
    connected.set(a.source, (connected.get(a.source) ?? 0) + 1);

  // Each store listing's installed extension, found once.
  const extensions = [...input.extensions];
  const listingOf = new Map<string, MarketplaceListItem>();
  for (const i of input.items) {
    const e = matchInstalled(i, extensions);
    if (e) listingOf.set(e.id, i);
  }

  const sources: CatalogTile[] = input.descriptors.map((d) => {
    const n = connected.get(d.id) ?? 0;
    const owner = extensions.find((e) => e.sourceIds.includes(d.id));
    return {
      key: `source:${d.id}`,
      name: d.name,
      sentence:
        BUILT_IN_SENTENCES[d.id] ??
        (owner && listingOf.get(owner.id)?.description) ??
        '',
      brand: sourceBrandOf(d.id, d.name, extensions),
      // No extension owns it: it ships with the app.
      footer:
        n > 0
          ? { kind: 'connected', n }
          : owner
            ? { kind: 'none' }
            : { kind: 'built-in' },
      start: { sourceId: d.id },
    };
  });

  const store: CatalogTile[] = input.items
    .filter((i) => !matchInstalled(i, extensions))
    .map((i) => ({
      key: `store:${i.owner}/${i.repo}`,
      name: i.displayName,
      sentence: i.description,
      brand: sourceBrand(storeBrandId(i.repo), {
        name: i.displayName,
        iconDataUrl: i.iconDataUrl,
      }),
      footer: { kind: 'install' },
      start: { item: i },
    }));

  const q = (input.query ?? '').trim().toLowerCase();
  const match = (t: CatalogTile): boolean =>
    q === '' ||
    t.name.toLowerCase().includes(q) ||
    t.sentence.toLowerCase().includes(q);
  return { sources: sources.filter(match), store: store.filter(match) };
}

/** "2 connected" / "Built in" / "Install" / "". */
export function footerWords(f: CatalogFooter): string {
  if (f.kind === 'connected') return `${f.n} connected`;
  if (f.kind === 'built-in') return 'Built in';
  if (f.kind === 'install') return 'Install';
  return '';
}
