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
jest.mock('@renderer/screen-registry', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const Sources = () => {
    R.useEffect(() => {
      sourcesMounts += 1;
    }, []);
    return R.createElement('div', { 'data-testid': 'screen-sources' });
  };
  const Outbox = () =>
    R.createElement('div', { 'data-testid': 'screen-outbox' });
  const screens: Record<string, { factory: () => React.ReactElement }> = {
    sources: { factory: () => R.createElement(Sources) },
    outbox: { factory: () => R.createElement(Outbox) },
    connection: { factory: () => R.createElement('div') },
    marketplace: { factory: () => R.createElement('div') },
    logs: { factory: () => R.createElement('div') },
  };
  return {
    createScreenRegistry: () => ({
      get: (view: string) => screens[view]?.factory() ?? null,
    }),
    getDefaultScreens: () => screens,
  };
});

jest.mock('@renderer/components/SettingsModal', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    SettingsModal: (p: { onClose: () => void }) =>
      R.createElement(
        'div',
        { 'data-testid': 'settings-modal' },
        R.createElement('button', { onClick: p.onClose }, 'close-modal'),
      ),
  };
});

function signedInState(): AppState {
  return {
    accounts: [],
    mcp: { port: null },
    identity: { name: 'Alice', emails: ['alice@example.com'], phones: [] },
  } as unknown as AppState;
}

beforeEach(() => {
  localStorage.clear();
  sourcesMounts = 0;
  mockState = signedInState();
});

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

  it('opens and closes the settings modal from the account menu', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByTestId('settings-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'close-modal' }));
    expect(screen.queryByTestId('settings-modal')).not.toBeInTheDocument();
  });

  // The modal is mocked, but its DOM *position* is App.tsx's call, not the
  // mock's — so this asserts the real contract: everything the modal mounts
  // must sit inside `.ac`, whose `.ac *` rule is the only source of
  // `box-sizing: border-box` (web-ui/components.css — no global fallback).
  it('mounts the settings modal inside the .ac scope', () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const scope = container.querySelector('.ac');
    expect(scope).not.toBeNull();
    expect(scope!.contains(screen.getByTestId('settings-modal'))).toBe(true);
  });

  it('shows no sidebar while signed out', () => {
    mockState = { ...signedInState(), identity: null } as unknown as AppState;
    render(<App />);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
