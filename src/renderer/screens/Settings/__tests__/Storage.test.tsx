import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { FactoryResetOutcome } from '@shared/ipc';
import { Storage } from '../Storage';

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({ accounts: [], processing: { done: 0 }, extensions: [] }),
}));

const invoke = jest.fn();
const alert = jest.fn();
const STATS = {
  docCount: 335550,
  accountCount: 13,
  dbBytes: 12.5 * 1024 ** 3,
  dataDir: '/Users/test/Library/Application Support/App',
};

function setup(outcome?: FactoryResetOutcome | Error) {
  invoke.mockReset();
  alert.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'storage:stats') return Promise.resolve(STATS);
    if (channel === 'maintenance:reset-all')
      return outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve(outcome);
    return Promise.resolve(undefined);
  });
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: () => () => {},
  };
  window.alert = alert;
}

const wiped: FactoryResetOutcome = {
  ok: true,
  coreWiped: true,
  failed: [],
  error: null,
};

async function reset(afterWipe?: () => Promise<string | null>) {
  render(<Storage afterWipe={afterWipe} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Reset…' }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Reset all data' }));
  });
}

describe('Storage pane', () => {
  it('lists items, sources, size and location', async () => {
    setup();
    render(<Storage />);
    expect(await screen.findByText('335,550')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.getByText('12.5 GB')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show in Finder' }));
    expect(invoke).toHaveBeenCalledWith('app:open-path', {
      path: STATS.dataDir,
    });
  });

  it('compacts only after the confirmation, and says so in the pane', async () => {
    setup();
    render(<Storage />);
    fireEvent.click(
      await screen.findByRole('button', { name: /^Maintenance/ }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));
    expect(invoke).not.toHaveBeenCalledWith('maintenance:compact', undefined);
    await act(async () => {
      fireEvent.click(
        screen
          .getAllByRole('button', { name: 'Compact' })
          .at(-1) as HTMLElement,
      );
    });
    expect(invoke).toHaveBeenCalledWith('maintenance:compact', undefined);
    expect(await screen.findByText('Database compacted.')).toBeInTheDocument();
  });
});

describe('Storage reset and the afterWipe step', () => {
  it('runs afterWipe only after a full core wipe and adds its sentence', async () => {
    setup(wiped);
    const afterWipe = jest.fn().mockResolvedValue('The record stays.');
    await reset(afterWipe);
    expect(afterWipe).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      'All local data was wiped. The record stays.',
    );
  });

  it.each([
    ['stopped before the core wipe', false],
    ['could not tell', null],
  ] as const)(
    'never runs afterWipe when the reset %s',
    async (_n, coreWiped) => {
      setup({ ok: false, coreWiped, failed: [], error: 'disk' });
      const afterWipe = jest.fn().mockResolvedValue(null);
      await reset(afterWipe);
      expect(afterWipe).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith(
        expect.stringMatching(/^The reset did not finish/),
      );
    },
  );

  it('reports an afterWipe that throws', async () => {
    setup(wiped);
    await reset(() => Promise.reject(new Error('locked')));
    expect(alert).toHaveBeenCalledWith(
      'All local data was wiped. Failed: locked',
    );
  });

  it('without afterWipe the reset sentence stands alone; a rejected reset is reported', async () => {
    setup(wiped);
    await reset();
    expect(alert).toHaveBeenCalledWith('All local data was wiped.');
  });

  it('a rejected reset is reported and the sheet closes', async () => {
    setup(new Error('busy'));
    await reset();
    expect(alert).toHaveBeenCalledWith('Failed: busy');
    expect(
      screen.queryByRole('button', { name: 'Reset all data' }),
    ).not.toBeInTheDocument();
  });
});
