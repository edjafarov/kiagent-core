import fs from 'fs';
import os from 'os';
import path from 'path';

import type { SyncRoleWire } from '@shared/contracts';

import { openDb, type AppDb } from '../../../../db/app-db';
import { migrate } from '../../../store/schema';
import { createSharedFolders, type SharedFoldersDeps, type SharedFolders } from '../../service';

export type FakeMode = 'leader' | 'copy' | 'fenced';

/** The slice of the sync service the shared folders read, driven by hand. */
export function fakeSync(mode: FakeMode, peerInitially = true) {
  let current = mode;
  // Whether another computer is in this device's account (a lone leader has none).
  let peer = peerInitially;
  const roleListeners: ((r: SyncRoleWire) => void)[] = [];
  const appliedListeners: ((tables: string[], meta: { prefKeys: string[] }) => void)[] = [];
  const role = (): SyncRoleWire => ({
    leader: current === 'leader',
    follower: current === 'copy',
    multiDevice: peer || current === 'copy',
    epoch: 1,
    priorRenewedAt: null,
    reason: current === 'leader' ? 'solo' : 'follower',
  });
  return {
    readOnly: () => current !== 'leader',
    role,
    onRole: (cb: (r: SyncRoleWire) => void) => void roleListeners.push(cb),
    onApplied: (cb: (tables: string[], meta: { prefKeys: string[] }) => void) => void appliedListeners.push(cb),
    /** Another computer joins (true) or leaves (false) this device's account. */
    setPeer(next: boolean, notify = true) {
      peer = next;
      if (notify) for (const cb of roleListeners) cb(role());
    },
    set(next: FakeMode) {
      current = next;
      for (const cb of roleListeners) cb(role());
    },
    applied(tables: string[]) {
      for (const cb of appliedListeners) cb(tables, { prefKeys: [] });
    },
  };
}

export interface Device {
  deps: SharedFoldersDeps;
  dir: string;
  db: AppDb;
  sync: ReturnType<typeof fakeSync>;
  svc: SharedFolders;
  trashed: string[];
  hashed: string[];
  logs: string[];
  clock: { t: number };
  /** A fresh service over the same database file (a restart). */
  restart(): Promise<SharedFolders>;
  close(): Promise<void>;
}

const devices: Device[] = [];

/** A device is, by default, joined to an account with a peer: shared folders are
 *  on. `{ alone: true }` is a Mac with no other computer in its account. */
export async function device(
  mode: FakeMode = 'leader',
  over: Partial<SharedFoldersDeps> = {},
  opts: { alone?: boolean } = {},
): Promise<Device> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-'));
  const db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  const sync = fakeSync(mode, !opts.alone);
  const trashed: string[] = [];
  const hashed: string[] = [];
  const logs: string[] = [];
  const clock = { t: 1_000_000 };
  const { createHash } = await import('node:crypto');
  // Default: no real watcher in tests; they drive the service with kick().
  const deps = (): SharedFoldersDeps => ({
    watch: () => ({ close: async () => {} }),
    debounceMs: 0,
    db,
    sync,
    hashFile: async (p) => {
      hashed.push(p);
      return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    },
    trash: async (p) => {
      trashed.push(p);
      fs.rmSync(p, { force: true });
    },
    now: () => clock.t,
    log: (_l, m) => void logs.push(m),
    ...over,
  });
  const d: Device = {
    deps: deps(),
    dir,
    db,
    sync,
    svc: await createSharedFolders(deps()),
    trashed,
    hashed,
    logs,
    clock,
    restart: async () => {
      await d.svc.close();
      return (d.svc = await createSharedFolders(deps()));
    },
    close: async () => {
      await d.svc.close();
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  devices.push(d);
  return d;
}

export async function closeDevices(): Promise<void> {
  for (const d of devices.splice(0)) await d.close();
}

/** Makes `<dir>/incoming` and `<dir>/sorted` and points the service at them. */
export async function withRoots(d: Device): Promise<{ incoming: string; sorted: string }> {
  const incoming = path.join(d.dir, 'incoming');
  const sorted = path.join(d.dir, 'sorted');
  fs.mkdirSync(incoming, { recursive: true });
  fs.mkdirSync(sorted, { recursive: true });
  await d.svc.setRoots({ incoming, sorted });
  return { incoming, sorted };
}
