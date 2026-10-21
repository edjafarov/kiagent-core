import React, { useState } from 'react';
import type { CalendarDraftView } from '@shared/ipc';
import {
  AttentionList,
  AttentionRow,
  Button,
  ConfirmSheet,
} from '@shared/web-ui/ui';
import {
  CATEGORY_LABEL,
  EventReviewSheet,
  calendarLabel,
} from './EventReviewSheet';
import type { CalendarDraftsData } from './use-calendar-drafts';

/** The row's time in the viewer's own zone. */
export function localWhen(p: CalendarDraftView['payload']): string {
  if (p.allDay)
    return new Date(`${p.start}T12:00:00`).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  return new Date(p.start).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Events Kia drafted for the calendar, above the waiting mail drafts. Hidden
 * when there are none. Add all is offered only when no listed draft invites
 * anyone, behind one confirmation; the server re-checks it.
 */
export function CalendarDrafts(props: {
  data: CalendarDraftsData;
}): React.ReactElement | null {
  const { drafts, reload } = props.data;
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Keeps a draft's last view for its sheet after it leaves the list
  // (discarded, so Restore stays reachable).
  const [snapshot, setSnapshot] = useState<CalendarDraftView | null>(null);

  const list = drafts ?? [];
  const open = list.find((d) => d.id === openId) ?? snapshot;
  if (list.length === 0 && !open) return null;

  const waiting = list.filter((d) => d.status === 'draft');
  const anyInvites = list.some((d) => d.payload.attendees.length > 0);
  const calendars = [...new Set(waiting.map((d) => d.calendarName ?? ''))];
  const target =
    calendars.length === 1 && calendars[0]
      ? calendars[0]
      : `${calendars.length} calendars`;

  const addAll = async () => {
    const out = await window.kiagent.invoke('calendar-out:confirm-all', {
      items: waiting.map((d) => ({ id: d.id, revision: d.revision })),
    });
    setNote(
      [
        out.created ? `Added ${out.created}` : '',
        out.changed ? `${out.changed} changed — review again` : '',
        out.failed ? `${out.failed} not added` : '',
      ]
        .filter(Boolean)
        .join(' · '),
    );
    reload();
  };

  return (
    <section aria-label="Calendar">
      <div className="ob-group-head">
        <h2 className="ob-group-title">Calendar</h2>
        {waiting.length >= 2 && !anyInvites && (
          <Button size="sm" onClick={() => setConfirmAll(true)}>
            Add all
          </Button>
        )}
      </div>
      {note && <p className="ob-note">{note}</p>}
      <AttentionList aria-label="Events waiting for you">
        {list.map((d) => {
          const bad = d.status === 'failed' || d.status === 'unknown';
          return (
            <AttentionRow
              key={d.id}
              tone={bad ? 'err' : 'acc'}
              kind={CATEGORY_LABEL[d.payload.category]}
              title={d.payload.title}
              sub={
                bad && d.error
                  ? d.error
                  : `${localWhen(d.payload)} · ${calendarLabel(d)}`
              }
              action={
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setSnapshot(d);
                    setOpenId(d.id);
                  }}
                >
                  Review
                </Button>
              }
            />
          );
        })}
      </AttentionList>
      {open && (
        <EventReviewSheet
          key={open.id}
          draft={open}
          onClose={() => {
            setOpenId(null);
            setSnapshot(null);
          }}
        />
      )}
      {confirmAll && (
        <ConfirmSheet
          title="Add all"
          confirmLabel="Add"
          busyLabel="Adding…"
          onConfirm={addAll}
          onClose={() => setConfirmAll(false)}
        >
          Add {waiting.length} events to {target}?
        </ConfirmSheet>
      )}
    </section>
  );
}
