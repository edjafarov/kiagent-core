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
import { matchInstalled } from '../Marketplace/rows';

/** The sources core ships with. */
export const BUILT_IN_SOURCE_IDS: ReadonlySet<string> = new Set([
  'gmail',
  'imap',
  'local-folder',
]);

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
  /** Source ids a product manages elsewhere. */
  hidden?: readonly string[];
  query?: string;
}): Catalog {
  const hidden = new Set(input.hidden ?? []);
  const connected = new Map<string, number>();
  for (const a of input.accounts)
    connected.set(a.source, (connected.get(a.source) ?? 0) + 1);

  const sentenceFor = (sourceId: string): string => {
    const builtIn = BUILT_IN_SENTENCES[sourceId];
    if (builtIn) return builtIn;
    const owner = input.extensions.find((e) => e.sourceIds.includes(sourceId));
    const item =
      owner &&
      input.items.find(
        (i) => matchInstalled(i, [...input.extensions])?.id === owner.id,
      );
    return item?.description ?? '';
  };

  const sources: CatalogTile[] = input.descriptors
    .filter((d) => !hidden.has(d.id))
    .map((d) => {
      const n = connected.get(d.id) ?? 0;
      const owner = input.extensions.find((e) => e.sourceIds.includes(d.id));
      return {
        key: `source:${d.id}`,
        name: d.name,
        sentence: sentenceFor(d.id),
        brand: sourceBrand(d.id, {
          name: d.name,
          iconDataUrl: owner?.iconDataUrl,
        }),
        footer:
          n > 0
            ? { kind: 'connected', n }
            : BUILT_IN_SOURCE_IDS.has(d.id)
              ? { kind: 'built-in' }
              : { kind: 'none' },
        start: { sourceId: d.id },
      };
    });

  const store: CatalogTile[] = input.items
    .filter((i) => !matchInstalled(i, [...input.extensions]))
    .map((i) => ({
      key: `store:${i.owner}/${i.repo}`,
      name: i.displayName,
      sentence: i.description,
      brand: sourceBrand(i.repo, {
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
