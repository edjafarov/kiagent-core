/**
 * `draft_event` — proposes a calendar event the USER adds (calendar spec
 * §5.5, §6). Nothing is created here: the draft waits for the user's
 * confirmation in KIAgent's Outbox or on its review link.
 */
import type {
  DraftEventResult,
  CalendarToolApi,
} from '@main/calendar-out/service';
import { EVENT_CATEGORIES, type EventCategory } from '@shared/contracts';

export const draftEventDescription = `Draft a calendar event for the user to add. NOTHING IS ADDED by this tool: the user confirms it in KIAgent (Outbox) or on the returned link; follow the returned instruction.
Capturing events from correspondence (mail, chats, messages — default window: the last 7 days): look for commitments the user or a child is expected to attend or do at a specific date/time. Skip marketing, newsletters, things with no personal relevance, and anything that already arrived as a calendar invite. Group mentions of the same occurrence and call draft_event ONCE per occurrence with the most specific source_document_id. Expect existing, already_in_calendar and dismissed results — they are normal; never retry around them.
category (required): kids = about the user's child (school, Kita/eFöB, clubs, kids' birthdays, a child's doctor, parents' evenings); work = the user's job; personal = everything else.
Captured events get NO attendees unless the user explicitly asks to invite someone.
Titles say WHAT first, then who, no prefixes: "Elternabend 7b", "Sara: swimming", "Dentist — Dr. Weber"; keep the source language when natural. Meetings: "Call with <Name> (<Company>)" or the stated topic.
Booking a meeting: once a time is agreed, draft it with the attendee(s), category work or personal, conference "auto" when it is remote and no location was named, and a neutral one-line description — never paste private correspondence into a description when there are attendees. Invites go out only after the user confirms a card that names every attendee.
Times: start/end as ISO date-time with offset, or a local "YYYY-MM-DDTHH:MM" read in time_zone; all-day events take dates (end exclusive, default one day). Timed events default to 30 minutes. Calendar: calendar_id from list_calendars, else the user's default.
To change a draft, call draft_event again with its draft_id and the revision you last saw (and the full event). Report back as a short numbered list: drafted, skipped (already in the calendar / dismissed before), unclear (e.g. a date but no time).`;

export const draftEventInputSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    start: {
      type: 'string',
      description: 'ISO date-time, or YYYY-MM-DD for all-day',
    },
    end: { type: 'string', description: 'Optional; all-day end is exclusive' },
    all_day: { type: 'boolean' },
    time_zone: {
      type: 'string',
      description: 'IANA zone (default: the user’s)',
    },
    account_id: { type: 'string' },
    calendar_id: { type: 'string', description: 'From list_calendars' },
    category: { type: 'string', enum: [...EVENT_CATEGORIES] },
    location: { type: 'string' },
    description: { type: 'string' },
    attendees: {
      type: 'array',
      items: {
        type: 'object',
        properties: { email: { type: 'string' }, name: { type: 'string' } },
        required: ['email'],
      },
      description: 'People to invite — default none',
    },
    conference: { type: 'string', enum: ['none', 'auto'] },
    source_document_id: {
      type: 'string',
      description: 'The mail/message it came from',
    },
    draft_id: { type: 'string', description: 'Revise this draft' },
    revision: { type: 'number', description: 'The revision you last saw' },
    force: {
      type: 'boolean',
      description:
        'Re-propose an event the user dismissed — only when they explicitly ask again',
    },
  },
  required: ['title', 'start', 'category'],
} as const;

export function draftEventOut(r: DraftEventResult): unknown {
  if ('alreadyInCalendar' in r)
    return {
      already_in_calendar: r.alreadyInCalendar,
      instruction: r.instruction,
    };
  if ('dismissed' in r)
    return { dismissed: true, draft_id: r.draftId, instruction: r.instruction };
  return {
    draft_id: r.draftId,
    revision: r.revision,
    mode: r.mode,
    ...(r.confirmUrl && { confirm_url: r.confirmUrl }),
    calendar: {
      calendar_id: r.calendar.id,
      name: r.calendar.name,
      account_email: r.calendar.accountEmail,
    },
    similar_events: r.similarEvents.map((s) => ({
      kind: s.kind,
      title: s.title,
      start: s.start,
      ...(s.calendar && { calendar: s.calendar }),
      ...(s.draftId && { draft_id: s.draftId }),
    })),
    ...(r.existing && { existing: true }),
    instruction: r.instruction,
  };
}

export function makeDraftEventTool(calendar: CalendarToolApi) {
  return async function draftEvent(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as Record<string, unknown>;
    const str = (k: string) =>
      typeof a[k] === 'string' && a[k] !== '' ? (a[k] as string) : undefined;
    if (!str('title')) throw new Error('draft_event: title is required');
    if (!str('start')) throw new Error('draft_event: start is required');
    const category = str('category') as EventCategory | undefined;
    if (!category || !EVENT_CATEGORIES.includes(category))
      throw new Error(
        `draft_event: category must be one of ${EVENT_CATEGORIES.join(', ')}`,
      );
    const conference = str('conference');
    if (conference && conference !== 'none' && conference !== 'auto')
      throw new Error("draft_event: conference must be 'none' or 'auto'");
    const attendees = Array.isArray(a.attendees)
      ? (a.attendees as Array<{ email?: unknown; name?: unknown }>).map((p) => {
          if (typeof p?.email !== 'string' || !p.email.includes('@'))
            throw new Error('draft_event: every attendee needs an email');
          return {
            email: p.email,
            ...(typeof p.name === 'string' && { name: p.name }),
          };
        })
      : undefined;
    return draftEventOut(
      await calendar.draftEvent({
        title: str('title')!,
        start: str('start')!,
        end: str('end'),
        allDay: typeof a.all_day === 'boolean' ? a.all_day : undefined,
        timeZone: str('time_zone'),
        accountId: str('account_id'),
        calendarId: str('calendar_id'),
        category,
        location: str('location'),
        description: str('description'),
        attendees,
        conference: conference as 'none' | 'auto' | undefined,
        sourceDocumentId: str('source_document_id'),
        draftId: str('draft_id'),
        revision: typeof a.revision === 'number' ? a.revision : undefined,
        force: a.force === true,
      }),
    );
  };
}
