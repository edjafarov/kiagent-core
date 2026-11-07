/** @jest-environment node */
/** Slice 2 Task 11: the lead API. `lead` promotes or seeds and leaves a
 *  promotion fenced; `open` is the one exit; a pending ack survives a restart. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { LeaseSnapshot, SyncRoleWire } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore } from '../../store/store';
import {
  readGateSync,
  SyncEpochBehind,
  SyncHeadPending,
  SyncNotLeader,
} from '../role';
import { readSyncStatus } from '../status';
import { createSyncService, type SyncService } from '../service';
import { leadProc } from './lead-proc';

interface Device {
  dir: string;
  db: AppDb;
  svc: SyncService;
  onOpen: jest.Mock;
  conn: () => import('better-sqlite3').Database;
}
const devices: Device[] = [];

async function device(
  setup: (c: import('better-sqlite3').Database) => void = () => undefined,
  existingDir?: string,
): Promise<Device> {
  const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lead-api-'));
  const db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  setup(db._conn!);
  const conn = () => db._conn!;
  (db as unknown as { proc: unknown }).proc = leadProc(conn);
  const onOpen = jest.fn(async () => undefined);
  const svc = createSyncService({
    bootGate: readGateSync(conn()),
    db,
    store: openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    }),
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    onOpen,
    log: () => undefined,
  });
  const d = { dir, db, svc, onOpen, conn };
  devices.push(d);
  return d;
}
const follower = (c: import('better-sqlite3').Database) =>
  c
    .prepare(
      `UPDATE sync_state SET role='follower', master_device_id='m1', tracking=0,
                             history_id='h1', after_seq=7, after_cursor=5, joined=1, epoch=1`,
    )
    .run();
const leader = (c: import('better-sqlite3').Database) =>
  c.prepare(`UPDATE sync_state SET tracking=1, joined=1, epoch=1`).run();
const lease = (o: Partial<LeaseSnapshot> = {}): LeaseSnapshot => ({
  isMaster: true,
  reason: 'holder',
  multiDevice: true,
  approved: true,
  holder: 'me',
  epoch: 2,
  priorRenewedAt: null,
  ...o,
});
/** Counts the queued rows the leader runs: one drain of one row is one call. */
const runnerCount = (d: Device): (() => number) => {
  let n = 0;
  d.svc.setRunners({
    ui: async () => void (n += 1),
    core: jest.fn(),
    commit: jest.fn(),
  });
  return () => n;
};
/** Records every proc call; a fence post reads `syncFence:on|off`. */
const procLog = (d: Device): string[] => {
  const real = (d.db as unknown as { proc: (n: string, a: unknown) => Promise<unknown> }).proc;
  const log: string[] = [];
  (d.db as unknown as { proc: unknown }).proc = async (n: string, a: unknown) => {
    log.push(n === 'syncFence' ? `syncFence:${(a as { on: boolean }).on ? 'on' : 'off'}` : n);
    return real(n, a);
  };
  return log;
};
const state = (d: Device) =>
  d.conn().prepare(`SELECT * FROM sync_state`).get() as Record<string, unknown>;
const epochs = (d: Device) => d.conn().prepare(`SELECT * FROM sync_epochs`).all();

afterEach(async () => {
  for (const d of devices.splice(0)) {
    await d.db.close();
    fs.rmSync(d.dir, { recursive: true, force: true });
  }
});

