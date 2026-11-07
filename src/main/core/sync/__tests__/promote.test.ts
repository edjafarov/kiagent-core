/** @jest-environment node */
/** Step 2 Task 1: the role changes while the app runs. Through the real
 *  writer worker, because the guard lives there and must be read per call. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDbInWorker } from '@main/db/worker-client';
import type { AppDb } from '@main/db/app-db';
import type { Account, LeaseSnapshot } from '@shared/contracts';

import { promoteCore, resumeAccounts, resumeHeld, type CorePlatform } from '../../boot';
import { openStore, type CoreStore } from '../../store/store';
import { notMineToRun } from '../sources';
import { gateEngine, readSyncGate } from '../role';
import { createSyncService, type SyncService } from '../service';

const entry = require.resolve('../../../db/worker-entry.ts');
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
let dir: string;
let dbPath: string;
let db: AppDb;
let store: CoreStore;
let sync: SyncService;
let execArgv: string[];
let promoted = 0;
let holdWork: (() => Promise<void>) | undefined;
let resumeWork: (() => Promise<void>) | undefined;

const open = async () => {
  db = await openDbInWorker(dbPath, entry, { execArgv });
  store = openStore(db, {
    encrypt: (s: string) => s,
    decrypt: (s: string) => s,
    detectLanguages: () => ['eng'],
    profileDir: dir,
  } as never);
  sync = createSyncService({
    db,
    store,
    dbPath,
    workerFile: entry,
    execArgv,
    bootGate: await readSyncGate(db),
    onOpen: async () => void (promoted += 1),
    holdWork: () => (holdWork ? holdWork() : Promise.resolve()),
    resumeWork: () => (resumeWork ? resumeWork() : Promise.resolve()),
  });
  await sync.setDeviceId('me-device');
};

beforeEach(async () => {
  promoted = 0;
  holdWork = undefined;
  resumeWork = undefined;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-promote-'));
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
  await open();
}, 60_000);

afterEach(async () => {
  await sync.close();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
const write = () => store.createAccount({ source: 's', identifier: `i${(n += 1)}` });
const lease = (o: Partial<LeaseSnapshot> = {}): LeaseSnapshot => ({
  isMaster: true,
  reason: 'solo',
  multiDevice: false,
  approved: true,
  holder: 'me-device',
  epoch: 0,
  priorRenewedAt: null,
  ...o,
});
/** A promotion as registration drives it: lead, then the head is acknowledged. */
const promote = async (epoch: number) => {
  await sync.lead({ epoch });
  await sync.open('head-acked');
};
const state = async () =>
  (await db.all(`SELECT * FROM sync_state`))[0] as Record<string, number | string | null>;
const follow = () =>
  db.run(
    `UPDATE sync_state SET role='follower', master_device_id='m1', tracking=0,
                           history_id='h1', after_seq=7, after_cursor=5, joined=1`,
  );

