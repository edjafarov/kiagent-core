import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';
import type { EventDraftInsert, EventPayload } from '../event-drafts';

describe('event_drafts store (schema v12)', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let clock = '2026-10-21T10:00:00.000Z';

  const payload = (over: Partial<EventPayload> = {}): EventPayload => ({
    calendarId: 'primary@cal',
    title: 'Elternabend 7b',
    start: '2026-11-03T18:00:00+01:00',
    end: '2026-11-03T19:30:00+01:00',
    allDay: false,
    timeZone: 'Europe/Berlin',
    location: null,
    description: null,
    attendees: [],
    conference: 'none',
    category: 'kids',
    ...over,
  });
  const insert = (over: Partial<EventDraftInsert> = {}) =>
    store.eventDrafts.insert({
      accountId,
      payload: payload(),
      sourceDocumentId: null,
      fingerprint: 'fp-1',
      confirmMode: 'review',
      createdVia: 'mcp-local',
      createdBy: null,
      ...over,
    });

  beforeEach(async () => {
    clock = '2026-10-21T10:00:00.000Z';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-evdrafts-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
      now: () => clock,
    });
    accountId = (
      await store.createAccount({
        source: 'google-calendar',
        identifier: 'me@example.com',
      })
    ).id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('insert then get round-trips the payload', async () => {
    const row = await insert({ sourceDocumentId: 'doc-1' });
    const back = await store.eventDrafts.get(row.id);
    expect(back).toMatchObject({
      revision: 1,
      status: 'draft',
      idempotencyKey: null,
      sourceDocumentId: 'doc-1',
      payload: payload(),
      touchedVia: 'mcp-local',
      expiresAt: '2026-10-28T10:00:00.000Z',
    });
  });

  it('beginCreate is a CAS on status and revision and freezes the key', async () => {
    const row = await insert();
    expect(await store.eventDrafts.beginCreate(row.id, 2)).toBeNull();
    const started = await store.eventDrafts.beginCreate(row.id, 1);
    expect(started).toMatchObject({
      status: 'creating',
      idempotencyKey: `${row.id}:1`,
      confirmedAt: clock,
    });
    expect(await store.eventDrafts.beginCreate(row.id, 1)).toBeNull();
  });

  it('revise only from draft bumps the revision', async () => {
    const row = await insert();
    const r2 = await store.eventDrafts.revise(
      row.id,
      1,
      payload({ title: 'Elternabend 7b (Aula)' }),
      'fp-2',
      'mcp-agent',
    );
    expect(r2).toMatchObject({
      revision: 2,
      fingerprint: 'fp-2',
      touchedVia: 'mcp-agent',
    });
    expect(
      await store.eventDrafts.revise(row.id, 1, payload(), 'fp-1', 'x'),
    ).toBeNull();
    await store.eventDrafts.beginCreate(row.id, 2);
    expect(
      await store.eventDrafts.revise(row.id, 2, payload(), 'fp-1', 'x'),
    ).toBeNull();
    await store.eventDrafts.failCreate(row.id, 'failed', 'not created: x');
    expect(
      await store.eventDrafts.revise(row.id, 2, payload(), 'fp-1', 'x'),
    ).toBeNull();
  });

  it('retry reuses the frozen key', async () => {
    const row = await insert();
    await store.eventDrafts.beginCreate(row.id, 1);
    await store.eventDrafts.failCreate(row.id, 'unknown', 'timed out');
    const again = await store.eventDrafts.beginRetry(row.id);
    expect(again).toMatchObject({
      status: 'creating',
      revision: 1,
      idempotencyKey: `${row.id}:1`,
    });
    await store.eventDrafts.finishCreate(row.id, {
      eventId: 'ev1',
      iCalUID: 'ical1',
      htmlLink: null,
      conferenceUrl: null,
      conferencePending: false,
      note: null,
    });
    expect(await store.eventDrafts.get(row.id)).toMatchObject({
      status: 'created',
      created: { eventId: 'ev1' },
    });
    expect(await store.eventDrafts.beginRetry(row.id)).toBeNull();
  });

  it('restore without a key returns a fresh draft; with a key returns unknown', async () => {
    const plain = await insert({ fingerprint: 'a' });
    await store.eventDrafts.discard(plain.id);
    clock = '2026-10-22T10:00:00.000Z';
    expect(await store.eventDrafts.restore(plain.id)).toMatchObject({
      status: 'draft',
      revision: 2,
      idempotencyKey: null,
      expiresAt: '2026-10-29T10:00:00.000Z',
    });

    const keyed = await insert({ fingerprint: 'b' });
    await store.eventDrafts.beginCreate(keyed.id, 1);
    await store.eventDrafts.failCreate(keyed.id, 'unknown', 'timed out');
    await store.eventDrafts.discard(keyed.id);
    expect(await store.eventDrafts.restore(keyed.id)).toMatchObject({
      status: 'unknown',
      revision: 1,
      idempotencyKey: `${keyed.id}:1`,
    });
  });

  it('expireOverdue never expires a keyed row', async () => {
    const plain = await insert({ fingerprint: 'a' });
    const keyed = await insert({ fingerprint: 'b' });
    await store.eventDrafts.beginCreate(keyed.id, 1);
    await store.eventDrafts.failCreate(keyed.id, 'unknown', 'x');
    clock = '2026-11-30T10:00:00.000Z';
    expect(await store.eventDrafts.expireOverdue()).toBe(1);
    expect((await store.eventDrafts.get(plain.id))?.status).toBe('expired');
    expect((await store.eventDrafts.get(keyed.id))?.status).toBe('unknown');
  });

  it('startup turns creating into unknown', async () => {
    const row = await insert();
    await store.eventDrafts.beginCreate(row.id, 1);
    expect(await store.eventDrafts.recoverOrphanedCreating()).toBe(1);
    expect(await store.eventDrafts.get(row.id)).toMatchObject({
      status: 'unknown',
      error: expect.stringContaining('may have been added'),
    });
  });

  it('touchedSince returns rows touched by the given transport after the instant', async () => {
    const a = await insert({ fingerprint: 'a', createdVia: 'mcp-agent' });
    await insert({ fingerprint: 'b', createdVia: 'mcp-local' });
    clock = '2026-10-21T11:00:00.000Z';
    const c = await insert({ fingerprint: 'c', createdVia: 'mcp-local' });
    await store.eventDrafts.touch(c.id, 'mcp-agent');
    expect(
      (
        await store.eventDrafts.touchedSince(
          '2026-10-21T10:30:00.000Z',
          'mcp-agent',
        )
      ).map((r) => r.id),
    ).toEqual([c.id]);
    expect(
      (
        await store.eventDrafts.touchedSince(
          '2026-10-21T09:00:00.000Z',
          'mcp-agent',
        )
      ).map((r) => r.id),
    ).toEqual([a.id, c.id]);
  });

  it('inWindow uses real overlap, timed and all-day', async () => {
    const timed = await insert({ fingerprint: 'a' }); // 17:00–18:30Z
    const allDay = await insert({
      fingerprint: 'b',
      payload: payload({
        allDay: true,
        start: '2026-10-20',
        end: '2026-11-05',
        title: 'Herbstferien',
      }),
    });
    const ids = async (from: string, to: string) =>
      (await store.eventDrafts.inWindow(from, to)).map((r) => r.id).sort();
    expect(
      await ids('2026-11-03T17:30:00.000Z', '2026-11-03T17:45:00.000Z'),
    ).toEqual([timed.id, allDay.id].sort());
    expect(
      await ids('2026-11-03T18:30:00.000Z', '2026-11-03T19:00:00.000Z'),
    ).toEqual([allDay.id]);
    expect(
      await ids('2026-11-06T00:00:00.000Z', '2026-11-07T00:00:00.000Z'),
    ).toEqual([]);
  });

  it('pending lists draft, failed and unknown; countPending counts drafts', async () => {
    const a = await insert({ fingerprint: 'a' });
    const b = await insert({ fingerprint: 'b' });
    await store.eventDrafts.beginCreate(b.id, 1);
    await store.eventDrafts.failCreate(b.id, 'failed', 'not created: x');
    const c = await insert({ fingerprint: 'c' });
    await store.eventDrafts.discard(c.id);
    expect((await store.eventDrafts.pending()).map((r) => r.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(await store.eventDrafts.countPending(accountId)).toBe(1);
  });

  it('removeAccount cascades and emits change', async () => {
    await insert();
    const seen = jest.fn();
    store.eventDrafts.onChange(seen);
    await store.commit({ removeAccount: accountId } as never);
    expect(seen).toHaveBeenCalled();
    expect(await store.eventDrafts.pending()).toEqual([]);
  });
});
