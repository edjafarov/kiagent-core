import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AppState } from '@shared/contracts';
import App from '../App';

let mockState: AppState | null;

jest.mock('@renderer/state/app-state', () => ({
  subscribeAppState: () => () => {},
  getAppState: () => mockState,
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));

// Screens are IPC-heavy; the shell contract is which one mounts, not what
// it renders. Key-based remount is observed via a fresh mount counter.
let sourcesMounts = 0;
let settingsMounts = 0;
jest.mock('@renderer/screen-registry', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { useView } = jest.requireActual<typeof import('@renderer/state/view')>(
    '@renderer/state/view',
  );
  const Sources = () => {
    R.useEffect(() => {
      sourcesMounts += 1;
    }, []);
    return R.createElement('div', { 'data-testid': 'screen-sources' });
  };
  const Outbox = () =>
    R.createElement('div', { 'data-testid': 'screen-outbox' });
  const Logs = () => {
    const { openSettings, back } = useView();
    return R.createElement(
      'div',
      { 'data-testid': 'screen-logs' },
      R.createElement('button', { onClick: openSettings }, 'logs-settings'),
      R.createElement('button', { onClick: back }, 'logs-back'),
    );
  };
  const Settings = (p: { pane?: string }) => {
    const { replaceParams, navigate } = useView();
    R.useEffect(() => {
      settingsMounts += 1;
    }, []);
    return R.createElement(
      'div',
      { 'data-testid': 'screen-settings', 'data-pane': p.pane ?? '(none)' },
      R.createElement(
        'button',
        { onClick: () => replaceParams({ pane: 'advanced' }) },
        'to-advanced',
      ),
      R.createElement('button', { onClick: () => navigate('logs') }, 'to-logs'),
    );
  };
  const screens: Record<
    string,
    {
      frame?: 'page' | 'host';
      factory: (p: { pane?: string }) => React.ReactElement;
    }
  > = {
    sources: { factory: () => R.createElement(Sources) },
    outbox: { factory: () => R.createElement(Outbox) },
    connection: { factory: () => R.createElement('div') },
    marketplace: { factory: () => R.createElement('div') },
    logs: { factory: () => R.createElement(Logs) },
    settings: {
      frame: 'page',
      factory: (p) => R.createElement(Settings, { pane: p.pane }),
    },
  };
  return {
    createScreenRegistry: () => ({
      get: (view: string, params: { pane?: string }) =>
        screens[view]?.factory(params) ?? null,
      frame: (view: string) => screens[view]?.frame ?? 'host',
    }),
    getDefaultScreens: () => screens,
  };
});

function signedInState(): AppState {
  return {
    accounts: [],
    extensions: [],
    mcp: { port: null },
    identity: { name: 'Alice', emails: ['alice@example.com'], phones: [] },
  } as unknown as AppState;
}

beforeEach(() => {
  localStorage.clear();
  sourcesMounts = 0;
  settingsMounts = 0;
  mockState = signedInState();
  // The app-root descriptor provider reads the source list.
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke: jest.fn(() => Promise.resolve([])),
    on: jest.fn(() => () => {}),
  };
});

/** Opens Settings the way a user does from the sidebar: the gear. */
function openSettingsPage(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Settings — / }));
}

describe('App shell', () => {
  it('renders the sidebar and the default Sources screen, with no TopBar', () => {
    render(<App />);
    expect(screen.getByRole('complementary')).toBeInTheDocument();
    expect(screen.getByTestId('screen-sources')).toBeInTheDocument();
  });

  it('switches screens from the sidebar', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Outbox' }));
    expect(screen.getByTestId('screen-outbox')).toBeInTheDocument();
    expect(screen.queryByTestId('screen-sources')).not.toBeInTheDocument();
  });

  it('re-clicking the active item remounts the screen (epoch contract)', () => {
    render(<App />);
    expect(sourcesMounts).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Sources' }));
    expect(sourcesMounts).toBe(2);
  });

  it('opens Settings on the Account pane from the account row', () => {
    render(<App />);
    openSettingsPage();
    const page = screen.getByTestId('screen-settings');
    expect(page).toHaveAttribute('data-pane', 'account');
    expect(screen.queryByTestId('screen-sources')).not.toBeInTheDocument();
    // Even after another pane was used, the row lands on Account.
    fireEvent.click(screen.getByRole('button', { name: 'to-advanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'Outbox' }));
    openSettingsPage();
    expect(screen.getByTestId('screen-settings')).toHaveAttribute(
      'data-pane',
      'account',
    );
  });

  it('gives host views the app top bar and page views none', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sources' }),
    ).toBeInTheDocument();
    openSettingsPage();
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('does not close Settings on Esc', () => {
    render(<App />);
    openSettingsPage();
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('screen-settings'), { key: 'Escape' });
    expect(screen.getByTestId('screen-settings')).toBeInTheDocument();
  });

  it('keeps the pane in the route without remounting, and Back returns to it', () => {
    render(<App />);
    openSettingsPage();
    fireEvent.click(screen.getByRole('button', { name: 'to-advanced' }));
    expect(screen.getByTestId('screen-settings')).toHaveAttribute(
      'data-pane',
      'advanced',
    );
    expect(settingsMounts).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'to-logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'logs-back' }));
    expect(screen.getByTestId('screen-settings')).toHaveAttribute(
      'data-pane',
      'advanced',
    );
  });

  it('treats a click event passed to openSettings as "no pane"', () => {
    render(<App />);
    openSettingsPage();
    fireEvent.click(screen.getByRole('button', { name: 'to-advanced' }));
    fireEvent.click(screen.getByRole('button', { name: 'to-logs' }));
    fireEvent.click(screen.getByRole('button', { name: 'logs-settings' }));
    expect(screen.getByTestId('screen-settings')).toHaveAttribute(
      'data-pane',
      'advanced',
    );
  });

  it('keeps every screen inside the .ac scope', () => {
    const { container } = render(<App />);
    const scope = container.querySelector('.ac.ui-shell');
    expect(scope).not.toBeNull();
    expect(scope!.contains(screen.getByTestId('screen-sources'))).toBe(true);
  });

  it('shows no sidebar while signed out', () => {
    mockState = { ...signedInState(), identity: null } as unknown as AppState;
    render(<App />);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
