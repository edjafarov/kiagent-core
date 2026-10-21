import { renderEmailBody } from '../email-body';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, ConfirmMode, Prefs, Sender } from '@shared/contracts';

import { openDb } from '../../db/app-db';
import { openStore, type CoreStore } from '../../core/store/store';
import {
  runWithClient,
  runWithTransport,
} from '../../core/mcp/transport-context';
import {
  createOutboundService,
  fitsRate,
  spreadTimes,
  type OutboundService,
} from '../service';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const MIN = 60_000;

describe('spreadTimes', () => {
  it('gives distinct whole minutes inside the window', () => {
    for (const [n, minutes] of [
      [1, 5],
      [4, 120],
      [7, 7],
      [50, 50],
      [3, 1440],
    ]) {
      const t = spreadTimes(n, 0, minutes);
      expect(new Set(t).size).toBe(n);
      for (const x of t) {
        expect(x % MIN).toBe(0);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(minutes * MIN);
      }
    }
  });

  it('refuses more drafts than minutes', () => {
    expect(() => spreadTimes(10, 0, 5)).toThrow(/more drafts than minutes/);
  });
});

describe('fitsRate', () => {
  it('counts every 60-minute window that holds the new send', () => {
    const at = (m: number) => m * MIN;
    expect(fitsRate([at(0), at(10)], at(20), 3)).toBe(true);
    expect(fitsRate([at(0), at(10), at(20)], at(30), 3)).toBe(false);
    // The window 10..70 holds 10, 50, 69 and the new one at 65.
    expect(fitsRate([at(10), at(50), at(69)], at(65), 3)).toBe(false);
    expect(fitsRate([at(0), at(10), at(20)], at(61), 3)).toBe(true);
  });
});

