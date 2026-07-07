import type { ExtensionSnapshot } from '@shared/contracts';
import type { MarketplaceListItem, UpdateInfo } from '@shared/ipc';
import { bareGithubRef, buildRows, matchInstalled } from '../rows';

function item(overrides: Partial<MarketplaceListItem> = {}): MarketplaceListItem {
  return {
    owner: 'kia-plugins',
    repo: 'gmail-tools',
    fullName: 'kia-plugins/gmail-tools',
    displayName: 'Gmail Tools',
    description: 'Gmail productivity tools.',
    ...overrides,
  };
}

function ext(overrides: Partial<ExtensionSnapshot> = {}): ExtensionSnapshot {
  return {
    id: 'ext.gmail-tools',
    name: 'Gmail Tools',
    version: '1.0.0',
    origin: 'marketplace',
    enabled: true,
    status: 'activated',
    caps: [],
    sourceIds: [],
    oauthSources: [],
    ref: 'github:kia-plugins/gmail-tools',
    ...overrides,
  };
}

function update(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    id: 'ext.gmail-tools',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    ref: 'github:kia-plugins/gmail-tools@v1.1.0',
    ...overrides,
  };
}

describe('matchInstalled', () => {
  it('matches a bare github ref', () => {
    const e = ext({ ref: 'github:kia-plugins/gmail-tools' });
    expect(matchInstalled(item(), [e])).toBe(e);
  });

  it('matches an @-pinned github ref', () => {
    const e = ext({ ref: 'github:kia-plugins/gmail-tools@v2.0.0' });
    expect(matchInstalled(item(), [e])).toBe(e);
  });

  it('does not match a different owner/repo', () => {
    const e = ext({ ref: 'github:kia-plugins/other-repo' });
    expect(matchInstalled(item(), [e])).toBeUndefined();
  });

  it('does not match a file: dev-install ref', () => {
    const e = ext({ ref: 'file:/Users/dev/gmail-tools' });
    expect(matchInstalled(item(), [e])).toBeUndefined();
  });

  it('does not partial-match a ref that merely starts with the owner/repo string without the @ separator', () => {
    // e.g. 'github:kia-plugins/gmail-tools-extra' must not match
    // 'kia-plugins/gmail-tools'.
    const e = ext({ ref: 'github:kia-plugins/gmail-tools-extra' });
    expect(matchInstalled(item(), [e])).toBeUndefined();
  });
});

describe('bareGithubRef', () => {
  it('strips an @tag pin suffix off a pinned github ref', () => {
    expect(bareGithubRef('github:kia-plugins/gmail-tools@v1.0.0')).toBe(
      'github:kia-plugins/gmail-tools',
    );
  });

  it('passes an already-bare github ref through unchanged', () => {
    expect(bareGithubRef('github:kia-plugins/gmail-tools')).toBe(
      'github:kia-plugins/gmail-tools',
    );
  });

  it('passes a non-github ref through unchanged', () => {
    expect(bareGithubRef('file:/Users/dev/gmail-tools')).toBe('file:/Users/dev/gmail-tools');
  });
});

