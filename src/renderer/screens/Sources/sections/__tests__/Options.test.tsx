import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Account, SourceDescriptor } from '@shared/contracts';
import { Options } from '../Options';

const descriptor = {
  id: 'claude-code',
  name: 'Claude Code',
  documentTypes: [],
  auth: 'none',
  options: [
    {
      key: 'skipSubagents',
      label: 'Skip subagent sessions',
      description: 'Not indexed.',
      type: 'boolean',
      default: true,
    },
  ],
} as SourceDescriptor;
const account = (config: Record<string, unknown> = {}) =>
  ({
    id: 'a1',
    source: 'claude-code',
    identifier: '~/.claude',
    config,
    status: 'live',
    cursor: null,
    createdAt: '',
  }) as unknown as Account;

let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(() => Promise.resolve(undefined));
  (window as unknown as { kiagent: unknown }).kiagent = { invoke };
});

test('shows the effective default', () => {
  render(<Options account={account()} descriptor={descriptor} />);
  expect(
    screen.getByRole('switch', { name: 'Skip subagent sessions' }),
  ).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText('Not indexed.')).toBeInTheDocument();
});

test('shows a stored value', () => {
  render(
    <Options
      account={account({ options: { skipSubagents: false } })}
      descriptor={descriptor}
    />,
  );
  expect(
    screen.getByRole('switch', { name: 'Skip subagent sessions' }),
  ).toHaveAttribute('aria-checked', 'false');
});

test('toggling invokes accounts:set-option and disables while pending', async () => {
  let resolve!: () => void;
  invoke.mockImplementation(
    () =>
      new Promise<void>((r) => {
        resolve = r;
      }),
  );
  render(<Options account={account()} descriptor={descriptor} />);
  const sw = screen.getByRole('switch', { name: 'Skip subagent sessions' });
  fireEvent.click(sw);
  expect(invoke).toHaveBeenCalledWith('accounts:set-option', {
    accountId: 'a1',
    key: 'skipSubagents',
    value: false,
  });
  expect(sw).toBeDisabled();
  expect(sw).toHaveAttribute('aria-checked', 'false');
  await act(async () => {
    resolve();
  });
  expect(sw).not.toBeDisabled();
});

test('an error reverts the toggle and shows the message', async () => {
  invoke.mockImplementation(() =>
    Promise.reject(
      new Error('another folder or reconnect flow is already running'),
    ),
  );
  render(<Options account={account()} descriptor={descriptor} />);
  const sw = screen.getByRole('switch', { name: 'Skip subagent sessions' });
  await act(async () => {
    fireEvent.click(sw);
  });
  expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Finishing the current sync step — try again in a moment',
  );
});

test('a successful write keeps the new value until the account prop catches up, then follows the prop', async () => {
  const { rerender } = render(
    <Options account={account()} descriptor={descriptor} />,
  );
  const sw = screen.getByRole('switch', { name: 'Skip subagent sessions' });
  await act(async () => {
    fireEvent.click(sw);
  });
  // Saved, but the throttled account push has not arrived: no snap-back.
  expect(sw).not.toBeDisabled();
  expect(sw).toHaveAttribute('aria-checked', 'false');
  // The push arrives with the saved value.
  rerender(
    <Options
      account={account({ options: { skipSubagents: false } })}
      descriptor={descriptor}
    />,
  );
  expect(sw).toHaveAttribute('aria-checked', 'false');
  // Later the stored value changes elsewhere: the card follows the prop.
  rerender(
    <Options
      account={account({ options: { skipSubagents: true } })}
      descriptor={descriptor}
    />,
  );
  expect(sw).toHaveAttribute('aria-checked', 'true');
});
