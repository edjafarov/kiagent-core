/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  CreatedEvent,
  EventIntent,
  Prefs,
  WritableCalendar,
} from '@shared/contracts';
import type { InvokeChannel, InvokeHandlers } from '@shared/ipc';

import { openDb } from '../../db/app-db';
import { openStore, type CoreStore } from '../../core/store/store';
import type { OutboundContext, OutboundService } from '../../outbound/service';
import { outboundInvokeHandlers } from '../../outbound/ipc';
import { CALENDAR_LIST_TTL_MS } from '../calendars';
import { calendarOutInvokeHandlers } from '../ipc';
import { wireCalendarOutPush } from '../push';
import {
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

const BASE = 'http://127.0.0.1:7421';
const T0 = '2026-11-02T08:00:00.000Z';

const cal: WritableCalendar = {
  id: 'family@group',
  name: 'Family',
  color: null,
  primary: true,
  canWrite: true,
  shared: false,
  timeZone: 'Europe/Berlin',
};

type Draft = Extract<DraftEventResult, { draftId: string; revision: number }>;
const asDraft = (r: DraftEventResult): Draft => {
  if (!('revision' in r)) throw new Error(`not a draft: ${JSON.stringify(r)}`);
  return r;
};

describe('calendar-out IPC', () => {
  let dir: string;
  let store: CoreStore;
  let svc: CalendarOutService;
  let acc: Account;
  let created: string[];
  let hang: boolean;
  let skewMs: number;
  let refuse: boolean;
  let handlers: Pick<InvokeHandlers, InvokeChannel>;

  const draft = async (title: string, over: Record<string, unknown> = {}) =>
    asDraft(
      await svc.draftEvent({
        title,
        start: '2026-11-03T18:00:00+01:00',
        end: '2026-11-03T19:30:00+01:00',
        ...(over.start ? { end: undefined } : {}),
        category: 'kids',
        ...over,
      } as never),
    );

  beforeEach(async () => {
    created = [];
    hang = false;
    skewMs = 0;
    refuse = false;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-calout-ipc-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
      now: () => T0,
    });
    acc = await store.createAccount({
      source: 'google-calendar',
      identifier: 'me@example.com',
      config: { folderRoots: [{ id: 'family@group', name: 'Family' }] },
    });
    await store.commit({ account: acc.id, documents: [], cursor: 0 });
    const writers = createCalendarWriterRegistry();
    writers.register('google-calendar', {
      listCalendars: () =>
        hang ? new Promise<never>(() => {}) : Promise.resolve([cal]),
      createEvent: async (i: EventIntent): Promise<CreatedEvent> => {
        if (refuse) throw new Error('not created: refused');
        created.push(i.kia.draftId);
        return {
          eventId: `ev-${i.kia.draftId}`,
          iCalUID: null,
          htmlLink: null,
          conferenceUrl: null,
          conferencePending: false,
          note: null,
        };
      },
    });
    const ctx: OutboundContext = {
      modeFor: () => 'review',
      baseFor: (t) => (t === 'remote' ? null : BASE),
      createdViaNow: () => 'mcp-local',
      secret: async () => Buffer.from('s'.repeat(32)),
    };
    svc = createCalendarOutService({
      sources: CAL_SOURCES,
      store,
      writers,
      ctx: () => ctx,
      prefs: { get: () => ({}) } as unknown as Prefs,
      vaultScope: async () => undefined,
      now: () => new Date(Date.parse(T0) + skewMs),
      logSink: { log: () => {} } as never,
      sheetDeadlineMs: 150,
    });
    handlers = {
      ...calendarOutInvokeHandlers({ service: svc, store }),
      ...outboundInvokeHandlers({
        service: {} as OutboundService,
        store,
        openExternal: async () => {},
      }),
    } as never;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('confirm-all adds every item when nobody is invited', async () => {
    const a = await draft('Swimming');
    const b = await draft('Piano', { start: '2026-11-04T16:00:00+01:00' });
    const out = await handlers['calendar-out:confirm-all']({
      items: [
        { id: a.draftId, revision: a.revision },
        { id: b.draftId, revision: b.revision },
      ],
    });
    expect(out).toEqual({ created: 2, failed: 0, changed: 0 });
    expect(created).toHaveLength(2);
  });

  it('confirm-all refuses ids with attendees', async () => {
    const a = await draft('Swimming');
    const b = await draft('Parents evening', {
      start: '2026-11-05T18:00:00+01:00',
      attendees: [{ email: 'teacher@school.de' }],
    });
    await expect(
      handlers['calendar-out:confirm-all']({
        items: [
          { id: a.draftId, revision: a.revision },
          { id: b.draftId, revision: b.revision },
        ],
      }),
    ).rejects.toThrow(/one at a time/);
    // The whole batch is refused: not even the harmless one was added.
    expect(created).toEqual([]);
    expect((await store.eventDrafts.get(a.draftId))?.status).toBe('draft');
  });

  it('confirm-all reports changed for a stale revision', async () => {
    const a = await draft('Swimming');
    const b = await draft('Piano', { start: '2026-11-04T16:00:00+01:00' });
    const out = await handlers['calendar-out:confirm-all']({
      items: [
        { id: a.draftId, revision: a.revision + 1 },
        { id: b.draftId, revision: b.revision },
      ],
    });
    expect(out).toEqual({ created: 1, failed: 0, changed: 1 });
    expect(created).toEqual([b.draftId]);
  });

  it('pending count includes event drafts', async () => {
    expect(await handlers['outbox:pending-count'](undefined)).toEqual({
      pending: 0,
    });
    const a = await draft('Swimming');
    await draft('Piano', { start: '2026-11-04T16:00:00+01:00' });
    expect(await handlers['outbox:pending-count'](undefined)).toEqual({
      pending: 2,
    });
    await handlers['calendar-out:discard']({ id: a.draftId });
    expect(await handlers['outbox:pending-count'](undefined)).toEqual({
      pending: 1,
    });
    expect(await handlers['calendar-out:list'](undefined)).toHaveLength(1);
  });

  it('discard and restore round-trip through the handlers', async () => {
    const a = await draft('Swimming');
    await handlers['calendar-out:discard']({ id: a.draftId });
    expect((await store.eventDrafts.get(a.draftId))?.status).toBe('discarded');
    await handlers['calendar-out:restore']({ id: a.draftId });
    expect((await store.eventDrafts.get(a.draftId))?.status).toBe('draft');
    expect(await handlers['calendar-out:list-calendars'](undefined)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ calendarId: 'family@group' }),
      ]),
    );
  });

  it('push coalesces a burst of draft changes into one broadcast', async () => {
    jest.useFakeTimers();
    try {
      const sent: string[] = [];
      wireCalendarOutPush(store, (channel) => void sent.push(channel));
      await draft('Swimming');
      await draft('Piano', { start: '2026-11-04T16:00:00+01:00' });
      jest.advanceTimersByTime(60);
      expect(sent).toEqual(['push:calendar-out-changed']);
    } finally {
      jest.useRealTimers();
    }
  });

  describe('day view for the review sheet', () => {
    const dayView = (id: string, revision: number) =>
      handlers['calendar-out:day-view']({ id, revision });

    it('answers the current revision with the page markup', async () => {
      const d = await draft('Elternabend 7b');
      const out = await dayView(d.draftId, d.revision);
      expect(out).toMatchObject({ revision: d.revision, busyClash: false });
      expect(out!.html).toContain('id="ev-day"');
      expect(out!.lineHtml).toContain('ev-line');
    });

    it('answers null for another revision or a discarded draft', async () => {
      const d = await draft('Elternabend 7b');
      expect(await dayView(d.draftId, d.revision + 1)).toBeNull();
      await handlers['calendar-out:discard']({ id: d.draftId });
      expect(await dayView(d.draftId, d.revision)).toBeNull();
      expect(await dayView('missing', 1)).toBeNull();
    });

    it('answers a failed draft too: Try again still adds it', async () => {
      const d = await draft('Elternabend 7b');
      refuse = true;
      await handlers['calendar-out:confirm']({
        id: d.draftId,
        revision: d.revision,
      });
      const row = await store.eventDrafts.get(d.draftId);
      expect(row!.status).toBe('failed');
      const out = await dayView(d.draftId, row!.revision);
      expect(out!.html).toContain('id="ev-day"');
    });

    it('answers null within the deadline when the listing hangs', async () => {
      const d = await draft('Elternabend 7b');
      hang = true;
      skewMs = CALENDAR_LIST_TTL_MS + 1; // past the listing cache
      const t0 = Date.now();
      expect(await dayView(d.draftId, d.revision)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(1000);
    });

    const slow = <T>(ms: number, v: () => Promise<T>) =>
      new Promise<T>((r) => setTimeout(r, ms)).then(v);

    it('answers null when the row read stalls', async () => {
      const d = await draft('Elternabend 7b');
      jest
        .spyOn(store.eventDrafts, 'get')
        .mockImplementation(() => new Promise<never>(() => {}));
      const t0 = Date.now();
      expect(await dayView(d.draftId, d.revision)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(400);
    });

    it('one deadline covers the whole call: two 100 ms steps miss 150 ms', async () => {
      const d = await draft('Elternabend 7b');
      const get = store.eventDrafts.get.bind(store.eventDrafts);
      const account = store.account.bind(store);
      jest
        .spyOn(store.eventDrafts, 'get')
        .mockImplementation((id) => slow(100, () => get(id)));
      jest
        .spyOn(store, 'account')
        .mockImplementation((id) => slow(100, () => account(id)));
      expect(await dayView(d.draftId, d.revision)).toBeNull();
    });

    it('a rejection after the deadline is consumed', async () => {
      const d = await draft('Elternabend 7b');
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      jest
        .spyOn(store.eventDrafts, 'get')
        .mockImplementation(() =>
          slow(250, () => Promise.reject(new Error('late'))),
        );
      expect(await dayView(d.draftId, d.revision)).toBeNull();
      await new Promise((r) => setTimeout(r, 300));
      process.off('unhandledRejection', unhandled);
      expect(unhandled).not.toHaveBeenCalled();
    });

    it('answers null for a created draft', async () => {
      const d = await draft('Elternabend 7b');
      await handlers['calendar-out:confirm']({
        id: d.draftId,
        revision: d.revision,
      });
      expect(await dayView(d.draftId, d.revision)).toBeNull();
    });

    it('list rows carry when and no listing', async () => {
      await draft('Elternabend 7b');
      const [row] = await handlers['calendar-out:list'](undefined);
      expect(row.when).toBe('Tue 3 Nov, 18:00–19:30 (Europe/Berlin)');
      expect(row).not.toHaveProperty('listing');
      expect(row).not.toHaveProperty('deadlineMs');
    });
  });
});
