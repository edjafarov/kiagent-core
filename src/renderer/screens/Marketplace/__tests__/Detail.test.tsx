import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import type { ExtensionSnapshot } from '@shared/contracts';
import type { MarketplaceListItem, PluginDetail } from '@shared/ipc';
import { CAP_CATALOG } from '../../../components/cap-catalog';
import type { MarketplaceRow } from '../rows';
import { Detail } from '../Detail';

// react-markdown v9 is ESM-only and must be mocked under ts-jest (importing
// it un-mocked crashes Jest) — this factory stands in for the real renderer
// everywhere Detail (or anything importing it) is under test.
jest.mock('react-markdown', () => (p: { children: string }) => (
  <div data-testid="md">{p.children}</div>
));

const invoke = jest.fn();
let mockState: { extensions: ExtensionSnapshot[] } = { extensions: [] };

jest.mock('../../../state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));

beforeEach(() => {
  invoke.mockReset();
  (window as unknown as { kiagent: unknown }).kiagent = { invoke, on: () => () => {} };
  mockState.extensions = [];
});

function catalogItem(overrides: Partial<MarketplaceListItem> = {}): MarketplaceListItem {
  return {
    owner: 'kia-plugins',
    repo: 'gmail-tools',
    fullName: 'kia-plugins/gmail-tools',
    displayName: 'Gmail Tools',
    description: 'Gmail productivity tools.',
    ...overrides,
  };
}

function extSnapshot(overrides: Partial<ExtensionSnapshot> = {}): ExtensionSnapshot {
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

function pluginDetail(overrides: Partial<PluginDetail> = {}): PluginDetail {
  return {
    listing: catalogItem(),
    readmeMarkdown: '# Gmail Tools\n\nDoes gmail things.',
    latest: {
      tag: 'v1.1.0',
      version: '1.1.0',
      publishedAt: '2026-01-01T00:00:00Z',
      tarballUrl: 'https://example.com/gmail-tools.tgz',
      prerelease: false,
    },
    ...overrides,
  };
}

/** Not-installed catalog row (the default shape used by most tests below). */
function catalogRow(overrides: Partial<MarketplaceRow> = {}): MarketplaceRow {
  return {
    key: 'gh:kia-plugins/gmail-tools',
    title: 'Gmail Tools',
    subtitle: 'Gmail productivity tools.',
    catalog: catalogItem(),
    installed: undefined,
    updateAvailable: false,
    ...overrides,
  };
}

/** Installed-but-not-in-catalog row (dev install), or used as a lightweight
 *  stand-in for "installed, no README fetch" scenarios that don't care
 *  about the marketplace:detail round-trip. */
function installedOnlyRow(overrides: Partial<MarketplaceRow> = {}): MarketplaceRow {
  return {
    key: 'ext:ext.gmail-tools',
    title: 'Gmail Tools',
    subtitle: 'v1.0.0 · dev install',
    catalog: undefined,
    installed: extSnapshot(),
    updateAvailable: false,
    ...overrides,
  };
}

function mockInvoke(handlers: Record<string, (payload: unknown) => unknown>): void {
  invoke.mockImplementation((channel: string, payload: unknown) => {
    const handler = handlers[channel];
    if (!handler) return Promise.reject(new Error(`unexpected channel ${channel}`));
    return Promise.resolve(handler(payload));
  });
}

describe('Detail', () => {
  test('catalog row invokes marketplace:detail and renders the README markdown', async () => {
    mockInvoke({
      'marketplace:detail': (payload) => {
        expect(payload).toEqual({ owner: 'kia-plugins', repo: 'gmail-tools' });
        return pluginDetail();
      },
    });

    render(<Detail row={catalogRow()} />);

    const md = await screen.findByTestId('md');
    expect(md).toHaveTextContent('Gmail Tools');
    expect(md).toHaveTextContent('Does gmail things.');
  });

  test('empty readmeMarkdown renders "No README." instead of the markdown pane', async () => {
    mockInvoke({
      'marketplace:detail': () => pluginDetail({ readmeMarkdown: '' }),
    });

    render(<Detail row={catalogRow()} />);

    expect(await screen.findByText('No README.')).toBeInTheDocument();
    expect(screen.queryByTestId('md')).not.toBeInTheDocument();
  });

  test('Install click previews with the github ref; confirming commits with the preview token', async () => {
    mockInvoke({
      'marketplace:detail': () => pluginDetail(),
      'extension:install-preview': (payload) => {
        expect(payload).toEqual({ ref: 'github:kia-plugins/gmail-tools' });
        return {
          ok: true,
          token: 'tok-1',
          id: 'ext.gmail-tools',
          name: 'Gmail Tools',
          version: '1.1.0',
          caps: ['net', 'query'],
          oauthSources: [{ id: 'google-docs', provider: 'google' }],
          sizeBytes: 2048,
          integrity: null,
        };
      },
      'extension:install-commit': (payload) => {
        expect(payload).toEqual({ token: 'tok-1' });
        return { ok: true, id: 'ext.gmail-tools' };
      },
    });

    render(<Detail row={catalogRow()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(CAP_CATALOG.net.label)).toBeInTheDocument();
    expect(within(dialog).getByText(CAP_CATALOG.query.label)).toBeInTheDocument();
    // The preview's oauth binding is part of install consent (I1): the
    // sign-in row must be visible BEFORE the user confirms the install.
    expect(
      within(dialog).getByText(
        /Signs in with your Google account \(google-docs\)/,
      ),
    ).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith('extension:install-commit', { token: 'tok-1' });
  });

  test('preview refusal shows an inline .mkt-error notice and never opens the modal', async () => {
    mockInvoke({
      'marketplace:detail': () => pluginDetail(),
      'extension:install-preview': () => ({ ok: false, error: 'rate limited, try later' }),
    });

    render(<Detail row={catalogRow()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

    const error = await screen.findByText('rate limited, try later');
    expect(error.closest('.mkt-error')).not.toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('commit refusal closes the modal and shows the inline error', async () => {
    mockInvoke({
      'marketplace:detail': () => pluginDetail(),
      'extension:install-preview': () => ({
        ok: true,
        token: 'tok-2',
        id: 'ext.gmail-tools',
        name: 'Gmail Tools',
        version: '1.1.0',
        caps: ['net'],
        sizeBytes: 1024,
        integrity: null,
      }),
      'extension:install-commit': () => ({ ok: false, error: 'disk full' }),
    });

    render(<Detail row={catalogRow()} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(await screen.findByText('disk full')).toBeInTheDocument();
  });

  test('needs-consent snapshot shows Review permissions; confirming grants consent by id with no preview call', async () => {
    mockInvoke({
      'extension:grant-consent': (payload) => {
        expect(payload).toEqual({ id: 'ext.gmail-tools' });
        return { ok: true };
      },
    });
    const snapshot = extSnapshot({ status: 'needs-consent', caps: ['db', 'ui'] });
    mockState.extensions = [snapshot];

    render(<Detail row={installedOnlyRow({ installed: snapshot })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Review permissions' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(CAP_CATALOG.db.label)).toBeInTheDocument();
    expect(within(dialog).getByText(CAP_CATALOG.ui.label)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Grant permissions' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith('extension:grant-consent', { id: 'ext.gmail-tools' });
    expect(invoke).not.toHaveBeenCalledWith('extension:install-preview', expect.anything());
  });

  test('an installed snapshot with oauthSources shows the sign-in row on the detail pane and in the review dialog', async () => {
    mockInvoke({
      'extension:grant-consent': () => ({ ok: true }),
    });
    const snapshot = extSnapshot({
      status: 'needs-consent',
      caps: ['net'],
      sourceIds: ['google-docs'],
      oauthSources: [{ id: 'google-docs', provider: 'google' }],
    });
    mockState.extensions = [snapshot];

    render(<Detail row={installedOnlyRow({ installed: snapshot })} />);

    // Detail pane permissions block (where caps are listed).
    const paneRow = await screen.findByText(
      /Signs in with your Google account \(google-docs\)/,
    );
    expect(paneRow.closest('.cm-cap-row')).toHaveClass('elevated');

    // Review-permissions dialog carries the same row.
    fireEvent.click(
      await screen.findByRole('button', { name: 'Review permissions' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(
        /Signs in with your Google account \(google-docs\)/,
      ),
    ).toBeInTheDocument();
  });

  test('uninstall refusal surfaces the exact error copy', async () => {
    const snapshot = extSnapshot();
    mockState.extensions = [snapshot];
    mockInvoke({
      'extension:uninstall': (payload) => {
        expect(payload).toEqual({ id: 'ext.gmail-tools' });
        return { ok: false, error: "Remove this connector's sources before uninstalling it." };
      },
    });

    render(<Detail row={installedOnlyRow({ installed: snapshot })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Uninstall' }));

    expect(
      await screen.findByText("Remove this connector's sources before uninstalling it."),
    ).toBeInTheDocument();
  });

  test.each([
    ['latest is null', pluginDetail({ latest: null })],
    [
      'latest has no tarballUrl',
      pluginDetail({ latest: { tag: 'v1.1.0', version: '1.1.0', publishedAt: '2026-01-01T00:00:00Z', tarballUrl: null, prerelease: false } }),
    ],
  ])('no installable release (%s) renders a disabled notice button', async (_label, detail) => {
    mockInvoke({ 'marketplace:detail': () => detail });

    render(<Detail row={catalogRow()} />);

    const btn = await screen.findByRole('button', { name: 'No installable release yet' });
    expect(btn).toBeDisabled();
  });

  test('the Enable/Disable toggle calls extension:set-enabled with the inverted flag', async () => {
    const snapshot = extSnapshot({ enabled: true });
    mockState.extensions = [snapshot];
    mockInvoke({
      'extension:set-enabled': (payload) => {
        expect(payload).toEqual({ id: 'ext.gmail-tools', enabled: false });
        return { ok: true };
      },
    });

    render(<Detail row={installedOnlyRow({ installed: snapshot })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Disable' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('extension:set-enabled', {
        id: 'ext.gmail-tools',
        enabled: false,
      }),
    );

    // And the reverse direction, from a disabled snapshot.
    invoke.mockReset();
    const disabledSnapshot = extSnapshot({ enabled: false });
    mockState.extensions = [disabledSnapshot];
    mockInvoke({
      'extension:set-enabled': (payload) => {
        expect(payload).toEqual({ id: 'ext.gmail-tools', enabled: true });
        return { ok: true };
      },
    });

    render(<Detail row={installedOnlyRow({ installed: disabledSnapshot })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('extension:set-enabled', {
        id: 'ext.gmail-tools',
        enabled: true,
      }),
    );
  });

  test('double-clicking Uninstall while the invoke is pending results in exactly ONE extension:uninstall invoke', async () => {
    const snapshot = extSnapshot();
    mockState.extensions = [snapshot];
    let resolve: (value: unknown) => void = () => {};
    const pending = new Promise((r) => {
      resolve = r;
    });
    mockInvoke({
      'extension:uninstall': () => pending,
    });

    render(<Detail row={installedOnlyRow({ installed: snapshot })} />);

    const uninstallBtn = await screen.findByRole('button', { name: 'Uninstall' });
    fireEvent.click(uninstallBtn);
    fireEvent.click(uninstallBtn);

    // Resolve the pending invoke
    resolve({ ok: true });
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(invoke).toHaveBeenCalledWith('extension:uninstall', { id: 'ext.gmail-tools' });
  });

  test('Update on a catalog-less marketplace-origin row previews with the bare (unpinned) installed ref', async () => {
    // Simulates an extension installed from the marketplace whose repo has
    // since dropped out of the catalog (e.g. topic removed): row.catalog is
    // undefined, but the installed snapshot still carries a pinned github:
    // ref and an update is flagged available.
    const snapshot = extSnapshot({ ref: 'github:kia-plugins/gmail-tools@v1.0.0' });
    mockState.extensions = [snapshot];
    mockInvoke({
      'extension:install-preview': (payload) => {
        expect(payload).toEqual({ ref: 'github:kia-plugins/gmail-tools' });
        return {
          ok: true,
          token: 'tok-update',
          id: 'ext.gmail-tools',
          name: 'Gmail Tools',
          version: '1.1.0',
          caps: ['net'],
          sizeBytes: 4096,
          integrity: null,
        };
      },
    });

    render(
      <Detail
        row={installedOnlyRow({ installed: snapshot, updateAvailable: true })}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('extension:install-preview', {
        ref: 'github:kia-plugins/gmail-tools',
      }),
    );
  });

  test('a catalog-less row whose installed ref is not a github: ref (e.g. a file: dev install) never renders Update, even if flagged updateAvailable', async () => {
    const snapshot = extSnapshot({ origin: 'dev', ref: 'file:/Users/dev/gmail-tools' });
    mockState.extensions = [snapshot];

    render(
      <Detail
        row={installedOnlyRow({ installed: snapshot, updateAvailable: true })}
      />,
    );

    await screen.findByRole('button', { name: 'Uninstall' });
    expect(screen.queryByRole('button', { name: 'Update' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Installed' })).toBeDisabled();
  });

  test('an installed extension with errored status renders the error notice', async () => {
    const snapshot = extSnapshot({ status: 'errored', error: 'Something went wrong' });
    mockState.extensions = [snapshot];

    render(<Detail row={installedOnlyRow({ installed: snapshot })} />);

    const errorNotice = await screen.findByText('Something went wrong');
    expect(errorNotice.closest('.mkt-error')).not.toBeNull();
  });
});
