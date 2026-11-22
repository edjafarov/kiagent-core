import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { AppState } from '@shared/contracts';

let mockState: AppState | null;
const mockUseShell = jest.fn();

jest.mock('@renderer/state/app-state', () => ({
  subscribeAppState: () => () => {},
  getAppState: () => mockState,
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
  useAppGate: (sel: (s: unknown) => unknown) => sel(mockState),
}));
jest.mock('@renderer/screen-registry', () => ({
  getDefaultScreens: () => ({}),
  createScreenRegistry: () => ({ get: () => null, frame: () => 'page' }),
}));
jest.mock('@renderer/screens/Sources/sources-registry', () => ({
  SourceDescriptorsProvider: (p: { children: React.ReactNode }) => p.children,
}));
jest.mock('@renderer/components/TitleBar', () => ({ TitleBar: () => null }));
jest.mock('@renderer/components/BootSplash', () => ({
  BootSplash: () => null,
}));
jest.mock('../extensions/use-install-link', () => ({
  InstallLinks: () => null,
}));
// A product replaces the composition file; this mock stands in for its copy.
jest.mock('@renderer/composition', () => ({
  PRODUCT_SCREENS: {},
  PRODUCT_SHELL: {
    SignIn: () => <div>product sign-in</div>,
    Sidebar: () => <div>product sidebar</div>,
    Frame: (p: { children: React.ReactNode }) => (
      <div data-testid="product-frame">{p.children}</div>
    ),
    useShell: (shell: unknown) => mockUseShell(shell),
  },
}));

/* eslint-disable import/first */
import App from '../App';

const signedIn = (over: Partial<AppState> = {}): AppState =>
  ({
    identity: { emails: ['b@x.test', 'a@x.test'] },
    extensions: [],
    ...over,
  }) as unknown as AppState;

beforeEach(() => mockUseShell.mockClear());

it('shows the product sign-in while nobody is signed in', () => {
  mockState = { identity: null, extensions: [] } as unknown as AppState;
  render(<App />);
  expect(screen.getByText('product sign-in')).toBeInTheDocument();
  expect(screen.queryByTestId('product-frame')).toBeNull();
  expect(mockUseShell).toHaveBeenLastCalledWith(
    expect.objectContaining({ principal: null }),
  );
});

it('puts the product frame around the loading screen until the state is ready', () => {
  mockState = signedIn({ ready: false } as Partial<AppState>);
  render(<App />);
  expect(screen.getByTestId('product-frame')).toBeInTheDocument();
  expect(screen.queryByText('product sidebar')).toBeNull();
});

it('mounts the product sidebar inside the product frame, and tells the hook who is signed in', () => {
  mockState = signedIn();
  render(<App />);
  expect(screen.getByTestId('product-frame')).toContainElement(
    screen.getByText('product sidebar'),
  );
  expect(mockUseShell).toHaveBeenLastCalledWith(
    expect.objectContaining({ principal: '["a@x.test","b@x.test"]' }),
  );
});
