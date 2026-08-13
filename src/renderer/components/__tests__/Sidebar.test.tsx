import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AppState } from '@shared/contracts';
import { ViewContext, type ViewContextValue } from '@renderer/state/view';
import { Sidebar } from '../Sidebar';

let mockState: Partial<AppState>;

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));

function stateWith(over: Partial<AppState> = {}): Partial<AppState> {
  return {
    accounts: [
      {
        account: { status: 'live' },
        docCount: 1200,
        recent: [],
      },
    ],
    mcp: { port: 7421 },
    identity: {
      name: 'Alice Example',
      emails: ['alice@example.com'],
      phones: [],
    },
    ...over,
  } as unknown as Partial<AppState>;
}

function renderSidebar(ctx: Partial<ViewContextValue> = {}) {
  const value: ViewContextValue = {
    view: 'sources',
    params: {},
    navigate: jest.fn(),
    back: jest.fn(),
    openSettings: jest.fn(),
    ...ctx,
  };
  render(
    <ViewContext.Provider value={value}>
      <Sidebar />
    </ViewContext.Provider>,
  );
  return value;
}

beforeEach(() => {
  localStorage.clear();
  mockState = stateWith();
});

describe('Sidebar nav', () => {
  it('renders the four nav items with Sources active and navigates on click', () => {
    const ctx = renderSidebar();
    expect(screen.getByRole('button', { name: 'Sources' })).toHaveClass(
      'active',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Outbox' }));
    expect(ctx.navigate).toHaveBeenCalledWith('outbox');
  });

  it('re-clicking the active item still calls navigate (epoch remount contract)', () => {
    const ctx = renderSidebar({ view: 'sources' });
    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
    expect(ctx.navigate).toHaveBeenCalledWith('sources');
  });

  it('shows the MCP dot online state on the Connection item', () => {
    renderSidebar();
    expect(
      screen.getByRole('button', { name: 'Connection online' }),
    ).toBeInTheDocument();
  });
});

/**
 * The MCP dot's on/off COLOURS live under a `.kg-tab` ancestor in
 * components.css, and the sidebar renders no `.kg-tab` — so the markup below
 * is only visible if Sidebar.css re-scopes those backgrounds. jsdom cannot
 * compute that (CSS imports are stubbed by identity-obj-proxy), so the pairing
 * is asserted in two halves: the class the markup emits, and the presence of a
 * sidebar-scoped background rule for it. Same shape as the ipc-handler
 * coverage test — scrape the source for what the compiler cannot see.
 */
describe('Sidebar MCP dot', () => {
  it('emits the on/off state class the stylesheet keys off', () => {
    renderSidebar();
    expect(
      document.body.querySelector('.kg-sb-item .tab-dot.on'),
    ).not.toBeNull();
  });

  it('falls back to the off class when the local server is down', () => {
    mockState = stateWith({
      mcp: { port: null },
    } as unknown as Partial<AppState>);
    renderSidebar();
    expect(
      document.body.querySelector('.kg-sb-item .tab-dot.off'),
    ).not.toBeNull();
  });

  it('Sidebar.css gives both dot states a sidebar-scoped background', () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, '../Sidebar.css'),
      'utf8',
    );
    for (const state of ['on', 'off']) {
      expect(css).toMatch(
        new RegExp(
          `\\.kg-s[\\w.-]*\\s+\\.tab-dot\\.${state}\\b[^{]*\\{[^}]*background\\s*:`,
        ),
      );
    }
  });
});

describe('Sidebar status line', () => {
  it('shows live count and docs when nothing errors', () => {
    renderSidebar();
    expect(screen.getByText('1 live · 1,200 docs')).toBeInTheDocument();
  });

  it('shows the error variant and navigates to sources on click', () => {
    mockState = stateWith({
      accounts: [{ account: { status: 'error' }, docCount: 0, recent: [] }],
    } as unknown as Partial<AppState>);
    const ctx = renderSidebar({ view: 'outbox' });
    const status = screen.getByRole('button', {
      name: '1 source needs attention',
    });
    fireEvent.click(status);
    expect(ctx.navigate).toHaveBeenCalledWith('sources');
  });
});

describe('Sidebar collapse', () => {
  it('toggles collapsed state and persists it to localStorage', () => {
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem('kia.sidebar.collapsed')).toBe('1');
    expect(screen.getByRole('complementary')).toHaveClass('collapsed');
    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(localStorage.getItem('kia.sidebar.collapsed')).toBe('0');
  });

  it('starts collapsed when localStorage says so', () => {
    localStorage.setItem('kia.sidebar.collapsed', '1');
    renderSidebar();
    expect(screen.getByRole('complementary')).toHaveClass('collapsed');
  });
});

describe('AccountMenu (core build)', () => {
  it('renders the identity chip and opens a menu with Settings but NO Log out', () => {
    const ctx = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(ctx.openSettings).toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Log out' }),
    ).not.toBeInTheDocument();
  });

  it('shows the identity initial and name', () => {
    renderSidebar();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('Alice Example')).toBeInTheDocument();
  });
});
