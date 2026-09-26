import type { ExtensionSnapshot, SourceDescriptor } from '@shared/contracts';
import type { MarketplaceListItem } from '@shared/ipc';
import { buildCatalog, footerWords } from '../catalog';

const d = (id: string, name: string): SourceDescriptor => ({
  id,
  name,
  documentTypes: [],
  auth: 'oauth',
});
const item = (repo: string, displayName: string, description: string) =>
  ({
    owner: 'example-org',
    repo,
    fullName: `example-org/${repo}`,
    displayName,
    description,
  }) as MarketplaceListItem;
const ext = (id: string, repo: string, sourceIds: string[]) =>
  ({
    id,
    name: id,
    version: '1.0.0',
    origin: 'marketplace',
    enabled: true,
    status: 'activated',
    caps: [],
    sourceIds,
    oauthSources: [],
    ref: `github:example-org/${repo}`,
  }) as ExtensionSnapshot;

const base = {
  descriptors: [
    d('gmail', 'Gmail'),
    d('slack', 'Slack'),
    d('meetings', 'Meetings'),
  ],
  items: [
    item('slack-connector', 'Slack', 'Channels and DMs from your workspace'),
    item('dropbox-connector', 'Dropbox', 'Files and folders from Dropbox'),
  ],
  extensions: [ext('slack-ext', 'slack-connector', ['slack'])],
  accounts: [{ source: 'slack' }, { source: 'slack' }],
};

test('sources: one tile per descriptor, with its sentence and footer', () => {
  const { sources } = buildCatalog(base);
  expect(
    sources.map((t) => [t.name, t.sentence, footerWords(t.footer)]),
  ).toEqual([
    ['Gmail', 'Mail, indexed and searchable', 'Built in'],
    ['Slack', 'Channels and DMs from your workspace', '2 connected'],
    ['Meetings', '', ''],
  ]);
  expect(sources[0].start).toEqual({ sourceId: 'gmail' });
});

test('store: only what is not installed, never an installed extension twice', () => {
  const { store } = buildCatalog(base);
  expect(store.map((t) => t.name)).toEqual(['Dropbox']);
  expect(footerWords(store[0].footer)).toBe('Install');
  expect(store[0].start).toEqual({ item: base.items[1] });
});

test('hidden sources and search narrow both sections', () => {
  expect(
    buildCatalog({ ...base, hidden: ['meetings'] }).sources.map((t) => t.name),
  ).toEqual(['Gmail', 'Slack']);
  const found = buildCatalog({ ...base, query: 'folders' });
  expect(found.sources).toEqual([]);
  expect(found.store.map((t) => t.name)).toEqual(['Dropbox']);
});
