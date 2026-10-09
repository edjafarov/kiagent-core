import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { OutboxDraftDetail, OutboxPanelRow } from '@shared/ipc';
import { SourceDescriptorsProvider } from '@renderer/screens/Sources/sources-registry';
import { ViewContext, type ViewContextValue } from '@renderer/state/view';
import { Outbox, outboxMeta } from '../index';

const mockState = {
  extensions: [],
  accounts: [
    {
      account: {
        id: 'a1',
        source: 'slack',
        identifier: 'Northwind',
        status: 'live',
      },
    },
    {
      account: {
        id: 'a2',
        source: 'gmail',
        identifier: 'alex@example.com',
        status: 'needsReauth',
      },
    },
    {
      account: {
        id: 'a3',
        source: 'notion',
        identifier: 'Northwind wiki',
        status: 'live',
      },
    },
  ],
  prefs: { outbound: { defaultMode: 'review' } },
};
jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
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
    createdBy: 'Anthropic/ClaudeAI',
    createdVia: 'mcp-remote',
    ...over,
  };
}

const WAIT = row({
  draftId: 'wait',
  status: 'draft',
  sourceId: 'slack',
  accountLabel: 'Northwind',
  recipientDisplay: '#design-review',
  subject: null,
  to: [],
  bodyPreview: 'Here are the three logo directions',
  sentAt: null,
  createdAt: iso(24, 11, 30),
});

