import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AppState } from '@shared/contracts';
import { ViewContext, type ViewContextValue } from '@renderer/state/view';
import { Sidebar } from '../Sidebar';
import { AccountRow } from '../AccountRow';

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
    replaceParams: jest.fn(),
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
  it('renders a row per contributed page after the static items and navigates to it', () => {
    mockState = stateWith({
      extensions: [
        {
          id: 'kia.google-calendar',
          name: 'Google Calendar',
          version: '1.0.0',
          origin: 'marketplace',
          enabled: true,
          status: 'activated',
          caps: [],
          sourceIds: [],
          oauthSources: [],
          ui: [{ id: 'calendar', slot: 'screen', title: 'Calendar' }],
        },
      ],
    });
    const ctx = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Calendar' }));
    expect(ctx.navigate).toHaveBeenCalledWith(
      'ext:kia.google-calendar/calendar',
    );
  });

  it('renders the four nav items with Sources active and navigates on click', () => {
    const ctx = renderSidebar();
    expect(screen.getByRole('button', { name: 'Sources' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Outbox' }));
    expect(ctx.navigate).toHaveBeenCalledWith('outbox');
  });

  it('has no Marketplace row: extensions live in Settings and the catalog', () => {
    renderSidebar();
    expect(
      screen.queryByRole('button', { name: 'Marketplace' }),
    ).not.toBeInTheDocument();
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

describe('Sidebar MCP dot', () => {
  it('names the offline state when the local server is down', () => {
    mockState = stateWith({
      mcp: { port: null },
    } as unknown as Partial<AppState>);
    renderSidebar();
    expect(
      screen.getByRole('button', { name: 'Connection offline' }),
    ).toBeInTheDocument();
  });

  it('keeps the dot decorative; the state is in the name', () => {
    renderSidebar();
    const item = screen.getByRole('button', { name: 'Connection online' });
    expect(
      item.querySelector('[aria-hidden="true"].ui-nav-dot'),
    ).not.toBeNull();
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

describe('Sidebar brand row', () => {
  it('has no collapse control — the rail is fixed-width', () => {
    renderSidebar();
    expect(
      screen.queryByRole('button', { name: 'Collapse sidebar' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('complementary')).not.toHaveClass('collapsed');
  });

  it('renders the KIAgent wordmark', () => {
    renderSidebar();
    expect(screen.getByText('KIAgent')).toBeInTheDocument();
  });

  it('ignores a stale collapse preference from older builds', () => {
    localStorage.setItem('kia.sidebar.collapsed', '1');
    renderSidebar();
    expect(screen.getByRole('complementary')).not.toHaveClass('collapsed');
    expect(screen.getByText('Sources')).toBeInTheDocument();
  });
});

describe('account row', () => {
  it('is one button: avatar, name and gear open the Account pane', () => {
    const ctx = renderSidebar();
    const row = screen.getByRole('button', {
      name: 'Settings — Alice Example',
    });
    expect(row).toHaveTextContent('A');
    expect(row).toHaveTextContent('Alice Example');
    fireEvent.click(row);
    expect(ctx.openSettings).toHaveBeenCalledWith('account');
    // No menu and no separate gear button any more.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Settings' }),
    ).not.toBeInTheDocument();
  });

  it('stays highlighted while Settings is open', () => {
    renderSidebar({ view: 'settings' });
    const row = screen.getByRole('button', {
      name: 'Settings — Alice Example',
    });
    expect(row).toHaveClass('is-active');
    expect(row).toHaveAttribute('aria-current', 'page');
  });

  it('is not highlighted on other pages', () => {
    renderSidebar({ view: 'sources' });
    expect(
      screen.getByRole('button', { name: 'Settings — Alice Example' }),
    ).not.toHaveClass('is-active');
  });
});

describe('AccountRow', () => {
  it('falls back to the email and keeps only the avatar when collapsed', () => {
    const open = jest.fn();
    render(
      <AccountRow
        identity={{ name: '', emails: ['alex@northwind.test'], phones: [] }}
        collapsed
        onOpenSettings={open}
      />,
    );
    const row = screen.getByRole('button', {
      name: 'Settings — alex@northwind.test',
    });
    expect(row).toHaveAttribute('title', 'Settings');
    expect(row).not.toHaveTextContent('alex@northwind.test');
    fireEvent.click(row);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
