import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Account, AppState } from '@shared/contracts';
import { ErrorCard } from '../ErrorCard';

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({ extensions: [], accounts: [] } as unknown as AppState),
}));

/**
 * needsReauth is terminal without new credentials: Retry only re-runs the
 * pull loop against the same dead token, so the card must offer a real
 * Reconnect action that re-enters the source's connect flow (safe because
 * createAccount upserts on (source, identifier) — the account and its
 * documents survive re-auth).
 */

function account(status: Account['status']): Account {
  return {
    id: 'a1' as Account['id'],
    source: 'gmail',
    identifier: 'user@example.com',
    config: {},
    status,
    cursor: null,
    lastError: 'gmail oauth token request failed: invalid_grant',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

beforeEach(() => {
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke: jest.fn(() => Promise.resolve(undefined)),
    on: jest.fn(() => () => {}),
  };
});

describe('ErrorCard reconnect action', () => {
  test('needsReauth renders a Reconnect button that fires onReconnect', () => {
    const onReconnect = jest.fn();
    render(
      <ErrorCard account={account('needsReauth')} onReconnect={onReconnect} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  test('plain error status offers Retry, not Reconnect', () => {
    render(<ErrorCard account={account('error')} onReconnect={jest.fn()} />);

    expect(
      screen.queryByRole('button', { name: 'Reconnect' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
