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
import { createExtensionSync, type ExtensionOps, type LocalExtension } from '../../../platform/extension-set';
import { createDbUserPrefsStore, createPrefs, type CorePrefs } from '../../prefs';
import { migrate } from '../../store/schema';
import { openStore } from '../../store/store';
import { createWriteTx, type WriteTx } from '../../store/write-tx';
import { buildDelta } from '../delta';
import { installSettingsSync } from '../settings-sync';
import { enableTracking } from '../tracking';

function fakeOps(initial: LocalExtension[]) {
  const local = new Map(initial.map((e) => [e.id, { ...e }]));
  const calls: string[] = [];
  const ops: ExtensionOps & { calls: string[] } = {
    calls,
    list: () => [...local.values()].map((e) => ({ ...e })),
    async setEnabled(id, enabled) {
      calls.push(`enable:${id}:${enabled}`);
      const e = local.get(id);
      if (!e) return { ok: false, error: 'none' };
      e.enabled = enabled;
      return { ok: true };
    },
    async installFromRef(ref, opts) {
      calls.push(`install:${ref}:${opts.grantConsent}`);
      return { ok: false, error: 'offline' };
    },
    async uninstall(id) {
      calls.push(`uninstall:${id}`);
      local.delete(id);
      return { ok: true };
    },
  };
  return ops;
}

interface Dev {
  db: AppDb;
  tx: WriteTx;
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
  openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  });
  const prefs = createPrefs(path.join(dir, `${name}-prefs`), createDbUserPrefsStore(db, canWrite));
  await prefs.ready;
  const d: Dev = {
    db,
    tx: createWriteTx(db._conn!, { detectLanguages: () => ['eng'], now: () => new Date().toISOString() }),
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
  const leaderOps = fakeOps([X]);
  const followerOps = fakeOps([X]);
  const leaderSet = createExtensionSync({ store: extStore(leader, () => true), ops: leaderOps, log: () => undefined });

  // The follower: the shipped wiring, with the real reconcile over fake ops.
  const followerSet = createExtensionSync({
    store: extStore(follower, () => false),
    ops: followerOps,
    log: () => undefined,
  });
  let applied: ((t: string[], m: { prefKeys: string[]; pullStartedAt?: number }) => void) | undefined;
  installSettingsSync({
    prefs: follower.prefs,
    sync: {
      forward: async () => ({ ok: true, value: undefined }),
      readOnly: () => true,
      enqueue: async () => 1,
      onQueueChange: () => undefined,
      discardQueued: async () => undefined,
      onApplied: (cb: never) => void (applied = cb),
      setSettingsOffer: () => undefined,
      queuedSettings: async () => [],
    } as never,
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

  /** One pull as the follower does it, then the service's onApplied. */
  const pull = (): void => {
    const s = follower
      .conn()
      .prepare(`SELECT epoch, after_seq AS seq, after_cursor AS cursor FROM sync_state`)
      .get() as { epoch: number; seq: number; cursor: number };
    const r = buildDelta(leader.reader, { seq: s.seq, cursor: s.cursor }, s.epoch, stage, 250 * 1024 * 1024);
    if (r.status !== 'ok') throw new Error(r.status);
    const out = follower.tx.applyDelta(stage);
    applied!(out.tables, { prefKeys: out.prefKeys });
  };

  // The leader disables X and records it.
  await leaderSet.act(
    () => leaderOps.setEnabled('conn.x', false),
    () => ({ kind: 'enabled', id: 'conn.x', enabled: false }),
  );
  pull();
  await until(() => followerOps.calls.includes('enable:conn.x:false'));
  expect(followerOps.calls).toEqual(['enable:conn.x:false']);

  // The leader records an install of Y with a ref.
  await leaderSet.act(
    async () => ({ ok: true as const }),
    () => ({ kind: 'installed', id: 'conn.y', ref: 'github:kia-plugins/y@2' }),
  );
  pull();
  await until(() => followerOps.calls.includes('install:github:kia-plugins/y@2:true'));
});
