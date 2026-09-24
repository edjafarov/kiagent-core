import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { ExtensionSnapshot } from '@shared/contracts';
import type { View } from '@renderer/state/view';

import { createScreenRegistry, getDefaultScreens } from '../screen-registry';

// The loader itself is covered by contributed-page.test.tsx; here it is a
// stub that shows which contribution the registry routed to it.
jest.mock('@renderer/contributed-page', () => ({
  ContributedPage: (p: {
    contributionId: string;
    params: { anchor?: string };
  }) => (
    <div>
      page:{p.contributionId}:{p.params.anchor ?? ''}
    </div>
  ),
}));

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

// The shared "unavailable" screen for every way a contributed view can
// fail to route; an available one mounts the runtime page loader.

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

describe('createScreenRegistry — known views (unchanged)', () => {
  it('still resolves core screens for a KnownView', () => {
    const registry = createScreenRegistry(getDefaultScreens());
    const el = registry.get('logs', {}, navigate, []);
    expect(el).not.toBeNull();
  });
});

describe('createScreenRegistry — contributed views (ExtView)', () => {
  function show(view: View, extensions: ExtensionSnapshot[]): void {
    const registry = createScreenRegistry(getDefaultScreens());
    render(<>{registry.get(view, { anchor: 'x' }, navigate, extensions)}</>);
  }

  it('renders the page loader for an activated extension declaring the contribution', () => {
    show('ext:test.contrib/main', [extSnapshot()]);
    expect(screen.getByText('page:main:x')).toBeInTheDocument();
  });

  it('shows the unavailable screen for an uninstalled extension', () => {
    show('ext:test.contrib/main', []);
    expect(screen.getByText(/test\.contrib unavailable/)).toBeInTheDocument();
  });

  it('shows the unavailable screen for an undeclared contribution', () => {
    show('ext:test.contrib/other', [extSnapshot()]);
    expect(
      screen.getByText(/Contrib Extension unavailable/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/page:/)).toBeNull();
  });

  it('shows the unavailable screen for a disabled extension', () => {
    show('ext:test.contrib/main', [extSnapshot({ enabled: false })]);
    expect(
      screen.getByText(/Contrib Extension is turned off/),
    ).toBeInTheDocument();
  });

  it('shows the unavailable screen for a failed (errored) extension', () => {
    show('ext:test.contrib/main', [extSnapshot({ status: 'errored' })]);
    expect(
      screen.getByText(/Contrib Extension failed to start/),
    ).toBeInTheDocument();
  });

  it('an extension waiting for consent says so instead of promising it is starting', () => {
    show('ext:test.contrib/main', [extSnapshot({ status: 'needs-consent' })]);
    expect(
      screen.getByText(/Contrib Extension needs your permission/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/is starting/)).toBeNull();
  });

  it('an extension still activating shows the starting screen', () => {
    show('ext:test.contrib/main', [extSnapshot({ status: 'disabled' })]);
    expect(
      screen.getByText(/Contrib Extension is starting/),
    ).toBeInTheDocument();
  });
});
