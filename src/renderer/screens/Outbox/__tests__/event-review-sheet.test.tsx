import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { CalendarDayView, CalendarDraftView } from '@shared/ipc';
import { EventReviewSheet } from '../EventReviewSheet';

function ev(over: Partial<CalendarDraftView> = {}): CalendarDraftView {
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
    when: 'Thu 5 Nov, 16:00–16:30 (Europe/Berlin)',
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
      attendees: [],
      conference: 'none',
      category: 'kids',
    },
    ...over,
  } as CalendarDraftView;
}

const answer = (
  revision: number,
  over: Partial<CalendarDayView> = {},
): CalendarDayView => ({
  revision,
  html: '<div class="dv-scroll" data-scroll="120">grid</div>',
  lineHtml: '<div class="ev-line">Free — nothing else at this time</div>',
  busyClash: false,
  ...over,
});

/** One deferred day-view answer per request, resolved by the test. */
let calls: {
  req: { id: string; revision: number };
  resolve: (v: CalendarDayView | null) => void;
  reject: (e: Error) => void;
}[];
let discard: () => Promise<void>;
let invoke: jest.Mock;

beforeEach(() => {
  calls = [];
  discard = () => Promise.resolve();
  invoke = jest.fn((channel: string, req: never) => {
    if (channel === 'calendar-out:day-view')
      return new Promise((resolve, reject) =>
        calls.push({ req, resolve, reject }),
      );
    if (channel === 'calendar-out:discard') return discard();
    return Promise.resolve(undefined);
  });
  (window as any).kiagent = { invoke, on: () => () => {} };
});
afterEach(() => {
  delete (window as any).kiagent;
});

const primary = () =>
  screen.getAllByRole('button').find((b) => b.className.includes('primary'))!;
const settle = (i: number, v: CalendarDayView | null) =>
  act(async () => calls[i].resolve(v));

test('Checking… until the answer, then the line, the grid and the scroll', async () => {
  render(<EventReviewSheet draft={ev()} onClose={() => {}} />);
  expect(primary()).toHaveTextContent('Checking…');
  expect(primary()).toBeDisabled();
  expect(calls[0].req).toEqual({ id: 'e1', revision: 1 });
  await settle(0, answer(1));
  expect(screen.getByText('Free — nothing else at this time')).toBeVisible();
  expect(document.querySelector<HTMLElement>('.dv-scroll')!.scrollTop).toBe(
    120,
  );
  expect(primary()).toHaveTextContent('Add');
  expect(primary()).toBeEnabled();
});

test('When is the line main built', () => {
  render(<EventReviewSheet draft={ev()} onClose={() => {}} />);
  expect(
    screen.getByText('Thu 5 Nov, 16:00–16:30 (Europe/Berlin)'),
  ).toBeVisible();
});

test('a busy clash reads Add anyway, with invites Add anyway and send invites', async () => {
  const { unmount } = render(
    <EventReviewSheet draft={ev()} onClose={() => {}} />,
  );
  await settle(0, answer(1, { busyClash: true }));
  expect(primary()).toHaveTextContent('Add anyway');
  unmount();
  render(
    <EventReviewSheet
      draft={ev({
        payload: {
          ...ev().payload,
          attendees: [{ email: 'teacher@school.de' }],
        },
      })}
      onClose={() => {}}
    />,
  );
  await settle(1, answer(1, { busyClash: true }));
  expect(primary()).toHaveTextContent('Add anyway and send invites');
});

test('no day view, or a failed request, leaves the normal label and no grid', async () => {
  const { unmount } = render(
    <EventReviewSheet draft={ev()} onClose={() => {}} />,
  );
  await settle(0, null);
  expect(primary()).toHaveTextContent('Add');
  expect(document.querySelector('.ob-day')).toBeNull();
  unmount();
  render(<EventReviewSheet draft={ev()} onClose={() => {}} />);
  await act(async () => calls[1].reject(new Error('boom')));
  expect(primary()).toHaveTextContent('Add');
  expect(primary()).toBeEnabled();
});

