/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  CalendarEventMetadata,
  CreatedEvent,
  EventIntent,
  Prefs,
  WritableCalendar,
} from '@shared/contracts';

import { openDb } from '../../db/app-db';
import { runWithTransport } from '../../core/mcp/transport-context';
import { openStore, type CoreStore } from '../../core/store/store';
import type { OutboundContext } from '../../outbound/service';
import { signConfirmToken } from '../../outbound/tokens';
import {
  classifyWriterError,
  createCalendarOutService,
  type CalendarOutService,
  type DraftEventResult,
} from '../service';
import { createCalendarWriterRegistry } from '../writers';

/** Source registry stub: google-calendar is calendar-only; microsoft-365
 *  syncs mail too (its folderRoots are mail folders). */
const CAL_SOURCES = {
  get: (id: string) => ({
    descriptor: {
      documentTypes:
        id === 'microsoft-365'
          ? ['email.thread', 'attachment', 'calendar.event']
          : ['calendar.event'],
    },
  }),
};

const SECRET = Buffer.from('s'.repeat(32));
const BASE = 'http://127.0.0.1:7421';
const T0 = '2026-11-02T08:00:00.000Z'; // Monday 09:00 Berlin

const cal = (over: Partial<WritableCalendar> = {}): WritableCalendar => ({
  id: 'family@group',
  name: 'Family',
  color: null,
  primary: true,
  canWrite: true,
  shared: false,
  timeZone: 'Europe/Berlin',
  ...over,
});

