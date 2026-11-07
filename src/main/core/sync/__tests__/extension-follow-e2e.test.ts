/** @jest-environment node */
/** The extension set follows the user end to end on the shipped chain: the
 *  leader records a change into `user_prefs`, a real delta carries it, the
 *  follower's `installSettingsSync` hears it and runs the REAL
 *  `createExtensionSync(...).runFromStore()` over pure fake ops. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { openDb, type AppDb } from '../../../db/app-db';
import { createExtensionSync, type LocalExtension } from '../../../platform/extension-set';
import { fakeOps } from '../../../platform/__tests__/helpers/extension-fakes';
import { createDbUserPrefsStore, createPrefs, type CorePrefs } from '../../prefs';
import { migrate } from '../../store/schema';
import { openStore } from '../../store/store';
import { buildDelta } from '../delta';
import { installSettingsSync } from '../settings-sync';
import { readGateSync } from '../role';
import { createSyncService, type SyncService } from '../service';
import { enableTracking } from '../tracking';

interface Dev {
  db: AppDb;
  /** The real service over this device's store: its `applyDelta` is the link
   *  from an applied delta to the `onApplied` listeners. */
  svc: SyncService;
  reader: Database.Database;
  conn: () => Database.Database;
  prefs: CorePrefs;
}
let dir = '';
let devs: Dev[] = [];

async function open(name: string, canWrite: () => boolean): Promise<Dev> {
  const file = path.join(dir, `${name}.db`);
  const db = await openDb(file);
  migrate(db._conn!);
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  });
  const svc = createSyncService({
    bootGate: readGateSync(db._conn!),
    db,
    store,
    dbPath: file,
    workerFile: '',
    log: () => undefined,
  });
  const prefs = createPrefs(path.join(dir, `${name}-prefs`), createDbUserPrefsStore(db, canWrite));
  await prefs.ready;
  const d: Dev = {
    db,
    svc,
    reader: new Database(file, { readonly: true }),
    conn: () => db._conn!,
    prefs,
  };
  devs.push(d);
  return d;
}

const extStore = (d: Dev, canWrite: () => boolean) => ({
  get: () => d.prefs.getCore('core.extensions') as never,
  canWrite,
  update: (fn: (cur: never) => unknown) => d.prefs.updateCore('core.extensions', (cur) => fn(cur as never) as never),
});

afterEach(async () => {
  for (const d of devs.splice(0)) {
    d.reader.close();
    await d.db.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

it("leader disables X → the follower's chain disables X; leader records an install with a ref → the follower's installFromRef is called with it", async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-follow-'));
  const stage = path.join(dir, 'stage');
  const leader = await open('leader', () => true);
  const follower = await open('follower', () => false);
  enableTracking(leader.conn());
  follower.conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();

  const X: LocalExtension = { id: 'conn.x', origin: 'marketplace', enabled: true, ref: 'github:kia-plugins/x@1' };
  const leaderOps = fakeOps([X], { failAll: true });
  const followerOps = fakeOps([X], { failAll: true });
  const leaderSet = createExtensionSync({ store: extStore(leader, () => true), ops: leaderOps, log: () => undefined });

  // The follower: the shipped wiring, with the real reconcile over fake ops.
  const followerSet = createExtensionSync({
    store: extStore(follower, () => false),
    ops: followerOps,
    log: () => undefined,
  });
  installSettingsSync({
    prefs: follower.prefs,
    sync: follower.svc,
    extensions: {
      reconcileExtensions: async () => void (await followerSet.runFromStore()),
      failedExtensions: () => [],
      hasPendingExtensionRecords: () => false,
      offerExtensions: () => ({}),
      unionExtensions: async () => [],
    } as never,
    handlers: {},
    afterPromote: () => undefined,
    syncExtensions: async () => undefined,
    onNoMaster: () => undefined,
    log: () => undefined,
    retryEveryMs: 1_000_000,
    nowMs: Date.now,
    setInterval: (() => ({ unref: () => undefined })) as never,
  });

  /** One pull as the follower does it: the real service applies the delta and
   *  tells its `onApplied` listeners, which `installSettingsSync` registered. */
  const pull = async (): Promise<void> => {
    const s = follower
      .conn()
      .prepare(`SELECT epoch, after_seq AS seq, after_cursor AS cursor FROM sync_state`)
      .get() as { epoch: number; seq: number; cursor: number };
    const r = buildDelta(leader.reader, { seq: s.seq, cursor: s.cursor }, s.epoch, stage, 250 * 1024 * 1024);
    if (r.status !== 'ok') throw new Error(r.status);
    await follower.svc.applyDelta(stage);
  };

  // The leader disables X and records it.
  await leaderSet.act(
    () => leaderOps.setEnabled('conn.x', false),
    () => ({ kind: 'enabled', id: 'conn.x', enabled: false }),
  );
  await pull();
  await until(() => followerOps.calls.includes('enable:conn.x:false'));
  expect(followerOps.calls).toEqual(['enable:conn.x:false']);

  // The leader records an install of Y with a ref.
  await leaderSet.act(
    async () => ({ ok: true as const }),
    () => ({ kind: 'installed', id: 'conn.y', ref: 'github:kia-plugins/y@2' }),
  );
  await pull();
  await until(() => followerOps.calls.includes('install:github:kia-plugins/y@2:true'));
});
