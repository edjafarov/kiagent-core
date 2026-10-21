import type { CalendarEventMetadata } from '@shared/contracts';

import type { EventDraftRow } from '../../core/store/event-drafts';
import {
  classifyDraft,
  classifyEvent,
  draftSpan,
  findSlots,
  zonedToUtc,
  type Busyish,
} from '../availability';

const ev = (
  over: Partial<CalendarEventMetadata> = {},
): CalendarEventMetadata => ({
  calendarId: 'c',
  calendarName: 'Family',
  calendarColor: null,
  eventId: 'e',
  iCalUID: null,
  occurrenceKey: 'e',
  start: '2026-11-03T10:00:00.000Z',
  end: '2026-11-03T11:00:00.000Z',
  allDay: false,
  timeZone: 'Europe/Berlin',
  status: 'confirmed',
  organizer: null,
  selfResponse: 'accepted',
  attendees: [],
  participants: [],
  conferenceUrl: null,
  location: null,
  eventType: 'default',
  transparency: 'opaque',
  ...over,
});

const draftRow = (over: Partial<EventDraftRow> = {}): EventDraftRow => ({
  id: 'd1',
  accountId: 'acc' as EventDraftRow['accountId'],
  revision: 1,
  payload: {
    calendarId: 'c',
    title: 'Elternabend',
    start: '2026-11-03T17:00:00.000Z',
    end: '2026-11-03T18:30:00.000Z',
    allDay: false,
    timeZone: 'Europe/Berlin',
    location: null,
    description: null,
    attendees: [],
    conference: 'none',
    category: 'kids',
  },
  idempotencyKey: 'd1:1',
  sourceDocumentId: null,
  fingerprint: 'fp',
  confirmMode: 'review',
  status: 'created',
  error: null,
  created: null,
  createdVia: 'mcp-local',
  createdBy: null,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
  confirmedAt: '2026-11-01T10:00:00.000Z',
  expiresAt: '2026-11-08T10:00:00.000Z',
  touchedAt: '2026-11-01T10:00:00.000Z',
  touchedVia: 'mcp-local',
  ...over,
});

describe('availability tiers', () => {
  it('classifyEvent order', () => {
    expect(
      classifyEvent(ev({ status: 'cancelled', eventType: 'outOfOffice' })),
    ).toBe('ignore');
    expect(classifyEvent(ev({ selfResponse: 'declined' }))).toBe('ignore');
    expect(classifyEvent(ev({ transparency: 'transparent' }))).toBe('ignore');
    expect(classifyEvent(ev({ eventType: 'workingLocation' }))).toBe('ignore');
    expect(classifyEvent(ev({ eventType: 'outOfOffice', allDay: true }))).toBe(
      'busy',
    );
    expect(classifyEvent(ev({ status: 'tentative' }))).toBe('maybe');
    expect(classifyEvent(ev({ selfResponse: 'needsAction' }))).toBe('maybe');
    expect(classifyEvent(ev({ selfResponse: 'tentative' }))).toBe('maybe');
    expect(classifyEvent(ev({ allDay: true }))).toBe('maybe');
    expect(classifyEvent(ev({ eventType: 'focusTime' }))).toBe('maybe');
    expect(classifyEvent(ev())).toBe('busy');
  });

  it('classifyDraft', () => {
    const at = (iso: string) => new Date(iso);
    expect(classifyDraft(draftRow(), false, at('2026-11-01T11:00:00Z'))).toBe(
      'busy',
    );
    expect(classifyDraft(draftRow(), false, at('2026-11-02T11:00:00Z'))).toBe(
      'maybe',
    );
    expect(classifyDraft(draftRow(), true, at('2026-11-01T11:00:00Z'))).toBe(
      'ignore',
    );
    expect(classifyDraft(draftRow(), false, at('2026-11-03T19:00:00Z'))).toBe(
      'ignore',
    );
    expect(
      classifyDraft(
        draftRow({ status: 'draft', confirmedAt: null, idempotencyKey: null }),
        false,
        at('2026-11-01T11:00:00Z'),
      ),
    ).toBe('maybe');
    expect(
      classifyDraft(
        draftRow({ status: 'unknown' }),
        false,
        at('2026-11-01T11:00:00Z'),
      ),
    ).toBe('maybe');
    expect(
      classifyDraft(
        draftRow({ status: 'discarded' }),
        false,
        at('2026-11-01T11:00:00Z'),
      ),
    ).toBe('ignore');
  });

  it('draftSpan turns all-day dates into local midnights', () => {
    expect(
      draftSpan({
        start: '2026-11-03',
        end: '2026-11-04',
        allDay: true,
        timeZone: 'Europe/Berlin',
      }),
    ).toEqual({
      start: '2026-11-02T23:00:00.000Z',
      end: '2026-11-03T23:00:00.000Z',
    });
  });

  it('zonedToUtc is DST-correct', () => {
    // Berlin: CEST (+2) before 2026-10-25 03:00, CET (+1) after.
    expect(
      new Date(zonedToUtc(2026, 10, 24, 9, 0, 'Europe/Berlin')).toISOString(),
    ).toBe('2026-10-24T07:00:00.000Z');
    expect(
      new Date(zonedToUtc(2026, 10, 26, 9, 0, 'Europe/Berlin')).toISOString(),
    ).toBe('2026-10-26T08:00:00.000Z');
    expect(
      new Date(zonedToUtc(2026, 11, 3, 9, 0, 'America/New_York')).toISOString(),
    ).toBe('2026-11-03T14:00:00.000Z');
  });
});

