/**
 * The event review page and its result pages (calendar spec §5.6), served
 * under /outbox/event/ by outbound/routes.ts on both transports. Rendered
 * from the stored row: what the user approves here is exactly what core
 * creates. The "Who" line is the load-bearing element — invites go out on
 * Add.
 */
import { esc } from '@shared/web-ui';

import { outboxPage, type OutboxIcon } from '../outbound/pages';
import type { CalendarOutService } from './service';
import type { EventDraftView } from './types';

export interface PageResult {
  status: number;
  html: string;
}

const CATEGORY_LABEL = { work: 'Work', personal: 'Personal', kids: 'Kids' };

const EVENT_CSS = `<style>
.ev-what { font-size: 17px; font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; }
.ev-chip { display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 6px; margin-left: 6px;
  vertical-align: middle; border: 1px solid var(--border-subtle); color: var(--text-secondary); }
.ev-row { display: flex; flex-direction: column; gap: 2px; }
.ev-k { font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.08em; }
.ev-v { font-size: 14px; color: var(--text-primary); overflow-wrap: anywhere; white-space: pre-wrap; }
.ev-invite { font-weight: 600; }
</style>`;

/** "Tue 3 Nov, 18:00–19:30 (Europe/Berlin)" / "Tue 3 Nov" / "26 Oct – 30 Oct". */
export function whenText(p: EventDraftView['payload']): string {
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

const row = (k: string, v: string, cls = '') =>
  `<div class="ev-row"><span class="ev-k">${esc(k)}</span><span class="ev-v ${cls}">${v}</span></div>`;

export function eventReviewPage(
  view: EventDraftView,
  token: string,
  changed = false,
): string {
  const p = view.payload;
  const who = p.attendees.length
    ? `Invites will be sent to: ${esc(p.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', '))}`
    : 'No one will be invited';
  const where = [
    p.location ? esc(p.location) : '',
    p.conference === 'auto' ? 'a video link will be added' : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const similar = view.similarEvents
    .map((s) =>
      s.kind === 'event'
        ? `Similar event already in your calendar: ${s.title}`
        : `Similar draft waiting: ${s.title}`,
    )
    .map(esc)
    .join('<br>');
  const inner = `${EVENT_CSS}
  ${changed ? `<p class="ob-note">This event changed — review it again. Nothing was added.</p>` : ''}
  <div class="ev-what">${esc(p.title)}<span class="ev-chip">${CATEGORY_LABEL[p.category]}</span></div>
  ${row('When', esc(whenText(p)))}
  ${row('Calendar', esc([view.calendarName ?? p.calendarId, view.accountEmail].filter(Boolean).join(' · ')))}
  ${row('Who', who, p.attendees.length ? 'ev-invite' : '')}
  ${where ? row('Where', where) : ''}
  ${p.description ? row('Note', esc(p.description)) : ''}
  ${view.source ? row('From', esc([view.source.title, view.source.createdAt?.slice(0, 10)].filter(Boolean).join(' · '))) : ''}
  ${similar ? `<p class="ob-note">${similar}</p>` : ''}
  <div class="ob-actions">
    <div class="ob-split"><form id="ob-send" method="POST" action="/outbox/event/confirm/${esc(token)}/${view.revision}">
      <button id="ob-send-btn" type="submit" class="btn primary ob-btn ob-disable"
        data-label="${p.attendees.length ? 'Add and send invites' : 'Add to calendar'}" data-working="Adding…"
        data-slow="The calendar is slow — still adding…">${p.attendees.length ? 'Add and send invites' : 'Add to calendar'}</button>
    </form></div>
    <div id="ob-status" class="ob-status" role="status" aria-live="polite"></div>
    <form method="POST" action="/outbox/event/cancel/${esc(token)}"><button type="submit" class="btn ob-btn-secondary ob-disable">Discard</button></form>
  </div>`;
  return outboxPage('Review event', inner, true);
}

export function eventResultPage(
  title: string,
  message: string,
  opts?: { icon?: OutboxIcon; note?: string; link?: string },
): string {
  return outboxPage(
    title,
    `<p class="ob-msg">${esc(message)}</p>
    ${opts?.note ? `<p class="ob-note">${esc(opts.note)}</p>` : ''}
    ${opts?.link ? `<p class="ob-note"><a href="${esc(opts.link)}" rel="noreferrer noopener" target="_blank">Open in calendar</a></p>` : ''}`,
  );
}

const GONE = (): PageResult => ({
  status: 410,
  html: eventResultPage(
    'Already handled',
    'This event was already added, discarded or expired. Open the Outbox in KIAgent to see where it stands.',
  ),
});
const CHANGED = (): PageResult => ({
  status: 409,
  html: eventResultPage(
    'Event changed',
    'This event was changed after this link was made. Nothing was added — open the newest link or the Outbox in KIAgent.',
  ),
});

export async function getEventConfirm(
  calendar: CalendarOutService,
  token: string,
): Promise<PageResult> {
  const peek = await calendar.peekByToken(token);
  if (peek.kind === 'ok')
    return { status: 200, html: eventReviewPage(peek.view, token) };
  if (peek.kind === 'changed') return CHANGED();
  if (peek.kind === 'expired')
    return {
      status: 410,
      html: eventResultPage(
        'Link expired',
        'This link expired. The event is still in the Outbox in KIAgent if it was not discarded.',
      ),
    };
  if (peek.kind === 'invalid')
    return {
      status: 404,
      html: eventResultPage('Invalid link', 'This link is not valid.'),
    };
  return GONE();
}

export async function postEventConfirm(
  calendar: CalendarOutService,
  token: string,
  revision: number | null,
): Promise<PageResult> {
  if (revision === null) return getEventConfirm(calendar, token);
  const out = await calendar.confirmByToken(token, revision);
  switch (out.kind) {
    case 'created':
      return {
        status: 200,
        html: eventResultPage('Added', 'Added to your calendar.', {
          note:
            [
              out.event.conferencePending
                ? 'The video link is still being made — it will appear in the event.'
                : '',
              out.event.note ?? '',
            ]
              .filter(Boolean)
              .join(' ') || undefined,
          link: out.event.htmlLink ?? undefined,
        }),
      };
    case 'failed':
      return {
        status: 200,
        html: eventResultPage('Not added', `Not added: ${out.error}`),
      };
    case 'unknown':
      return {
        status: 200,
        html: eventResultPage('Status unknown', `The event ${out.error}`),
      };
    case 'changed': {
      const peek = await calendar.peekByToken(token);
      return peek.kind === 'ok'
        ? { status: 409, html: eventReviewPage(peek.view, token, true) }
        : CHANGED();
    }
    default:
      return GONE();
  }
}

export async function postEventCancel(
  calendar: CalendarOutService,
  token: string,
): Promise<PageResult> {
  const out = await calendar.cancelByToken(token);
  if (out.kind === 'discarded')
    return {
      status: 200,
      html: eventResultPage(
        'Discarded',
        'Discarded — nothing was added. You can restore it from the Outbox in KIAgent.',
      ),
    };
  if (out.kind === 'changed') return CHANGED();
  return GONE();
}
