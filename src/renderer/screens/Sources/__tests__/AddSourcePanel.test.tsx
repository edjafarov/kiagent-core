import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AppState } from '@shared/contracts';
import { AddSourcePanel } from '../AddSourcePanel';
import { SourceDescriptorsProvider } from '../sources-registry';

// Mutable: A-4's Add-tile routing reads the account projection. The factory
// body only runs at require time, so the `let` is initialised by then.
let mockAccounts: unknown[] = [];

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({ extensions: [], accounts: mockAccounts } as unknown as AppState),
}));

const DESCRIPTORS = [
  {
    id: 'slack',
    name: 'Slack',
    documentTypes: ['slack.day'],
    auth: 'password',
    multiAccount: true,
    cadence: { every: '15m' },
  },
  {
    id: 'local-folder',
    name: 'Local files',
    documentTypes: ['file'],
    auth: 'none',
    multiAccount: true,
    folderScope: true,
  },
  {
    id: 'google-docs',
    name: 'Google Drive',
    documentTypes: ['gdoc'],
    auth: 'oauth',
    folderScope: true,
    // C-9: populated by core at registry-list time (boot.ts:118, Task 7).
    // google-docs gains `reauthenticate` in this train, so it CAN be
    // reconnected.
    hasReauthenticate: true,
  },
  {
    // Verbatim from src/main/sources/imap/source.ts:90-97, and deliberately
    // WITHOUT hasReauthenticate: imap has no `reauthenticate` today and gains
    // none in this train.
    id: 'imap',
    name: 'Email (IMAP)',
    documentTypes: ['email.message'],
    auth: 'password',
    multiAccount: true,
    cadence: { every: '15m' },
  },
];

// The single machine-scoped local-folder account: identifier is pinned to
// MACHINE_IDENTIFIER, which is exactly why a second accounts:add would upsert
// onto it (local-folder-source.ts:47, store.ts:1059-1064).
const LOCAL_ACCOUNT = {
  account: {
    id: 'lf1',
    source: 'local-folder',
    identifier: 'this-machine',
    config: {
      folderRoots: [
        { id: '/Users/me/Documents', name: 'Documents' },
        { id: '/Users/me/Code', name: 'Code' },
      ],
    },
    status: 'live',
    cursor: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
  docCount: 4,
  recent: [],
};

const ENRICHED_SCHEMA = {
  type: 'object',
  required: ['password'],
  description: 'Paste a token from your own internal Slack app.',
  'x-steps': [
    {
      title: 'Create the Slack app',
      body: 'Create New App → From a manifest → paste this:',
      link: 'https://api.slack.com/apps?new_app=1',
      copy: 'display_information:\n  name: KIAgent\n',
    },
  ],
  properties: {
    password: {
      type: 'string',
      title: 'User OAuth Token',
      format: 'password',
      description: 'From OAuth & Permissions after installing the app.',
      examples: ['xoxp-…'],
    },
  },
};

let pushHandler: ((evt: unknown) => void) | null = null;

beforeEach(() => {
  pushHandler = null;
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke: jest.fn((channel: string) => {
      if (channel === 'sources:list') return Promise.resolve(DESCRIPTORS);
      if (channel === 'accounts:add') return Promise.resolve({ flowId: 'f1' });
      if (channel === 'accounts:prompt-answer')
        return Promise.resolve(undefined);
      if (channel === 'accounts:cancel-flow') return Promise.resolve(undefined);
      if (channel === 'accounts:start-reconnect')
        return Promise.resolve({ flowId: 'f1' });
      if (channel === 'accounts:start-manage-folders')
        return Promise.resolve({ flowId: 'f1' });
      return Promise.reject(new Error(`unexpected invoke: ${channel}`));
    }),
    on: jest.fn((_channel: string, handler: (evt: unknown) => void) => {
      pushHandler = handler;
      return () => {};
    }),
  };
  mockAccounts = [];
});

