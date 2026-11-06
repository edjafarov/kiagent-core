/** @jest-environment node */
/** An old master that wakes up with tracking on may have been replaced while
 *  it was off: it starts fenced and the first isMaster reply opens it (final
 *  review, spec 7.8). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { createOutboxScheduler } from '../../../outbound/scheduler';
import { migrate } from '../../store/schema';
import { openStore } from '../../store/store';
import { gateFrom, readSyncGate } from '../role';
import { createSyncService } from '../service';

const dirs: string[] = [];
const dbs: AppDb[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function boot(tracking: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-fence-'));
  dirs.push(dir);
  const db = await openDb(path.join(dir, 'a.db'));
  dbs.push(db);
  migrate(db._conn!);
  if (tracking) db._conn!.prepare(`UPDATE sync_state SET tracking = 1, joined = 1`).run();
  // What boot.ts does, in this order.
  const gate = await readSyncGate(db);
  const readOnlyAtBoot = gateFrom(gate);
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  } as never);
  const onOpen = jest.fn(async () => undefined);
  const svc = createSyncService({
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    initialReadOnly: readOnlyAtBoot,
    fencedAtBoot: gate.tracking && !readOnlyAtBoot,
    onOpen,
    log: () => undefined,
  });
  return { svc, onOpen, gate };
}

describe('a master that wakes with tracking on', () => {
  it('reads tracking from sync_state', async () => {
    expect((await boot(true)).gate.tracking).toBe(true);
    expect((await boot(false)).gate.tracking).toBe(false);
  });

  it('is fenced until the first isMaster reply, and the scheduler sends nothing meanwhile', async () => {
    const { svc, onOpen } = await boot(true);
    expect(svc.readOnly()).toBe(true);
    const sendScheduled = jest.fn(async () => 'sent' as const);
    const sched = createOutboxScheduler({
      store: { outbox: { listDue: async () => [{ id: 'd1', sendAt: '2000-01-01T00:00:00.000Z' }] } } as never,
      service: { sendScheduled },
      logSink: { log: () => undefined },
      readOnly: () => svc.readOnly(),
    });
    await sched.tick();
    expect(sendScheduled).not.toHaveBeenCalled();
    await svc.open('lease');
    expect(svc.readOnly()).toBe(false);
    await sched.tick();
    expect(sendScheduled).toHaveBeenCalledWith('d1', expect.anything());
    // What the fence held back (accounts, workers) starts once, at the first reply.
    expect(onOpen).toHaveBeenCalledTimes(1);
    await svc.open('lease');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('a master that was never tracking starts open', async () => {
    const { svc } = await boot(false);
    expect(svc.readOnly()).toBe(false);
  });
});
