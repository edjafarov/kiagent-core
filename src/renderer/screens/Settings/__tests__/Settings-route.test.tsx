import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ViewContext, type ViewContextValue } from '@renderer/state/view';
import { Settings } from '..';

// The panes are IPC-heavy; this test is about which one shows.
jest.mock('../Account', () => ({ Account: () => <p>account pane</p> }));
jest.mock('../Storage', () => ({ Storage: () => <p>storage pane</p> }));
jest.mock('../LocalProcessing', () => ({
  LocalProcessing: () => <p>local pane</p>,
}));
jest.mock('../Advanced', () => ({ Advanced: () => <p>advanced pane</p> }));
jest.mock('../About', () => ({ About: () => <p>about pane</p> }));

function renderAt(pane: string | undefined, replaceParams = jest.fn()) {
  const ctx: ViewContextValue = {
    view: 'settings',
    params: { pane },
    navigate: jest.fn(),
    back: jest.fn(),
    openSettings: jest.fn(),
    replaceParams,
  };
  const ui = (p: string | undefined) => (
    <ViewContext.Provider value={ctx}>
      <Settings pane={p} />
    </ViewContext.Provider>
  );
  const r = render(ui(pane));
  return {
    replaceParams,
    rerender: (p: string | undefined) => r.rerender(ui(p)),
  };
}

describe('Settings page', () => {
  it('shows the pane the route names, Account by default', () => {
    renderAt(undefined);
    expect(screen.getByText('account pane')).toBeInTheDocument();
  });

  it('switches by rewriting the route and follows the route', () => {
    const { replaceParams, rerender } = renderAt('about');
    expect(screen.getByText('about pane')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Storage' }));
    expect(replaceParams).toHaveBeenCalledWith({ pane: 'storage' });
    rerender('storage');
    expect(screen.getByText('storage pane')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Storage' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
