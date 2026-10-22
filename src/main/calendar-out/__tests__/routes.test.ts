/** @jest-environment node */
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import type { Prefs } from '@shared/contracts';

import { openDb } from '../../db/app-db';
import { createPrefs } from '../../core/prefs';
import { openStore, type CoreStore } from '../../core/store/store';
import { createOutboundRoutes } from '../../outbound/routes';
import type { OutboundService } from '../../outbound/service';
import { signConfirmToken } from '../../outbound/tokens';
import * as dayViewHtmlModule from '../day-view-html';
import { daySection } from '../pages';
import { createCalendarOutService, type CalendarOutService } from '../service';
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

const SECRET = Buffer.from('k'.repeat(32));

describe('event review pages under /outbox/event/', () => {
  let dir: string;
  let store: CoreStore;
  let svc: CalendarOutService;
  let srv: http.Server;
  let base: string;
  const created: string[] = [];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-evroutes-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    await store.createAccount({
      source: 'google-calendar',
      identifier: 'me@example.com',
      config: { folderRoots: [{ id: 'fam', name: 'Family' }] },
    });
    const writers = createCalendarWriterRegistry();
    writers.register('google-calendar', {
      listCalendars: async () => [
        {
          id: 'fam',
          name: 'Family',
          color: null,
          primary: true,
          canWrite: true,
          shared: false,
          timeZone: 'Europe/Berlin',
        },
      ],
      createEvent: async (i) => {
        created.push(i.idempotencyKey);
        return {
          eventId: 'e1',
          iCalUID: null,
          htmlLink: 'https://calendar.google.com/e1',
          conferenceUrl: null,
          conferencePending: false,
          note: null,
        };
      },
    });
    svc = createCalendarOutService({
      sources: CAL_SOURCES,
      store,
      writers,
      ctx: () => ({
        modeFor: () => 'review',
        // The page links are minted for the REMOTE origin here: handleRemote
        // serves them, the same way the tunnel does.
        baseFor: () => base,
        createdViaNow: () => 'mcp-local',
        secret: async () => SECRET,
      }),
      prefs: { get: () => ({}) } as unknown as Prefs,
      vaultScope: async () => undefined,
      logSink: { log: () => {} } as never,
    });
    const routes = createOutboundRoutes({} as OutboundService, svc);
    srv = http.createServer((req, res) => {
      void routes.handleRemote(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    srv.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const draft = async (over: Record<string, unknown> = {}) => {
    const r = await svc.draftEvent({
      title: 'Call with Anna (Acme)',
      start: '2026-12-03T10:00:00Z',
      category: 'work',
      ...over,
    } as never);
    if (!('confirmUrl' in r) || !r.confirmUrl) throw new Error('no url');
    return {
      id: r.draftId,
      url: r.confirmUrl,
      token: r.confirmUrl.split('/outbox/event/confirm/')[1],
    };
  };

  it('GET /outbox/event/confirm/<token> renders the card with invite warning when attendees exist', async () => {
    const d = await draft({
      attendees: [{ email: 'anna@acme.com', name: 'Anna' }],
      conference: 'auto',
    });
    const res = await fetch(d.url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(
      'Invites will be sent to: Anna &lt;anna@acme.com&gt;',
    );
    expect(html).toContain('a video link will be added');
    expect(html).toContain('Add and send invites');
    expect(res.headers.get('content-security-policy')).toMatch(
      /script-src 'sha256-/,
    );

    const solo = await draft({
      title: 'Dentist',
      start: '2026-12-04T09:00:00Z',
    });
    const soloHtml = await (await fetch(solo.url)).text();
    expect(soloHtml).toContain('No one will be invited');
    expect(soloHtml).toContain('Add to calendar');
  });

  it('POST confirm with the shown revision creates; with an old revision shows changed', async () => {
    const d = await draft({ title: 'Swimming', start: '2026-12-05T15:00:00Z' });
    await svc.draftEvent({
      draftId: d.id,
      revision: 1,
      title: 'Swimming (pool B)',
      start: '2026-12-05T15:00:00Z',
      category: 'kids',
    });
    const old = await fetch(`${base}/outbox/event/confirm/${d.token}/1`, {
      method: 'POST',
    });
    expect(old.status).toBe(409);
    expect(await old.text()).toMatch(/changed/);
    expect(created).toEqual([]);

    const fresh = (await svc.confirmUrl(d.id))!.split(
      '/outbox/event/confirm/',
    )[1];
    const ok = await fetch(`${base}/outbox/event/confirm/${fresh}/2`, {
      method: 'POST',
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('Added to your calendar');
    expect(created).toEqual([`${d.id}:2`]);
  });

  it('cancel discards', async () => {
    const d = await draft({ title: 'Haircut', start: '2026-12-06T09:00:00Z' });
    const res = await fetch(`${base}/outbox/event/cancel/${d.token}`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect((await store.eventDrafts.get(d.id))!.status).toBe('discarded');
  });

  it('a mail token on an event path is invalid', async () => {
    const d = await draft({ title: 'Piano', start: '2026-12-07T16:00:00Z' });
    const mail = signConfirmToken(SECRET, d.id, Date.now() + 60_000);
    const res = await fetch(`${base}/outbox/event/confirm/${mail}`);
    expect(res.status).toBe(404);
  });
});

describe('prefs', () => {
  it('prefs sanitise calendar defaults to nulls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-calprefs-'));
    fs.writeFileSync(
      path.join(dir, 'prefs.json'),
      JSON.stringify({
        calendar: {
          defaultCalendar: { accountId: 1 },
          workingHours: { start: '9am', end: '18:00', days: [1] },
          timeZone: 'Mars/Olympus',
        },
      }),
    );
    const prefs = createPrefs(dir);
    expect(prefs.get().calendar).toEqual({
      defaultCalendar: null,
      workingHours: null,
      timeZone: null,
    });
    await prefs.patch({
      calendar: {
        defaultCalendar: { accountId: 'a', calendarId: 'c' },
        workingHours: { start: '08:30', end: '17:00', days: [5, 1, 9] },
        timeZone: 'Europe/Berlin',
      },
    });
    expect(prefs.get().calendar).toEqual({
      defaultCalendar: { accountId: 'a', calendarId: 'c' },
      workingHours: { start: '08:30', end: '17:00', days: [1, 5] },
      timeZone: 'Europe/Berlin',
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('review page: bounded listing + similar-event disclosure', () => {
  let dir: string;
  let store: CoreStore;
  let svc: CalendarOutService;
  let srv: http.Server;
  let base: string;
  let hang = false;
  let skewMs = 0;
  let accId: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-evlisting-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const acc = await store.createAccount({
      source: 'google-calendar',
      identifier: 'me@example.com',
      config: { folderRoots: [{ id: 'fam', name: 'Family' }] },
    });
    accId = acc.id;
    const writers = createCalendarWriterRegistry();
    const cal = (id: string) => ({
      id,
      name: id,
      color: null,
      primary: id === 'fam',
      canWrite: true,
      shared: false,
      timeZone: 'Europe/Berlin',
    });
    writers.register('google-calendar', {
      listCalendars: () =>
        hang
          ? new Promise<never>(() => {})
          : Promise.resolve([cal('fam'), cal('other')]),
      createEvent: async () => {
        throw new Error('unused');
      },
    });
    svc = createCalendarOutService({
      sources: CAL_SOURCES,
      store,
      writers,
      now: () => new Date(Date.now() + skewMs),
      pageDeadlineMs: 150,
      ctx: () => ({
        modeFor: () => 'review',
        baseFor: () => base,
        createdViaNow: () => 'mcp-local',
        secret: async () => SECRET,
      }),
      prefs: { get: () => ({}) } as unknown as Prefs,
      vaultScope: async () => undefined,
      logSink: { log: () => {} } as never,
    });
    const routes = createOutboundRoutes({} as OutboundService, svc);
    srv = http.createServer((req, res) => {
      void routes.handleRemote(req, res).then((handled) => {
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    srv.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const seedEvent = async (
    calendarId: string,
    title: string,
    when = {
      start: '2026-12-03T14:00:00.000Z',
      end: '2026-12-03T15:00:00.000Z',
    },
    id = `ev-${calendarId}`,
  ) => {
    const md = {
      calendarId,
      calendarName: calendarId,
      calendarColor: null,
      eventId: id,
      iCalUID: null,
      occurrenceKey: id,
      start: when.start,
      end: when.end,
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
    };
    await store.commit({
      account: accId as never,
      documents: [
        {
          externalId: id,
          type: 'calendar.event',
          title,
          markdown: null,
          metadata: md,
          createdAt: md.start,
        },
      ],
      cursor: 1,
    });
  };

  const draftToken = async (
    calendarId: string,
    title: string,
    start = '2026-12-03T10:00:00Z',
  ) => {
    const r = await svc.draftEvent({
      title,
      start,
      category: 'work',
      calendarId,
    } as never);
    if (!('confirmUrl' in r) || !r.confirmUrl) throw new Error('no url');
    return r.confirmUrl.split('/outbox/event/confirm/')[1];
  };

  it('shows the title of a similar event on an indexed calendar', async () => {
    await seedEvent('fam', 'Dentist Anna');
    const token = await draftToken('fam', 'Dentist Anna');
    const res = await fetch(`${base}/outbox/event/confirm/${token}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      'Similar event already in your calendar: Dentist Anna',
    );
  });

  it('hides the title when the calendar is not indexed', async () => {
    await seedEvent('other', 'Secret Dentist Anna');
    const token = await draftToken('fam', 'Dentist Anna visit');
    const res = await fetch(`${base}/outbox/event/confirm/${token}`);
    const html = await res.text();
    expect(html).toContain('A similar event may already be in your calendar');
    expect(html).not.toContain('Secret Dentist');
  });

  const getPage = async (token: string) => {
    const res = await fetch(`${base}/outbox/event/confirm/${token}`);
    return { res, html: await res.text() };
  };

  it('GET has the day view with the proposed block and a free line', async () => {
    const token = await draftToken(
      'fam',
      'Plain visit',
      '2026-12-08T08:00:00Z',
    );
    const { res, html } = await getPage(token);
    expect(res.status).toBe(200);
    expect(html).toContain('id="ev-day"');
    expect(html).toContain('data-scroll=');
    expect(html).toContain('Free');
    expect(html).toContain('Add to calendar');
  });

  it('a busy clash relabels the button Add anyway', async () => {
    await seedEvent(
      'fam',
      'Clashing meeting',
      { start: '2026-12-03T10:00:00.000Z', end: '2026-12-03T11:00:00.000Z' },
      'ev-clash',
    );
    const token = await draftToken('fam', 'Overlapper');
    const { html } = await getPage(token);
    expect(html).toContain('Overlaps Clashing meeting');
    expect(html).toContain('Add anyway');
    expect(html).not.toContain('>Add to calendar<');
  });

  it('the generic similar note appears at most once', async () => {
    await seedEvent('other', 'Hidden twin one', undefined, 'ev-tw1');
    await seedEvent('other', 'Hidden twin two', undefined, 'ev-tw2');
    const token = await draftToken('fam', 'Hidden twin');
    const { html } = await getPage(token);
    expect(
      html.split('A similar event may already be in your calendar'),
    ).toHaveLength(2);
  });

  describe.each([
    [
      'rejects',
      () => jest.spyOn(svc, 'dayView').mockRejectedValue(new Error('boom')),
    ],
    [
      'hangs',
      () =>
        jest
          .spyOn(svc, 'dayView')
          .mockImplementation(() => new Promise(() => {})),
    ],
    [
      'render throws',
      () =>
        jest.spyOn(dayViewHtmlModule, 'dayViewHtml').mockImplementation(() => {
          throw new Error('render');
        }),
    ],
  ])('day view %s', (_name, arm) => {
    it('still serves the page, without the day view or the line', async () => {
      await seedEvent(
        'fam',
        'Clash again',
        { start: '2026-12-03T10:00:00.000Z', end: '2026-12-03T11:00:00.000Z' },
        'ev-clash2',
      );
      const token = await draftToken('fam', 'Survivor');
      const spy = arm();
      try {
        const { res, html } = await getPage(token);
        expect(res.status).toBe(200);
        expect(html).not.toContain('id="ev-day"');
        expect(html).not.toContain('Overlaps');
        expect(html).not.toContain('Free');
        expect(html).toContain('Add to calendar');
        expect(html).not.toContain('Add anyway');
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('the CSP script hash equals the sha256 of the served script', async () => {
    const token = await draftToken('fam', 'Hash check');
    const { res, html } = await getPage(token);
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
    const hash = createHash('sha256').update(script).digest('base64');
    expect(res.headers.get('content-security-policy')).toContain(
      `script-src 'sha256-${hash}'`,
    );
    expect(script.indexOf("getElementById('ev-day')")).toBeLessThan(
      script.indexOf("getElementById('ob-send')"),
    );
  });

  it('daySection logs once per draft id', async () => {
    const view = { id: 'dup-1', deadlineMs: 0 } as never;
    const log = jest.fn();
    const cal = {
      dayView: async () => {
        throw new Error('x');
      },
    } as never;
    expect(await daySection(cal, view, log)).toBeNull();
    expect(await daySection(cal, view, log)).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
  });

  // Last: a hung listing stays in the service's in-flight cache.
  it('a hanging listing still renders in time, with the generic note', async () => {
    const token = await draftToken('fam', 'Dentist Anna again');
    skewMs = 10 * 60_000; // past the 5-minute calendar-list cache
    hang = true;
    const t0 = Date.now();
    const res = await fetch(`${base}/outbox/event/confirm/${token}`);
    const html = await res.text();
    hang = false;
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(html).toContain('A similar event may already be in your calendar');
    expect(html).not.toContain('already in your calendar: Dentist');
  });
});