describe('findSlots', () => {
  const week = {
    from: '2026-11-02T00:00:00+01:00', // Monday
    to: '2026-11-09T00:00:00+01:00',
    durationMinutes: 60,
    between: { start: '09:00', end: '18:00' },
    days: [1, 2, 3, 4, 5],
    timeZone: 'Europe/Berlin',
    limit: 500,
  };
  const now = new Date('2026-11-01T00:00:00Z');
  const block = (
    start: string,
    end: string,
    tier: Busyish['tier'],
  ): Busyish => ({
    title: tier === 'busy' ? 'Dentist' : 'Birthday?',
    start,
    end,
    calendar: 'Family',
    tier,
  });

  it('findSlots respects working hours, days and the time zone', () => {
    const busy = block('2026-11-03T09:00:00Z', '2026-11-03T11:00:00Z', 'busy'); // Tue 10:00–12:00 Berlin
    const slots = findSlots(week, [busy], now);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      const st = Date.parse(s.start);
      const en = Date.parse(s.end);
      expect(st < Date.parse(busy.end) && en > Date.parse(busy.start)).toBe(
        false,
      );
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Berlin',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(st));
      const part = (t: string) => local.find((p) => p.type === t)!.value;
      expect(['Sat', 'Sun']).not.toContain(part('weekday'));
      expect(['00', '30']).toContain(part('minute'));
      const h = Number(part('hour'));
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h * 60 + Number(part('minute')) + 60).toBeLessThanOrEqual(18 * 60);
    }
    // Monday 09:00 Berlin is the first slot.
    expect(slots[0].start).toBe('2026-11-02T08:00:00.000Z');
    // 5 days × 17 candidates, minus the 5 starts that touch Tue 10:00–12:00.
    expect(slots).toHaveLength(5 * 17 - 5);
  });

  it('findSlots ranks free before maybe', () => {
    const maybe = block(
      '2026-11-02T08:00:00Z',
      '2026-11-02T09:00:00Z',
      'maybe',
    ); // Mon 09–10
    const slots = findSlots(
      { ...week, to: '2026-11-03T00:00:00+01:00', limit: 50 },
      [maybe],
      now,
    );
    const firstMaybe = slots.findIndex((s) => s.tier === 'maybe');
    expect(firstMaybe).toBeGreaterThan(0);
    expect(slots.slice(firstMaybe).every((s) => s.tier === 'maybe')).toBe(true);
    const m = slots.find((s) => s.start === '2026-11-02T08:00:00.000Z')!;
    expect(m.tier).toBe('maybe');
    expect(m.conflicts).toEqual([maybe]);
  });

  it('never offers a slot in the past and caps at limit', () => {
    const slots = findSlots(
      { ...week, limit: 3 },
      [],
      new Date('2026-11-02T10:10:00Z'),
    );
    expect(slots.map((s) => s.start)).toEqual([
      '2026-11-02T10:30:00.000Z',
      '2026-11-02T11:00:00.000Z',
      '2026-11-02T11:30:00.000Z',
    ]);
  });
});
