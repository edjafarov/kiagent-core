import React, { useState } from 'react';
import type { CalendarDraftView } from '@shared/ipc';
import { Button, KeyValue, Sheet, type KeyValueItem } from '@shared/web-ui/ui';
import { errorText } from './use-calendar-drafts';

export const CATEGORY_LABEL = {
  work: 'Work',
  personal: 'Personal',
  kids: 'Kids',
} as const;

type Payload = CalendarDraftView['payload'];

/** "Tue 3 Nov, 18:00–19:30 (Europe/Berlin)" / "Tue 3 Nov (all day)" — the
 *  review page's wording, in the event's own zone. */
export function eventWhen(p: Payload): string {
  if (p.allDay) {
    const d = (s: string) =>
      new Date(`${s}T12:00:00Z`).toLocaleDateString('en-GB', {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });
    const [y, m, dd] = p.end.split('-').map(Number);
    const last = new Date(Date.UTC(y, m - 1, dd - 1))
      .toISOString()
      .slice(0, 10);
    return last === p.start
      ? `${d(p.start)} (all day)`
      : `${d(p.start)} – ${d(last)} (all day)`;
  }
  const opts = { timeZone: p.timeZone } as const;
  const day = new Date(p.start).toLocaleDateString('en-GB', {
    ...opts,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const t = (s: string) =>
    new Date(s).toLocaleTimeString('en-GB', {
      ...opts,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  return `${day}, ${t(p.start)}–${t(p.end)} (${p.timeZone})`;
}

export function calendarLabel(d: CalendarDraftView): string {
  return [d.calendarName ?? d.payload.calendarId, d.accountEmail]
    .filter(Boolean)
    .join(' · ');
}

/**
 * One event draft in full — the review page's fields. Add runs the same gate
 * and create as the page (`calendar-out:confirm`, at the revision shown), so
 * an event that changed meanwhile is not added. Discard keeps the sheet open
 * on a Restore, because a discarded draft leaves the list.
 */
export function EventReviewSheet(props: {
  draft: CalendarDraftView;
  onClose: () => void;
}): React.ReactElement {
  const { draft: d, onClose } = props;
  const p = d.payload;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const invites = p.attendees.length > 0;
  const retryable = d.status === 'failed' || d.status === 'unknown';

  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const settle = (out: Awaited<ReturnType<typeof confirmCall>>) => {
    if (out.kind === 'created') onClose();
    else if (out.kind === 'failed' || out.kind === 'unknown')
      setError(out.error);
    else if (out.kind === 'changed')
      setError('This event changed — review it again. Nothing was added.');
    else setError('This event was already added, discarded or expired.');
  };
  const confirmCall = () =>
    window.kiagent.invoke('calendar-out:confirm', {
      id: d.id,
      revision: d.revision,
    });
  const add = () => act(async () => settle(await confirmCall()));
  const retry = () =>
    act(async () =>
      settle(await window.kiagent.invoke('calendar-out:retry', { id: d.id })),
    );
  const discard = () =>
    act(async () => {
      await window.kiagent.invoke('calendar-out:discard', { id: d.id });
      setDiscarded(true);
    });
  const restore = () =>
    act(async () => {
      await window.kiagent.invoke('calendar-out:restore', { id: d.id });
      onClose();
    });

  const where = [
    p.location,
    p.conference === 'auto' ? 'a video link will be added' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const items: KeyValueItem[] = [
    { label: 'When', value: eventWhen(p) },
    { label: 'Calendar', value: calendarLabel(d) },
    {
      label: 'Who',
      value: invites
        ? `Invites will be sent to: ${p.attendees
            .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
            .join(', ')}`
        : 'No one will be invited',
    },
    ...(where ? [{ label: 'Where', value: where }] : []),
    ...(p.description ? [{ label: 'Note', value: p.description }] : []),
    ...(d.source
      ? [
          {
            label: 'From',
            value: [d.source.title, d.source.createdAt?.slice(0, 10)]
              .filter(Boolean)
              .join(' · '),
          },
        ]
      : []),
  ];

  let footer: React.ReactNode;
  if (discarded)
    footer = (
      <>
        <Button disabled={busy} onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void restore()}
        >
          Restore
        </Button>
      </>
    );
  else
    footer = (
      <>
        <Button variant="ghost" disabled={busy} onClick={() => void discard()}>
          Discard
        </Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => void (retryable ? retry() : add())}
        >
          {busy
            ? 'Working…'
            : retryable
              ? 'Try again'
              : invites
                ? 'Add and send invites'
                : 'Add'}
        </Button>
      </>
    );

  return (
    <Sheet
      title="Review event"
      onClose={onClose}
      busy={busy}
      width={640}
      footer={footer}
    >
      <p className="ob-meta">
        {CATEGORY_LABEL[p.category]} · {p.title}
      </p>
      <KeyValue items={items} />
      {discarded && (
        <p className="ob-note">
          Discarded — nothing was added. You can restore it.
        </p>
      )}
      {!discarded && retryable && d.error && (
        <p className="ob-note is-err">{d.error}</p>
      )}
      {d.similarEvents.map((s) => (
        <p key={`${s.kind}:${s.title}:${s.start}`} className="ob-note">
          {s.kind === 'event'
            ? `Similar event already in your calendar: ${s.title}`
            : `Similar draft waiting: ${s.title}`}
        </p>
      ))}
      {error && <p className="ob-note is-err">{error}</p>}
    </Sheet>
  );
}
