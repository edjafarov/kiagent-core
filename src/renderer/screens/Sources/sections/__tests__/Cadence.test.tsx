import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Account } from '@shared/contracts';
import { Cadence } from '../Cadence';

const account = {
  id: 'a1',
  source: 'imap',
  identifier: 'someone@example.com',
  config: {},
  status: 'live',
  cursor: null,
  createdAt: '2026-01-01T00:00:00Z',
} as unknown as Account;

let invoke: jest.Mock;

beforeEach(() => {
  const now = Date.now();
  invoke = jest.fn((channel: string) =>
    Promise.resolve(
      channel === 'scheduler:jobs'
        ? [
            {
              id: 'source:imap:a1',
              lastRun: new Date(now - 5 * 60_000).toISOString(),
              nextRun: new Date(now + 10 * 60_000).toISOString(),
            },
          ]
        : undefined,
    ),
  );
  (window as unknown as { kiagent: unknown }).kiagent = { invoke };
});

test('says when it last checked and when it checks next', async () => {
  render(<Cadence account={account} />);
  expect(
    await screen.findByText('Last checked 5 minutes ago · next in 10 minutes'),
  ).toBeInTheDocument();
});

test('Run now syncs the account the same way Sync now does', async () => {
  render(<Cadence account={account} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
  });
  expect(invoke).toHaveBeenCalledWith('accounts:sync-now', {
    accountId: 'a1',
  });
  expect(invoke).not.toHaveBeenCalledWith(
    'scheduler:trigger',
    expect.anything(),
  );
});

test('Run now stays busy saying Checking now until the sync lands, then shows it', async () => {
  jest.useFakeTimers();
  try {
    const { rerender } = render(<Cadence account={account} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    });
    expect(screen.getByText('Checking now…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run now/ })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    await act(async () => {
      jest.advanceTimersByTime(3_000);
    });
    expect(screen.getByText('Checking now…')).toBeInTheDocument();
    // The run commits: the pushed account carries a new lastSyncAt.
    const synced = {
      ...account,
      lastSyncAt: new Date().toISOString(),
    } as Account;
    rerender(<Cadence account={synced} />);
    await act(async () => {
      jest.advanceTimersByTime(1_500);
    });
    expect(screen.queryByText('Checking now…')).toBeNull();
    expect(screen.getByText(/^Last checked (now|\d+ seconds ago)/)).toBeInTheDocument();
  } finally {
    jest.useRealTimers();
  }
});

test('Run now gives up waiting after a minute', async () => {
  jest.useFakeTimers();
  try {
    render(<Cadence account={account} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    });
    for (let i = 0; i < 62; i++)
      await act(async () => {
        jest.advanceTimersByTime(1_000);
      });
    expect(screen.queryByText('Checking now…')).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test('a signed-out source says it waits for a sign-in', async () => {
  render(
    <Cadence account={{ ...account, status: 'needsReauth' } as Account} />,
  );
  expect(
    await screen.findByText('Paused until you sign in again'),
  ).toBeInTheDocument();
});
