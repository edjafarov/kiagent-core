import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { AppState, ExtensionSnapshot } from '@shared/contracts';
import { ViewContext, type ViewContextValue } from '@renderer/state/view';
import { Extensions } from '../Extensions';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: (p: { children: string }) => <div>{p.children}</div>,
}));

let mockState: Partial<AppState>;
jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));

function ext(over: Partial<ExtensionSnapshot>): ExtensionSnapshot {
  return {
    id: 'kia.calendar',
    name: 'Calendar Sync',
    version: '1.0.0',
    origin: 'marketplace',
    enabled: true,
    status: 'activated',
    caps: ['net'],
    sourceIds: [],
    oauthSources: [],
    ui: [],
    ref: 'github:example-org/calendar-sync-kia-connector@v1.0.0',
    ...over,
  } as ExtensionSnapshot;
}

let invoke: jest.Mock;
let navigate: jest.Mock;

function seed(extensions: ExtensionSnapshot[], updates: unknown[] = []): void {
  mockState = { extensions } as unknown as Partial<AppState>;
  invoke = jest.fn((channel: string) => {
    if (channel === 'marketplace:check-updates')
      return Promise.resolve(updates);
    if (channel === 'extension:install-preview')
      return Promise.resolve({
        token: 't1',
        id: 'kia.calendar',
        name: 'Calendar Sync',
        version: '1.1.0',
        caps: ['net', 'send'],
        oauthSources: [],
        fileRoots: [],
        ui: [],
        sourceIds: [],
      });
    if (channel === 'marketplace:detail')
      return Promise.resolve({ readmeMarkdown: 'Syncs your calendars.' });
    return Promise.resolve({ ok: true });
  });
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: jest.fn(() => () => {}),
  };
}

async function renderPane(): Promise<void> {
  navigate = jest.fn();
  const value: ViewContextValue = {
    view: 'settings',
    params: {},
    navigate,
    back: jest.fn(),
    openSettings: jest.fn(),
    replaceParams: jest.fn(),
  };
  render(
    <ViewContext.Provider value={value}>
      <Extensions />
    </ViewContext.Provider>,
  );
  await act(async () => {});
}

test('lists installed extensions, not built-in parts, with what each can do', async () => {
  seed([
    ext({ caps: ['net'], ui: [{ id: 'p', slot: 'screen', title: 'P' }] }),
    ext({ id: 'kia.documents', name: 'Documents', origin: 'bundled' }),
  ]);
  await renderPane();
  const list = screen.getByRole('list', { name: 'Installed extensions' });
  expect(within(list).getByText('Calendar Sync')).toBeInTheDocument();
  expect(
    within(list).getByText('v1.0.0 · adds a page · uses the internet'),
  ).toBeInTheDocument();
  expect(within(list).queryByText('Documents')).not.toBeInTheDocument();
  expect(screen.getByText('Built-in parts aren’t listed.')).toBeInTheDocument();
});

test('each update is its own, through the install sheet', async () => {
  seed(
    [ext({})],
    [
      {
        id: 'kia.calendar',
        installedVersion: '1.0.0',
        latestVersion: '1.1.0',
        ref: 'github:example-org/calendar-sync-kia-connector@v1.0.0',
      },
    ],
  );
  await renderPane();
  const updates = screen.getByRole('list', { name: 'Updates' });
  expect(within(updates).getByText('Calendar Sync 1.1.0')).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(within(updates).getByRole('button', { name: 'Update' }));
  });
  expect(invoke).toHaveBeenCalledWith('extension:install-preview', {
    ref: 'github:example-org/calendar-sync-kia-connector',
  });
  const sheet = screen.getByRole('dialog');
  await act(async () => {
    fireEvent.click(within(sheet).getByRole('button', { name: 'Update' }));
  });
  expect(invoke).toHaveBeenCalledWith('extension:install-commit', {
    token: 't1',
  });
});

test('an update that needs a newer app says so and offers no button', async () => {
  seed(
    [ext({})],
    [
      {
        id: 'kia.calendar',
        installedVersion: '1.0.0',
        latestVersion: '2.0.0',
        ref: 'github:example-org/calendar-sync-kia-connector@v1.0.0',
        needsNewerApp: true,
      },
    ],
  );
  await renderPane();
  const updates = screen.getByRole('list', { name: 'Updates' });
  expect(within(updates).getByText('Calendar Sync 2.0.0')).toBeInTheDocument();
  expect(
    within(updates).getByText('Needs a newer KIAgent · you have v1.0.0'),
  ).toBeInTheDocument();
  expect(
    within(updates).queryByRole('button', { name: 'Update' }),
  ).not.toBeInTheDocument();
});

test('a spent update entry (already applied) is not offered', async () => {
  seed(
    [ext({ version: '1.1.0' })],
    [
      {
        id: 'kia.calendar',
        installedVersion: '1.0.0',
        latestVersion: '1.1.0',
        ref: 'github:example-org/calendar-sync-kia-connector',
      },
    ],
  );
  await renderPane();
  expect(
    screen.queryByRole('list', { name: 'Updates' }),
  ).not.toBeInTheDocument();
});

test('the menu turns an extension off and uninstalls after asking', async () => {
  seed([ext({})]);
  await renderPane();
  fireEvent.click(
    screen.getByRole('button', { name: 'Calendar Sync actions' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Turn off' }));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('extension:set-enabled', {
    id: 'kia.calendar',
    enabled: false,
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Calendar Sync actions' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Uninstall' }));
  const sheet = screen.getByRole('dialog', {
    name: 'Uninstall Calendar Sync?',
  });
  await act(async () => {
    fireEvent.click(within(sheet).getByRole('button', { name: 'Uninstall' }));
  });
  expect(invoke).toHaveBeenCalledWith('extension:uninstall', {
    id: 'kia.calendar',
  });
});

test('needs-consent offers Review permissions; errored shows its error', async () => {
  seed([
    ext({ status: 'needs-consent' }),
    ext({
      id: 'kia.chat',
      name: 'Chat Sync',
      status: 'errored',
      error: 'manifest invalid',
    }),
  ]);
  await renderPane();
  expect(screen.getByText('manifest invalid')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Review permissions' }));
  expect(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Allow' }),
  ).toBeInTheDocument();
});

test('Details shows what it can do and its README, then comes back', async () => {
  seed([ext({})]);
  await renderPane();
  fireEvent.click(
    screen.getByRole('button', { name: 'Calendar Sync actions' }),
  );
  fireEvent.click(screen.getByRole('menuitem', { name: 'Details' }));
  expect(
    screen.getByRole('heading', { name: 'Calendar Sync' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Access the internet')).toBeInTheDocument();
  expect(await screen.findByText('Syncs your calendars.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '← Extensions' }));
  expect(
    screen.getByRole('heading', { name: 'Extensions' }),
  ).toBeInTheDocument();
});

test('Browse all opens the Sources catalog', async () => {
  seed([]);
  await renderPane();
  expect(screen.getByText('No extensions installed yet.')).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Browse all extensions' }),
  );
  expect(navigate).toHaveBeenCalledWith('sources', { add: '' });
});
