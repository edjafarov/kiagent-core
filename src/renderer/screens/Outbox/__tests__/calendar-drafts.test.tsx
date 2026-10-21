import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { CalendarDraftView } from '@shared/ipc';
import { CalendarDrafts } from '../CalendarDrafts';
import { useCalendarDrafts } from '../use-calendar-drafts';

function ev(
  over: Partial<CalendarDraftView> & {
    attendees?: { email: string; name?: string }[];
  },
): CalendarDraftView {
  const { attendees = [], ...rest } = over;
  return {
    id: 'e1',
    accountId: 'a1',
    revision: 1,
    status: 'draft',
    error: null,
    createdAt: '2026-11-02T08:00:00.000Z',
    expiresAt: '2026-11-09T08:00:00.000Z',
    calendarName: 'Family',
    accountEmail: 'me@example.com',
    source: null,
    similarEvents: [],
    payload: {
      calendarId: 'family@group',
      title: 'Swimming',
      start: '2026-11-05T15:00:00.000Z',
      end: '2026-11-05T15:30:00.000Z',
      allDay: false,
      timeZone: 'Europe/Berlin',
      location: null,
      description: null,
      attendees,
      conference: 'none',
      category: 'kids',
    },
    ...rest,
  } as CalendarDraftView;
}

let drafts: CalendarDraftView[];
let listeners: Set<() => void>;
let invoke: jest.Mock;

function Harness() {
  const data = useCalendarDrafts();
  return <CalendarDrafts data={data} />;
}
const mount = async () => {
  render(<Harness />);
  await act(async () => {});
};

beforeEach(() => {
  listeners = new Set();
  invoke = jest.fn((channel: string) => {
    if (channel === 'calendar-out:list') return Promise.resolve(drafts);
    if (channel === 'calendar-out:confirm-all')
      return Promise.resolve({ created: 2, failed: 0, changed: 0 });
    if (channel === 'calendar-out:confirm')
      return Promise.resolve({ kind: 'created', event: {} });
    return Promise.resolve(undefined);
  });
  (window as any).kiagent = {
    invoke,
    on: jest.fn((channel: string, fn: () => void) => {
      if (channel !== 'push:calendar-out-changed') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
  };
});
afterEach(() => {
  delete (window as any).kiagent;
});

const two = () => [
  ev({ id: 'e1', revision: 3 }),
  ev({ id: 'e2', revision: 5, payload: { ...ev({}).payload, title: 'Piano' } }),
];

test('the group is hidden when there are no event drafts', async () => {
  drafts = [];
  await mount();
  expect(screen.queryByText('Calendar')).toBeNull();
});

test('rows read category · title · when · calendar', async () => {
  drafts = [ev({})];
  await mount();
  const row = within(
    screen.getByRole('list', { name: 'Events waiting for you' }),
  ).getByRole('listitem');
  expect(row).toHaveTextContent('Kids');
  expect(row).toHaveTextContent('Swimming');
  expect(row).toHaveTextContent('Family · me@example.com');
});

test('Add all asks once and sends the revisions shown', async () => {
  drafts = two();
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add all' }));
  expect(screen.getByRole('dialog')).toHaveTextContent(
    'Add 2 events to Family?',
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  });
  expect(invoke).toHaveBeenCalledWith('calendar-out:confirm-all', {
    items: [
      { id: 'e1', revision: 3 },
      { id: 'e2', revision: 5 },
    ],
  });
});

test('Add all hidden when a draft invites someone', async () => {
  drafts = [
    ...two(),
    ev({ id: 'e3', attendees: [{ email: 'teacher@school.de' }] }),
  ];
  await mount();
  expect(screen.queryByRole('button', { name: 'Add all' })).toBeNull();
});

test('invite rows show "Invites will be sent to" and offer Add and send invites', async () => {
  drafts = [
    ev({ attendees: [{ email: 'teacher@school.de', name: 'Frau Roth' }] }),
  ];
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  const sheet = screen.getByRole('dialog');
  expect(sheet).toHaveTextContent(
    'Invites will be sent to: Frau Roth <teacher@school.de>',
  );
  expect(
    within(sheet).getByRole('button', { name: 'Add and send invites' }),
  ).toBeInTheDocument();
});

test('a draft with nobody invited says so; Add confirms at the shown revision', async () => {
  drafts = [ev({ revision: 4 })];
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  const sheet = screen.getByRole('dialog');
  expect(sheet).toHaveTextContent('No one will be invited');
  await act(async () => {
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add' }));
  });
  expect(invoke).toHaveBeenCalledWith('calendar-out:confirm', {
    id: 'e1',
    revision: 4,
  });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a failed draft shows its error and Try again', async () => {
  drafts = [
    ev({ status: 'failed', error: 'Reconnect me@example.com in Settings' }),
  ];
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  const sheet = screen.getByRole('dialog');
  expect(sheet).toHaveTextContent('Reconnect me@example.com in Settings');
  await act(async () => {
    fireEvent.click(within(sheet).getByRole('button', { name: 'Try again' }));
  });
  expect(invoke).toHaveBeenCalledWith('calendar-out:retry', { id: 'e1' });
});

test('Discard leaves a Restore in the sheet', async () => {
  drafts = [ev({})];
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  drafts = [];
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  });
  await act(async () => listeners.forEach((fn) => fn()));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  });
  expect(invoke).toHaveBeenCalledWith('calendar-out:restore', { id: 'e1' });
});
