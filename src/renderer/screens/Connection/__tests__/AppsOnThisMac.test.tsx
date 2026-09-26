import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppsOnThisMac } from '../AppsOnThisMac';

const CLIENTS = [
  { id: 'claude-code', name: 'Claude Code', connected: true },
  { id: 'vscode', name: 'VS Code', connected: false },
];

let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(() => Promise.resolve());
  (window as any).kiagent = { invoke, on: jest.fn(() => () => {}) };
});
afterEach(() => {
  delete (window as any).kiagent;
});

function mount(over: Partial<React.ComponentProps<typeof AppsOnThisMac>> = {}) {
  const props = {
    clients: CLIENTS,
    port: 7421,
    onChanged: jest.fn(),
    onManualSetup: jest.fn(),
    ...over,
  };
  render(<AppsOnThisMac {...props} />);
  return props;
}

test('one row per detected app with its state and the count', () => {
  mount();
  expect(screen.getAllByTestId('local-client-row')).toHaveLength(2);
  expect(screen.getByText('✓ Connected')).toBeInTheDocument();
  expect(screen.getByText('Ready to connect')).toBeInTheDocument();
  expect(screen.getByText('1 of 2 connected')).toBeInTheDocument();
  expect(screen.getByText('127.0.0.1:7421')).toBeInTheDocument();
});

test('Connect writes the app and re-reads', async () => {
  const p = mount();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Connect VS Code' }));
  });
  expect(invoke).toHaveBeenCalledWith('mcp:connect-client', { id: 'vscode' });
  expect(p.onChanged).toHaveBeenCalled();
});

test('Disconnect (on hover) removes the app and re-reads, even when the write fails', async () => {
  invoke.mockRejectedValueOnce(new Error('locked'));
  const p = mount();
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', { name: 'Disconnect Claude Code' }),
    );
  });
  expect(invoke).toHaveBeenCalledWith('mcp:disconnect-client', {
    id: 'claude-code',
  });
  expect(p.onChanged).toHaveBeenCalled();
});

test('no port: Connect is disabled', () => {
  mount({ port: null });
  expect(
    screen.getByRole('button', { name: 'Connect VS Code' }),
  ).toBeDisabled();
});

test('none detected, and loading', async () => {
  const { unmount } = render(
    <AppsOnThisMac
      clients={[]}
      port={7421}
      onChanged={jest.fn()}
      onManualSetup={jest.fn()}
    />,
  );
  expect(screen.getByText(/No supported apps found/)).toBeInTheDocument();
  unmount();
  mount({ clients: null });
  // Busy shows after its short delay.
  expect(await screen.findByRole('status')).toBeInTheDocument();
});

test('Manual setup opens Advanced', () => {
  const p = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Manual setup' }));
  expect(p.onManualSetup).toHaveBeenCalled();
});
