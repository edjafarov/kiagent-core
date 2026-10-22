/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  CalendarEventMetadata,
  Prefs,
  WritableCalendar,
} from '@shared/contracts';

import { openDb } from '../../db/app-db';
import type { EventDraftRow } from '../../core/store/event-drafts';
import { openStore, type CoreStore } from '../../core/store/store';
import type { OutboundContext } from '../../outbound/service';
import { classifyEvent, type Tier } from '../availability';
import type { Collected } from '../collect';
import { buildDayModel, layoutLanes } from '../day-model';
import { createCalendarOutService, type CalendarOutService } from '../service';
import { createCalendarWriterRegistry } from '../writers';

const BER = 'Europe/Berlin';

const meta = (
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
  timeZone: BER,
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

const ev = (
  title: string,
  over: Partial<CalendarEventMetadata> = {},
  disclosable = true,
): Collected['events'][number] => {
  const m = meta(over);
  return {
    e: {
      documentId: `d-${title}`,
      accountId: 'acc' as never,
      title,
      metadata: m,
    },
    tier: classifyEvent(m),
    disclosable,
  };
};

const draftRow = (
  id: string,
  payload: Partial<EventDraftRow['payload']> = {},
  over: Partial<EventDraftRow> = {},
): EventDraftRow => ({
  id,
  accountId: 'acc' as never,
  revision: 1,
  payload: {
    calendarId: 'c',
    title: 'Mine',
    start: '2026-11-03T10:00:00.000Z',
    end: '2026-11-03T11:00:00.000Z',
    allDay: false,
    timeZone: BER,
    location: null,
    description: null,
    attendees: [],
    conference: 'none',
    category: 'work',
    ...payload,
  },
  idempotencyKey: null,
  sourceDocumentId: null,
  fingerprint: 'fp',
  confirmMode: 'review',
  status: 'draft',
  error: null,
  created: null,
  createdVia: 'mcp-local',
  createdBy: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  confirmedAt: null,
  expiresAt: '2026-11-08T00:00:00.000Z',
  touchedAt: '2026-11-01T00:00:00.000Z',
  touchedVia: 'mcp-local',
  ...over,
});

const other = (
  id: string,
  payload: Partial<EventDraftRow['payload']>,
  tier: Tier,
  disclosable = true,
  over: Partial<EventDraftRow> = {},
): Collected['drafts'][number] => {
  const row = draftRow(id, payload, over);
  return {
    row,
    tier,
    span: {
      start: new Date(row.payload.start).toISOString(),
      end: new Date(row.payload.end).toISOString(),
    },
    seen: false,
    disclosable,
  };
};

const col = (over: Partial<Collected> = {}): Collected => ({
  indexed: [],
  notIndexedWritable: [],
  warnings: [],
  lastSync: new Map(),
  events: [],
  drafts: [],
  ...over,
});

describe('layoutLanes', () => {
  it('splits overlapping items and leaves disjoint ones alone', () => {
    const r = layoutLanes([
      { start: 0, end: 10 },
      { start: 5, end: 15 },
      { start: 20, end: 30 },
    ]);
    expect(r.map((x) => [x.lane, x.lanes])).toEqual([
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
  });
});

describe('buildDayModel', () => {
  it('Berlin fall-back day: 1500 min, repeated 02:00, two 02:10 events apart with offsets', () => {
    // 2026-10-25: 02:10 CEST = 00:10Z, 02:10 CET = 01:10Z. Day starts 22:00Z.
    const d = draftRow('me', {
      start: '2026-10-25T09:00:00.000Z',
      end: '2026-10-25T10:00:00.000Z',
    });
    const m = buildDayModel(
      d,
      col({
        events: [
          ev('First', {
            start: '2026-10-25T00:10:00.000Z',
            end: '2026-10-25T00:30:00.000Z',
          }),
          ev('Second', {
            start: '2026-10-25T01:10:00.000Z',
            end: '2026-10-25T01:30:00.000Z',
          }),
        ],
      }),
      BER,
    );
    expect(m.dayLenMin).toBe(1500);
    expect(m.hours).toHaveLength(25);
    expect(m.hours.filter((h) => h.label === '02:00')).toHaveLength(2);
    expect(m.hours[2]).toEqual({ y: 120, label: '02:00' });
    expect(m.hours[3]).toEqual({ y: 180, label: '02:00' });
    expect(m.blocks.map((b) => b.y)).toEqual([130, 190]);
    expect(m.blocks[0].time).toBe('02:10 GMT+2–02:30 GMT+2');
    expect(m.blocks[1].time).toBe('02:10 GMT+1–02:30 GMT+1');
  });

  it('overnight proposal sees a next-day 00:30 busy event in the line', () => {
    // Fri 23 Oct 23:30 – Sat 24 Oct 01:30 Berlin (CEST).
    const d = draftRow('me', {
      start: '2026-10-23T21:30:00.000Z',
      end: '2026-10-23T23:30:00.000Z',
    });
    const m = buildDayModel(
      d,
      col({
        events: [
          ev('Late call', {
            start: '2026-10-23T22:30:00.000Z',
            end: '2026-10-23T23:00:00.000Z',
          }),
        ],
      }),
      BER,
    );
    expect(m.line).toEqual({
      kind: 'busy',
      text: 'Overlaps Late call 00:30–01:00',
    });
    expect(m.busyClash).toBe(true);
    expect(m.blocks).toHaveLength(0);
    expect(m.proposed.continues).toBe(true);
    expect(m.proposed.time).toBe('23:30–01:30 continues →');
  });

  it('excludes this draft by id but draws other drafts', () => {
    const d = draftRow('me');
    const m = buildDayModel(
      d,
      col({
        drafts: [
          other('me', {}, 'maybe'),
          other('d2', { title: 'Other' }, 'maybe'),
        ],
      }),
      BER,
    );
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0]).toMatchObject({
      title: 'Other (Kia draft, not added yet)',
      draft: true,
      outline: 'maybe',
    });
    expect(m.line.kind).toBe('maybe');
  });

  it('omits ignore-tier drafts and adds the added-by-Kia suffix', () => {
    const d = draftRow('me');
    const m = buildDayModel(
      d,
      col({
        drafts: [
          other('gone', { title: 'Seen' }, 'ignore'),
          other(
            'p',
            {
              title: 'Placeholder',
              start: '2026-11-03T15:00:00.000Z',
              end: '2026-11-03T16:00:00.000Z',
            },
            'busy',
            true,
            { status: 'created' },
          ),
        ],
      }),
      BER,
    );
    expect(m.blocks.map((b) => b.title)).toEqual([
      'Placeholder (added by Kia, not seen in sync yet)',
    ]);
  });

  it('an all-day proposal keeps its counted events through the cap', () => {
    const d = draftRow('me', {
      allDay: true,
      start: '2026-11-03',
      end: '2026-11-04',
    });
    const events: Collected['events'] = [];
    const base = Date.parse('2026-11-02T23:00:00.000Z');
    for (let i = 0; i < 200; i += 1) {
      const x = ev(`i${i}`, {
        eventId: `i${i}`,
        transparency: 'transparent',
        start: new Date(base + i * 120_000).toISOString(),
        end: new Date(base + i * 120_000 + 60_000).toISOString(),
      });
      events.push({ ...x, tier: 'ignore' });
    }
    events.push(
      ev('Real', {
        start: '2026-11-03T15:00:00.000Z',
        end: '2026-11-03T16:00:00.000Z',
      }),
    );
    const m = buildDayModel(d, col({ events }), BER);
    expect(m.line).toMatchObject({ kind: 'count' });
    expect(m.blocks.some((b) => b.title === 'Real')).toBe(true);
    expect(m.more).toBe(1);
  });

  it('an unseen all-day placeholder is strip-only, never a busy clash', () => {
    const m = buildDayModel(
      draftRow('me'),
      col({
        drafts: [
          other(
            'p',
            {
              title: 'Holiday',
              allDay: true,
              start: '2026-11-03',
              end: '2026-11-04',
            },
            'busy',
            true,
            { status: 'created' },
          ),
        ],
      }),
      BER,
    );
    expect(m.busyClash).toBe(false);
    expect(m.line.kind).toBe('free');
    expect(m.allDay.map((c) => c.title)).toEqual([
      'Holiday (added by Kia, not seen in sync yet)',
    ]);
  });

  it("a Tokyo all-day event on the next date is not in Berlin's strip", () => {
    // Berlin Fri 23 Oct 22:00–23:00 CEST. Tokyo's all-day Sat 24 Oct runs
    // 2026-10-23T15:00Z–10-24T15:00Z, so it overlaps but is not on D.
    const d = draftRow('me', {
      start: '2026-10-23T20:00:00.000Z',
      end: '2026-10-23T21:00:00.000Z',
    });
    const m = buildDayModel(
      d,
      col({
        events: [
          ev('Tokyo trip', {
            allDay: true,
            startDate: '2026-10-24',
            endDate: '2026-10-25',
            start: '2026-10-23T15:00:00.000Z',
            end: '2026-10-24T15:00:00.000Z',
            timeZone: 'Asia/Tokyo',
          }),
        ],
      }),
      BER,
    );
    expect(m.allDay).toHaveLength(0);
    expect(m.alsoOn).toEqual(['Also on Sat 24 Oct: Tokyo trip (all day)']);
    expect(m.line.kind).toBe('free');
  });

  it('Kiritimati out-of-office vs a Honolulu proposal: busy line, not in the strip', () => {
    // Honolulu Thu 22 Oct 10:00–11:00 HST = 20:00Z–21:00Z. Kiritimati (+14)
    // all-day Fri 23 Oct = 2026-10-22T10:00Z–10-23T10:00Z.
    const d = draftRow('me', {
      timeZone: 'Pacific/Honolulu',
      start: '2026-10-22T20:00:00.000Z',
      end: '2026-10-22T21:00:00.000Z',
    });
    const m = buildDayModel(
      d,
      col({
        events: [
          ev('Away', {
            allDay: true,
            eventType: 'outOfOffice',
            startDate: '2026-10-23',
            endDate: '2026-10-24',
            start: '2026-10-22T10:00:00.000Z',
            end: '2026-10-23T10:00:00.000Z',
          }),
        ],
      }),
      'Pacific/Honolulu',
    );
    expect(m.line).toEqual({ kind: 'busy', text: 'Overlaps Away (all day)' });
    expect(m.allDay).toHaveLength(0);
    expect(m.busyClash).toBe(true);
  });

  it('an ordinary all-day event shows in the strip and the line stays free', () => {
    const d = draftRow('me');
    const m = buildDayModel(
      d,
      col({
        events: [
          ev('School trip', {
            allDay: true,
            startDate: '2026-11-03',
            endDate: '2026-11-04',
            start: '2026-11-02T23:00:00.000Z',
            end: '2026-11-03T23:00:00.000Z',
          }),
        ],
      }),
      BER,
    );
    expect(m.allDay.map((c) => c.title)).toEqual(['School trip']);
    expect(m.blocks).toHaveLength(0);
    expect(m.line).toEqual({
      kind: 'free',
      text: 'Free — nothing else at this time',
    });
    expect(m.busyClash).toBe(false);
    expect(m.alsoOn).toEqual([]);
  });

  it('busy clash: outline, time range, plural copy, maybe tail', () => {
    const d = draftRow('me');
    const one = buildDayModel(
      d,
      col({
        events: [
          ev('Standup', {
            start: '2026-11-03T10:30:00.000Z',
            end: '2026-11-03T11:30:00.000Z',
          }),
        ],
      }),
      BER,
    );
    expect(one.line.text).toBe('Overlaps Standup 11:30–12:30');
    expect(one.blocks[0]).toMatchObject({ outline: 'busy', lane: 1, lanes: 2 });
    expect(one.proposed).toMatchObject({ lane: 0, lanes: 2 });

    const many = buildDayModel(
      d,
      col({
        events: [
          ev('A', {
            start: '2026-11-03T10:00:00.000Z',
            end: '2026-11-03T10:30:00.000Z',
          }),
          ev('B', {
            start: '2026-11-03T10:30:00.000Z',
            end: '2026-11-03T11:00:00.000Z',
          }),
          ev('T', {
            selfResponse: 'tentative',
            start: '2026-11-03T10:15:00.000Z',
            end: '2026-11-03T10:45:00.000Z',
          }),
        ],
      }),
      BER,
    );
    expect(many.line.text).toBe('Overlaps 2 events: A, B · may overlap 1 more');
  });

  it('maybe tier: amber outline, "May overlap", button not escalated', () => {
    const d = draftRow('me');
    const m = buildDayModel(
      d,
      col({ events: [ev('Maybe', { selfResponse: 'tentative' })] }),
      BER,
    );
    expect(m.blocks[0].outline).toBe('maybe');
    expect(m.line).toEqual({
      kind: 'maybe',
      text: 'May overlap Maybe — not confirmed',
    });
    expect(m.busyClash).toBe(false);
  });

  it('ignore tier (declined) is drawn dimmed but never clashes', () => {
    const d = draftRow('me');
    const m = buildDayModel(
      d,
      col({ events: [ev('No', { selfResponse: 'declined' })] }),
      BER,
    );
    expect(m.blocks[0]).toMatchObject({ declined: true, outline: null });
    expect(m.line.kind).toBe('free');
  });

  it('non-disclosable: Busy grey block, "an event" in the line, "Kia draft"', () => {
    const d = draftRow('me');
    const m = buildDayModel(
      d,
      col({
        events: [
          ev('Secret', { calendarColor: '#ff0000', category: 'kids' }, false),
        ],
        drafts: [
          other(
            'x',
            {
              title: 'Hidden',
              start: '2026-11-03T20:00:00.000Z',
              end: '2026-11-03T21:00:00.000Z',
            },
            'maybe',
            false,
          ),
        ],
      }),
      BER,
    );
    expect(m.blocks.find((b) => b.title === 'Busy')).toMatchObject({
      color: '#94a3b8',
      category: null,
    });
    expect(m.blocks.some((b) => b.title === 'Kia draft')).toBe(true);
    expect(m.line.text).toBe('Overlaps an event 11:00–12:00');
    expect(JSON.stringify(m)).not.toContain('Secret');
    expect(JSON.stringify(m)).not.toContain('Hidden');
  });

  it('colours are validated', () => {
    const d = draftRow('me');
    const m = buildDayModel(
      d,
      col({
        events: [
          ev('Bad', { calendarColor: 'red;position:fixed' }),
          ev('Good', {
            calendarColor: '#33b679',
            start: '2026-11-03T15:00:00.000Z',
            end: '2026-11-03T16:00:00.000Z',
          }),
        ],
      }),
      BER,
    );
    expect(m.blocks.map((b) => b.color)).toEqual(['#4285f4', '#33b679']);
  });

  it('a 25 h proposal gets the spans line and no clash claim', () => {
    const d = draftRow('me', {
      start: '2026-11-03T10:00:00.000Z',
      end: '2026-11-04T11:00:00.000Z',
    });
    const m = buildDayModel(d, col({ events: [ev('Standup')] }), BER);
    expect(m.line).toEqual({
      kind: 'spans',
      text: "Spans several days — Kia didn't check them all",
    });
    expect(m.blocks[0].outline).toBeNull();
    expect(m.busyClash).toBe(false);
    expect(m.proposed.continues).toBe(true);
  });

  it('single-day all-day proposal: count line (singular/plural) or free', () => {
    const d = draftRow('me', {
      allDay: true,
      start: '2026-11-03',
      end: '2026-11-04',
    });
    const none = buildDayModel(d, col(), BER);
    expect(none.line.kind).toBe('free');
    expect(none.proposed).toMatchObject({ allDay: true, time: 'All day' });
    expect(none.allDay).toEqual([
      expect.objectContaining({ proposed: true, title: 'Mine' }),
    ]);
    const one = buildDayModel(d, col({ events: [ev('Standup')] }), BER);
    expect(one.line).toEqual({ kind: 'count', text: 'That day: 1 event' });
    expect(one.blocks[0].outline).toBeNull();
    expect(one.busyClash).toBe(false);
    const two = buildDayModel(
      d,
      col({
        events: [
          ev('Standup'),
          ev('Declined', { selfResponse: 'declined' }),
          ev('Tent', { selfResponse: 'tentative' }),
        ],
      }),
      BER,
    );
    expect(two.line.text).toBe('That day: 2 events');
  });

  it('Havana missing-midnight all-day proposal covers the 23:30 event', () => {
    // 2026-03-07 Havana: day starts 05:00Z the day before? UTC-5 → 05:00Z; a
    // 23:30 local event is 04:30Z next day, inside the (fixed) span.
    const d = draftRow('me', {
      timeZone: 'America/Havana',
      allDay: true,
      start: '2026-03-07',
      end: '2026-03-08',
    });
    const m = buildDayModel(
      d,
      col({
        events: [
          ev('Late', {
            start: '2026-03-08T04:30:00.000Z',
            end: '2026-03-08T04:50:00.000Z',
          }),
        ],
      }),
      'America/Havana',
    );
    expect(m.line.text).toBe('That day: 1 event');
  });

  it('notes: Not checked first, warnings verbatim, not-synced lines dropped; free-partial', () => {
    const d = draftRow('me');
    const m = buildDayModel(
      d,
      col({
        notIndexedWritable: [{ accountEmail: 'me@x.com', calendar: 'Work' }],
        warnings: [
          'me@x.com last synced 5 h ago',
          'Work (me@x.com) is not synced by Kia — its events are unknown',
          'you@y.com has never synced',
        ],
      }),
      BER,
    );
    expect(m.notes).toEqual([
      'Not checked: Work (me@x.com)',
      'me@x.com last synced 5 h ago',
      'you@y.com has never synced',
    ]);
    expect(m.line).toEqual({
      kind: 'free-partial',
      text: 'Free as far as Kia can see',
    });
  });

  it('scrollPx: start − 90 clamped at 0; all-day → 08:00 − 90', () => {
    const at = (iso: string) =>
      buildDayModel(
        draftRow('me', {
          start: iso,
          end: new Date(Date.parse(iso) + 3_600_000).toISOString(),
        }),
        col(),
        BER,
      );
    // 14:00 Berlin (CET) = 13:00Z → y 840.
    expect(at('2026-11-03T13:00:00.000Z').scrollPx).toBe(750);
    expect(at('2026-11-03T13:00:00.000Z').proposed.y).toBe(840);
    expect(at('2026-11-03T00:30:00.000Z').scrollPx).toBe(0);
    const ad = buildDayModel(
      draftRow('me', { allDay: true, start: '2026-11-03', end: '2026-11-04' }),
      col(),
      BER,
    );
    expect(ad.proposed.y).toBe(480);
    expect(ad.scrollPx).toBe(390);
  });

  it('caps timed blocks at 200 keeping clashing ones; all-day chips uncapped', () => {
    const d = draftRow('me');
    const events: Collected['events'] = [];
    // 200 one-minute blocks from 00:00 Berlin, all before the proposal
    // (11:00–12:00 Berlin = 10:00Z–11:00Z); then a clash and a late block that
    // both sort AFTER them by start. A plain start-order cap would drop the
    // clash; the rule keeps it and drops the latest non-clashing ones.
    const base = Date.parse('2026-11-02T23:00:00.000Z');
    for (let i = 0; i < 200; i += 1)
      events.push(
        ev(`e${i}`, {
          eventId: `e${i}`,
          start: new Date(base + i * 120_000).toISOString(),
          end: new Date(base + i * 120_000 + 60_000).toISOString(),
        }),
      );
    events.push(
      ev('clash', {
        start: '2026-11-03T10:00:00.000Z',
        end: '2026-11-03T10:30:00.000Z',
      }),
    );
    events.push(
      ev('late', {
        start: '2026-11-03T17:00:00.000Z',
        end: '2026-11-03T17:30:00.000Z',
      }),
    );
    for (let i = 0; i < 5; i += 1)
      events.push(
        ev(`ad${i}`, {
          allDay: true,
          startDate: '2026-11-03',
          endDate: '2026-11-04',
          start: '2026-11-02T23:00:00.000Z',
          end: '2026-11-03T23:00:00.000Z',
        }),
      );
    const m = buildDayModel(d, col({ events }), BER);
    // 200 timed blocks drawn in total: the proposal + 199 others.
    expect(m.blocks).toHaveLength(199);
    expect(m.more).toBe(3);
    expect(
      m.blocks.some((b) => b.title === 'clash' && b.outline === 'busy'),
    ).toBe(true);
    expect(m.blocks.some((b) => b.title === 'e197')).toBe(true);
    expect(m.blocks.some((b) => b.title === 'e198')).toBe(false);
    expect(m.blocks.some((b) => b.title === 'e199')).toBe(false);
    expect(m.blocks.some((b) => b.title === 'late')).toBe(false);
    expect(m.allDay).toHaveLength(5);
  });
});

describe('service.dayView', () => {
  let dir: string;
  let store: CoreStore;
  let svc: CalendarOutService;
  let acc: Account;
  const clock = new Date('2026-11-02T08:00:00.000Z');

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-dayview-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
      now: () => clock.toISOString(),
    });
    acc = await store.createAccount({
      source: 'google-calendar',
      identifier: 'me@example.com',
      config: { folderRoots: [{ id: 'family@group', name: 'Family' }] },
    });
    await store.commit({ account: acc.id, documents: [], cursor: 0 });
    const writers = createCalendarWriterRegistry();
    const cal: WritableCalendar = {
      id: 'family@group',
      name: 'Family',
      color: null,
      primary: true,
      canWrite: true,
      shared: false,
      timeZone: BER,
    };
    writers.register('google-calendar', {
      listCalendars: async () => [cal],
      createEvent: async () => {
        throw new Error('unused');
      },
    });
    const ctx: OutboundContext = {
      modeFor: () => 'review',
      baseFor: () => 'http://127.0.0.1:7421',
      createdViaNow: () => 'mcp-local',
      secret: async () => Buffer.from('s'.repeat(32)),
    };
    svc = createCalendarOutService({
      sources: {
        get: () => ({ descriptor: { documentTypes: ['calendar.event'] } }),
      },
      store,
      writers,
      ctx: () => ctx,
      prefs: { get: () => ({ calendar: undefined }) } as unknown as Prefs,
      vaultScope: async () => undefined,
      now: () => clock,
      logSink: { log: () => {} } as never,
    } as never);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const view = async (over: Record<string, unknown> = {}) => {
    await svc.draftEvent({
      title: 'Offsite',
      start: '2026-11-03T10:00:00+01:00',
      end: '2026-11-03T11:00:00+01:00',
      category: 'work',
      ...over,
    } as never);
    return (await svc.listPending())[0];
  };

  it('windows a timed proposal by drawn day ± 26 h and returns a model', async () => {
    const v = await view();
    const overlap = jest.spyOn(store.calendarIndex, 'overlap');
    const m = await svc.dayView(v);
    // D = 2026-11-03 Berlin: 2026-11-02T23:00Z … 2026-11-03T23:00Z.
    expect(overlap.mock.calls[0].slice(0, 2)).toEqual([
      new Date(
        Date.parse('2026-11-02T23:00:00Z') - 26 * 3_600_000,
      ).toISOString(),
      new Date(
        Date.parse('2026-11-03T23:00:00Z') + 26 * 3_600_000,
      ).toISOString(),
    ]);
    expect(overlap.mock.calls[0][3]).toBe(1001);
    expect(m).toMatchObject({ date: '2026-11-03', line: { kind: 'free' } });
  });

  it('a 30-day proposal collects the drawn day ± 26 h only', async () => {
    const v = await view({ end: '2026-12-03T10:00:00+01:00' });
    const overlap = jest.spyOn(store.calendarIndex, 'overlap');
    const m = await svc.dayView(v);
    expect(overlap.mock.calls[0].slice(0, 2)).toEqual([
      new Date(
        Date.parse('2026-11-02T23:00:00Z') - 26 * 3_600_000,
      ).toISOString(),
      new Date(
        Date.parse('2026-11-03T23:00:00Z') + 26 * 3_600_000,
      ).toISOString(),
    ]);
    expect(m?.line.kind).toBe('spans');
  });

  it('returns null when the listing failed, on overflow, and at the deadline', async () => {
    const v = await view();
    const overlap = jest.spyOn(store.calendarIndex, 'overlap');
    expect(await svc.dayView({ ...v, listing: { ok: false } })).toBeNull();
    expect(overlap).not.toHaveBeenCalled();

    overlap.mockResolvedValueOnce(new Array(1001).fill({}));
    expect(await svc.dayView(v)).toBeNull();

    overlap.mockImplementationOnce(() => new Promise(() => {}));
    const t0 = Date.now();
    expect(await svc.dayView({ ...v, deadlineMs: Date.now() + 30 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);

    // Already past the deadline: no query is started, no model is built.
    overlap.mockClear();
    expect(
      await svc.dayView({ ...v, deadlineMs: Date.now() - 1000 }),
    ).toBeNull();
    expect(overlap).not.toHaveBeenCalled();
  });
});
