import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AppState } from '@shared/contracts';
import { AddSourcePanel } from '../AddSourcePanel';
import { SourceDescriptorsProvider } from '../sources-registry';

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({ extensions: [], accounts: [] } as unknown as AppState),
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
];

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
      return Promise.reject(new Error(`unexpected invoke: ${channel}`));
    }),
    on: jest.fn((_channel: string, handler: (evt: unknown) => void) => {
      pushHandler = handler;
      return () => {};
    }),
  };
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
