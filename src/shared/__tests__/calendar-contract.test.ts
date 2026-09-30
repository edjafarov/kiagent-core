import {
  CALENDAR_EVENT_DOCUMENT_TYPE,
  type CalendarEventMetadata,
  type QueryAccount,
} from '../contracts';

test('calendar.event is the calendar document type', () => {
  expect(CALENDAR_EVENT_DOCUMENT_TYPE).toBe('calendar.event');
});

test('the metadata carries what every consumer reads', () => {
  const m: CalendarEventMetadata = {
    calendarId: 'c',
    calendarName: 'Work',
    calendarColor: null,
    eventId: 'e',
    iCalUID: null,
    occurrenceKey: 'k',
    start: '2026-10-01T09:00:00.000Z',
    end: '2026-10-01T10:00:00.000Z',
    allDay: false,
    timeZone: 'UTC',
    status: 'confirmed',
    organizer: null,
    selfResponse: null,
    attendees: [{ email: 'a@x.com', name: null, response: null }],
    participants: ['a@x.com'],
    conferenceUrl: null,
    location: null,
    eventType: 'default',
    transparency: 'opaque',
  };
  expect(m.occurrenceKey).toBe('k');
  const a: QueryAccount = {
    id: 'A' as never,
    source: 's',
    identifier: 'i',
    config: {},
    status: 'live' as never,
    cursor: null,
    createdAt: '',
    documentTypes: ['calendar.event'],
  };
  expect(a.documentTypes).toContain('calendar.event');
});
