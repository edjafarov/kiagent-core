import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { OutboxPanelRow } from '@shared/ipc';
import { SourceDescriptorsProvider } from '@renderer/screens/Sources/sources-registry';
import { Outbox, outboxMeta } from '../index';

jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) =>
    sel({
      extensions: [],
      accounts: [],
      prefs: { outbound: { defaultMode: 'review' } },
    }),
}));

const NOW = new Date(2026, 8, 24, 11, 37);
const iso = (day: number, h: number, m = 0) =>
  new Date(2026, 8, day, h, m).toISOString();

function row(over: Partial<OutboxPanelRow>): OutboxPanelRow {
  return {
    draftId: 'd',
    status: 'sent',
    kind: 'reply',
    accountLabel: 'alex@example.com',
    recipientDisplay: 'Sam Patel',
    subject: 'Launch plan',
    bodyPreview: 'Thanks for the notes',
    error: null,
    errorDetail: null,
    canRetry: false,
    deliveryUncertain: false,
    createdAt: iso(24, 9),
    sentAt: iso(24, 9, 5),
    to: ['sam@example.com'],
    cc: [],
    sourceId: 'gmail',
    createdBy: 'claude-ai',
    createdVia: 'mcp-remote',
    ...over,
  };
}

const ROWS: OutboxPanelRow[] = [
  row({
    draftId: 'wait',
    status: 'draft',
    sourceId: 'slack',
    recipientDisplay: '#design-review',
    subject: null,
    to: [],
    bodyPreview: 'Here are the three logo directions',
    sentAt: null,
    createdAt: iso(24, 11, 30),
  }),
  row({ draftId: 'sent', sentAt: iso(24, 10, 52), sourceId: 'slack' }),
  row({
    draftId: 'retry',
    status: 'failed',
    error: 'Gmail is signed out — sign in again, then try again',
    canRetry: true,
    sentAt: null,
    createdAt: iso(24, 9, 15),
  }),
  row({
    draftId: 'discarded',
    status: 'discarded',
    recipientDisplay: 'Robin',
    sentAt: null,
    createdAt: iso(23, 16, 20),
  }),
  row({
    draftId: 'unsure',
    status: 'failed',
    error: 'It may have been sent',
    deliveryUncertain: true,
    sentAt: null,
    createdAt: iso(23, 11, 47),
  }),
  row({
    draftId: 'old',
    status: 'expired',
    recipientDisplay: 'Old friend',
    sentAt: null,
    createdAt: iso(14, 9),
  }),
];

let rows: OutboxPanelRow[];
let push: (() => void) | null;
let invoke: jest.Mock;

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['queueMicrotask'] });
  rows = ROWS;
  push = null;
  invoke = jest.fn((channel: string) => {
    if (channel === 'outbox:list') return Promise.resolve(rows);
    if (channel === 'sources:list')
      return Promise.resolve([
        { id: 'slack', name: 'Slack' },
        { id: 'gmail', name: 'Gmail' },
      ]);
    if (channel === 'outbox:redraft')
      return Promise.resolve({ draftId: 'fresh' });
    return Promise.resolve(undefined);
  });
  (window as any).kiagent = {
    invoke,
    on: jest.fn((channel: string, fn: () => void) => {
      if (channel === 'push:outbox-changed') push = fn;
      return () => {};
    }),
  };
});
afterEach(() => {
  jest.useRealTimers();
  delete (window as any).kiagent;
});

async function mount() {
  render(
    <SourceDescriptorsProvider>
      <Outbox />
    </SourceDescriptorsProvider>,
  );
  await act(async () => {});
}

const history = () =>
  screen.getByRole('list', { name: 'Sent and past drafts' });

test('meta counts the waiting drafts', () => {
  expect(outboxMeta(0)).toBe(
    'Nothing waiting · nothing is sent until you confirm it',
  );
  expect(outboxMeta(1)).toBe(
    '1 draft waiting · nothing is sent until you confirm it',
  );
  expect(outboxMeta(3)).toMatch(/^3 drafts waiting/);
});

test('a waiting draft: chat title, Discard is immediate, Review & send opens it', async () => {
  await mount();
  expect(screen.getByText('1 draft waiting', { exact: false })).toBeTruthy();
  const waiting = screen.getByRole('list', { name: 'Waiting for you' });
  expect(
    within(waiting).getByText('Slack message to #design-review'),
  ).toBeInTheDocument();
  fireEvent.click(within(waiting).getByRole('button', { name: 'Discard' }));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('outbox:discard', { draftId: 'wait' });
  fireEvent.click(
    within(waiting).getByRole('button', { name: 'Review & send' }),
  );
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('outbox:open-confirm', {
    draftId: 'wait',
  });
});

test('history: day groups in order, a status word only when it did not go out', async () => {
  await mount();
  const groups = within(history())
    .getAllByRole('listitem')
    .filter((li) => li.className.includes('ui-day'))
    .map((li) => li.textContent);
  expect(groups).toEqual(['Today', 'Yesterday', 'Earlier']);
  const sent = within(history())
    .getAllByRole('button', {
      name: /Sam Patel/,
    })[0]
    .closest('li') as HTMLElement;
  expect(sent).toHaveTextContent('Slack · 10:52');
  expect(sent.textContent).not.toMatch(/Sent|Failed/);
  expect(within(history()).getByText('Failed')).toBeInTheDocument();
  expect(within(history()).getByText('Delivery unknown')).toBeInTheDocument();
  expect(within(history()).getByText('Discarded')).toBeInTheDocument();
  expect(within(history()).getByText('Expired')).toBeInTheDocument();
  expect(
    within(history()).getByText(
      'Gmail is signed out — sign in again, then try again',
    ),
  ).toBeInTheDocument();
});

test('a sending row says so', async () => {
  rows = [row({ draftId: 's', status: 'sending', sentAt: null })];
  await mount();
  expect(within(history()).getByText('Sending…')).toBeInTheDocument();
});

test('Try again reopens the same row; Draft again makes a fresh draft', async () => {
  await mount();
  fireEvent.click(within(history()).getByRole('button', { name: 'Try again' }));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('outbox:open-confirm', {
    draftId: 'retry',
  });
  const [oneClick] = within(history()).getAllByRole('button', {
    name: 'Draft again',
  });
  fireEvent.click(oneClick);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('outbox:redraft', {
    draftId: 'discarded',
  });
});

test('a maybe-delivered row drafts again only after a confirmation', async () => {
  await mount();
  const buttons = within(history()).getAllByRole('button', {
    name: 'Draft again',
  });
  // Row order: discarded (one click), unsure (guarded), expired (one click).
  fireEvent.click(buttons[1]);
  expect(invoke).not.toHaveBeenCalledWith('outbox:redraft', {
    draftId: 'unsure',
  });
  const sheet = screen.getByRole('dialog');
  expect(sheet).toHaveTextContent(/may already have been delivered/);
  fireEvent.click(within(sheet).getByRole('button', { name: 'Draft again' }));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('outbox:redraft', {
    draftId: 'unsure',
  });
});

test('a failed read says so, never "nothing sent"', async () => {
  invoke.mockImplementation((channel: string) =>
    channel === 'outbox:list'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve([]),
  );
  await mount();
  expect(screen.getByText('Couldn’t load the outbox.')).toBeInTheDocument();
  expect(screen.queryByText(/Nothing sent yet/)).toBeNull();
});

test('a push re-reads the outbox', async () => {
  await mount();
  rows = [];
  await act(async () => push?.());
  expect(screen.getByText(/Nothing sent yet/)).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Waiting for you' })).toBeNull();
});
