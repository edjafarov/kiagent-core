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
      listCalendars: async () => [cal],
      createEvent: async (i: EventIntent): Promise<CreatedEvent> => {
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
      now: () => new Date(T0),
      logSink: { log: () => {} } as never,
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
});
