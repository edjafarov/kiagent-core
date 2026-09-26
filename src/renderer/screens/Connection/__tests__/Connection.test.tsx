import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Connection } from '../index';

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel({ mcp: { port: 7421 } }),
}));

beforeEach(() => {
  (window as any).kiagent = {
    invoke: jest.fn((channel: string) => {
      if (channel === 'mcp:info')
        return Promise.resolve({
          port: 7421,
          clients: [
            { id: 'claude-code', name: 'Claude Code', connected: true },
            { id: 'cursor', name: 'Cursor', connected: true },
            { id: 'vscode', name: 'VS Code', connected: false },
          ],
        });
      return Promise.resolve([]);
    }),
    on: jest.fn(() => () => {}),
  };
});
afterEach(() => {
  delete (window as any).kiagent;
});

test('the page: title, apps meta, the apps and the requests', async () => {
  render(<Connection />);
  await act(async () => {});
  expect(
    screen.getByRole('heading', { name: 'Connection', level: 1 }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/2 apps on this (Mac|computer) connected/),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('region', { name: /Apps on this/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Requests' })).toBeInTheDocument();
});

test('Advanced opens the local server page; the crumb returns', async () => {
  render(<Connection />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
  expect(screen.getByRole('heading', { name: 'Advanced' })).toBeInTheDocument();
  expect(
    screen.getByRole('region', { name: 'Local server' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Back to Connection' }));
  await act(async () => {});
  expect(screen.getByRole('region', { name: 'Requests' })).toBeInTheDocument();
});
