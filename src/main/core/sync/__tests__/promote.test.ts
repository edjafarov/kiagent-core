/** @jest-environment node */
/** Step 2 Task 1: the role changes while the app runs. Through the real
 *  writer worker, because the guard lives there and must be read per call. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDbInWorker } from '@main/db/worker-client';
import type { AppDb } from '@main/db/app-db';
import type { Account } from '@shared/contracts';

import { promoteCore, resumeAccounts, type CorePlatform } from '../../boot';
import { openStore, type CoreStore } from '../../store/store';
import { notMineToRun } from '../sources';
import { createSyncService, type SyncService } from '../service';

const entry = require.resolve('../../../db/worker-entry.ts');
const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const GAP = 10_000_000_000;
let dir: string;
let dbPath: string;
let db: AppDb;
let store: CoreStore;
let sync: SyncService;
let execArgv: string[];
let promoted = 0;

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
    onPromoted: async () => void (promoted += 1),
  });
  await sync.setDeviceId('me-device');
};

beforeEach(async () => {
  promoted = 0;
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
const state = async () =>
  (await db.all(`SELECT * FROM sync_state`))[0] as Record<string, number | string | null>;
const follow = () =>
  db.run(
    `UPDATE sync_state SET role='follower', master_device_id='m1', tracking=0,
                           history_id='h1', after_seq=7, after_cursor=5, joined=1`,
  );
const seqOf = async (name: string) =>
  ((await db.all(`SELECT seq FROM sqlite_sequence WHERE name = ?`, [name]))[0]?.seq ?? 0) as number;

describe('the writer', () => {
  it('refuses after demote without a restart', async () => {
    await sync.enableTracking();
    await write();
    await sync.demote('m1');
    await expect(write()).rejects.toThrow(/read-only/);
    expect(sync.readOnly()).toBe(true);
  });

  it('accepts after promote without a restart', async () => {
    await follow();
    await expect(write()).rejects.toThrow(/read-only/);
    await sync.promote(2);
    await expect(write()).resolves.toBeTruthy();
    expect(sync.readOnly()).toBe(false);
    expect(promoted).toBe(1);
  });

  it('a promotion made while fenced stays closed, and starts the workers only when the fence lifts', async () => {
    await follow();
    sync.setFenced(true);
    await sync.promote(2);
    expect(sync.readOnly()).toBe(true);
    await expect(write()).rejects.toThrow(/read-only/);
    expect(promoted).toBe(0);
    sync.setFenced(false);
    await expect(write()).resolves.toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(promoted).toBe(1);
  });

  it('a call queued during promote runs with the new role', async () => {
    await follow();
    const p = sync.promote(2);
    const w = write();
    await p;
    await expect(w).resolves.toBeTruthy();
  });

  it('setFenced closes the writer without touching sync_state, and opening it again reopens', async () => {
    await sync.enableTracking();
    const before = await state();
    sync.setFenced(true);
    expect(sync.readOnly()).toBe(true);
    await expect(write()).rejects.toThrow(/read-only/);
    expect(await state()).toEqual(before);
    sync.setFenced(false);
    expect(sync.readOnly()).toBe(false);
    await expect(write()).resolves.toBeTruthy();
  });

  it('a restart clears the fence: sync_state decides at boot', async () => {
    sync.setFenced(true);
    await expect(write()).rejects.toThrow(/read-only/);
    await sync.close();
    await db.close();
    await open();
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

describe('promote', () => {
  it('raises both counters to the epoch range, and the next rows land above it', async () => {
    await follow();
    await sync.promote(3);
    expect(await seqOf('changes')).toBeGreaterThanOrEqual(3 * GAP);
    expect(await seqOf('sync_rows')).toBeGreaterThanOrEqual(3 * GAP);
    await write();
    const head = (await db.all(`SELECT max(seq) AS m FROM changes`))[0].m as number;
    expect(head).toBeGreaterThan(3 * GAP);
  });

  it('raises counters that already have rows, with one sequence row each, and the next rows land above', async () => {
    await write();
    await write();
    await follow();
    await sync.promote(3);
    for (const name of ['changes', 'sync_rows']) {
      const rows = await db.all(`SELECT seq FROM sqlite_sequence WHERE name = ?`, [name]);
      expect(rows).toHaveLength(1);
      expect(rows[0].seq as number).toBeGreaterThanOrEqual(3 * GAP);
    }
    await write();
    const head = (await db.all(`SELECT max(seq) AS m FROM changes`))[0].m as number;
    expect(head).toBeGreaterThan(3 * GAP);
  });

  it('never lowers a counter that is already higher', async () => {
    await follow();
    await db.run(`INSERT OR REPLACE INTO sqlite_sequence(name, seq) VALUES ('changes', ?)`, [9 * GAP]);
    await sync.promote(2);
    expect(await seqOf('changes')).toBe(9 * GAP);
  });

  it('writes sync_epochs with the old position and records the epoch', async () => {
    await follow();
    await sync.promote(3);
    const rows = await db.all(`SELECT * FROM sync_epochs`);
    expect(rows).toEqual([{ epoch: 3, grant_seq: 7, grant_cursor: 5 }]);
    expect((await state()).epoch).toBe(3);
  });

  it('the sync_epochs row is the first tracked row, so it travels', async () => {
    await follow();
    await sync.promote(3);
    const first = await db.all(`SELECT tbl, pk, cursor FROM sync_rows ORDER BY cursor LIMIT 1`);
    expect(first).toMatchObject([{ tbl: 'sync_epochs', pk: '[3]' }]);
    expect(Number((first[0] as { cursor: number }).cursor)).toBeGreaterThan(3 * GAP);
  });

  it('keeps history_id, turns tracking on and clears the master', async () => {
    await follow();
    await sync.promote(2);
    expect(await state()).toMatchObject({ role: 'normal', tracking: 1, history_id: 'h1', master_device_id: null });
  });

  it('status reports the epoch and the grant of the device\'s own epoch', async () => {
    await follow();
    expect(await sync.status()).toMatchObject({ epoch: 0, grant: null });
    await sync.promote(3);
    expect(await sync.status()).toMatchObject({ epoch: 3, grant: { seq: 7, cursor: 5 } });
  });

  it('promoting twice with the same epoch changes nothing the second time', async () => {
    await follow();
    await sync.promote(2);
    await sync.promote(2);
    expect(await db.all(`SELECT * FROM sync_epochs`)).toHaveLength(1);
  });

  it('deletes every consumer and their ledger rows so workers re-seed', async () => {
    await follow();
    await db.run(`INSERT INTO consumers(name, cursor) VALUES ('worker:ocr:v1', 99)`);
    await db.run(
      `INSERT INTO work_ledger(consumer, seq, attempts, outcome, updated_at) VALUES ('worker:ocr:v1', 4, 1, 'done', 'n')`,
    );
    await sync.promote(2);
    expect(await db.all(`SELECT * FROM consumers`)).toEqual([]);
    expect(await db.all(`SELECT * FROM work_ledger`)).toEqual([]);
  });

  it('demote sets after to the head and stops tracking', async () => {
    await sync.enableTracking();
    await write();
    const head = (await db.all(
      `SELECT (SELECT coalesce(max(seq), 0) FROM documents) AS s, (SELECT coalesce(max(cursor), 0) FROM sync_rows) AS c`,
    ))[0];
    await sync.demote('m2');
    expect(await state()).toMatchObject({
      role: 'follower',
      tracking: 0,
      master_device_id: 'm2',
      after_seq: head.s,
      after_cursor: head.c,
    });
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
      engine: { run: () => (order.push('resume'), {}), isRunning: () => false },
    } as unknown as CorePlatform;
    await promoteCore(p, {
      deviceId: () => 'me-device',
      archiveSweep: () => void order.push('sweep'),
      ledgerRekey: () => void order.push('rekey'),
      attachHeld: async () => void order.push('attach'),
    });
    expect(order).toEqual(['resume', 'sweep', 'rekey', 'attach']);
  });
});
