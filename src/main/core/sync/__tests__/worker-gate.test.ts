/** @jest-environment node */
/** Step 2: the read-only gate in the real worker. Plugin connections and
 *  attention transactions live there, outside the store's writer guard, and
 *  must refuse on a follower, per call, with no restart. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { openDbInWorker } from '@main/db/worker-client';
import type { AppDb } from '@main/db/app-db';

import { readGateSync } from '../role';
import { createSyncService, type SyncService } from '../service';
import { openStore, type CoreStore } from '../../store/store';

const entry = require.resolve('../../../db/worker-entry.ts');
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const PLUGIN = 'gate.plugin';
const owner = {
  kind: 'plugin' as const,
  extensionId: PLUGIN,
  handle: 'gate-owner',
};
const descriptor = {
  format: 1 as const,
  objects: [
    { name: 'items', kind: 'table' as const },
    { name: 'mine', kind: 'table' as const },
  ],
  modules: [
    {
      name: 'base',
      migrations: [
        {
          version: 0,
          statements: [
            'CREATE TABLE {{items}} (id TEXT PRIMARY KEY, v TEXT)',
            'CREATE TABLE {{mine}} (id TEXT PRIMARY KEY, v TEXT)',
          ],
        },
      ],
    },
  ],
  legacy: {
    tables: [
      { name: 'items', columns: ['id', 'v'] },
      { name: 'mine', columns: ['id', 'v'] },
    ],
  },
  synced: ['items'],
};

let dir: string;
let db: AppDb;
let store: CoreStore;
let sync: SyncService;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-worker-gate-'));
  const preload = path.join(dir, 'preload.js');
  fs.writeFileSync(
    preload,
    `const M = require('module');
     const t = ${JSON.stringify(path.join(repoRoot, 'node_modules', 'better-sqlite3'))};
     const o = M._resolveFilename;
     M._resolveFilename = function (r, ...a) { return o.call(this, r === 'better-sqlite3' ? t : r, ...a); };`,
  );
  const execArgv = [
    '--no-experimental-strip-types',
    '-r',
    preload,
    '-r',
    'ts-node/register/transpile-only',
    '-r',
    'tsconfig-paths/register',
  ];
  const dbPath = path.join(dir, 'kiagent.db');
  const legacy = new Database(path.join(dir, 'private.db'));
  legacy.exec(
    'CREATE TABLE items (id TEXT PRIMARY KEY, v TEXT); CREATE TABLE mine (id TEXT PRIMARY KEY, v TEXT)',
  );
  legacy.close();
  db = await openDbInWorker(dbPath, entry, {
    execArgv,
    pluginSources: { [PLUGIN]: path.join(dir, 'private.db') },
  });
  store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => ['eng'],
    profileDir: dir,
  } as never);
  sync = createSyncService({ db, store, dbPath, workerFile: entry, execArgv });
  await sync.setDeviceId('me-device');
  await db.plugin!({ op: 'register', pluginId: PLUGIN, descriptor } as never);
  await db.plugin!({ op: 'prepare', pluginId: PLUGIN, descriptor } as never);
  await db.plugin!({ op: 'open', owner, pluginId: PLUGIN });
}, 60_000);

afterEach(async () => {
  await sync.close();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const follow = () =>
  db.run(
    `UPDATE sync_state SET role='follower', master_device_id='m1', tracking=0,
                           history_id='h1', after_seq=7, after_cursor=5, joined=1`,
  );
const insert = (table: string, id: string) =>
  db.plugin!({
    op: 'exec',
    owner,
    sql: `INSERT INTO {{${table}}}(id, v) VALUES (?, 'x')`,
    params: [id],
  } as never);
const item = {
  id: 'gate:1',
  producer: 'gate',
  kind: 'action',
  state: 'open',
  revision: 1,
  title: 't',
  createdAt: 1,
  updatedAt: 1,
  expiresAt: null,
};

it('a plugin connection opened while leading is refused its synced table once the device follows, and not its own table', async () => {
  await expect(insert('items', 'a')).resolves.toBeUndefined();
  await follow();
  await expect(insert('items', 'b')).rejects.toThrow(/read-only/);
  await expect(insert('mine', 'b')).resolves.toBeUndefined();
  await db.run(`UPDATE sync_state SET role='normal', master_device_id=NULL`);
  await expect(insert('items', 'c')).resolves.toBeUndefined();
});

it('the fence closes a plugin connection too, and lifting it opens it', async () => {
  await sync.lead({ epoch: 1 });
  await sync.setLease({
    isMaster: false,
    reason: 'fenced',
    multiDevice: true,
    approved: true,
    holder: null,
    epoch: 0,
    priorRenewedAt: null,
  });
  await expect(insert('items', 'a')).rejects.toThrow(/read-only/);
  await sync.open('lease');
  await expect(insert('items', 'a')).resolves.toBeUndefined();
});

it('seed overtaken mid-lead: a copied-table write is refused after lead() resolves; a fresh grant and open lift it', async () => {
  const lease = (o: object) => ({
    isMaster: true,
    reason: 'holder' as const,
    multiDevice: true,
    approved: true,
    holder: 'me-device',
    epoch: 2,
    priorRenewedAt: null,
    ...o,
  });
  // Hold the real worker's syncLead until the newer lease has landed.
  const realProc = db.proc!.bind(db);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  (db as unknown as { proc: unknown }).proc = async (n: string, a: unknown) => {
    if (n === 'syncLead') await held;
    return realProc(n, a);
  };
  const p = sync.lead({ epoch: 1 });
  await new Promise((r) => setTimeout(r, 50));
  await sync.setLease(lease({ isMaster: false, reason: 'fenced' }) as never);
  release();
  await p;
  await expect(insert('items', 'a')).rejects.toThrow(/read-only/);
  await sync.setLease(lease({}) as never);
  await sync.open('head-acked');
  await expect(insert('items', 'a')).resolves.toBeUndefined();
}, 60_000);

it('attention publish is refused on a follower, a tick quietly writes nothing, and promote reopens it', async () => {
  const args = {
    producer: 'gate',
    items: [item],
    availableProducers: ['gate'],
  };
  await follow();
  const refused = (await db.proc!('attention.publish', args)) as {
    ok: boolean;
    error?: { name?: string };
  };
  expect(refused.ok).toBe(false);
  expect(refused.error?.name).toBe('SyncReadOnly');
  expect(await db.all(`SELECT id FROM attention_items`)).toEqual([]);
  const tick = (await db.proc!('attention.tick', {
    availableProducers: ['gate'],
  })) as { ok: boolean };
  expect(tick.ok).toBe(true);
  await sync.lead({ epoch: 2 });
  await sync.open('head-acked');
  const ok = (await db.proc!('attention.publish', args)) as {
    ok: boolean;
    error?: unknown;
  };
  expect(ok).toMatchObject({ ok: true });
  expect(await db.all(`SELECT id FROM attention_items`)).toHaveLength(1);
});

it('a tracking-leader boot refuses a copied-table write before any proc, and open(head-acked) lifts it', async () => {
  const dbPath = path.join(dir, 'kiagent.db');
  await sync.close();
  await db.close();
  // The device was leading with tracking on when it stopped.
  const raw = new Database(dbPath);
  raw
    .prepare(`UPDATE sync_state SET tracking = 1, joined = 1, head_pending = 1`)
    .run();
  const bootGate = readGateSync(raw);
  raw.close();
  const execArgv = [
    '--no-experimental-strip-types',
    '-r',
    path.join(dir, 'preload.js'),
    '-r',
    'ts-node/register/transpile-only',
    '-r',
    'tsconfig-paths/register',
  ];
  db = await openDbInWorker(dbPath, entry, {
    execArgv,
    pluginSources: { [PLUGIN]: path.join(dir, 'private.db') },
  });
  store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => ['eng'],
    profileDir: dir,
  } as never);
  sync = createSyncService({
    db,
    store,
    dbPath,
    workerFile: entry,
    execArgv,
    bootGate,
  });
  await db.plugin!({ op: 'register', pluginId: PLUGIN, descriptor } as never);
  await db.plugin!({ op: 'prepare', pluginId: PLUGIN, descriptor } as never);
  await db.plugin!({ op: 'open', owner, pluginId: PLUGIN });
  // No proc was sent: the worker derived the fence from the same row.
  expect(sync.readOnly()).toBe(true);
  await expect(insert('items', 'a')).rejects.toThrow(/read-only/);
  await expect(insert('mine', 'a')).resolves.toBeUndefined();
  await sync.open('head-acked');
  expect(sync.readOnly()).toBe(false);
  await expect(insert('items', 'a')).resolves.toBeUndefined();
}, 60_000);

it('a joining boot refuses a copied-table write, and resetState lifts it with no restart', async () => {
  const dbPath = path.join(dir, 'kiagent.db');
  await sync.close();
  await db.close();
  const raw = new Database(dbPath);
  raw.prepare(`UPDATE sync_state SET joining = 1`).run();
  const bootGate = readGateSync(raw);
  raw.close();
  const execArgv = [
    '--no-experimental-strip-types',
    '-r',
    path.join(dir, 'preload.js'),
    '-r',
    'ts-node/register/transpile-only',
    '-r',
    'tsconfig-paths/register',
  ];
  db = await openDbInWorker(dbPath, entry, {
    execArgv,
    pluginSources: { [PLUGIN]: path.join(dir, 'private.db') },
  });
  store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => ['eng'],
    profileDir: dir,
  } as never);
  sync = createSyncService({
    db,
    store,
    dbPath,
    workerFile: entry,
    execArgv,
    bootGate,
  });
  await db.plugin!({ op: 'register', pluginId: PLUGIN, descriptor } as never);
  await db.plugin!({ op: 'prepare', pluginId: PLUGIN, descriptor } as never);
  await db.plugin!({ op: 'open', owner, pluginId: PLUGIN });
  expect(sync.readOnly()).toBe(true);
  await expect(insert('items', 'a')).rejects.toThrow(/read-only/);
  await sync.resetState();
  expect(sync.readOnly()).toBe(false);
  await expect(insert('items', 'a')).resolves.toBeUndefined();
  expect(await sync.status()).toMatchObject({
    role: 'normal',
    joining: false,
    headPending: false,
  });
}, 60_000);
