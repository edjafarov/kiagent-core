import React, { useLayoutEffect, useRef, useState } from 'react';
import type { CalendarDraftView } from '@shared/ipc';
import { Button, KeyValue, Sheet, type KeyValueItem } from '@shared/web-ui/ui';
import { errorText } from './use-calendar-drafts';
import { useSheetDayView } from './use-sheet-day-view';

export const CATEGORY_LABEL = {
  work: 'Work',
  personal: 'Personal',
  kids: 'Kids',
} as const;

export function calendarLabel(d: CalendarDraftView): string {
  return [d.calendarName ?? d.payload.calendarId, d.accountEmail]
    .filter(Boolean)
    .join(' · ');
}

/**
 * One event draft in full — the review page's fields and its day view
 * (main renders both, so the sheet and the link page can't drift). Add runs
 * the same gate and create as the page (`calendar-out:confirm`, at the
 * revision shown), so an event that changed meanwhile is not added. Discard
 * keeps the sheet open on a Restore, because a discarded draft leaves the
 * list; `live` is false once the draft left the list some other way.
 */
export function EventReviewSheet(props: {
  draft: CalendarDraftView;
  onClose: () => void;
  live?: boolean;
}): React.ReactElement {
  const { draft: d, onClose, live = true } = props;
  const p = d.payload;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discarded, setDiscarded] = useState(false);
  const invites = p.attendees.length > 0;
  const retryable = d.status === 'failed' || d.status === 'unknown';
  // Add is held by Checking…; Try again (failed / unknown) shows the day
  // view too but is not held.
  const actionable = live && !discarded && d.status === 'draft';
  const { day, checking } = useSheetDayView(
    d,
    live && !discarded && (actionable || retryable),
  );
  const dayRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const grid = dayRef.current?.querySelector<HTMLElement>('.dv-scroll');
    if (grid) grid.scrollTop = Number(grid.dataset.scroll) || 0;
  }, [day?.html]);

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
  const head: KeyValueItem[] = [
    { label: 'When', value: d.when },
    { label: 'Calendar', value: calendarLabel(d) },
    {
      label: 'Who',
      value: invites
        ? `Invites will be sent to: ${p.attendees
            .map((a) => (a.name ? `${a.name} <${a.email}>` : a.email))
            .join(', ')}`
        : 'No one will be invited',
    },
  ];
  const tail: KeyValueItem[] = [
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
          disabled={busy || (actionable && checking)}
          onClick={() => void (retryable ? retry() : add())}
        >
          {busy
            ? 'Working…'
            : retryable
              ? 'Try again'
              : actionable && checking
                ? 'Checking…'
                : `Add${day?.busyClash ? ' anyway' : ''}${invites ? ' and send invites' : ''}`}
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
      <KeyValue items={day ? head : [...head, ...tail]} />
      {day && (
        <div
          ref={dayRef}
          className="ob-day"
          // Built in main by day-view-html.ts: every text escaped, colours
          // hex-only, styles numeric — the review page's own markup.
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: day.lineHtml + day.html }}
        />
      )}
      {day && tail.length > 0 && <KeyValue items={tail} />}
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
