/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../db/app-db';
import { migrate } from '../store/schema';
import { openStore } from '../store/store';
import { gateFrom, readSyncGate } from '../sync/role';
import { createSyncService } from '../sync/service';
import { installCrashRecovery } from '../crash-recovery';

const dirs: string[] = [];
const dbs: AppDb[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

async function boot(fenced: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-recovery-'));
  dirs.push(dir);
  const db = await openDb(path.join(dir, 'a.db'));
  dbs.push(db);
  migrate(db._conn!);
  if (fenced)
    db._conn!.prepare(`UPDATE sync_state SET tracking = 1, joined = 1`).run();
  const gate = await readSyncGate(db);
  const readOnlyAtBoot = gateFrom(gate);
  // Writable while the crashed-process rows are seeded; the guard follows the service afterwards.
  let ro: () => boolean = () => false;
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
    readOnly: () => ro(),
  } as never);

  const account = await store.createAccount({
    source: 'imap',
    identifier: 'me@example.com@imap.example.com',
  });
  const outbox = await store.outbox.create({
    accountId: account.id,
    kind: 'new',
    recipientDisplay: 'bob@example.com',
    to: ['bob@example.com'],
    cc: [],
    subject: 'Hi',
    bodyMarkdown: 'Hello Bob',
    confirmMode: 'review',
    createdVia: 'mcp-local',
    expiresAt: '2099-01-01T00:00:00.000Z',
  } as never);
  await store.outbox.transition(outbox.id, ['draft'], 'sending');
  const cal = await store.createAccount({
    source: 'google-calendar',
    identifier: 'me@example.com',
  });
  const draft = await store.eventDrafts.insert({
    accountId: cal.id,
    payload: {
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
    },
    sourceDocumentId: null,
    fingerprint: 'fp-1',
    confirmMode: 'review',
    createdVia: 'mcp-local',
    createdBy: null,
  } as never);
  await store.eventDrafts.beginCreate(draft.id, 1);

  const hooks: Array<() => void | Promise<void>> = [];
  let resolvePromoted: () => void = () => undefined;
  const promotedP = new Promise<void>((r) => {
    resolvePromoted = r;
  });
  const svc = createSyncService({
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    initialReadOnly: readOnlyAtBoot,
    fencedAtBoot: gate.tracking && !readOnlyAtBoot,
    onPromoted: async () => {
      for (const h of hooks) await h();
      resolvePromoted();
    },
    log: () => undefined,
  });
  ro = () => svc.readOnly();

  const cal$ = jest.fn(() =>
    store.eventDrafts.recoverOrphanedCreating().then(() => undefined),
  );
  const out$ = jest.fn(() => store.outbox.recoverOrphanedSending());
  const logSink = { log: jest.fn() };
  return {
    svc,
    store,
    hooks,
    cal: cal$,
    out: out$,
    logSink,
    outboxId: outbox.id,
    draftId: draft.id,
    promoted: () => promotedP,
    platform: {
      readOnly: () => svc.readOnly(),
      afterPromote: (h: () => void | Promise<void>) => void hooks.push(h),
    },
  };
}

describe('installCrashRecovery', () => {
  it('a fenced boot leaves the rows until the fence lifts, then recovers them once', async () => {
    const b = await boot(true);
    await installCrashRecovery({
      platform: b.platform,
      recoverCalendar: b.cal,
      recoverOutbox: b.out,
      logSink: b.logSink,
    });
    expect(b.cal).not.toHaveBeenCalled();
    expect(b.out).not.toHaveBeenCalled();
    expect((await b.store.outbox.get(b.outboxId))?.status).toBe('sending');
    expect((await b.store.eventDrafts.get(b.draftId))?.status).toBe('creating');
    b.svc.setFenced(false);
    await b.promoted();
    expect(b.cal).toHaveBeenCalledTimes(1);
    expect(b.out).toHaveBeenCalledTimes(1);
    expect((await b.store.outbox.get(b.outboxId))?.status).toBe(
      'delivery_unknown',
    );
    expect((await b.store.eventDrafts.get(b.draftId))?.status).toBe('unknown');
  });

  it('a writable boot runs the sweeps once, from the boot call', async () => {
    const b = await boot(false);
    await installCrashRecovery({
      platform: b.platform,
      recoverCalendar: b.cal,
      recoverOutbox: b.out,
      logSink: b.logSink,
    });
    expect(b.cal).toHaveBeenCalledTimes(1);
    expect(b.out).toHaveBeenCalledTimes(1);
    expect(b.hooks).toHaveLength(1);
    expect((await b.store.outbox.get(b.outboxId))?.status).toBe(
      'delivery_unknown',
    );
  });

  it('a failing calendar sweep is logged and does not stop the outbox sweep', async () => {
    const b = await boot(false);
    const cal = jest.fn(async () => {
      throw new Error('boom');
    });
    await installCrashRecovery({
      platform: b.platform,
      recoverCalendar: cal,
      recoverOutbox: b.out,
      logSink: b.logSink,
    });
    expect(b.out).toHaveBeenCalledTimes(1);
    expect(b.logSink.log).toHaveBeenCalledWith(
      'calendar-out',
      'error',
      'boot-time recover failed',
      { error: 'boom' },
    );
  });
});
