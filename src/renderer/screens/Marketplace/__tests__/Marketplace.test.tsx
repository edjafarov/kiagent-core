import '@testing-library/jest-dom';
import React from 'react';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import type { ExtensionSnapshot } from '@shared/contracts';
import type { MarketplaceListItem, UpdateInfo } from '@shared/ipc';
import { Marketplace } from '..';

// index.tsx mounts Detail (Task 10), which imports react-markdown for the
// README pane; react-markdown v9 is ESM-only and must be mocked under
// ts-jest in every test that renders it, directly or transitively.
jest.mock(
  'react-markdown',
  () =>
    function (p: { children: string }) {
      return <div data-testid="md">{p.children}</div>;
    },
);

const invoke = jest.fn();
beforeEach(() => {
  invoke.mockReset();
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: () => () => {},
  };
  mockState.extensions = [];
});

let mockState: { extensions: ExtensionSnapshot[] } = { extensions: [] };

jest.mock('../../../state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));

function catalogItem(
  overrides: Partial<MarketplaceListItem> = {},
): MarketplaceListItem {
  return {
    owner: 'kia-plugins',
    repo: 'gmail-tools',
    fullName: 'kia-plugins/gmail-tools',
    displayName: 'Gmail Tools',
    description: 'Gmail productivity tools.',
    ...overrides,
  };
}

function extSnapshot(
  overrides: Partial<ExtensionSnapshot> = {},
): ExtensionSnapshot {
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

/** Resolves marketplace:list with `items` and marketplace:check-updates with
 *  `updates` (or leaves it pending if omitted, when a test doesn't care). */
function mockInvokes(
  items: MarketplaceListItem[],
  updates: UpdateInfo[] = [],
): void {
  invoke.mockImplementation((channel: string) => {
    if (channel === 'marketplace:list') return Promise.resolve(items);
    if (channel === 'marketplace:check-updates')
      return Promise.resolve(updates);
    return Promise.reject(new Error(`unexpected channel ${channel}`));
  });
}

describe('Marketplace', () => {
  test('renders catalog rows after marketplace:list resolves', async () => {
    mockInvokes([
      catalogItem(),
      catalogItem({
        owner: 'kia-plugins',
        repo: 'other',
        fullName: 'kia-plugins/other',
        displayName: 'Other Plugin',
        description: 'Another one.',
      }),
    ]);

    render(<Marketplace />);

    expect(screen.getByText('Loading catalog…')).toBeInTheDocument();

    expect(await screen.findByText('Gmail Tools')).toBeInTheDocument();
    expect(screen.getByText('Other Plugin')).toBeInTheDocument();
  });

  test('a file:-ref installed snapshot appears as an installed-only row', async () => {
    mockInvokes([catalogItem()]);
    mockState.extensions = [
      extSnapshot({
        id: 'ext.local-tool',
        name: 'Local Tool',
        version: '0.2.0',
        origin: 'dev',
        ref: 'file:/Users/dev/local-tool',
      }),
    ];

    render(<Marketplace />);

    await screen.findByText('Gmail Tools');
    expect(screen.getByText('Local Tool')).toBeInTheDocument();
    expect(screen.getByText('v0.2.0 · dev install')).toBeInTheDocument();
  });

  test("pill 'Installed' filters out catalog rows with no installed match", async () => {
    mockInvokes([
      catalogItem(),
      catalogItem({
        owner: 'kia-plugins',
        repo: 'other',
        fullName: 'kia-plugins/other',
        displayName: 'Other Plugin',
        description: 'Another one.',
      }),
    ]);
    mockState.extensions = [extSnapshot()];

    render(<Marketplace />);
    await screen.findByText('Gmail Tools');
    expect(screen.getByText('Other Plugin')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Installed' }));

    expect(screen.getByText('Gmail Tools')).toBeInTheDocument();
    expect(screen.queryByText('Other Plugin')).not.toBeInTheDocument();
  });

  test('search filters rows by title', async () => {
    mockInvokes([
      catalogItem(),
      catalogItem({
        owner: 'kia-plugins',
        repo: 'other',
        fullName: 'kia-plugins/other',
        displayName: 'Other Plugin',
        description: 'Another one.',
      }),
    ]);

    render(<Marketplace />);
    await screen.findByText('Gmail Tools');

    fireEvent.change(screen.getByLabelText('Search plugins'), {
      target: { value: 'other' },
    });

    expect(screen.queryByText('Gmail Tools')).not.toBeInTheDocument();
    expect(screen.getByText('Other Plugin')).toBeInTheDocument();
  });

  test('a search matching nothing renders a "no plugins found" message instead of a blank list', async () => {
    mockInvokes([catalogItem()]);

    render(<Marketplace />);
    await screen.findByText('Gmail Tools');

    fireEvent.change(screen.getByLabelText('Search plugins'), {
      target: { value: 'nonexistent' },
    });

    expect(screen.queryByText('Gmail Tools')).not.toBeInTheDocument();
    expect(screen.getByText('No plugins found.')).toBeInTheDocument();
  });

  test('an installed extension with origin "marketplace" absent from the catalog gets no "dev install" subtitle', async () => {
    mockInvokes([catalogItem()]);
    mockState.extensions = [
      extSnapshot({
        id: 'ext.dropped-tool',
        name: 'Dropped Tool',
        version: '1.2.0',
        origin: 'marketplace',
        ref: 'github:kia-plugins/dropped-tool@v1.2.0',
      }),
    ];

    render(<Marketplace />);

    await screen.findByText('Gmail Tools');
    expect(screen.getByText('Dropped Tool')).toBeInTheDocument();
    expect(screen.getByText('v1.2.0')).toBeInTheDocument();
    expect(screen.queryByText('v1.2.0 · dev install')).not.toBeInTheDocument();
  });

  test('Update badge appears for an id returned by marketplace:check-updates', async () => {
    mockInvokes(
      [catalogItem()],
      [
        {
          id: 'ext.gmail-tools',
          installedVersion: '1.0.0',
          latestVersion: '1.1.0',
          ref: 'github:kia-plugins/gmail-tools@v1.1.0',
        },
      ],
    );
    mockState.extensions = [extSnapshot()];

    render(<Marketplace />);

    const title = await screen.findByText('Gmail Tools');
    const row = title.closest('.mkt-row') as HTMLElement;
    // Scoped to the row: the left-pane filter pills also render an
    // "Installed" label, so an unscoped getByText would be ambiguous.
    expect(await within(row).findByText('Update')).toBeInTheDocument();
    expect(within(row).getByText('Installed')).toBeInTheDocument();
  });

  test('list rejection renders the error message and Retry re-invokes the fetch', async () => {
    invoke.mockImplementation((channel: string) => {
      if (channel === 'marketplace:list')
        return Promise.reject(new Error('network down'));
      if (channel === 'marketplace:check-updates') return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<Marketplace />);

    expect(await screen.findByText('network down')).toBeInTheDocument();

    mockInvokes([catalogItem()]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('Gmail Tools')).toBeInTheDocument();
  });

  test('selecting a row mounts the Detail pane; nothing selected shows the empty notice', async () => {
    // Detail's own marketplace:detail fetch is irrelevant to this routing
    // test; give it a harmless "no installable release" response rather
    // than an unhandled-channel rejection.
    invoke.mockImplementation((channel: string) => {
      if (channel === 'marketplace:list')
        return Promise.resolve([catalogItem()]);
      if (channel === 'marketplace:check-updates') return Promise.resolve([]);
      if (channel === 'marketplace:detail')
        return Promise.resolve({
          listing: catalogItem(),
          readmeMarkdown: '',
          latest: null,
        });
      return Promise.reject(new Error(`unexpected channel ${channel}`));
    });

    render(<Marketplace />);
    await screen.findByText('Gmail Tools');

    expect(
      screen.getByText('Select an extension to see details.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Gmail Tools'));

    expect(
      screen.queryByText('Select an extension to see details.'),
    ).not.toBeInTheDocument();
    // Detail's header re-renders the row title alongside the version line.
    expect(
      await screen.findByText('No installable release yet'),
    ).toBeInTheDocument();
  });

  test('an installed, disabled extension shows the Disabled badge', async () => {
    mockInvokes([catalogItem()]);
    mockState.extensions = [extSnapshot({ enabled: false })];

    render(<Marketplace />);

    await screen.findByText('Gmail Tools');
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  test('list fetch resolving after unmount throws nothing and logs nothing', async () => {
    // React 18+ made setState on an unmounted component a silent no-op, so
    // the alive-ref guard's absence is not observable from out here — this
    // is a smoke test for the late-resolution race (no throw, no console
    // noise), not proof the guard exists.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let resolveList: (items: MarketplaceListItem[]) => void = () => {};
      invoke.mockImplementation((channel: string) => {
        if (channel === 'marketplace:list') {
          return new Promise((resolve) => {
            resolveList = resolve;
          });
        }
        if (channel === 'marketplace:check-updates') return Promise.resolve([]);
        return Promise.reject(new Error(`unexpected channel ${channel}`));
      });

      const { unmount } = render(<Marketplace />);
      unmount();
      resolveList([catalogItem()]);

      // Flush microtasks so the resolved promise's `.then` actually runs.
      await waitFor(() => Promise.resolve());

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
