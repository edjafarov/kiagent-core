/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { createDbUserPrefsStore, createPrefs } from '../../prefs';
import { migrate } from '../../store/schema';
import { openStore } from '../../store/store';
import { leadProc } from './lead-proc';
import { readGateSync } from '../role';
import { createSyncService } from '../service';
import { installSettingsSync } from '../settings-sync';

let db: AppDb | undefined;
let dir = '';
afterEach(async () => {
  jest.useRealTimers();
  await db?.close();
  db = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

it('installSettingsSync wires the same things main did', async () => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-sync-'));
  db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  db._conn!.prepare(`UPDATE sync_state SET role = 'follower'`).run();
  (db as unknown as { proc: unknown }).proc = leadProc(() => db!._conn!);
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  });
  const svc = createSyncService({
    bootGate: readGateSync(db._conn!),
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    log: () => undefined,
  });
  const prefs = createPrefs(path.join(dir, 'prefs'), createDbUserPrefsStore(db, () => !svc.readOnly()));
  await prefs.ready;
  const extensions = {
    reconcileExtensions: jest.fn(async () => undefined),
    failedExtensions: jest.fn(() => [{ id: 'x' }]),
    hasPendingExtensionRecords: jest.fn(() => false),
    offerExtensions: jest.fn(() => ({})),
    unionExtensions: jest.fn(async () => []),
  };
  const syncExtensions = jest.fn(async () => undefined);
  let captured: ((t: string[], m: object) => void) | undefined;
  const sync = {
    ...svc,
    onApplied: (cb: never) => {
      captured = cb;
      return svc.onApplied(cb);
    },
  };
  const settings = installSettingsSync({
    prefs,
    sync: sync as never,
    extensions: extensions as never,
    handlers: { 'prefs:patch': (r) => prefs.patch(r as never) },
    afterPromote: () => undefined,
    syncExtensions,
    onNoMaster: () => undefined,
    log: () => undefined,
    retryEveryMs: 1000,
    setInterval: setInterval,
  });

  // A prefs:patch on a follower with no leader lands in sync_outbound.
  await settings.forwardedLocal.get('prefs:patch')!({ theme: 'dark' });
  expect(db._conn!.prepare(`SELECT kind FROM sync_outbound`).all()).toEqual([{ kind: 'prefs:patch' }]);

  // onApplied(['user_prefs']) refreshes prefs, then reconciles once.
  const refresh = jest.spyOn(prefs, 'refreshUser');
  captured!(['user_prefs'], {});
  await jest.advanceTimersByTimeAsync(0);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(extensions.reconcileExtensions).toHaveBeenCalledTimes(1);

  // The retry timer calls syncExtensions when a connector failed.
  syncExtensions.mockClear();
  jest.advanceTimersByTime(1000);
  expect(syncExtensions).toHaveBeenCalledTimes(1);

  // The core runner applies prefs:set-ext with notify.
  const setExt = jest.spyOn(prefs, 'setExt');
  await settings.coreRunner('prefs:set-ext', { key: 'kiagent.x.y', value: 1 });
  expect(setExt).toHaveBeenCalledWith('kiagent.x.y', 1, { notify: true });
});