const ROWS: OutboxPanelRow[] = [
  WAIT,
  row({ draftId: 'sent', sentAt: iso(24, 10, 52), sourceId: 'slack' }),
  row({
    draftId: 'retry',
    status: 'failed',
    error: 'Gmail is signed out — sign in again, then try again',
    errorDetail: 'send failed: invalid_grant',
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
let listeners: Set<() => void>;
const push = () => listeners.forEach((fn) => fn());
let invoke: jest.Mock;
let sendResult: { outcome: string; row: OutboxPanelRow | null };

function detail(id: string): OutboxDraftDetail | null {
  const fresh = row({ draftId: 'fresh', status: 'draft', createdVia: 'panel' });
  const r = [...rows, fresh].find((x) => x.draftId === id);
  return r ? { ...r, body: `Full body of ${id}` } : null;
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW, doNotFake: ['queueMicrotask'] });
  rows = ROWS;
  listeners = new Set();
  sendResult = { outcome: 'sent', row: null };
  mockState.prefs.outbound.defaultMode = 'review';
  invoke = jest.fn((channel: string, payload?: any) => {
    switch (channel) {
      case 'outbox:list':
        return Promise.resolve(rows);
      case 'sources:list':
        return Promise.resolve([
          { id: 'slack', name: 'Slack' },
          { id: 'gmail', name: 'Gmail' },
          { id: 'notion', name: 'Notion' },
        ]);
      case 'outbox:redraft':
        return Promise.resolve({ draftId: 'fresh' });
      case 'outbox:get':
        return Promise.resolve(detail(payload.draftId));
      case 'outbox:send':
        return Promise.resolve(sendResult);
      case 'outbox:sender-sources':
        return Promise.resolve(['slack', 'gmail']);
      case 'app:info':
        return Promise.resolve({
          version: '1',
          platform: 'darwin',
          productName: 'Acme',
        });
      default:
        return Promise.resolve(undefined);
    }
  });
  (window as any).kiagent = {
    invoke,
    on: jest.fn((channel: string, fn: () => void) => {
      if (channel !== 'push:outbox-changed') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
  };
});
afterEach(() => {
  jest.useRealTimers();
  delete (window as any).kiagent;
});

const navigate = jest.fn();
const replaceParams = jest.fn();

async function mount(params: Record<string, string> = {}) {
  const nav = {
    view: 'outbox',
    params,
    navigate,
    back: () => {},
    openSettings: () => {},
    replaceParams,
  } as unknown as ViewContextValue;
  render(
    <ViewContext.Provider value={nav}>
      <SourceDescriptorsProvider>
        <Outbox />
      </SourceDescriptorsProvider>
    </ViewContext.Provider>,
  );
  await act(async () => {});
}

const history = () =>
  screen.getByRole('list', { name: 'Sent and past drafts' });
const sheet = () => screen.getByRole('dialog');
const groupsOf = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .filter((li) => li.className.includes('ui-day'))
    .map((li) => li.textContent);

// ── The page ─────────────────────────────────────────────────────────────

test('meta counts the waiting drafts', () => {
  expect(outboxMeta(0)).toBe(
    'Nothing waiting · nothing is sent until you confirm it',
  );
  expect(outboxMeta(1)).toBe(
    '1 draft waiting · nothing is sent until you confirm it',
  );
  expect(outboxMeta(3)).toMatch(/^3 drafts waiting/);
});

test('a waiting draft: chat title, Discard is immediate, Review & send opens it here', async () => {
  await mount();
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
  expect(sheet()).toHaveTextContent('Full body of wait');
  expect(invoke).not.toHaveBeenCalledWith(
    'outbox:open-confirm',
    expect.anything(),
  );
});

test('history: day groups in order, a status word only when it did not go out', async () => {
  await mount();
  expect(groupsOf(history())).toEqual(['Today', 'Yesterday', 'Earlier']);
  const sent = within(history())
    .getAllByRole('button', { name: /Sam Patel/ })[0]
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

test('history orders by the time a row shows, not when it was drafted', async () => {
  rows = [
    row({
      draftId: 'late',
      recipientDisplay: 'Drafted early',
      createdAt: iso(23, 9),
      sentAt: iso(24, 11),
    }),
    row({
      draftId: 'mid',
      recipientDisplay: 'Sent yesterday',
      createdAt: iso(23, 10),
      sentAt: iso(23, 10, 5),
    }),
  ];
  await mount();
  expect(groupsOf(history())).toEqual(['Today', 'Yesterday']);
});

test('a sending row says so', async () => {
  rows = [row({ draftId: 's', status: 'sending', sentAt: null })];
  await mount();
  expect(within(history()).getByText('Sending…')).toBeInTheDocument();
});

test('a maybe-delivered row offers no one-click action in the list', async () => {
  await mount();
  // Discarded and expired offer Draft again; the uncertain one does not.
  expect(
    within(history()).getAllByRole('button', { name: 'Draft again' }),
  ).toHaveLength(2);
});

test('Try again opens the same row; Draft again opens the fresh draft', async () => {
  await mount();
  fireEvent.click(within(history()).getByRole('button', { name: 'Try again' }));
  await act(async () => {});
  expect(sheet()).toHaveTextContent('Full body of retry');
  fireEvent.keyDown(sheet(), { key: 'Escape' });
  await act(async () => {});
  const [oneClick] = within(history()).getAllByRole('button', {
    name: 'Draft again',
  });
  fireEvent.click(oneClick);
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('outbox:redraft', {
    draftId: 'discarded',
  });
  expect(sheet()).toHaveTextContent('Full body of fresh');
});

test('a failed first read says so, never "nothing sent", and shows no count', async () => {
  invoke.mockImplementation((channel: string) =>
    channel === 'outbox:list'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve([]),
  );
  await mount();
  expect(screen.getByText('Couldn’t load the outbox.')).toBeInTheDocument();
  expect(screen.queryByText(/Nothing sent yet/)).toBeNull();
  expect(screen.queryByText(/waiting ·/)).toBeNull();
});

test('a failed refresh keeps the rows and says they may be out of date', async () => {
  await mount();
  invoke.mockImplementation((channel: string) =>
    channel === 'outbox:list'
      ? Promise.reject(new Error('boom'))
      : Promise.resolve([]),
  );
  await act(async () => push());
  expect(screen.getByText(/Couldn’t refresh/)).toBeInTheDocument();
  expect(within(history()).getAllByRole('button').length).toBeGreaterThan(0);
});

test('a push re-reads the outbox', async () => {
  await mount();
  rows = [];
  await act(async () => push());
  expect(screen.getByText(/Nothing sent yet/)).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Waiting for you' })).toBeNull();
});

test('a draft= link opens that review once', async () => {
  await mount({ draft: 'wait' });
  expect(sheet()).toHaveTextContent('Full body of wait');
  expect(replaceParams).toHaveBeenCalledWith({});
});

// ── The side cards ───────────────────────────────────────────────────────

test('confirm mode: the product name, the current choice, a click writes the pref', async () => {
  await mount();
  const choices = screen.getByRole('list', {
    name: 'How drafts are confirmed',
  });
  expect(
    within(choices).getByRole('button', { name: 'Review in Acme' }),
  ).toHaveAttribute('aria-current', 'true');
  expect(screen.queryByText(/30 per hour/)).toBeNull();
  fireEvent.click(
    within(choices).getByRole('button', { name: 'One-click link' }),
  );
  expect(invoke).toHaveBeenCalledWith('prefs:patch', {
    outbound: { defaultMode: 'link' },
  });
});

test('confirm mode: the chat choice carries its warning', async () => {
  mockState.prefs.outbound.defaultMode = 'chat';
  await mount();
  expect(screen.getByText(/30 per hour per account/)).toBeInTheDocument();
});

test('sends from: only accounts that can send, signed-out marked', async () => {
  await mount();
  const list = screen.getByRole('list', { name: 'Accounts that can send' });
  expect(within(list).getByText('Slack')).toBeInTheDocument();
  expect(within(list).getByText('Northwind')).toBeInTheDocument();
  expect(within(list).getByText('Signed out')).toBeInTheDocument();
  expect(within(list).queryByText('Notion')).toBeNull();
});

// ── The review sheet ─────────────────────────────────────────────────────

async function openReview(id: string) {
  await mount({ draft: id });
  return sheet();
}

test('review: a chat draft shows its target, who drafted it, the account and the body', async () => {
  const s = await openReview('wait');
  expect(s).toHaveTextContent('Review message');
  expect(s).toHaveTextContent('#design-review · Slack (Northwind)');
  expect(s).toHaveTextContent('Claude.ai');
  expect(s).toHaveTextContent('Sending account');
  expect(s).not.toHaveTextContent('Cc');
  expect(s).toHaveTextContent('Full body of wait');
  expect(s).toHaveTextContent('Nothing is sent until you press Send.');
});

test('review: an email lists every recipient and its Cc', async () => {
  rows = [
    row({
      draftId: 'mail',
      status: 'draft',
      to: ['sam@example.com', 'jo@example.com'],
      cc: ['pat@example.com'],
      sentAt: null,
    }),
  ];
  const s = await openReview('mail');
  expect(s).toHaveTextContent('sam@example.com, jo@example.com');
  expect(s).toHaveTextContent('pat@example.com');
  expect(s).toHaveTextContent('Subject');
});

test('review: Send sends and closes', async () => {
  const s = await openReview('wait');
  fireEvent.click(within(s).getByRole('button', { name: 'Send' }));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('outbox:send', { draftId: 'wait' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('review: a failed send stays open with the reason; Send stays only if it never went out', async () => {
  sendResult = {
    outcome: 'failed',
    row: row({
      draftId: 'wait',
      status: 'failed',
      error: 'Slack refused it',
      canRetry: false,
      deliveryUncertain: true,
    }),
  };
  const s = await openReview('wait');
  fireEvent.click(within(s).getByRole('button', { name: 'Send' }));
  await act(async () => {});
  expect(sheet()).toHaveTextContent('Slack refused it');
  expect(within(sheet()).queryByRole('button', { name: 'Send' })).toBeNull();
});

test('review: Open in browser uses the signed page', async () => {
  const s = await openReview('wait');
  fireEvent.click(within(s).getByRole('button', { name: 'Open in browser' }));
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('outbox:open-confirm', {
    draftId: 'wait',
  });
});

test('review: a sent message opens read-only', async () => {
  const s = await openReview('sent');
  expect(s).toHaveTextContent('Message');
  expect(s).toHaveTextContent('Sent 45m ago');
  expect(within(s).queryByRole('button', { name: 'Send' })).toBeNull();
  // The footer's Close beside the sheet's own close control.
  expect(within(s).getAllByRole('button', { name: 'Close' })).toHaveLength(2);
});

test('review: a failure shows its technical details', async () => {
  const s = await openReview('retry');
  expect(s).toHaveTextContent('Technical details');
  expect(within(s).getByRole('button', { name: 'Send' })).toBeInTheDocument();
});

test('review: a maybe-delivered message drafts again only after a confirmation', async () => {
  const s = await openReview('unsure');
  fireEvent.click(within(s).getByRole('button', { name: 'Draft again' }));
  expect(invoke).not.toHaveBeenCalledWith('outbox:redraft', expect.anything());
  expect(sheet()).toHaveTextContent(/may already have been delivered/);
  fireEvent.click(
    within(sheet()).getByRole('button', { name: 'Draft again anyway' }),
  );
  await act(async () => {});
  expect(invoke).toHaveBeenCalledWith('outbox:redraft', { draftId: 'unsure' });
  expect(sheet()).toHaveTextContent('Full body of fresh');
  expect(sheet()).toHaveTextContent('You, from the Outbox');
});

test('a send from the browser updates the list and the open review together', async () => {
  const s = await openReview('wait');
  expect(within(s).getByRole('button', { name: 'Send' })).toBeInTheDocument();
  rows = rows.map((r) =>
    r.draftId === 'wait'
      ? { ...r, status: 'sent', sentAt: iso(24, 11, 36) }
      : r,
  );
  await act(async () => push());
  expect(screen.queryByRole('list', { name: 'Waiting for you' })).toBeNull();
  expect(within(sheet()).queryByRole('button', { name: 'Send' })).toBeNull();
  expect(sheet()).toHaveTextContent('Sent');
});

test('the relative-time clock does not tick while the window is hidden', async () => {
  // The file's beforeEach fakes Date too; the catch-up commit depends on it.
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const nav = {
    view: 'outbox',
    params: {},
    navigate,
    back: () => {},
    openSettings: () => {},
    replaceParams,
  } as unknown as ViewContextValue;
  let commits = 0;
  try {
    render(
      <React.Profiler
        id="outbox"
        onRender={() => {
          commits += 1;
        }}
      >
        <ViewContext.Provider value={nav}>
          <SourceDescriptorsProvider>
            <Outbox />
          </SourceDescriptorsProvider>
        </ViewContext.Provider>
      </React.Profiler>,
    );
    await act(async () => {});
    act(() => setVisibility('hidden'));
    commits = 0;
    await act(async () => {
      jest.advanceTimersByTime(5 * 60_000);
    });
    expect(commits).toBe(0);
    act(() => setVisibility('visible'));
    expect(commits).toBe(1);
  } finally {
    delete (document as unknown as { visibilityState?: unknown })
      .visibilityState;
  }
});