const meta = (
  over: Partial<CalendarEventMetadata> = {},
): CalendarEventMetadata => ({
  calendarId: 'family@group',
  calendarName: 'Family',
  calendarColor: null,
  eventId: 'ev-x',
  iCalUID: null,
  occurrenceKey: 'ev-x',
  start: '2026-11-03T17:00:00.000Z',
  end: '2026-11-03T18:30:00.000Z',
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

type Draft = Extract<DraftEventResult, { draftId: string; revision: number }>;
const asDraft = (r: DraftEventResult): Draft => {
  if (!('revision' in r)) throw new Error(`not a draft: ${JSON.stringify(r)}`);
  return r;
};

describe('calendar-out service', () => {
  let dir: string;
  let store: CoreStore;
  let svc: CalendarOutService;
  let acc: Account;
  let clock: Date;
  let scope: string | undefined;
  let calendars: WritableCalendar[];
  let prefsCalendar: Record<string, unknown> | undefined;
  let createImpl: (i: EventIntent) => Promise<CreatedEvent>;
  const keys: string[] = [];

  const seed = async (
    externalId: string,
    title: string,
    m: Partial<CalendarEventMetadata>,
  ) => {
    const md = meta({ eventId: externalId, occurrenceKey: externalId, ...m });
    await store.commit({
      account: acc.id,
      documents: [
        {
          externalId,
          type: 'calendar.event',
          title,
          markdown: null,
          metadata: md as unknown as Record<string, unknown>,
          createdAt: md.start,
        },
      ],
      cursor: 1,
    });
  };

  const draft = (over: Record<string, unknown> = {}) =>
    svc.draftEvent({
      title: 'Elternabend 7b',
      start: '2026-11-03T18:00:00+01:00',
      end: '2026-11-03T19:30:00+01:00',
      category: 'kids',
      ...over,
    } as never);

  beforeEach(async () => {
    clock = new Date(T0);
    scope = undefined;
    calendars = [
      cal(),
      cal({ id: 'work@group', name: 'Work', primary: false }),
    ];
    prefsCalendar = undefined;
    keys.length = 0;
    createImpl = async (i) => {
      keys.push(i.idempotencyKey);
      return {
        eventId: `ev-${i.kia.draftId}`,
        iCalUID: `uid-${i.kia.draftId}`,
        htmlLink: null,
        conferenceUrl: null,
        conferencePending: false,
        note: null,
      };
    };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-calout-'));
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
    // A sync: last_sync_at is fresh.
    await store.commit({ account: acc.id, documents: [], cursor: 0 });
    const writers = createCalendarWriterRegistry();
    writers.register('google-calendar', {
      listCalendars: async () => calendars,
      createEvent: (i) => createImpl(i),
    });
    const ctx: OutboundContext = {
      modeFor: (a) =>
        (a.config as { outbound?: { mode?: 'review' | 'link' | 'chat' } })
          .outbound?.mode ?? 'review',
      baseFor: (t) => (t === 'remote' ? null : BASE),
      createdViaNow: () => 'mcp-local',
      secret: async () => SECRET,
    };
    svc = createCalendarOutService({
      sources: CAL_SOURCES,
      store,
      writers,
      ctx: () => ctx,
      prefs: { get: () => ({ calendar: prefsCalendar }) } as unknown as Prefs,
      vaultScope: async () => scope,
      now: () => clock,
      logSink: { log: () => {} } as never,
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('draft_event defaults to prefs.defaultCalendar, else the only account primary', async () => {
    const d = asDraft(await draft());
    expect(d.calendar).toMatchObject({ id: 'family@group', name: 'Family' });
    expect(d.confirmUrl).toMatch(new RegExp(`^${BASE}/outbox/event/confirm/`));
    expect(d.mode).toBe('review');

    await store.setAccountConfig(acc.id, {
      folderRoots: [
        { id: 'family@group', name: 'Family' },
        { id: 'work@group', name: 'Work' },
      ],
    });
    prefsCalendar = {
      defaultCalendar: { accountId: acc.id, calendarId: 'work@group' },
    };
    const svc2 = svc; // same service, prefs read per call
    const w = asDraft(
      await svc2.draftEvent({
        title: 'Standup',
        start: '2026-11-04T09:00:00Z',
        category: 'work',
      }),
    );
    expect(w.calendar.id).toBe('work@group');
  });

  it('normalizes a wall time without offset in the event time zone', async () => {
    const d = asDraft(
      await svc.draftEvent({
        title: 'Swimming',
        start: '2026-11-05T16:00',
        timeZone: 'Europe/Berlin',
        category: 'kids',
      }),
    );
    const row = (await store.eventDrafts.get(d.draftId))!;
    expect(row.payload.start).toBe('2026-11-05T15:00:00.000Z');
    expect(row.payload.end).toBe('2026-11-05T15:30:00.000Z');
  });

  it('draft_event refuses a calendar that is not indexed', async () => {
    await expect(draft({ calendarId: 'work@group' })).rejects.toThrow(
      /Sources/,
    );
  });

  it('effective can_write needs the granted scope', async () => {
    scope = 'https://www.googleapis.com/auth/calendar.readonly';
    const list = await svc.listCalendars({});
    expect(list.find((c) => c.calendarId === 'family@group')).toMatchObject({
      canWrite: false,
      note: expect.stringContaining('reconnect'),
    });
    await expect(draft()).rejects.toThrow(/reconnect/);
    scope =
      'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
    // cached calendars, scope re-read per list
    expect((await svc.listCalendars({}))[0].canWrite).toBe(true);
  });

  it('already in calendar refuses on same start and similar title', async () => {
    await seed('ev-1', 'Elternabend Klasse 7b', {
      start: '2026-11-03T17:00:00Z',
      end: '2026-11-03T18:30:00Z',
    });
    // Jaccard("elternabend 7b", "elternabend klasse 7b") = 2/3 < 0.8 → not refused
    expect('revision' in (await draft())).toBe(true);
    await seed('ev-2', 'Dentist Dr Weber', {
      start: '2026-11-04T10:00:00Z',
      end: '2026-11-04T11:00:00Z',
    });
    const r = await draft({
      title: 'Dr. Weber — dentist',
      start: '2026-11-04T11:00:00+01:00',
      end: undefined,
    });
    expect(r).toMatchObject({
      alreadyInCalendar: [{ title: 'Dentist Dr Weber' }],
    });
  });

  it('same fingerprint returns the existing draft and touches it', async () => {
    const a = asDraft(await draft());
    clock = new Date(Date.parse(T0) + 60_000);
    const b = asDraft(await draft({ title: 'elternabend, 7B' }));
    expect(b.draftId).toBe(a.draftId);
    expect(b.existing).toBe(true);
    expect((await store.eventDrafts.get(a.draftId))!.touchedAt).toBe(
      clock.toISOString(),
    );
  });

  it('similar draft is reported', async () => {
    const a = asDraft(await draft());
    const b = asDraft(
      await draft({
        title: 'Elternabend',
        start: '2026-11-03T19:00:00+01:00',
        end: undefined,
      }),
    );
    expect(b.draftId).not.toBe(a.draftId);
    expect(b.similarEvents).toEqual([
      expect.objectContaining({ kind: 'draft', draftId: a.draftId }),
    ]);
  });

  it('dismissed refuses; force from the agent transport is refused; force elsewhere restores', async () => {
    const a = asDraft(await draft());
    await svc.discardById(a.draftId);
    expect(await draft()).toMatchObject({
      dismissed: true,
      draftId: a.draftId,
    });
    await expect(
      runWithTransport('agent', () => draft({ force: true })),
    ).rejects.toThrow(/force/);
    const r = asDraft(await draft({ force: true }));
    expect(r.draftId).toBe(a.draftId);
    expect(r.revision).toBe(2);
    expect((await store.eventDrafts.get(a.draftId))!.status).toBe('draft');
  });

  it('agent transport gets review mode and no confirm_url', async () => {
    await store.setAccountConfig(acc.id, {
      folderRoots: [{ id: 'family@group', name: 'Family' }],
      outbound: { mode: 'link' },
    });
    const d = asDraft(await runWithTransport('agent', () => draft()));
    expect(d.mode).toBe('review');
    expect(d.confirmUrl).toBeUndefined();
    expect(d.instruction).toMatch(/Outbox/);
  });

  it('chat account mode drafts as link', async () => {
    await store.setAccountConfig(acc.id, {
      folderRoots: [{ id: 'family@group', name: 'Family' }],
      outbound: { mode: 'chat' },
    });
    const d = asDraft(await draft());
    expect(d.mode).toBe('link');
    expect(d.confirmUrl).toBeDefined();
  });

  it('confirm creates once and stores the event', async () => {
    const d = asDraft(await draft());
    expect(await svc.confirmById(d.draftId, 1)).toMatchObject({
      kind: 'created',
    });
    expect(await svc.confirmById(d.draftId, 1)).toEqual({ kind: 'gone' });
    expect(keys).toEqual([`${d.draftId}:1`]);
    expect((await store.eventDrafts.get(d.draftId))!.created).toMatchObject({
      eventId: `ev-${d.draftId}`,
    });
  });

  it('event tokens bind the revision', async () => {
    const d = asDraft(await draft());
    const token = d.confirmUrl!.split('/').pop()!;
    expect(await svc.peekByToken(token)).toMatchObject({ kind: 'ok' });
    await svc.draftEvent({
      draftId: d.draftId,
      revision: 1,
      title: 'Elternabend 7b (Aula)',
      start: '2026-11-03T18:00:00+01:00',
      category: 'kids',
    });
    expect(await svc.peekByToken(token)).toEqual({ kind: 'changed' });
    expect(await svc.confirmByToken(token, 1)).toEqual({ kind: 'changed' });
    expect(keys).toEqual([]);
    // a mail token on the event path is invalid
    expect(
      await svc.peekByToken(
        signConfirmToken(SECRET, d.draftId, Date.now() + 1e6),
      ),
    ).toEqual({
      kind: 'invalid',
    });
  });

  it('writer timeout leaves unknown; retry reuses the frozen key', async () => {
    const d = asDraft(await draft());
    createImpl = async (i) => {
      keys.push(i.idempotencyKey);
      throw new Error('extension calendar createEvent timed out after 60s');
    };
    expect(await svc.confirmById(d.draftId, 1)).toMatchObject({
      kind: 'unknown',
      error: expect.stringContaining('may have been added'),
    });
    expect(await svc.retryById(d.draftId)).toMatchObject({ kind: 'unknown' });
    expect(keys).toEqual([`${d.draftId}:1`, `${d.draftId}:1`]);
  });

  it('definitive 4xx is failed and immutable', async () => {
    const d = asDraft(await draft());
    createImpl = async () => {
      throw new Error('not created: calendar not found');
    };
    expect(await svc.confirmById(d.draftId, 1)).toEqual({
      kind: 'failed',
      error: 'not created: calendar not found',
    });
    await expect(
      svc.draftEvent({
        draftId: d.draftId,
        revision: 1,
        title: 'x',
        start: '2026-11-03T18:00:00+01:00',
        category: 'kids',
      }),
    ).rejects.toThrow(/no longer be changed/);
    const again = asDraft(await draft());
    expect(again.draftId).not.toBe(d.draftId);
  });

  it('pending cap 50 per account', async () => {
    for (let i = 0; i < 50; i += 1)
      await draft({
        title: `Event ${i}`,
        start: `2026-11-1${i % 10}T0${i % 8}:00:00Z`,
        end: undefined,
      });
    await expect(draft({ title: 'one more' })).rejects.toThrow(
      /50 event drafts/,
    );
  });

  it('overlap query finds long events that began earlier', async () => {
    await seed('trip', 'Grandparents visit', {
      allDay: true,
      start: new Date(Date.parse(T0) - 20 * 86_400_000).toISOString(),
      end: new Date(Date.parse(T0) + 2 * 86_400_000).toISOString(),
    });
    const r = await svc.findFreeTime({
      from: T0,
      to: '2026-11-02T17:00:00Z',
      durationMinutes: 60,
    });
    expect(r.slots[0]).toMatchObject({
      tier: 'maybe',
      conflicts: [expect.objectContaining({ title: 'Grandparents visit' })],
    });
  });

  it('find_free_time marks incomplete coverage', async () => {
    const r = await svc.findFreeTime({
      from: T0,
      to: '2026-11-03T00:00:00Z',
      durationMinutes: 30,
    });
    expect(r.complete).toBe(false);
    expect(r.coverage.notIndexedWritable).toEqual([
      { accountEmail: 'me@example.com', calendar: 'Work' },
    ]);
    calendars = [cal()];
    // calendar list is cached for 5 min
    clock = new Date(Date.parse(T0) + 6 * 60_000);
    const r2 = await svc.findFreeTime({
      from: clock.toISOString(),
      to: '2026-11-03T00:00:00Z',
      durationMinutes: 30,
    });
    expect(r2.complete).toBe(true);
    await expect(
      svc.findFreeTime({
        from: T0,
        to: '2027-12-01T00:00:00Z',
        durationMinutes: 30,
      }),
    ).rejects.toThrow(/that far ahead/);
  });

  it('created placeholder blocks until seen, then the indexed event rules', async () => {
    const d = asDraft(
      await draft({
        start: '2026-11-02T10:00:00Z',
        end: '2026-11-02T11:00:00Z',
      }),
    );
    await svc.confirmById(d.draftId, 1);
    const q = {
      from: T0,
      to: '2026-11-02T17:00:00Z',
      durationMinutes: 60,
      limit: 50,
    };
    const blocked = (r: Awaited<ReturnType<typeof svc.findFreeTime>>) =>
      !r.slots.some((s) => s.start === '2026-11-02T10:00:00.000Z');
    expect(blocked(await svc.findFreeTime(q))).toBe(true);
    // Seen in sync, then moved by the user to 14:00 → 10:00 is free, 14:00 is busy.
    await seed(`ev-${d.draftId}`, 'Elternabend 7b', {
      iCalUID: `uid-${d.draftId}`,
      start: '2026-11-02T14:00:00Z',
      end: '2026-11-02T15:00:00Z',
    });
    const r = await svc.findFreeTime(q);
    expect(blocked(r)).toBe(false);
    expect(r.slots.some((s) => s.start === '2026-11-02T14:00:00.000Z')).toBe(
      false,
    );
  });

  it('touchedSince lists created, revised and existing-returned drafts', async () => {
    const since = clock.toISOString();
    const a = asDraft(await draft());
    const b = asDraft(
      await draft({
        title: 'Swimming',
        start: '2026-11-05T15:00:00Z',
        end: undefined,
      }),
    );
    await draft(); // existing → touched again
    const views = await svc.touchedSince(since, 'mcp-local');
    expect(new Set(views.map((v) => v.id))).toEqual(
      new Set([a.draftId, b.draftId]),
    );
    expect(views[0]).toMatchObject({
      calendarName: 'Family',
      accountEmail: 'me@example.com',
    });
  });

  it('classifyWriterError maps connector copy onto the row status', () => {
    expect(classifyWriterError('reconnect the account', 'me@x')).toEqual({
      status: 'failed',
      error: 'reconnect me@x in Settings to allow adding events',
    });
    expect(
      classifyWriterError(
        'reconnect Google Calendar (fam@group.calendar.google.com) in Settings to allow adding events',
        'me@x',
      ).error,
    ).toBe('reconnect me@x in Settings to allow adding events');
    expect(classifyWriterError('rate-limited: slow down', 'me@x').status).toBe(
      'failed',
    );
    expect(classifyWriterError('socket hang up', 'me@x').status).toBe(
      'unknown',
    );
  });

  it('recover turns creating into unknown', async () => {
    const d = asDraft(await draft());
    await store.eventDrafts.beginCreate(d.draftId, 1);
    await svc.recover();
    expect((await store.eventDrafts.get(d.draftId))!.status).toBe('unknown');
  });

  it('parallel captures of one occurrence give one draft', async () => {
    const rs = await Promise.all([
      draft(),
      draft(),
      draft({ title: 'elternabend 7B' }),
    ]);
    const ids = new Set(rs.map((r) => asDraft(r).draftId));
    expect(ids.size).toBe(1);
    expect(await store.eventDrafts.pending()).toHaveLength(1);
  });

  it('a stale link cannot discard a newer revision', async () => {
    const d = asDraft(await draft());
    const token = d.confirmUrl!.split('/').pop()!;
    await svc.draftEvent({
      draftId: d.draftId,
      revision: 1,
      title: 'Elternabend 7b (Aula)',
      start: '2026-11-03T18:00:00+01:00',
      category: 'kids',
    });
    expect(await svc.cancelByToken(token)).toEqual({ kind: 'changed' });
    expect((await store.eventDrafts.get(d.draftId))!.status).toBe('draft');
  });

  it('a calendar listing failure makes coverage incomplete but keeps known busy time', async () => {
    await seed('ev-busy', 'Dentist', {
      start: '2026-11-02T08:00:00Z',
      end: '2026-11-02T09:00:00Z',
    });
    calendars = [cal()];
    const failing = createCalendarWriterRegistry();
    failing.register('google-calendar', {
      listCalendars: async () => {
        throw new Error('reconnect Google Calendar in Settings');
      },
      createEvent: async () => {
        throw new Error('unreachable');
      },
    });
    const svc2 = createCalendarOutService({
      sources: CAL_SOURCES,
      store,
      writers: failing,
      ctx: () => ({
        modeFor: () => 'review',
        baseFor: () => BASE,
        createdViaNow: () => 'mcp-local',
        secret: async () => SECRET,
      }),
      prefs: { get: () => ({}) } as unknown as Prefs,
      vaultScope: async () => undefined,
      now: () => clock,
      logSink: { log: () => {} } as never,
    });
    const r = await svc2.findFreeTime({
      from: T0,
      to: '2026-11-02T17:00:00Z',
      durationMinutes: 60,
      limit: 50,
    });
    expect(r.complete).toBe(false);
    expect(r.coverage.warnings.join(' ')).toMatch(/reconnect/);
    expect(r.slots.some((s) => s.start === '2026-11-02T08:00:00.000Z')).toBe(
      false,
    );
  });

  it('an existing in-progress draft gets no link and says so', async () => {
    const d = asDraft(await draft());
    await store.eventDrafts.beginCreate(d.draftId, 1);
    await store.eventDrafts.failCreate(d.draftId, 'unknown', 'x');
    const again = asDraft(await draft());
    expect(again).toMatchObject({ draftId: d.draftId, existing: true });
    expect(again.confirmUrl).toBeUndefined();
    expect(again.instruction).toMatch(/already confirmed/);
  });

  const svcWith = (writers: ReturnType<typeof createCalendarWriterRegistry>) =>
    createCalendarOutService({
      sources: CAL_SOURCES,
      store,
      writers,
      ctx: () => ({
        modeFor: () => 'review',
        baseFor: () => BASE,
        createdViaNow: () => 'mcp-local',
        secret: async () => SECRET,
      }),
      prefs: { get: () => ({}) } as unknown as Prefs,
      vaultScope: async () => undefined,
      now: () => clock,
      logSink: { log: () => {} } as never,
    });

  it("a mail source's folderRoots are not calendar picks: indexed follows synced events", async () => {
    const ms = await store.createAccount({
      source: 'microsoft-365',
      identifier: 'me@outlook.com',
      config: { folderRoots: [{ id: 'inbox-folder', name: 'Inbox' }] },
    });
    await store.commit({
      account: ms.id,
      documents: [
        {
          externalId: 'ms-ev',
          type: 'calendar.event',
          title: 'Standup',
          markdown: null,
          metadata: meta({
            calendarId: 'AAMk-cal',
            calendarName: 'Calendar',
            eventId: 'ms-ev',
            occurrenceKey: 'ms-ev',
          }) as unknown as Record<string, unknown>,
          createdAt: '2026-11-03T17:00:00.000Z',
        },
      ],
      cursor: 1,
    });
    const writers = createCalendarWriterRegistry();
    writers.register('microsoft-365', {
      listCalendars: async () => [
        cal({ id: 'AAMk-cal', name: 'Calendar' }),
        cal({ id: 'AAMk-birthdays', name: 'Birthdays', primary: false }),
      ],
      createEvent: (i) => createImpl(i),
    });
    const list = await svcWith(writers).listCalendars({});
    const mine = list.filter((c) => c.accountId === ms.id);
    expect(mine.map((c) => [c.calendarId, c.indexed])).toEqual([
      ['AAMk-cal', true],
      ['AAMk-birthdays', false],
    ]);
  });

  it('a stale account without a writer still makes coverage incomplete', async () => {
    clock = new Date(Date.parse(T0) - 3 * 86_400_000);
    const ro = await store.createAccount({
      source: 'ics-feed',
      identifier: 'school@ics',
      config: {},
    });
    await store.commit({ account: ro.id, documents: [], cursor: 0 });
    clock = new Date(T0);
    const writers = createCalendarWriterRegistry();
    writers.register('google-calendar', {
      listCalendars: async () => [cal()],
      createEvent: (i) => createImpl(i),
    });
    const r = await svcWith(writers).findFreeTime({
      from: T0,
      to: '2026-11-03T00:00:00Z',
      durationMinutes: 30,
    });
    expect(r.complete).toBe(false);
    expect(r.coverage.warnings).toContain('school@ics last synced 3 days ago');
  });
});
