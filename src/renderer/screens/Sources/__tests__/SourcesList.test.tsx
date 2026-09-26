import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Account, AppState } from '@shared/contracts';
import { SourcesList } from '../SourcesList';
import { Sources } from '..';
import { SourceDescriptorsProvider } from '../sources-registry';

let mockState: Partial<AppState>;
jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));

const DESCRIPTORS = [
  { id: 'gmail', name: 'Gmail', documentTypes: [], auth: 'oauth' },
  { id: 'slack', name: 'Slack', documentTypes: [], auth: 'oauth' },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    documentTypes: [],
    auth: 'oauth',
  },
  {
    id: 'google-docs',
    name: 'Google Drive',
    documentTypes: [],
    auth: 'oauth',
    folderScope: true,
    hasReauthenticate: true,
  },
  {
    id: 'imap',
    name: 'Email (IMAP)',
    documentTypes: [],
    auth: 'password',
    cadence: { every: '15m' },
  },
  { id: 'meetings', name: 'Meetings', documentTypes: [], auth: 'none' },
];

function entry(
  id: string,
  source: string,
  status: Account['status'],
  extra: Partial<Account> = {},
  docCount = 100,
): AppState['accounts'][number] {
  return {
    account: {
      id: id as Account['id'],
      source,
      identifier: `${id}@example.com`,
      config: {},
      status,
      cursor: null,
      createdAt: '2026-01-01T00:00:00Z',
      ...extra,
    },
    docCount,
    recent: [],
  } as unknown as AppState['accounts'][number];
}

let invoke: jest.Mock;

function seed(
  accounts: AppState['accounts'],
  opts: { ready?: boolean } = {},
): void {
  mockState = {
    accounts,
    extensions: [],
    ready: opts.ready ?? true,
    prefs: {
      onboarding: {
        sourceBackfilledAt: null,
        mcpConnectedAt: null,
        firstQueryAt: null,
        dismissedAt: '2026-01-01T00:00:00Z',
      },
    },
  } as unknown as Partial<AppState>;
}

beforeEach(() => {
  invoke = jest.fn((channel: string) => {
    if (channel === 'sources:list') return Promise.resolve(DESCRIPTORS);
    if (channel === 'marketplace:list') return Promise.resolve([]);
    if (channel === 'accounts:start-reconnect')
      return Promise.resolve({ flowId: 'f1' });
    if (channel === 'accounts:add') return Promise.resolve({ flowId: 'f1' });
    return Promise.resolve(undefined);
  });
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke,
    on: jest.fn(() => () => {}),
  };
});

const noop = (): void => {};

async function list(
  props: Partial<React.ComponentProps<typeof SourcesList>>,
  hidden?: string[],
) {
  const all = {
    onOpenDetail: jest.fn(),
    onOpenConnection: noop,
    onCatalog: jest.fn(),
    onReconnect: jest.fn(),
    ...props,
  };
  render(
    <SourceDescriptorsProvider hidden={hidden}>
      <SourcesList {...all} />
    </SourceDescriptorsProvider>,
  );
  await act(async () => {});
  return all;
}

function panel(): HTMLElement {
  return screen.getByRole('region', { name: /Gmail|Slack|Google|Email/ });
}