async function openSlackPrompt(onDone = jest.fn()): Promise<jest.Mock> {
  render(
    <SourceDescriptorsProvider>
      <AddSourcePanel onDone={onDone} />
    </SourceDescriptorsProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /slack/i }));
  // accounts:add resolves (flow state set), then the prompt event arrives.
  await act(async () => {});
  act(() => {
    pushHandler!({
      flowId: 'f1',
      kind: 'prompt',
      requestId: 'r1',
      schema: ENRICHED_SCHEMA,
    });
  });
  return onDone;
}

describe('AddSourcePanel wizard card', () => {
  test('renders heading, intro, steps, placeholder, helper text, and footer buttons', async () => {
    await openSlackPrompt();
    expect(screen.getByText('Connect Slack')).toBeInTheDocument();
    expect(
      screen.getByText('Paste a token from your own internal Slack app.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Create the Slack app')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('xoxp-…')).toBeInTheDocument();
    expect(
      screen.getByText('From OAuth & Permissions after installing the app.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveClass('btn', 'sm');
    expect(cancel).not.toHaveClass('ghost');
  });

  test('Connect submits the answers for the prompt requestId', async () => {
    await openSlackPrompt();
    fireEvent.change(screen.getByPlaceholderText('xoxp-…'), {
      target: { value: 'xoxp-test-deadbeef' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await act(async () => {});
    expect(
      (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent.invoke,
    ).toHaveBeenCalledWith('accounts:prompt-answer', {
      requestId: 'r1',
      answers: { password: 'xoxp-test-deadbeef' },
    });
  });

  test('footer Cancel exits the panel', async () => {
    const onDone = await openSlackPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onDone).toHaveBeenCalled();
  });

  test('unmounting mid-flow cancels it main-side (accounts:cancel-flow)', async () => {
    // The real Cancel path: props.onDone → the parent unmounts the panel with
    // the prompt still pending — without the cancel the suspended connect()
    // and its broker entries live until app quit.
    const { unmount } = render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={jest.fn()} />
      </SourceDescriptorsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /slack/i }));
    await act(async () => {});
    act(() => {
      pushHandler!({
        flowId: 'f1',
        kind: 'prompt',
        requestId: 'r1',
        schema: ENRICHED_SCHEMA,
      });
    });

    unmount();
    expect(
      (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent.invoke,
    ).toHaveBeenCalledWith('accounts:cancel-flow', { flowId: 'f1' });
  });

  test('unmounting a settled flow does NOT send a stale cancel', async () => {
    const { unmount } = render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={jest.fn()} />
      </SourceDescriptorsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /slack/i }));
    await act(async () => {});
    act(() => {
      pushHandler!({ flowId: 'f1', kind: 'error', msg: 'boom' });
    });

    unmount();
    expect(
      (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent.invoke,
    ).not.toHaveBeenCalledWith('accounts:cancel-flow', expect.anything());
  });

  test('tile-grid Cancel is a visible bordered button', async () => {
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={jest.fn()} />
      </SourceDescriptorsProvider>,
    );
    await screen.findByRole('button', { name: /slack/i });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveClass('btn', 'sm');
    expect(cancel).not.toHaveClass('ghost');
  });

  test('reconnect starts an account-scoped reconnect flow, never accounts:add', async () => {
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel
          onDone={jest.fn()}
          reconnect={{
            accountId: 'a1' as never,
            sourceId: 'google-docs',
            identifier: 'user@example.com',
          }}
        />
      </SourceDescriptorsProvider>,
    );
    // Two flushes, deliberately: the first lets `sources:list` resolve (C-20:
    // the gate WAITS for a non-null descriptor list), the second lets the
    // mount effect's own invoke settle.
    await act(async () => {});
    await act(async () => {});
    const { invoke } = (window as unknown as { kiagent: { invoke: jest.Mock } })
      .kiagent;
    expect(invoke).toHaveBeenCalledWith('accounts:start-reconnect', {
      accountId: 'a1',
    });
    expect(invoke).not.toHaveBeenCalledWith('accounts:add', expect.anything());
    // The wizard card is up (not the tile grid) with reconnect copy.
    expect(screen.getByText('Reconnect Google Drive')).toBeInTheDocument();
  });

  test('C-9: a source that cannot reauthenticate keeps TODAY’S accounts:add route', async () => {
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel
          onDone={jest.fn()}
          reconnect={{
            accountId: 'a1' as never,
            sourceId: 'imap',
            identifier: 'user@example.com',
          }}
        />
      </SourceDescriptorsProvider>,
    );
    await act(async () => {});
    await act(async () => {});
    const { invoke } = (window as unknown as { kiagent: { invoke: jest.Mock } })
      .kiagent;
    // THE REGRESSION GUARD. engine.reconnect throws "imap cannot be
    // reconnected — remove this source and add it again" for any source
    // without `reauthenticate`, and imap emits needsReauth on every expired
    // password. Offering start-reconnect there leaves Remove — which DESTROYS
    // the account's documents — as the only in-app action.
    expect(invoke).toHaveBeenCalledWith('accounts:add', { sourceId: 'imap' });
    expect(invoke).not.toHaveBeenCalledWith(
      'accounts:start-reconnect',
      expect.anything(),
    );
    // Today's route means today's copy too: the fallback runs as mode
    // 'connect', so the heading and the outcome line are unchanged.
    expect(screen.getByText('Connect Email (IMAP)')).toBeInTheDocument();
    expect(
      screen.queryByText('Reconnect Email (IMAP)'),
    ).not.toBeInTheDocument();
  });

  test('a reconnected event renders the reconnect outcome and settles the flow', async () => {
    const onDone = jest.fn();
    const { unmount } = render(
      <SourceDescriptorsProvider>
        <AddSourcePanel
          onDone={onDone}
          reconnect={{
            accountId: 'a1' as never,
            sourceId: 'google-docs',
            identifier: 'user@example.com',
          }}
        />
      </SourceDescriptorsProvider>,
    );
    await act(async () => {});
    await act(async () => {});
    act(() => {
      pushHandler!({ flowId: 'f1', kind: 'reconnected', accountId: 'a1' });
    });
    expect(screen.getByText('user@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/^Connected:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledWith('a1');

    // `reconnected` is terminal: liveFlowRef must have cleared, or unmounting
    // sends a stale cancel for a flow main-side already finished.
    unmount();
    expect(
      (window as unknown as { kiagent: { invoke: jest.Mock } }).kiagent.invoke,
    ).not.toHaveBeenCalledWith('accounts:cancel-flow', expect.anything());
  });

  test('A-4: the Add tile MANAGES an existing local-folder account, never accounts:add', async () => {
    mockAccounts = [LOCAL_ACCOUNT];
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={jest.fn()} />
      </SourceDescriptorsProvider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Local files/i }),
    );
    await act(async () => {});

    const { invoke } = (window as unknown as { kiagent: { invoke: jest.Mock } })
      .kiagent;
    expect(invoke).toHaveBeenCalledWith('accounts:start-manage-folders', {
      accountId: 'lf1',
    });
    // THE CORPUS WIPE THIS TEST EXISTS FOR: accounts:add would upsert on
    // (local-folder, 'this-machine') and replace config.folderRoots with ONLY
    // the newly picked folder, archiving /Users/me/Documents and
    // /Users/me/Code on an ordinary two-click "add another folder".
    expect(invoke).not.toHaveBeenCalledWith('accounts:add', expect.anything());
    expect(screen.getByText('Add folders to Local files')).toBeInTheDocument();
  });

  test('A-4: the Add tile still CONNECTS when no local-folder account exists', async () => {
    mockAccounts = [];
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={jest.fn()} />
      </SourceDescriptorsProvider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Local files/i }),
    );
    await act(async () => {});

    const { invoke } = (window as unknown as { kiagent: { invoke: jest.Mock } })
      .kiagent;
    expect(invoke).toHaveBeenCalledWith('accounts:add', {
      sourceId: 'local-folder',
    });
    expect(invoke).not.toHaveBeenCalledWith(
      'accounts:start-manage-folders',
      expect.anything(),
    );
  });

  test('C-32: reconnecting a local-folder account MANAGES it — never accounts:add, never start-reconnect', async () => {
    // THE COMPOSITION. The two tests above prove the halves separately: the
    // C-9 fallback (a source with no `hasReauthenticate` keeps today's route)
    // and A-4's gate (the Add tile manages an existing machine-scoped
    // account). This is the single path where they MEET — R4 offers Reconnect
    // on an `error`/`needsReauth` account of ANY source, `local-folder` has no
    // `reauthenticate` and never gains one, so its Reconnect takes the C-9
    // fallback into `pick()`. If that fallback ever opens its own
    // `accounts:add` call site instead of going through `pick`, A-4's corpus
    // wipe comes straight back: `accounts:add` upserts on
    // (local-folder, 'this-machine') and replaces config.folderRoots with only
    // the newly picked folder, archiving every other tracked root. Neither
    // half's test can see that regression on its own.
    mockAccounts = [LOCAL_ACCOUNT];
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel
          onDone={jest.fn()}
          reconnect={{
            accountId: 'lf1' as never,
            sourceId: 'local-folder',
            identifier: 'this-machine',
          }}
        />
      </SourceDescriptorsProvider>,
    );
    // Two flushes, as above: the first lets `sources:list` resolve (C-20's
    // descriptors wait), the second lets the routed invoke settle.
    await act(async () => {});
    await act(async () => {});

    const { invoke } = (window as unknown as { kiagent: { invoke: jest.Mock } })
      .kiagent;
    expect(invoke).toHaveBeenCalledWith('accounts:start-manage-folders', {
      accountId: 'lf1',
    });
    expect(invoke).not.toHaveBeenCalledWith('accounts:add', expect.anything());
    expect(invoke).not.toHaveBeenCalledWith(
      'accounts:start-reconnect',
      expect.anything(),
    );
    // …and it is the MANAGE wizard, not the reconnect one.
    expect(screen.getByText('Add folders to Local files')).toBeInTheDocument();
    expect(screen.queryByText('Reconnect Local files')).not.toBeInTheDocument();
  });

  test('a scope-saved event ends the manage flow with its counts', async () => {
    mockAccounts = [LOCAL_ACCOUNT];
    const onDone = jest.fn();
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={onDone} />
      </SourceDescriptorsProvider>,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /Local files/i }),
    );
    await act(async () => {});
    act(() => {
      pushHandler!({
        flowId: 'f1',
        kind: 'scope-saved',
        accountId: 'lf1',
        added: 2,
        retained: 1,
        removed: 0,
      });
    });

    expect(
      screen.getByText('Folders updated — 2 added, 0 removed.'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledWith('lf1');
  });

  test('a folder-paths prompt no longer opens the picker fast path', async () => {
    // Task 8 gives local-folder a real FolderPickerSpec, so nothing emits this
    // schema any more; the fast path and its existingPaths union are DELETED.
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={jest.fn()} />
      </SourceDescriptorsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /slack/i }));
    await act(async () => {});
    act(() => {
      pushHandler!({
        flowId: 'f1',
        kind: 'prompt',
        requestId: 'r1',
        schema: {
          type: 'object',
          properties: { dirs: { type: 'array', format: 'folder-paths' } },
        },
      });
    });
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('schema without conventions still renders the plain form', async () => {
    const plain = {
      type: 'object',
      properties: {
        password: { type: 'string', title: 'Token', format: 'password' },
      },
    };
    render(
      <SourceDescriptorsProvider>
        <AddSourcePanel onDone={jest.fn()} />
      </SourceDescriptorsProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /slack/i }));
    await act(async () => {});
    act(() => {
      pushHandler!({
        flowId: 'f1',
        kind: 'prompt',
        requestId: 'r1',
        schema: plain,
      });
    });
    expect(screen.getByText('Connect Slack')).toBeInTheDocument();
    expect(screen.getByText('Token')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument(); // no steps <ol>
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });
});