describe('buildRows', () => {
  it('merges a catalog item with its installed snapshot: one row, catalog description as subtitle', () => {
    const e = ext();
    const rows = buildRows([item()], [e], [], 'all', '');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'gh:kia-plugins/gmail-tools',
      title: 'Gmail Tools',
      subtitle: 'Gmail productivity tools.',
      installed: e,
      updateAvailable: false,
    });
  });

  it('a catalog item with no installed snapshot renders installed as undefined', () => {
    const rows = buildRows([item()], [], [], 'all', '');
    expect(rows).toHaveLength(1);
    expect(rows[0].installed).toBeUndefined();
  });

  it('a dev install (file: ref) with no catalog match appears as an installed-only row after catalog rows', () => {
    const devInstall = ext({
      id: 'ext.local-tool',
      name: 'Local Tool',
      version: '0.1.0',
      origin: 'dev',
      ref: 'file:/Users/dev/local-tool',
    });
    const rows = buildRows([item()], [devInstall], [], 'all', '');

    expect(rows).toHaveLength(2);
    expect(rows[0].key).toBe('gh:kia-plugins/gmail-tools');
    expect(rows[1]).toMatchObject({
      key: 'ext:ext.local-tool',
      title: 'Local Tool',
      subtitle: 'v0.1.0 · dev install',
      installed: devInstall,
    });
    expect(rows[1].catalog).toBeUndefined();
  });

  it('an installed-only row with origin "dev" gets the "dev install" subtitle suffix', () => {
    const devInstall = ext({
      id: 'ext.local-tool',
      name: 'Local Tool',
      version: '0.1.0',
      origin: 'dev',
      ref: 'file:/Users/dev/local-tool',
    });
    const rows = buildRows([], [devInstall], [], 'all', '');
    expect(rows[0].subtitle).toBe('v0.1.0 · dev install');
  });

  it('an installed-only row with origin "marketplace" (absent from the catalog, e.g. its topic was dropped) gets no "dev install" suffix', () => {
    const droppedFromCatalog = ext({
      id: 'ext.gmail-tools',
      name: 'Gmail Tools',
      version: '1.0.0',
      origin: 'marketplace',
      ref: 'github:kia-plugins/gmail-tools@v1.0.0',
    });
    const rows = buildRows([], [droppedFromCatalog], [], 'all', '');
    expect(rows[0].subtitle).toBe('v1.0.0');
    expect(rows[0].subtitle).not.toContain('dev install');
  });

  it('matches a pinned-ref installed extension to its catalog item, not as a separate row', () => {
    const pinned = ext({ ref: 'github:kia-plugins/gmail-tools@v1.0.0' });
    const rows = buildRows([item()], [pinned], [], 'all', '');

    expect(rows).toHaveLength(1);
    expect(rows[0].installed).toBe(pinned);
  });

  it("filter 'official' keeps only catalog rows, dropping installed-only dev installs", () => {
    const devInstall = ext({ id: 'ext.local-tool', name: 'Local Tool', ref: 'file:/x' });
    const rows = buildRows([item()], [devInstall], [], 'official', '');

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('gh:kia-plugins/gmail-tools');
  });

  it("filter 'installed' keeps catalog rows that are installed plus dev-install rows, drops uninstalled catalog rows", () => {
    const other = item({ owner: 'kia-plugins', repo: 'other', displayName: 'Other', fullName: 'kia-plugins/other' });
    const devInstall = ext({ id: 'ext.local-tool', name: 'Local Tool', ref: 'file:/x' });
    const installedMatch = ext({ ref: 'github:kia-plugins/gmail-tools' });

    const rows = buildRows([item(), other], [installedMatch, devInstall], [], 'installed', '');

    const keys = rows.map((r) => r.key).sort();
    expect(keys).toEqual(['ext:ext.local-tool', 'gh:kia-plugins/gmail-tools'].sort());
  });

  it("filter 'all' includes everything: catalog (installed or not) and dev installs", () => {
    const other = item({ owner: 'kia-plugins', repo: 'other', displayName: 'Other', fullName: 'kia-plugins/other' });
    const devInstall = ext({ id: 'ext.local-tool', name: 'Local Tool', ref: 'file:/x' });

    const rows = buildRows([item(), other], [devInstall], [], 'all', '');

    expect(rows.map((r) => r.key)).toEqual([
      'gh:kia-plugins/gmail-tools',
      'gh:kia-plugins/other',
      'ext:ext.local-tool',
    ]);
  });

  it('search matches the title case-insensitively, across both catalog and installed-only rows', () => {
    const devInstall = ext({ id: 'ext.local-tool', name: 'Local Tool', ref: 'file:/x' });
    const rows = buildRows([item()], [devInstall], [], 'all', 'GMAIL');

    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe('gh:kia-plugins/gmail-tools');
  });

  it('search with no match returns an empty array', () => {
    const rows = buildRows([item()], [], [], 'all', 'nonexistent');
    expect(rows).toEqual([]);
  });

  it('updateAvailable is true for a matched catalog row whose installed id appears in updates', () => {
    const e = ext();
    const rows = buildRows([item()], [e], [update({ id: e.id })], 'all', '');
    expect(rows[0].updateAvailable).toBe(true);
  });

  it('updateAvailable is true for a dev-install row whose id appears in updates', () => {
    const devInstall = ext({ id: 'ext.local-tool', name: 'Local Tool', ref: 'file:/x' });
    const rows = buildRows([], [devInstall], [update({ id: 'ext.local-tool' })], 'all', '');
    expect(rows[0].updateAvailable).toBe(true);
  });

  it('updateAvailable is false when the update id does not match anything installed', () => {
    const e = ext();
    const rows = buildRows([item()], [e], [update({ id: 'ext.someone-else' })], 'all', '');
    expect(rows[0].updateAvailable).toBe(false);
  });

  it('an uninstalled catalog row is never flagged with updateAvailable even if its repo id happens to appear in updates', () => {
    const rows = buildRows([item()], [], [update({ id: 'ext.gmail-tools' })], 'all', '');
    expect(rows[0].updateAvailable).toBe(false);
  });
});