describe('the writer', () => {
  it('refuses after demote without a restart', async () => {
    await sync.lead({ epoch: 1 });
    await write();
    await sync.demote('m1');
    await expect(write()).rejects.toThrow(/read-only/);
    expect(sync.readOnly()).toBe(true);
  });

  it('accepts after promote without a restart', async () => {
    await follow();
    await expect(write()).rejects.toThrow(/read-only/);
    await promote(2);
    await expect(write()).resolves.toBeTruthy();
    expect(sync.readOnly()).toBe(false);
    expect(promoted).toBe(1);
  });

  it('a promotion stays closed until the head is acknowledged, and starts the workers only then', async () => {
    await follow();
    await sync.lead({ epoch: 2 });
    expect(sync.readOnly()).toBe(true);
    await expect(write()).rejects.toThrow(/read-only/);
    expect(promoted).toBe(0);
    await sync.open('head-acked');
    await expect(write()).resolves.toBeTruthy();
    expect(promoted).toBe(1);
  });

  it('a write after the promotion opens runs with the new role', async () => {
    await follow();
    await promote(2);
    await expect(write()).resolves.toBeTruthy();
  });

  it('a lease that is not ours closes the writer without touching sync_state, and open reopens it', async () => {
    await sync.lead({ epoch: 1 });
    const before = await state();
    await sync.setLease(lease({ isMaster: false, reason: 'follower' }));
    expect(sync.readOnly()).toBe(true);
    await expect(write()).rejects.toThrow(/read-only/);
    expect(await state()).toEqual(before);
    await sync.open('lease');
    expect(sync.readOnly()).toBe(false);
    await expect(write()).resolves.toBeTruthy();
  });

  it('a restart wakes a tracking leader fenced, in the worker and in main, and open lifts it', async () => {
    await sync.lead({ epoch: 1 });
    await sync.setLease(lease({ reason: 'fenced', isMaster: false }));
    await expect(write()).rejects.toThrow(/read-only/);
    await sync.close();
    await db.close();
    await open();
    expect(sync.readOnly()).toBe(true);
    await expect(write()).rejects.toThrow(/read-only/);
    await sync.open('lease');
    await expect(write()).resolves.toBeTruthy();
    expect(sync.readOnly()).toBe(false);
  });

  it('the main-side answer follows beginJoin and leaveJoin as well', async () => {
    await sync.beginJoin();
    expect(sync.readOnly()).toBe(true);
    await sync.leaveJoin();
    expect(sync.readOnly()).toBe(false);
  });
});

describe('one order for the held work', () => {
  it('beginJoin stops an attached worker before joining flips, holds it, and logs no SyncReadOnly', async () => {
    const seen: string[] = [];
    holdWork = async () => {
      // Joining has not flipped yet, so a worker finishing its write is fine.
      seen.push(`hold readOnly=${sync.readOnly()}`);
      await expect(write()).resolves.toBeTruthy();
    };
    await sync.beginJoin();
    expect(seen).toEqual(['hold readOnly=false']);
    expect(sync.readOnly()).toBe(true);
  });

  it('leaveJoin reattaches once and a stopped live-source account run resumes', async () => {
    const runs: string[] = [];
    let attached = 0;
    const p = {
      store: {
        read: {
          accounts: async () => [
            { id: 'live', source: 'gmail', identifier: 'x', status: 'live', cursor: { c: 1 }, config: {}, ownerDeviceId: null },
          ],
        },
      },
      sources: { get: (id: string) => ({ descriptor: { id } }) },
      logSink: { log: () => undefined },
      engine: { run: (a: Account) => (runs.push(a.id), {}), isRunning: () => false },
      scheduler: { register: jest.fn() },
      sync: { deviceId: () => 'me-device' },
    } as unknown as CorePlatform;
    resumeWork = () => resumeHeld(p, { attachHeld: async () => void (attached += 1) });
    await sync.beginJoin();
    await sync.leaveJoin();
    expect(attached).toBe(1);
    expect(runs).toEqual(['live']);
  });

  it('open() does not resume the work', async () => {
    let resumed = 0;
    resumeWork = async () => void (resumed += 1);
    await sync.lead({ epoch: 1 });
    await sync.open('head-acked');
    expect(resumed).toBe(0);
  });

  it('fence-on: the worker observes the fence before any stop resolves, and the quiesced handles are held', async () => {
    await sync.lead({ epoch: 1 });
    await sync.open('head-acked');
    const seen: string[] = [];
    holdWork = async () => {
      seen.push(`readOnly=${sync.readOnly()}`);
      await expect(write()).rejects.toThrow(/read-only/);
      seen.push('stopped');
    };
    await sync.setLease(lease({ isMaster: false, reason: 'follower' }));
    expect(seen).toEqual(['readOnly=true', 'stopped']);
    seen.length = 0;
    await sync.open('lease');
    await sync.demote('m1');
    expect(seen).toEqual(['readOnly=true', 'stopped']);
  });

  it('a holdWork rejection leaves the fence on and setLease resolved', async () => {
    await sync.lead({ epoch: 1 });
    await sync.open('head-acked');
    holdWork = () => Promise.reject(new Error('stuck'));
    await expect(
      sync.setLease(lease({ isMaster: false, reason: 'follower' })),
    ).resolves.toBeUndefined();
    expect(sync.readOnly()).toBe(true);
    await expect(write()).rejects.toThrow(/read-only/);
  });
});

