import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import type { AppState } from '@shared/contracts';
import { SourcesList } from '../SourcesList';

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