test('a mismatched answer installs no grid and does not hold Add', async () => {
  render(<EventReviewSheet draft={ev()} onClose={() => {}} />);
  await settle(0, answer(2, { busyClash: true }));
  expect(document.querySelector('.ob-day')).toBeNull();
  expect(primary()).toHaveTextContent('Add');
});

test('a revision change hides the old grid and holds Add in the same render', async () => {
  const { rerender } = render(
    <EventReviewSheet draft={ev()} onClose={() => {}} />,
  );
  await settle(0, answer(1, { busyClash: true }));
  expect(document.querySelector('.ob-day')).not.toBeNull();
  rerender(<EventReviewSheet draft={ev({ revision: 2 })} onClose={() => {}} />);
  expect(document.querySelector('.ob-day')).toBeNull();
  expect(primary()).toHaveTextContent('Checking…');
  expect(primary()).toBeDisabled();
});

test('revision changes in flight: one request at a time, one follow-up, Checking… again', async () => {
  const { rerender } = render(
    <EventReviewSheet draft={ev()} onClose={() => {}} />,
  );
  rerender(<EventReviewSheet draft={ev({ revision: 2 })} onClose={() => {}} />);
  rerender(<EventReviewSheet draft={ev({ revision: 3 })} onClose={() => {}} />);
  expect(calls).toHaveLength(1);
  // The obsolete answer neither installs nor ends Checking…
  await settle(0, answer(1, { busyClash: true }));
  expect(primary()).toHaveTextContent('Checking…');
  expect(calls).toHaveLength(2);
  expect(calls[1].req).toEqual({ id: 'e1', revision: 3 });
  await settle(1, answer(3));
  expect(primary()).toHaveTextContent('Add');
  expect(calls).toHaveLength(2);
});

test('unmount mid-flight drops the answer and the queued follow-up', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const { rerender, unmount } = render(
    <EventReviewSheet draft={ev()} onClose={() => {}} />,
  );
  rerender(<EventReviewSheet draft={ev({ revision: 2 })} onClose={() => {}} />);
  unmount();
  await settle(0, answer(1));
  expect(error).not.toHaveBeenCalled();
  expect(calls).toHaveLength(1);
  error.mockRestore();
});

test('Discard during the fetch: the Restore footer wins and the grid stays hidden', async () => {
  render(<EventReviewSheet draft={ev()} onClose={() => {}} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  });
  await settle(0, answer(1));
  expect(screen.getByRole('button', { name: 'Restore' })).toBeVisible();
  expect(document.querySelector('.ob-day')).toBeNull();
});

test('a Discard that fails during the first fetch still ends Checking…', async () => {
  discard = () => Promise.reject(new Error('nope'));
  render(<EventReviewSheet draft={ev()} onClose={() => {}} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  });
  await settle(0, answer(1));
  expect(primary()).toHaveTextContent('Add');
  expect(screen.getByText('nope')).toBeVisible();
});

test('a failed draft shows the grid too, and Try again is not held by Checking…', async () => {
  render(
    <EventReviewSheet
      draft={ev({ status: 'failed', error: 'reconnect me' })}
      onClose={() => {}}
    />,
  );
  expect(primary()).toHaveTextContent('Try again');
  expect(primary()).toBeEnabled();
  await settle(0, answer(1));
  expect(document.querySelector('.ob-day')).not.toBeNull();
});

test('without a grid the fields stay one list', async () => {
  render(
    <EventReviewSheet
      draft={ev({ payload: { ...ev().payload, description: 'Bring towel' } })}
      onClose={() => {}}
    />,
  );
  await settle(0, null);
  expect(document.querySelectorAll('dl.ui-kv')).toHaveLength(1);
});

test('a sheet whose draft left the list shows no grid and drops the answer', async () => {
  const { rerender } = render(
    <EventReviewSheet draft={ev()} onClose={() => {}} />,
  );
  rerender(<EventReviewSheet draft={ev()} live={false} onClose={() => {}} />);
  await settle(0, answer(1));
  expect(document.querySelector('.ob-day')).toBeNull();
  expect(primary()).toHaveTextContent('Add');
});
