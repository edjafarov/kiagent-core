/**
 * The event review page and its result pages (calendar spec §5.6), served
 * under /outbox/event/ by outbound/routes.ts on both transports. Rendered
 * from the stored row: what the user approves here is exactly what core
 * creates. The "Who" line is the load-bearing element — invites go out on
 * Add.
 */
import { esc } from '@shared/web-ui';

import { outboxPage, type OutboxIcon } from '../outbound/pages';
import { dayViewHtml } from './day-view-html';
import { fmtTime, localDate, rangeNeedsOffsets } from './local-time';
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
/* Phones: the shared minimal shell's 24px padding + 25px stripe inset leave
   the day grid's lanes too narrow; event pages with a grid get 16px gutters. */
@media (max-width: 480px) {
  .sh-min:has(#ev-day) { padding-left: 16px; padding-right: 16px; }
  .sh-min:has(#ev-day) .sh-min__card { padding-left: 13px; }
}
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
  const tz = p.timeZone;
  const a = new Date(p.start).getTime();
  const b = new Date(p.end).getTime();
  const day = (ms: number) =>
    new Date(ms).toLocaleDateString('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  const off = rangeNeedsOffsets(a, b, tz);
  if (localDate(a, tz) !== localDate(b, tz))
    return `${day(a)}, ${fmtTime(a, tz, off)} – ${day(b)}, ${fmtTime(b, tz, off)} (${tz})`;
  return `${day(a)}, ${fmtTime(a, tz, off)}–${fmtTime(b, tz, off)} (${tz})`;
}

const hasInvitees = (view: EventDraftView): boolean =>
  view.payload.attendees.length > 0;

const row = (k: string, v: string, cls = '') =>
  `<div class="ev-row"><span class="ev-k">${esc(k)}</span><span class="ev-v ${cls}">${v}</span></div>`;

export interface DaySection {
  html: string;
  lineHtml: string;
  busyClash: boolean;
}

const loggedDays = new Set<string>();

/**
 * The day view's one failure boundary: any reject, hang past the page
 * deadline, or render error returns null (the page renders as before) and
 * is logged once per draft id per process.
 */
export async function daySection(
  calendar: Pick<CalendarOutService, 'dayView'>,
  view: EventDraftView,
  log: (message: string) => void = (m) => console.warn(m),
): Promise<DaySection | null> {
  const logOnce = (why: string) => {
    if (loggedDays.has(view.id)) return;
    loggedDays.add(view.id);
    log(`event day view skipped for draft ${view.id}: ${why}`);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = calendar.dayView(view);
    let model: Awaited<typeof run>;
    if (view.deadlineMs) {
      run.catch(() => {});
      model = await Promise.race([
        run,
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => resolve(null),
            Math.max(0, view.deadlineMs - Date.now()),
          );
        }),
      ]);
    } else model = await run;
    if (!model) {
      logOnce('listing failed, too many events, or out of time');
      return null;
    }
    const { kind } = model.line;
    const cls =
      kind === 'busy'
        ? ' ev-line-busy'
        : kind === 'maybe'
          ? ' ev-line-maybe'
          : '';
    return {
      html: dayViewHtml(model),
      lineHtml: `<div class="ev-line${cls}">${esc(model.line.text)}</div>`,
      busyClash: model.busyClash,
    };
  } catch (err) {
    logOnce(err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function eventReviewPage(
  view: EventDraftView,
  token: string,
  changed = false,
  day: DaySection | null = null,
): string {
  const addLabel = day?.busyClash
    ? hasInvitees(view)
      ? 'Add anyway and send invites'
      : 'Add anyway'
    : hasInvitees(view)
      ? 'Add and send invites'
      : 'Add to calendar';
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
  // An event's title is shown only when its calendar is known to be one
  // Kia syncs (the same rule find_free_time applies); otherwise a generic
  // note, so the page never leaks a title from an unlisted calendar.
  const disclosable = (s: (typeof view.similarEvents)[number]) =>
    view.listing.ok &&
    view.listing.items.some(
      (c) =>
        c.indexed &&
        c.accountId === s.accountId &&
        c.calendarId === s.calendarId,
    );
  const similar = view.similarEvents
    .map((s) =>
      s.kind === 'draft'
        ? `Similar draft waiting: ${s.title}`
        : disclosable(s)
          ? `Similar event already in your calendar: ${s.title}`
          : 'A similar event may already be in your calendar',
    )
    .map(esc);
  const similarHtml = [...new Set(similar)].join('<br>');
  const inner = `${EVENT_CSS}
  ${changed ? `<p class="ob-note">This event changed — review it again. Nothing was added.</p>` : ''}
  <div class="ev-what">${esc(p.title)}<span class="ev-chip">${CATEGORY_LABEL[p.category]}</span></div>
  ${row('When', esc(whenText(p)))}
  ${row('Calendar', esc([view.calendarName ?? p.calendarId, view.accountEmail].filter(Boolean).join(' · ')))}
  ${row('Who', who, p.attendees.length ? 'ev-invite' : '')}
  ${day ? `${day.lineHtml}${day.html}` : ''}
  ${where ? row('Where', where) : ''}
  ${p.description ? row('Note', esc(p.description)) : ''}
  ${view.source ? row('From', esc([view.source.title, view.source.createdAt?.slice(0, 10)].filter(Boolean).join(' · '))) : ''}
  ${similarHtml ? `<p class="ob-note">${similarHtml}</p>` : ''}
  <div class="ob-actions">
    <div class="ob-split"><form id="ob-send" method="POST" action="/outbox/event/confirm/${esc(token)}/${view.revision}">
      <button id="ob-send-btn" type="submit" class="btn primary ob-btn ob-disable"
        data-label="${addLabel}" data-working="Adding…"
        data-slow="The calendar is slow — still adding…">${addLabel}</button>
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

const logOf =
  (calendar: CalendarOutService) =>
  (message: string): void =>
    calendar.logWarn ? calendar.logWarn(message) : console.warn(message);

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
  if (peek.kind === 'ok') {
    const day = await daySection(calendar, peek.view, logOf(calendar));
    return {
      status: 200,
      html: eventReviewPage(peek.view, token, false, day),
    };
  }
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
      if (peek.kind !== 'ok') return CHANGED();
      const day = await daySection(calendar, peek.view, logOf(calendar));
      return {
        status: 409,
        html: eventReviewPage(peek.view, token, true, day),
      };
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
        'Discarded — nothing was added. Ask Kia again if you change your mind.',
      ),
    };
  if (out.kind === 'changed') return CHANGED();
  return GONE();
}