describe('outbound service — schedule_drafts', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let service: OutboundService;
  let sendMock: jest.Mock;
  let now: number;
  let mode: ConfirmMode;

  const make = () => {
    const prefs = {
      get: () => ({ outbound: { defaultMode: mode } }),
      patch: async () => {},
      onChange: () => () => {},
    } as unknown as Prefs;
    service = createOutboundService({
      store,
      prefs,
      senders: new Map<string, Sender>([['gmail', { send: sendMock }]]),
      logSink: { log: () => {} },
      nowMs: () => now,
    });
    service.setBaseUrl('http://127.0.0.1:7421');
  };

  const draft = (to = 'bob@example.com') =>
    service.draftMessage({ accountId, to: [to], subject: 'Hi', body: 'Hello' });
  const row = (id: string) => store.outbox.get(id);
  const at = (m: number) => new Date(now + m * MIN).toISOString();

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-schedule-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'gmail',
      identifier: 'me@gmail.com',
      config: { outbound: { sendsPerHour: 3 } },
    });
    accountId = account.id;
    sendMock = jest.fn(async () => ({ externalMessageId: '<x@y>' }));
    now = Date.now();
    mode = 'chat';
    make();
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('chat mode schedules each draft at its time', async () => {
    const a = await draft('a@example.com');
    const b = await draft('b@example.com');
    const out = await service.scheduleDrafts({
      drafts: [
        { draftId: a.draft_id, revision: 1, sendAt: at(10) },
        { draftId: b.draft_id, revision: 1, sendAt: at(25) },
      ],
    });
    expect(out.results.map((r) => r.status)).toEqual([
      'scheduled',
      'scheduled',
    ]);
    expect((await row(a.draft_id))?.sendAt).toBe(at(10));
    expect((await row(b.draft_id))?.sendAt).toBe(at(25));
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('review mode only suggests, with the review link', async () => {
    mode = 'review';
    const a = await draft();
    const out = await service.scheduleDrafts({
      drafts: [{ draftId: a.draft_id, revision: 1, sendAt: at(40) }],
    });
    expect(out.results[0]).toMatchObject({
      status: 'suggested',
      send_at: at(40),
      confirm_url: expect.stringContaining('/outbox/confirm/'),
    });
    const got = await row(a.draft_id);
    expect(got?.sendAt).toBeNull();
    expect(got?.suggestedSendAt).toBe(at(40));
    expect(out.instruction).toMatch(/nothing is sent until the user confirms/);
  });

  it('link mode suggests too, with a link that lasts the review TTL', async () => {
    mode = 'link';
    const a = await draft();
    const out = await service.scheduleDrafts({
      drafts: [{ draftId: a.draft_id, revision: 1, sendAt: at(40) }],
    });
    expect(out.results[0].status).toBe('suggested');
    // A link-mode link dies in 5 min; this one still opens at 20.
    now += 20 * MIN;
    const peek = await service.peekByToken(
      out.results[0].confirm_url!.split('/').pop()!,
    );
    expect(peek.kind).not.toBe('invalid');
  });

  it("Kia's own assistant only suggests, and never gets a link", async () => {
    const a = await draft();
    const out = await runWithTransport('agent', () =>
      service.scheduleDrafts({
        drafts: [{ draftId: a.draft_id, revision: 1, sendAt: at(40) }],
      }),
    );
    expect(out.results[0].status).toBe('suggested');
    expect(out.results[0].confirm_url).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('/outbox/confirm/');
  });

  it('a chat draft whose account left chat mode only suggests', async () => {
    const a = await draft();
    mode = 'review';
    const out = await service.scheduleDrafts({
      drafts: [{ draftId: a.draft_id, revision: 1, sendAt: at(40) }],
    });
    expect(out.results[0].status).toBe('suggested');
    expect((await row(a.draft_id))?.sendAt).toBeNull();
  });

  it('spread: Kia picks distinct times inside the window', async () => {
    const ids = [];
    for (const to of ['a', 'b', 'c', 'd'])
      ids.push((await draft(`${to}@example.com`)).draft_id);
    const out = await service.scheduleDrafts({
      drafts: ids.map((draftId) => ({ draftId, revision: 1 })),
      spread: { start: at(10), minutes: 120 },
    });
    const times = out.results.map((r) => Date.parse(r.send_at!));
    expect(new Set(times).size).toBe(4);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(now + 10 * MIN);
      expect(t).toBeLessThan(now + 130 * MIN);
    }
  });

  it('spread starts 5 min out in chat mode and 30 min out otherwise', async () => {
    const a = await draft();
    const chat = await service.scheduleDrafts({
      drafts: [{ draftId: a.draft_id, revision: 1 }],
      spread: { minutes: 5 },
    });
    expect(Date.parse(chat.results[0].send_at!)).toBeGreaterThanOrEqual(
      now + 5 * MIN,
    );
    mode = 'review';
    const b = await draft();
    const review = await service.scheduleDrafts({
      drafts: [{ draftId: b.draft_id, revision: 1 }],
      spread: { minutes: 5 },
    });
    expect(Date.parse(review.results[0].send_at!)).toBeGreaterThanOrEqual(
      now + 30 * MIN,
    );
  });

  it('input errors refuse the whole call before any write', async () => {
    const a = await draft();
    const b = await draft('b@example.com');
    await expect(
      service.scheduleDrafts({
        drafts: [
          { draftId: a.draft_id, revision: 1, sendAt: at(10) },
          { draftId: b.draft_id, revision: 1 },
        ],
      }),
    ).rejects.toThrow(/every draft a send_at, or give spread/);
    await expect(
      service.scheduleDrafts({
        drafts: [
          { draftId: a.draft_id, revision: 1 },
          { draftId: a.draft_id, revision: 1 },
        ],
        spread: { minutes: 30 },
      }),
    ).rejects.toThrow(/listed twice/);
    const many = [];
    for (let i = 0; i < 6; i += 1)
      many.push((await draft(`p${i}@x.com`)).draft_id);
    await expect(
      service.scheduleDrafts({
        drafts: many.map((draftId) => ({ draftId, revision: 1 })),
        spread: { minutes: 5 },
      }),
    ).rejects.toThrow(/at least 6 minutes/);
    expect((await row(a.draft_id))?.sendAt).toBeNull();
  });

  it('a stale revision is refused per draft with the current one', async () => {
    const a = await draft();
    const b = await draft('b@example.com');
    const out = await service.scheduleDrafts({
      drafts: [
        { draftId: a.draft_id, revision: 2, sendAt: at(10) },
        { draftId: b.draft_id, revision: 1, sendAt: at(20) },
      ],
    });
    expect(out.results[0]).toMatchObject({ status: 'error', revision: 1 });
    expect(out.results[1].status).toBe('scheduled');
  });

  it('cancel: chat may clear its schedule; the user’s own schedule stays', async () => {
    const a = await draft();
    await service.scheduleDrafts({
      drafts: [{ draftId: a.draft_id, revision: 1, sendAt: at(10) }],
    });
    const out = await runWithClient('Claude', () =>
      service.scheduleDrafts({
        drafts: [{ draftId: a.draft_id, revision: 1, sendAt: null }],
      }),
    );
    expect(out.results[0].status).toBe('unscheduled');
    const got = await row(a.draft_id);
    expect(got?.sendAt).toBeNull();
    expect(got?.error).toBe('Schedule cancelled by Claude');

    mode = 'review';
    const b = await draft('b@example.com');
    await service.scheduleById(b.draft_id, 1, at(15));
    await service.scheduleDrafts({
      drafts: [{ draftId: b.draft_id, revision: 1, sendAt: at(40) }],
    });
    const kept = await service.scheduleDrafts({
      drafts: [{ draftId: b.draft_id, revision: 1, sendAt: null }],
    });
    expect(kept.results[0].status).toBe('unchanged');
    expect((await row(b.draft_id))?.sendAt).toBe(at(15));
  });

  it('a schedule replaces a suggestion', async () => {
    mode = 'review';
    const a = await draft();
    await service.scheduleDrafts({
      drafts: [{ draftId: a.draft_id, revision: 1, sendAt: at(40) }],
    });
    await service.scheduleById(a.draft_id, 1, at(50));
    const got = await row(a.draft_id);
    expect(got?.sendAt).toBe(at(50));
    expect(got?.suggestedSendAt).toBeNull();
  });

  it('the rate rule counts scheduled sends, and send_draft obeys it too', async () => {
    const ids = [];
    for (const to of ['a', 'b', 'c', 'd', 'e'])
      ids.push((await draft(`${to}@example.com`)).draft_id);
    const out = await service.scheduleDrafts({
      drafts: ids.slice(0, 4).map((draftId, i) => ({
        draftId,
        revision: 1,
        sendAt: at(10 + i),
      })),
    });
    expect(out.results.map((r) => r.status)).toEqual([
      'scheduled',
      'scheduled',
      'scheduled',
      'error',
    ]);
    expect(out.results[3].error).toMatch(/rate limit/);
    // Three go out within the hour from now: an immediate send would be a 4th.
    await expect(
      service.sendDraft({ draftId: ids[4], revision: 1 }),
    ).rejects.toThrow(/rate limit/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('two batches at once cannot both pass the rate rule', async () => {
    const ids = [];
    for (const to of ['a', 'b', 'c', 'd'])
      ids.push((await draft(`${to}@example.com`)).draft_id);
    const [x, y] = await Promise.all([
      service.scheduleDrafts({
        drafts: ids.slice(0, 2).map((draftId, i) => ({
          draftId,
          revision: 1,
          sendAt: at(10 + i),
        })),
      }),
      service.scheduleDrafts({
        drafts: ids.slice(2).map((draftId, i) => ({
          draftId,
          revision: 1,
          sendAt: at(12 + i),
        })),
      }),
    ]);
    const scheduled = [...x.results, ...y.results].filter(
      (r) => r.status === 'scheduled',
    );
    expect(scheduled).toHaveLength(3);
  });

  it('list_outbox shows a suggestion', async () => {
    mode = 'review';
    const a = await draft();
    await service.scheduleDrafts({
      drafts: [{ draftId: a.draft_id, revision: 1, sendAt: at(40) }],
    });
    const [item] = await service.listOutbox({});
    expect(item.suggested_for).toBe(at(40));
    expect(item.scheduled_for).toBeUndefined();
  });

  it('list_outbox gives the rendered body only when asked (the phone)', async () => {
    await draft();
    const [plain] = await service.listOutbox({});
    expect(plain.draft?.body_html).toBeUndefined();
    const [item] = await service.listOutbox({ html: true });
    expect(item.draft?.body_html).toBe(renderEmailBody('Hello').html);
  });
});
