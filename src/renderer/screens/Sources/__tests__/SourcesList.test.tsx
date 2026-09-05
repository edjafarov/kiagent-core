import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Account, AppState } from '@shared/contracts';
import { SourcesList } from '../SourcesList';
import { SourceDescriptorsProvider } from '../sources-registry';

/**
 * `ready` distinguishes "still hydrating" from "genuinely no sources" —
 * before the feed projection's first init() snapshot lands, the seeded
 * state has zero accounts too, so without this flag the empty state would
 * lie during that window (Task 4).
 */

let mockState: Partial<AppState>;

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));

function stateWith(ready: boolean): Partial<AppState> {
  return {
    accounts: [],
    ready,
    prefs: {
      onboarding: {
        sourceBackfilledAt: null,
        mcpConnectedAt: null,
        firstQueryAt: null,
        // Dismissed so GetStartedPanel (also mounted by SourcesList) stays
        // out of the way — this test is about the ready/empty branch only.
        dismissedAt: '2026-01-01T00:00:00Z',
      },
    },
  } as unknown as Partial<AppState>;
}

const noop = () => {};

const DESCRIPTORS = [
  {
    id: 'google-docs',
    name: 'Google Drive',
    documentTypes: ['gdoc'],
    auth: 'oauth',
    folderScope: true,
    // Populated by core at registry-list time (boot.ts:118, Task 7).
    // google-docs gains `reauthenticate` in this train, so it CAN be
    // reconnected.
    hasReauthenticate: true,
  },
  {
    // Verbatim from src/main/sources/imap/source.ts:90-97 — and deliberately
    // WITHOUT hasReauthenticate: imap has no `reauthenticate` today (grep over
    // the worktree: zero hits) and gains none in this train.
    id: 'imap',
    name: 'Email (IMAP)',
    documentTypes: ['email.message'],
    auth: 'password',
    multiAccount: true,
    cadence: { every: '15m' },
  },
];

function invokeMock(): jest.Mock {
  return (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent
    .invoke;
}

/** One needsReauth account of `source`, with the descriptor list served. */
function seedNeedsReauth(source: string): void {
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke: jest.fn((channel: string) => {
      if (channel === 'sources:list') return Promise.resolve(DESCRIPTORS);
      if (channel === 'accounts:start-reconnect')
        return Promise.resolve({ flowId: 'f1' });
      if (channel === 'accounts:add') return Promise.resolve({ flowId: 'f1' });
      return Promise.resolve(undefined);
    }),
    on: jest.fn(() => () => {}),
  };
  const account: Account = {
    id: 'a1' as Account['id'],
    source,
    identifier: 'user@example.com',
    config: {},
    status: 'needsReauth',
    cursor: null,
    lastError: 'invalid_grant',
    createdAt: '2026-01-01T00:00:00Z',
  };
  mockState = {
    ...stateWith(true),
    extensions: [],
    accounts: [{ account, docCount: 0, recent: [] }],
  } as unknown as Partial<AppState>;
}

describe('SourcesList: ErrorCard Reconnect routes on the account and its descriptor', () => {
  it('reconnects THAT account, not that source id, when the source can reauthenticate', async () => {
    seedNeedsReauth('google-docs');
    render(
      <SourceDescriptorsProvider>
        <SourcesList onOpenDetail={noop} onOpenConnection={noop} />
      </SourceDescriptorsProvider>,
    );
    // Flush BEFORE the click: the panel's mount effect waits for a non-null
    // descriptor list (C-20), so letting sources:list settle first keeps this
    // assertion off a longer promise chain.
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await act(async () => {});

    expect(invokeMock()).toHaveBeenCalledWith('accounts:start-reconnect', {
      accountId: 'a1',
    });
    expect(invokeMock()).not.toHaveBeenCalledWith(
      'accounts:add',
      expect.anything(),
    );
    expect(screen.getByText('Reconnect Google Drive')).toBeInTheDocument();
  });

  it('C-9: an imap account keeps TODAY’S accounts:add route and is never sent to start-reconnect', async () => {
    seedNeedsReauth('imap');
    render(
      <SourceDescriptorsProvider>
        <SourcesList onOpenDetail={noop} onOpenConnection={noop} />
      </SourceDescriptorsProvider>,
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await act(async () => {});

    // THE REGRESSION THIS TEST EXISTS FOR: engine.reconnect throws
    // "imap cannot be reconnected — remove this source and add it again" for a
    // source with no `reauthenticate`, and imap emits needsReauth on every
    // expired password. Routing it to accounts:start-reconnect would leave
    // Remove — which DESTROYS the account's documents — as the only in-app
    // action a user with an expired mail password has.
    expect(invokeMock()).toHaveBeenCalledWith('accounts:add', {
      sourceId: 'imap',
    });
    expect(invokeMock()).not.toHaveBeenCalledWith(
      'accounts:start-reconnect',
      expect.anything(),
    );
    // "Byte-for-byte today's route" includes today's copy: mode 'connect'.
    expect(screen.getByText('Connect Email (IMAP)')).toBeInTheDocument();
    expect(
      screen.queryByText('Reconnect Email (IMAP)'),
    ).not.toBeInTheDocument();
  });
});

describe('SourcesList: loading vs. genuinely empty', () => {
  it('shows a loading status, not the empty state, while hydrating', async () => {
    mockState = stateWith(false);
    render(<SourcesList onOpenDetail={noop} onOpenConnection={noop} />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Loading sources…',
    );
    expect(
      screen.queryByText(/No sources connected yet/),
    ).not.toBeInTheDocument();
  });

  it('shows the empty state once ready with no accounts', () => {
    mockState = stateWith(true);
    render(<SourcesList onOpenDetail={noop} onOpenConnection={noop} />);

    expect(
      screen.getByText(/No sources connected yet — add one to get started\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
