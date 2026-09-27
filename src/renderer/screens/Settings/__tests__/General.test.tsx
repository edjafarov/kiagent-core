import '@testing-library/jest-dom';
import React from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import type { UpdateState } from '@shared/ipc';
import { ViewContext, type ViewContextValue } from '@renderer/state/view';
import { General, updateLine } from '../General';

const prefs = { launchAtLogin: true, showInMenuBar: false, logLevel: 'info' };
jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel({ prefs }),
}));

const invoke = jest.fn();
let pushUpdate: ((s: UpdateState) => void) | null = null;

function setup(update: Partial<UpdateState>) {
  invoke.mockReset();
  invoke.mockImplementation((channel: string) => {
    if (channel === 'app:info')
      return Promise.resolve({
        version: '1.2.3',
        platform: 'darwin',
        productName: 'Acme',
      });
    if (channel === 'update:get-state' || channel === 'update:check')
      return Promise.resolve({
        currentVersion: '1.2.3',
        version: null,
        ...update,
      });
    if (channel === 'logs:export') return Promise.resolve('/tmp/logs.zip');
    return Promise.resolve(undefined);
  });
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: (_ch: string, fn: (s: UpdateState) => void) => {
      pushUpdate = fn;
      return () => {};
    },
  };
  const navigate = jest.fn();
  const ctx: ViewContextValue = {
    view: 'settings',
    params: {},
    navigate,
    back: jest.fn(),
    openSettings: jest.fn(),
    replaceParams: jest.fn(),
  };
  render(
    <ViewContext.Provider value={ctx}>
      <General />
    </ViewContext.Provider>,
  );
  return { navigate };
}

describe('General pane', () => {
  it('startup toggles patch the prefs', async () => {
    setup({ status: 'idle' });
    await screen.findByText(/Start Acme when you sign in/);
    fireEvent.click(screen.getByRole('switch', { name: 'Show in menu bar' }));
    expect(invoke).toHaveBeenCalledWith('prefs:patch', {
      showInMenuBar: true,
    });
  });

  it('shows the version and the last check, with Check now', async () => {
    const checkedAt = new Date();
    checkedAt.setHours(9, 12, 0, 0);
    setup({ status: 'up-to-date', checkedAt: checkedAt.getTime() });
    await screen.findByText('Checked today at 09:12');
    expect(screen.getByText('1.2.3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(invoke).toHaveBeenCalledWith('update:check', undefined);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Check now' })).toBeEnabled(),
    );
  });

  it('a downloaded update offers only Restart to update', async () => {
    setup({ status: 'downloaded', version: '1.3.0' });
    await screen.findByText('1.3.0 is ready — restart to finish.');
    expect(
      screen.queryByRole('button', { name: 'Check now' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(invoke).toHaveBeenCalledWith('update:quit-and-install', undefined);
  });

  it('follows pushes: downloading shows its percent and disables the check', async () => {
    setup({ status: 'idle' });
    await screen.findByText('You’re up to date.');
    await waitFor(() => expect(pushUpdate).not.toBeNull());
    act(() =>
      pushUpdate?.({
        status: 'downloading',
        currentVersion: '1.2.3',
        version: '1.3.0',
        percent: 41.6,
      }),
    );
    expect(screen.getByText('Downloading 1.3.0 · 42%')).toBeInTheDocument();
    expect(
      screen.getByRole('progressbar', { name: 'Update download' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeDisabled();
  });

  it('disabled updates show why and no button', async () => {
    setup({ status: 'disabled', reason: 'dev' });
    await screen.findByText('Updates are disabled in development.');
    expect(
      screen.queryByRole('button', { name: /Check now|Restart/ }),
    ).not.toBeInTheDocument();
  });

  it('diagnostics: log level, export and the way to Logs', async () => {
    const { navigate } = setup({ status: 'idle' });
    await screen.findByText(/Start Acme when you sign in/);
    fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Log level' }), {
      target: { value: 'warn' },
    });
    expect(invoke).toHaveBeenCalledWith('prefs:patch', { logLevel: 'warn' });
    fireEvent.click(screen.getByRole('button', { name: 'Export logs…' }));
    await screen.findByText('Exported to /tmp/logs.zip');
    fireEvent.click(screen.getByRole('button', { name: 'Open logs' }));
    expect(navigate).toHaveBeenCalledWith('logs');
  });
});

describe('updateLine', () => {
  const base = { currentVersion: '1.2.3', version: null } as const;
  it('never-checked idle reads up to date', () => {
    expect(updateLine({ ...base, status: 'idle' }, Date.now())).toBe(
      'You’re up to date.',
    );
  });
  it('an error says so', () => {
    expect(
      updateLine({ ...base, status: 'error', error: 'offline' }, Date.now()),
    ).toBe('Update check failed: offline');
  });
});