describe('SourcesList', () => {
  test('the title line counts sources, items and what needs you', async () => {
    seed([
      entry('a1', 'gmail', 'needsReauth', {}, 1000),
      entry('a2', 'slack', 'live', {}, 234),
    ]);
    await list({});
    expect(
      screen.getByText('2 sources · 1,234 items · 1 needs you'),
    ).toBeInTheDocument();
  });

  test('rows filter by kind; the last column shows a status instead of a time', async () => {
    seed([
      entry('a1', 'gmail', 'needsReauth'),
      entry('a2', 'slack', 'live'),
      entry('a3', 'imap', 'paused'),
    ]);
    await list({});
    const table = screen.getByRole('table', { name: 'Sources' });
    expect(within(table).getByText('Signed out')).toBeInTheDocument();
    expect(within(table).getByText('Paused')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Chat/ }));
    expect(within(table).queryByText('Gmail')).not.toBeInTheDocument();
    expect(within(table).getByText('Slack')).toBeInTheDocument();
  });

  test('a first import shows its progress beside the item count', async () => {
    seed([
      entry('a1', 'google-calendar', 'backfilling', {
        progress: { done: 64, totalEstimate: 100 },
      } as Partial<Account>),
    ]);
    await list({});
    expect(
      screen.getByRole('progressbar', { name: 'First import' }),
    ).toBeInTheDocument();
    expect(screen.getByText('64%')).toBeInTheDocument();
  });

  test('selects the first source needing you, and holds a picked row', async () => {
    seed([entry('a2', 'slack', 'live'), entry('a1', 'gmail', 'needsReauth')]);
    await list({});
    expect(panel()).toHaveAccessibleName('Gmail');
    fireEvent.click(screen.getByText('Slack'));
    expect(panel()).toHaveAccessibleName('Slack');
  });

  test('the panel offers each problem’s one fix', async () => {
    seed([entry('a1', 'gmail', 'needsReauth', { lastError: 'invalid_grant' })]);
    const { onReconnect } = await list({});
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }));
    expect(screen.getByText('invalid_grant')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(onReconnect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a1' }),
    );
  });

  test('retry re-runs a plain error', async () => {
    seed([entry('a1', 'slack', 'error')]);
    await list({});
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(invoke).toHaveBeenCalledWith('accounts:sync-now', {
      accountId: 'a1',
    });
  });

  test('resume resumes a paused source', async () => {
    seed([entry('a1', 'imap', 'paused')]);
    await list({});
    fireEvent.click(within(panel()).getByRole('button', { name: 'Resume' }));
    expect(invoke).toHaveBeenCalledWith('accounts:resume', {
      accountId: 'a1',
    });
  });

  test('the panel says how often it checks and opens the source page', async () => {
    seed([entry('a1', 'imap', 'live')]);
    const { onOpenDetail } = await list({});
    expect(within(panel()).getByText('Every 15 minutes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open Email (IMAP)' }));
    expect(onOpenDetail).toHaveBeenCalledWith('a1');
  });

  test('Sync all syncs every visible source', async () => {
    seed([entry('a1', 'gmail', 'live'), entry('a2', 'meetings', 'live')]);
    await list({}, ['meetings']);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sync all' }));
    expect(invoke).toHaveBeenCalledWith('accounts:sync-now', {
      accountId: 'a1',
    });
    expect(invoke).not.toHaveBeenCalledWith('accounts:sync-now', {
      accountId: 'a2',
    });
  });

  test('hidden sources are left out of rows and counts', async () => {
    seed([entry('a1', 'gmail', 'live'), entry('a2', 'meetings', 'live')]);
    await list({}, ['meetings']);
    expect(screen.getByText('1 source · 100 items')).toBeInTheDocument();
    expect(screen.queryByText('Meetings')).not.toBeInTheDocument();
  });

  test('add more: store extensions not installed open their install sheet', async () => {
    invoke.mockImplementation((channel: string) =>
      Promise.resolve(
        channel === 'sources:list'
          ? DESCRIPTORS
          : channel === 'marketplace:list'
            ? [
                {
                  owner: 'example-org',
                  repo: 'dropbox-kia-connector',
                  fullName: 'example-org/dropbox-kia-connector',
                  displayName: 'Dropbox',
                  description: 'Files and folders',
                },
              ]
            : undefined,
      ),
    );
    seed([entry('a1', 'gmail', 'live')]);
    const { onCatalog } = await list({});
    fireEvent.click(screen.getByRole('button', { name: 'Add Dropbox' }));
    expect(onCatalog).toHaveBeenCalledWith('example-org/dropbox-kia-connector');
    fireEvent.click(screen.getByRole('button', { name: /^All \d+ sources$/ }));
    expect(onCatalog).toHaveBeenLastCalledWith();
  });

  test('empty: says so and offers Add source', async () => {
    seed([]);
    const { onCatalog } = await list({});
    expect(
      screen.getByText('No sources connected yet — add one to get started.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Add source/ })[0]);
    expect(onCatalog).toHaveBeenCalled();
  });

  test('loading: a status, not the empty state, while hydrating', async () => {
    seed([], { ready: false });
    await list({});
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Loading sources…',
    );
    expect(
      screen.queryByText(/No sources connected yet/),
    ).not.toBeInTheDocument();
  });
});

describe('Sources: Sign in again routes on the account and its descriptor', () => {
  async function signInAgain(source: string): Promise<void> {
    seed([entry('a1', source, 'needsReauth')]);
    render(<Sources onOpenConnection={noop} />, {
      wrapper: SourceDescriptorsProvider,
    });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    await act(async () => {});
  }

  test('reconnects THAT account when the source can reauthenticate', async () => {
    await signInAgain('google-docs');
    expect(invoke).toHaveBeenCalledWith('accounts:start-reconnect', {
      accountId: 'a1',
    });
    expect(invoke).not.toHaveBeenCalledWith('accounts:add', expect.anything());
    expect(screen.getByText('Reconnect Google Drive')).toBeInTheDocument();
  });

  test('C-9: an imap account keeps the accounts:add route', async () => {
    // imap has no `reauthenticate`: start-reconnect would throw and leave
    // Remove — which deletes the account's documents — as the only action.
    await signInAgain('imap');
    expect(invoke).toHaveBeenCalledWith('accounts:add', { sourceId: 'imap' });
    expect(invoke).not.toHaveBeenCalledWith(
      'accounts:start-reconnect',
      expect.anything(),
    );
    expect(screen.getByText('Connect Email (IMAP)')).toBeInTheDocument();
  });
});
