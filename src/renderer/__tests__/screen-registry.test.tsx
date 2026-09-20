import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { ExtensionSnapshot } from '@shared/contracts';

import {
  createScreenRegistry,
  getDefaultScreens,
  registerContributedScreens,
  resetContributedScreens,
  type ScreenFactory,
} from '../screen-registry';

// getDefaultScreens() pulls in Marketplace -> Detail.tsx -> react-markdown,
// which is ESM-only and must be mocked under ts-jest in every test that
// imports screen-registry.tsx, directly or transitively — same mock as
// Marketplace/__tests__/{Marketplace,Detail}.test.tsx.
jest.mock(
  'react-markdown',
  () =>
    function (p: { children: string }) {
      return <div data-testid="md">{p.children}</div>;
    },
);

// B3 item 5: the shared "unavailable" screen, the registration seam, and
// per-contribution error boundaries. Core registers no contributed screens
// itself — every case below registers its own fixture factory and cleans
// up, so this file owns the ONLY writes to the module-level registry in
// the whole suite.

function extSnapshot(
  overrides: Partial<ExtensionSnapshot> = {},
): ExtensionSnapshot {
  return {
    id: 'test.contrib',
    name: 'Contrib Extension',
    version: '1.0.0',
    origin: 'bundled',
    enabled: true,
    status: 'activated',
    caps: ['ui'],
    sourceIds: [],
    oauthSources: [],
    ui: [{ id: 'main', slot: 'screen', title: 'Main Screen' }],
    ...overrides,
  };
}

const navigate = () => {};

afterEach(() => {
  resetContributedScreens();
});

describe('createScreenRegistry — known views (unchanged)', () => {
  it('still resolves core screens for a KnownView', () => {
    const registry = createScreenRegistry(getDefaultScreens());
    const el = registry.get('logs', {}, navigate, []);
    expect(el).not.toBeNull();
  });
});

describe('createScreenRegistry — contributed views (ExtView)', () => {
  it('shows the unavailable screen, naming the extension, when no factory is registered', () => {
    const registry = createScreenRegistry(getDefaultScreens());
    const el = registry.get('ext:test.contrib/main', {}, navigate, [
      extSnapshot(),
    ]);
    render(<>{el}</>);
    expect(screen.getAllByText(/Contrib Extension/).length).toBeGreaterThan(0);
  });

  it('shows the unavailable screen for an uninstalled extension', () => {
    const registry = createScreenRegistry(getDefaultScreens());
    const el = registry.get('ext:test.nope/main', {}, navigate, []);
    render(<>{el}</>);
    // No snapshot at all — falls back to the raw extension id as the name.
    expect(screen.getAllByText(/test\.nope/).length).toBeGreaterThan(0);
  });

  it.each(['disabled', 'activating', 'needs-consent'] as const)(
    'never mounts a live factory for an ENABLED extension whose status is %s (the first boot snapshot)',
    (status) => {
      // extension-platform's start() creates every entry as
      // `status: 'disabled', enabled: true` and pushes a snapshot before any
      // activate() — a gate that only lists the bad statuses falls open here.
      registerContributedScreens({
        'ext:test.contrib/main': {
          factory: () => <div data-testid="live-screen">live</div>,
        } satisfies ScreenFactory,
      });
      const registry = createScreenRegistry(getDefaultScreens());
      const el = registry.get('ext:test.contrib/main', {}, navigate, [
        extSnapshot({ enabled: true, status }),
      ]);
      render(<>{el}</>);
      expect(screen.queryByTestId('live-screen')).not.toBeInTheDocument();
      expect(screen.getAllByText(/Contrib Extension/).length).toBeGreaterThan(
        0,
      );
    },
  );

  it('shows the unavailable screen for a disabled extension even though a factory IS registered', () => {
    registerContributedScreens({
      'ext:test.contrib/main': {
        factory: () => <div data-testid="live-screen">live</div>,
      } satisfies ScreenFactory,
    });
    const registry = createScreenRegistry(getDefaultScreens());
    const el = registry.get('ext:test.contrib/main', {}, navigate, [
      extSnapshot({ enabled: false, status: 'disabled' }),
    ]);
    render(<>{el}</>);
    expect(screen.queryByTestId('live-screen')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Contrib Extension/).length).toBeGreaterThan(0);
  });

  it('shows the unavailable screen for a failed (errored) extension', () => {
    registerContributedScreens({
      'ext:test.contrib/main': {
        factory: () => <div data-testid="live-screen">live</div>,
      } satisfies ScreenFactory,
    });
    const registry = createScreenRegistry(getDefaultScreens());
    const el = registry.get('ext:test.contrib/main', {}, navigate, [
      extSnapshot({ status: 'errored', error: 'boom' }),
    ]);
    render(<>{el}</>);
    expect(screen.queryByTestId('live-screen')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Contrib Extension/).length).toBeGreaterThan(0);
  });

  it('renders a registered factory for an activated, enabled extension', () => {
    registerContributedScreens({
      'ext:test.contrib/main': {
        factory: () => <div data-testid="live-screen">live</div>,
      } satisfies ScreenFactory,
    });
    const registry = createScreenRegistry(getDefaultScreens());
    const el = registry.get('ext:test.contrib/main', {}, navigate, [
      extSnapshot(),
    ]);
    render(<>{el}</>);
    expect(screen.getByTestId('live-screen')).toBeInTheDocument();
  });

  it('a throwing factory is contained by its own error boundary, and the rest of the tree survives', () => {
    // eslint-disable-next-line no-console
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    registerContributedScreens({
      'ext:test.contrib/main': {
        factory: () => {
          throw new Error('boom');
        },
      } satisfies ScreenFactory,
    });
    const registry = createScreenRegistry(getDefaultScreens());
    const el = registry.get('ext:test.contrib/main', {}, navigate, [
      extSnapshot(),
    ]);
    render(
      <div>
        <nav data-testid="app-shell-sidebar">sidebar</nav>
        {el}
      </div>,
    );
    // The sidebar sibling is untouched — the boundary contained the throw
    // to the contributed screen, never the app shell.
    expect(screen.getByTestId('app-shell-sidebar')).toBeInTheDocument();
    expect(screen.getAllByText(/Contrib Extension/).length).toBeGreaterThan(0);
    spy.mockRestore();
  });

  it('a declared-but-unregistered factory on an activated extension is the no-factory reason, not a crash', () => {
    // No registerContributedScreens call at all — nothing registered.
    const registry = createScreenRegistry(getDefaultScreens());
    const el = registry.get('ext:test.contrib/main', {}, navigate, [
      extSnapshot(),
    ]);
    expect(() => render(<>{el}</>)).not.toThrow();
    expect(screen.getAllByText(/Contrib Extension/).length).toBeGreaterThan(0);
  });
});
