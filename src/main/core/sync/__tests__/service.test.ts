/** @jest-environment node */
/** Through the real worker: hashing and snapshots must never run on main. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDbInWorker } from '@main/db/worker-client';
import type { AppDb } from '@main/db/app-db';

import { openStore, type CoreStore } from '../../store/store';
import { hashFile } from '../snapshot';
import { createSyncService, type SyncService } from '../service';

const entry = require.resolve('../../../db/worker-entry.ts');
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
let dir: string;
let dbPath: string;
let db: AppDb;
let store: CoreStore;
let sync: SyncService;
let execArgv: string[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-service-'));
  dbPath = path.join(dir, 'kiagent.db');
  const preload = path.join(dir, 'preload.js');
  fs.writeFileSync(
    preload,
    `const M = require('module');
     const t = ${JSON.stringify(path.join(repoRoot, 'node_modules', 'better-sqlite3'))};
     const o = M._resolveFilename;
     M._resolveFilename = function (r, ...a) { return o.call(this, r === 'better-sqlite3' ? t : r, ...a); };`,
  );
  execArgv = [
    '--no-experimental-strip-types',
    '-r', preload,
    '-r', 'ts-node/register/transpile-only',
    '-r', 'tsconfig-paths/register',
  ];
  db = await openDbInWorker(dbPath, entry, { execArgv });
  store = openStore(db, {
    encrypt: (s: string) => s,
    decrypt: (s: string) => s,
    detectLanguages: () => ['eng'],
    profileDir: dir,
  } as never);
  sync = createSyncService({ db, store, dbPath, workerFile: entry, execArgv });
}, 60_000);

afterEach(async () => {
  await sync.close();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const seed = async () => {
  const { id } = await store.createAccount({ source: 's', identifier: 'i' });
  await store.commit({
    account: id,
    documents: [
      { externalId: 'e', type: 'file', title: 't', markdown: 'body', metadata: {}, createdAt: null },
    ],
    cursor: null,
  });
};

it('reports status and turns tracking on and off', async () => {
  let s = await sync.status();
  expect(s).toMatchObject({ role: 'normal', tracking: false, historyId: null, masterDeviceId: null });
  expect(s.schemaVersion).toBeGreaterThanOrEqual(13);
  await sync.enableTracking();
  s = await sync.status();
  expect(s.tracking).toBe(true);
  expect(s.historyId).toEqual(expect.any(String));
  await sync.disableTracking();
  expect((await sync.status()).tracking).toBe(false);
}, 60_000);

it('builds a delta on the sync worker while the writer is free, and head advances', async () => {
  await sync.enableTracking();
  await seed();
  const out = path.join(dir, 'd.stage');
  const r = await sync.buildDelta({ seq: 0, cursor: 0 }, out, 1024 * 1024);
  expect(r.status).toBe('ok');
  expect(fs.existsSync(out)).toBe(true);
  const s = await sync.status();
  expect(s.head.cursor).toBeGreaterThan(0);
  expect(s.after).toEqual({ seq: 0, cursor: 0 });
}, 60_000);

it('applyDelta on a follower moves its position and wakes its feed', async () => {
  await sync.enableTracking();
  await seed();
  const out = path.join(dir, 'd.stage');
  const built = await sync.buildDelta({ seq: 0, cursor: 0 }, out, 1024 * 1024);
  if (built.status !== 'ok') throw new Error('expected a delta');

  const fdir = path.join(dir, 'f');
  fs.mkdirSync(fdir);
  const fPath = path.join(fdir, 'kiagent.db');
  const fDb = await openDbInWorker(fPath, entry, { execArgv });
  const fStore = openStore(fDb, {
    encrypt: (s: string) => s,
    decrypt: (s: string) => s,
    detectLanguages: () => ['eng'],
    profileDir: fdir,
  } as never);
  const fSync = createSyncService({ db: fDb, store: fStore, dbPath: fPath, workerFile: entry, execArgv });
  await fDb.run(`UPDATE sync_state SET role = 'follower'`);
  const feed = fStore.feed(0 as never)[Symbol.asyncIterator]();
  const woken = feed.next();
  const r = await fSync.applyDelta(out);
  expect(r.target).toEqual(built.target);
  expect((await woken).value.length).toBeGreaterThan(0);
  expect((await fSync.status()).after).toEqual(built.target);
  await feed.return?.();
  await fSync.close();
  await fDb.close();
}, 60_000);

it('builds a snapshot and prepares a swap, refusing a wrong hash', async () => {
  await sync.enableTracking();
  await seed();
  const out = path.join(dir, 'snap.db');
  const snap = await sync.buildSnapshot(out);
  expect(snap.sha256).toBe(hashFile(out));
  expect(await sync.prepareSwap(out, 'wrong', 'master-1')).toBe('invalid');
  expect(await sync.prepareSwap(out, snap.sha256, 'master-1')).toBe('ready');
  expect(fs.existsSync(`${dbPath}.swap.json`)).toBe(true);
}, 120_000);
