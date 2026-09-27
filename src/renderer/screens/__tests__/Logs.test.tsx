import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { LogRecord } from '@shared/contracts';
import { ViewContext, type ViewContextValue } from '@renderer/state/view';
import { Logs } from '../Logs';

const invoke = jest.fn();
let push: ((batch: LogRecord[]) => void) | null = null;

const rec = (
  msg: string,
  level: LogRecord['level'],
  scope: string,
): LogRecord => ({ ts: '2026-09-27T11:46:05.000Z', level, scope, msg });

const SEED = [
  rec('Request from Claude', 'info', 'mcp'),
  rec('Sync skipped', 'warn', 'gmail'),
  rec('Reindex batch failed', 'error', 'index'),
];

function setup() {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) =>
    channel === 'logs:recent'
      ? Promise.resolve(SEED)
      : Promise.resolve('/tmp/logs.txt'),
  );
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: (_ch: string, fn: (batch: LogRecord[]) => void) => {
      push = fn;
      return () => {};
    },
  };
  const ctx: ViewContextValue = {
    view: 'logs',
    params: {},
    navigate: jest.fn(),
    back: jest.fn(),
    openSettings: jest.fn(),
    replaceParams: jest.fn(),
  };
  render(
    <ViewContext.Provider value={ctx}>
      <Logs />
    </ViewContext.Provider>,
  );
  return ctx;
}

describe('Logs page', () => {
  it('is titled by its breadcrumb; the parent opens Settings, back steps back', async () => {
    const ctx = setup();
    await screen.findByText('Request from Claude');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(ctx.openSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /back/i }));
    expect(ctx.back).toHaveBeenCalled();
  });

  it('filters by level, scope and search, and counts what shows', async () => {
    setup();
    await screen.findByText('3 of 3 lines');
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Filter by level' }),
      {
        target: { value: 'warn' },
      },
    );
    expect(screen.queryByText('Request from Claude')).not.toBeInTheDocument();
    expect(screen.getByText('2 of 3 lines')).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Filter by scope' }),
      {
        target: { value: 'index' },
      },
    );
    expect(screen.getByText('1 of 3 lines')).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Filter by scope' }),
      {
        target: { value: 'all' },
      },
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Search messages' }), {
      target: { value: 'sync' },
    });
    expect(screen.getByText('Sync skipped')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 lines')).toBeInTheDocument();
  });

  it('pause freezes the rows while the stream keeps coming; clear empties', async () => {
    setup();
    await screen.findByText('Streaming');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByText('Paused')).toBeInTheDocument();
    act(() => push?.([rec('Late arrival', 'info', 'sync')]));
    expect(screen.queryByText('Late arrival')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByText('Late arrival')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Clear/ }));
    expect(screen.getByText('Waiting for log activity…')).toBeInTheDocument();
  });

  it('exports and says where', async () => {
    setup();
    await screen.findByText('Request from Claude');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Export/ }));
    });
    expect(screen.getByText('Exported to /tmp/logs.txt')).toBeInTheDocument();
  });
});