describe('what promotion starts', () => {
  const account = (o: Partial<Account>): Account =>
    ({ id: 'a', source: 'gmail', identifier: 'x', status: 'idle', cursor: { c: 1 }, config: {}, ownerDeviceId: null, ...o }) as never;
  const platform = (accounts: Account[], runs: unknown[]) =>
    ({
      store: { read: { accounts: async () => accounts } },
      sources: { get: (id: string) => ({ descriptor: { id } }) },
      logSink: { log: () => undefined },
      engine: { run: (a: Account) => (runs.push(a), {}), isRunning: () => false },
      scheduler: { register: jest.fn() },
    }) as unknown as CorePlatform;

  it('resumes accounts from the copied cursor', async () => {
    const runs: Account[] = [];
    await resumeAccounts(platform([account({})], runs));
    expect(runs.map((a) => a.cursor)).toEqual([{ c: 1 }]);
  });

  it("never resumes another device's device-owned account", async () => {
    const runs: Account[] = [];
    const accounts = [
      account({ id: 'f1', source: 'local-folder', ownerDeviceId: 'other' }),
      account({ id: 'f2', source: 'local-folder', ownerDeviceId: 'me-device' }),
      account({ id: 'g1' }),
    ];
    await resumeAccounts(platform(accounts, runs), {
      skip: (a) => notMineToRun(a, 'me-device'),
    });
    expect(runs.map((a) => a.id).sort()).toEqual(['f2', 'g1']);
  });

  it("the master never runs another device's whatsapp, and runs its own", async () => {
    const runs: Account[] = [];
    const accounts = [
      account({ id: 'w1', source: 'whatsapp', ownerDeviceId: 'phone-owner' }),
      account({ id: 'w2', source: 'whatsapp', ownerDeviceId: 'me-device' }),
    ];
    await resumeAccounts(platform(accounts, runs), {
      skip: (a) => notMineToRun(a, 'me-device'),
    });
    expect(runs.map((a) => a.id)).toEqual(['w2']);
  });

  it('promoteCore resumes, sweeps, re-keys and attaches the held workers, in that order', async () => {
    const order: string[] = [];
    const p = {
      ...platform([account({})], []),
      sync: { deviceId: () => 'me-device' },
      engine: { run: () => (order.push('resume'), {}), isRunning: () => false },
    } as unknown as CorePlatform;
    await promoteCore(p, {
      archiveSweep: () => void order.push('sweep'),
      ledgerRekey: () => void order.push('rekey'),
      attachHeld: async () => void order.push('attach'),
      release: async () => undefined,
    });
    expect(order).toEqual(['resume', 'sweep', 'rekey', 'attach']);
  });
  it('promoteCore releases the hold before it re-runs accounts, through the real gate', async () => {
    const order: string[] = [];
    const run = jest.fn(() => (order.push('resume'), { stop: async () => undefined, status: 'running' }));
    const eng = { run, attach: jest.fn(() => ({ stop: async () => undefined, status: 'running' })), rerunDeferred: jest.fn() };
    const g = gateEngine(eng as never, () => false);
    await g.closeWriter();
    const p = {
      ...platform([account({})], []),
      sync: { deviceId: () => 'me-device' },
      engine: { run: (a: Account) => (eng as unknown as { run(a: Account): unknown }).run(a), isRunning: () => false },
    } as unknown as CorePlatform;
    await promoteCore(p, {
      archiveSweep: () => void order.push('sweep'),
      ledgerRekey: () => void order.push('rekey'),
      attachHeld: async () => {
        order.push('attach');
        await g.attachHeld();
      },
      release: g.release,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['resume', 'sweep', 'rekey', 'attach']);
  });
});