describe('lead', () => {
  it('on a follower writes the grant row, sets head_pending and leaves the device fenced', async () => {
    const d = await device(follower);
    await d.svc.setLease(lease({ reason: 'holder', isMaster: true }));
    await d.svc.lead({ epoch: 2 });
    expect(epochs(d)).toEqual([{ epoch: 2, grant_seq: 7, grant_cursor: 5 }]);
    expect(state(d)).toMatchObject({ role: 'normal', tracking: 1, epoch: 2, head_pending: 1 });
    expect(d.svc.readOnly()).toBe(true);
    expect(d.svc.role()).toMatchObject({ leader: false, follower: false, reason: 'holder' });
    expect(readSyncStatus(d.conn()).headPending).toBe(true);
  });

  it('fences (readOnly, syncFence on posted) before the syncLead proc runs', async () => {
    const d = await device(follower);
    const real = (d.db as unknown as { proc: (n: string, a: unknown) => Promise<unknown> }).proc;
    const log: string[] = [];
    let readOnlyAtLead: boolean | null = null;
    (d.db as unknown as { proc: unknown }).proc = async (n: string, a: unknown) => {
      log.push(n === 'syncFence' ? `syncFence:${(a as { on: boolean }).on ? 'on' : 'off'}` : n);
      if (n === 'syncLead') readOnlyAtLead = d.svc.readOnly();
      return real(n, a);
    };
    await d.svc.lead({ epoch: 2 });
    expect(log.slice(0, 2)).toEqual(['syncFence:on', 'syncLead']);
    expect(readOnlyAtLead).toBe(true);
  });

  it('on a follower with epoch <= sync_state.epoch throws SyncEpochBehind', async () => {
    const d = await device(follower);
    await expect(d.svc.lead({ epoch: 1 })).rejects.toThrow(SyncEpochBehind);
    expect(state(d)).toMatchObject({ role: 'follower', head_pending: 0 });
    expect(d.svc.readOnly()).toBe(true);
  });

  it('on the seed posts no fence at all and stays writable throughout', async () => {
    const d = await device();
    const log = procLog(d);
    await d.svc.lead({ epoch: 1 });
    expect(log).toEqual(['syncLead']);
    expect(d.svc.readOnly()).toBe(false);
  });

  it('on a tracking leader (no-op) posts no fence', async () => {
    const d = await device(leader);
    await d.svc.open('lease');
    const log = procLog(d);
    await d.svc.lead({ epoch: 5 });
    expect(log).toEqual(['syncLead']);
    expect(d.svc.readOnly()).toBe(false);
  });

  it('on a follower the fence post comes first, and a refused grant posts nothing', async () => {
    const d = await device(follower);
    const log = procLog(d);
    await expect(d.svc.lead({ epoch: 1 })).rejects.toThrow(SyncEpochBehind);
    expect(log).toEqual([]);
    await d.svc.lead({ epoch: 2 });
    // the promoted reply re-asserts the fence once more
    expect(log).toEqual(['syncFence:on', 'syncLead', 'syncFence:on']);
  });

  it('on a follower whose proc throws restores the pre-call fence', async () => {
    const d = await device(follower);
    const real = (d.db as unknown as { proc: (n: string, a: unknown) => Promise<unknown> }).proc;
    (d.db as unknown as { proc: unknown }).proc = async (n: string, a: unknown) => {
      if (n === 'syncLead') throw new Error('boom');
      return real(n, a);
    };
    const log = procLog(d);
    await expect(d.svc.lead({ epoch: 2 })).rejects.toThrow('boom');
    expect(log).toEqual(['syncFence:on', 'syncLead', 'syncFence:off']);
  });

  it('on the seed enables tracking, writes sync_epochs, does not fence and leaves head_pending 0', async () => {
    const d = await device();
    await d.svc.lead({ epoch: 1 });
    expect(state(d)).toMatchObject({ role: 'normal', tracking: 1, head_pending: 0 });
    expect(epochs(d)).toEqual([{ epoch: 1, grant_seq: 0, grant_cursor: 0 }]);
    expect(d.svc.readOnly()).toBe(false);
  });

  it('a seed whose lead() is overtaken by a non-master lease ends tracking AND fenced: readOnly true, role not leader, one syncFence on', async () => {
    const d = await device();
    const log = procLog(d);
    const real = (d.db as unknown as { proc: (n: string, a: unknown) => Promise<unknown> }).proc;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    (d.db as unknown as { proc: unknown }).proc = async (n: string, a: unknown) => {
      if (n === 'syncLead') await held;
      return real(n, a);
    };
    const p = d.svc.lead({ epoch: 1 });
    await new Promise((r) => setTimeout(r, 20));
    // Tracking is still 0: setLease exempts the seed and closes nothing.
    await d.svc.setLease(lease({ isMaster: false, reason: 'fenced', holder: 'me' }));
    expect(d.svc.readOnly()).toBe(false);
    release();
    await p;
    expect(state(d)).toMatchObject({ tracking: 1 });
    expect(d.svc.readOnly()).toBe(true);
    expect(d.svc.role().leader).toBe(false);
    expect(log.filter((n) => n === 'syncFence:on')).toHaveLength(1);
  });

  it('fences an overtaken seed before the final refresh can report it as leader', async () => {
    const d = await device();
    const real = (d.db as unknown as { proc: (n: string, a: unknown) => Promise<unknown> }).proc;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    (d.db as unknown as { proc: unknown }).proc = async (n: string, a: unknown) => {
      if (n === 'syncLead') await held;
      return real(n, a);
    };
    const p = d.svc.lead({ epoch: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await d.svc.setLease(lease({ isMaster: false, reason: 'fenced', holder: 'me' }));
    // From here on, record the role seen at the first await of the final refresh.
    const seen: boolean[] = [];
    const realAll = d.db.all.bind(d.db);
    (d.db as unknown as { all: unknown }).all = (sql: string, ...rest: unknown[]) => {
      if (sql.includes('master_device_id')) seen.push(d.svc.role().leader);
      return (realAll as (...a: unknown[]) => unknown)(sql, ...rest);
    };
    release();
    await p;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((l) => l === false)).toBe(true);
    expect(d.svc.readOnly()).toBe(true);
    expect(d.svc.role().leader).toBe(false);
  });

  it("the same device recovers on a fresh master grant: setLease(holder) then open('head-acked') -> readOnly false", async () => {
    const d = await device();
    const real = (d.db as unknown as { proc: (n: string, a: unknown) => Promise<unknown> }).proc;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    (d.db as unknown as { proc: unknown }).proc = async (n: string, a: unknown) => {
      if (n === 'syncLead') await held;
      return real(n, a);
    };
    const p = d.svc.lead({ epoch: 1 });
    await new Promise((r) => setTimeout(r, 20));
    await d.svc.setLease(lease({ isMaster: false, reason: 'fenced', holder: 'me' }));
    release();
    await p;
    expect(d.svc.readOnly()).toBe(true);
    await d.svc.setLease(lease());
    await d.svc.open('head-acked');
    expect(d.svc.readOnly()).toBe(false);
    expect(d.svc.role().leader).toBe(true);
  });

  it('a seed with a non-master lease cached BEFORE lead() (the rig: alone, undecided) still leads, unfenced', async () => {
    const d = await device();
    await d.svc.setLease(lease({ isMaster: false, reason: 'unjoined', holder: null }));
    await d.svc.lead({ epoch: 1 });
    expect(state(d)).toMatchObject({ tracking: 1 });
    expect(d.svc.readOnly()).toBe(false);
  });

  it("the rig's takeover: follower with a non-master lease, setLease(master) then lead() with the same master lease arriving mid-lead, open('head-acked') succeeds", async () => {
    const d = await device(follower);
    await d.svc.setLease(lease({ isMaster: false, reason: 'follower', holder: 'm1' }));
    await d.svc.setLease(lease());
    const real = (d.db as unknown as { proc: (n: string, a: unknown) => Promise<unknown> }).proc;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    (d.db as unknown as { proc: unknown }).proc = async (n: string, a: unknown) => {
      if (n === 'syncLead') await held;
      return real(n, a);
    };
    const p = d.svc.lead({ epoch: 2, relayImported: true });
    await new Promise((r) => setTimeout(r, 20));
    await d.svc.setLease(lease());
    release();
    await p;
    await d.svc.open('head-acked');
    expect(d.svc.role().leader).toBe(true);
    expect(d.svc.readOnly()).toBe(false);
  });

  it('on a tracking leader is a no-op whatever the epoch', async () => {
    const d = await device(leader);
    await d.svc.lead({ epoch: 9 });
    await d.svc.lead({ epoch: 0 });
    expect(state(d)).toMatchObject({ epoch: 1, head_pending: 0 });
    expect(epochs(d)).toEqual([]);
  });
});

describe('open', () => {
  it("'lease' throws SyncNotLeader on a follower, SyncHeadPending while pending, and is a no-op when not fenced", async () => {
    const f = await device(follower);
    await expect(f.svc.open('lease')).rejects.toThrow(SyncNotLeader);
    const p = await device(follower);
    await p.svc.lead({ epoch: 2 });
    await expect(p.svc.open('lease')).rejects.toThrow(SyncHeadPending);
    expect(p.svc.readOnly()).toBe(true);
    const free = await device();
    await free.svc.open('lease');
    expect(free.onOpen).not.toHaveBeenCalled();
  });

  it("'head-acked' clears head_pending, lifts the fence, runs onOpen and drains once; a second open is a no-op", async () => {
    const d = await device(follower);
    const ran = runnerCount(d);
    await d.svc.enqueue({ kind: 'ui', extensionId: 'x', name: 'n', payload: {} });
    await d.svc.lead({ epoch: 2 });
    expect(ran()).toBe(0);
    await Promise.all([d.svc.open('head-acked'), d.svc.open('head-acked')]);
    await d.svc.open('head-acked');
    await d.svc.open('lease');
    expect(state(d)).toMatchObject({ head_pending: 0 });
    expect(d.svc.readOnly()).toBe(false);
    expect(d.onOpen).toHaveBeenCalledTimes(1);
    expect(d.svc.role().leader).toBe(true);
    expect(ran()).toBe(1);
    expect(d.conn().prepare(`SELECT count(*) n FROM sync_outbound`).get()).toEqual({ n: 0 });
  });
});

describe('setLease', () => {
  const closers: [string, Partial<LeaseSnapshot>][] = [
    ['fenced', { reason: 'fenced', isMaster: false }],
    ['another holder', { isMaster: false, reason: 'follower', holder: 'other' }],
    ['a self-granted handover', { isMaster: false, reason: 'follower', holder: 'me' }],
    ['a null holder', { isMaster: false, reason: 'unjoined', holder: null }],
    ['an unknown holder', { isMaster: false, reason: 'stale-root', holder: '???' }],
  ];
  it.each(closers)('%s closes a tracking leader at once', async (_n, o) => {
    const d = await device(leader);
    await d.svc.open('lease'); // the boot fence: open
    expect(d.svc.readOnly()).toBe(false);
    await d.svc.setLease(lease(o));
    expect(d.svc.readOnly()).toBe(true);
    expect(d.svc.role().leader).toBe(false);
  });

  it('a non-master lease closes the writer synchronously, before the returned promise settles', async () => {
    const d = await device(leader);
    await d.svc.open('lease');
    expect(d.svc.readOnly()).toBe(false);
    const p = d.svc.setLease(lease({ isMaster: false, reason: 'follower', holder: 'other' }));
    expect(d.svc.readOnly()).toBe(true);
    await p;
    expect(d.svc.readOnly()).toBe(true);
  });

  it('never fences a seed (normal, tracking 0), whatever the lease says: no fence post', async () => {
    const d = await device();
    const log = procLog(d);
    await d.svc.setLease(lease({ isMaster: false, reason: 'fenced' }));
    expect(d.svc.readOnly()).toBe(false);
    expect(log.filter((n) => n.startsWith('syncFence'))).toEqual([]);
  });

  it('a master lease leaves a leader open', async () => {
    const d = await device(leader);
    await d.svc.open('lease');
    await d.svc.setLease(lease());
    expect(d.svc.readOnly()).toBe(false);
  });

  it('emits onRole once per change, not per call', async () => {
    const d = await device(leader);
    const seen: SyncRoleWire[] = [];
    d.svc.onRole((r) => seen.push(r));
    await d.svc.setLease(lease());
    await d.svc.setLease(lease());
    expect(seen).toHaveLength(1);
    await d.svc.setLease(lease({ isMaster: false, reason: 'fenced' }));
    await d.svc.setLease(lease({ isMaster: false, reason: 'fenced' }));
    expect(seen).toHaveLength(2);
    expect(d.svc.lease()).toMatchObject({ reason: 'fenced' });
  });
});

it("a lease loss during open('head-acked') leaves the device fenced and never runs onOpen", async () => {
  const d = await device(follower);
  await d.svc.lead({ epoch: 2 });
  const real = (d.db as unknown as { proc: (n: string, a: unknown) => Promise<unknown> }).proc;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let entered = false;
  const ran = runnerCount(d);
  await d.svc.enqueue({ kind: 'ui', extensionId: 'x', name: 'n', payload: {} });
  (d.db as unknown as { proc: unknown }).proc = async (n: string, a: unknown) => {
    if (n === 'syncOpen') {
      entered = true;
      await gate;
    }
    return real(n, a);
  };
  const first = d.svc.open('head-acked');
  const second = d.svc.open('head-acked');
  while (!entered) await new Promise((r) => setImmediate(r));
  await d.svc.setLease(
    lease({ isMaster: false, reason: 'holder', holder: 'other', epoch: 2 }),
  );
  release();
  await Promise.all([first, second]);
  expect(d.svc.readOnly()).toBe(true);
  expect(d.onOpen).not.toHaveBeenCalled();
  expect(ran()).toBe(0);
  expect(d.svc.role().leader).toBe(false);
});

it('demote sets head_pending to 0 and fences', async () => {
  const d = await device(follower);
  await d.svc.lead({ epoch: 2 });
  expect(state(d)).toMatchObject({ head_pending: 1 });
  await d.svc.demote('m2');
  expect(state(d)).toMatchObject({ role: 'follower', head_pending: 0, master_device_id: 'm2' });
  expect(d.svc.readOnly()).toBe(true);
});

it('after a restart with head_pending = 1 the device is leader-fenced and only open(head-acked) exits', async () => {
  const a = await device(follower);
  await a.svc.lead({ epoch: 2 });
  await a.db.close();
  devices.splice(devices.indexOf(a), 1);
  const b = await device(undefined, a.dir);
  expect(b.svc.readOnly()).toBe(true);
  await expect(b.svc.open('lease')).rejects.toThrow(SyncHeadPending);
  expect(b.svc.readOnly()).toBe(true);
  expect(b.svc.role()).toMatchObject({ leader: false });
  await b.svc.open('head-acked');
  expect(b.svc.readOnly()).toBe(false);
  expect(b.onOpen).toHaveBeenCalledTimes(1);
});
