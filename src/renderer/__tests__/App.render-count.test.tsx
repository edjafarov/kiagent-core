import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { deserialize, serialize } from 'node:v8';
import type { AppState } from '@shared/contracts';
import App from '../App';

// The sidebar element is created in App's render and nowhere else, so its
// render count is the shell's render count.
let mockSidebarRenders = 0;
jest.mock('@renderer/components/Sidebar', () => ({
  Sidebar: () => {
    mockSidebarRenders += 1;
    return null;
  },
}));
jest.mock('@renderer/screen-registry', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    createScreenRegistry: () => ({
      get: () => R.createElement('div', { 'data-testid': 'screen' }),
      frame: () => 'page',
    }),
    getDefaultScreens: () => ({}),
  };
});
jest.mock('@renderer/components/TitleBar', () => ({ TitleBar: () => null }));
jest.mock('@renderer/components/BootSplash', () => ({
  BootSplash: () => null,
}));
jest.mock('@renderer/screens/SignIn', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return { SignIn: () => R.createElement('div', { 'data-testid': 'sign-in' }) };
});

/** What IPC does to every push. jest 29 / jsdom 20 has no structuredClone. */
const clone = <T,>(v: T): T => deserialize(serialize(v)) as T;

function baseState(): AppState {
  return {
    accounts: [
      {
        account: { id: 'a', source: 'gmail', status: 'live' },
        docCount: 1,
        recent: [],
      },
      {
        account: { id: 'b', source: 'slack', status: 'backfilling' },
        docCount: 2,
        recent: [],
      },
    ],
    extensions: [
      { id: 'ext.a', name: 'A', status: 'activated', enabled: true, ui: [] },
    ],
    mcp: { port: 7421, clients: 0 },
    identity: { name: 'Alice', emails: ['alice@example.com'], phones: [] },
    prefs: { features: {}, onboarding: {} },
    processing: { pending: 0, done: 0, skipped: 0, failed: 0 },
    ready: true,
  } as unknown as AppState;
}

let pushListener: ((payload: unknown) => void) | null = null;

function installBridge(initial: AppState): void {
  pushListener = null;
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke: jest.fn((channel: string) =>
      channel === 'app:get-state'
        ? Promise.resolve({ state: clone(initial), seq: 0, rev: 1 })
        : Promise.resolve([]),
    ),
    on: jest.fn((channel: string, fn: (payload: unknown) => void) => {
      if (channel === 'push:app-state') pushListener = fn;
      return () => {
        if (pushListener === fn) pushListener = null;
      };
    }),
  };
}

function push(state: AppState, rev: number): void {
  act(() => pushListener?.({ state: clone(state), seq: rev, rev }));
}

async function mountLoaded(base: AppState): Promise<void> {
  installBridge(base);
  render(<App />);
  await act(async () => {});
  await act(async () => {});
  expect(screen.getByTestId('screen')).toBeInTheDocument();
  mockSidebarRenders = 0;
}

afterEach(() => {
  delete (window as unknown as { kiagent?: unknown }).kiagent;
});

test('a docCount-only push does not re-render the shell', async () => {
  const base = baseState();
  await mountLoaded(base);
  const next = clone(base);
  next.accounts[1].docCount = 3;
  push(next, 2);
  expect(mockSidebarRenders).toBe(0);
});

test('a push that changes the extension list re-renders the shell once', async () => {
  const base = baseState();
  await mountLoaded(base);
  const next = clone(base);
  next.extensions = [
    ...next.extensions,
    { id: 'ext.b', name: 'B', status: 'activated', enabled: true, ui: [] },
  ] as unknown as AppState['extensions'];
  push(next, 2);
  expect(mockSidebarRenders).toBe(1);
});

test('signing out still reaches the sign-in gate', async () => {
  const base = baseState();
  await mountLoaded(base);
  push({ ...clone(base), identity: null } as AppState, 2);
  expect(screen.getByTestId('sign-in')).toBeInTheDocument();
});
