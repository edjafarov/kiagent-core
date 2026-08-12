import '@testing-library/jest-dom';
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
