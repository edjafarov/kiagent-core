/** A follower reads, and applies what the master sends, and writes nothing
 *  else (spec 7.6). The role is set by the swap at boot and read once, so no
 *  device changes role while running. */
import type BetterSqlite3 from 'better-sqlite3';

import type { Handle } from '@shared/contracts';

import type { AppDb } from '../../db/app-db';

export type SyncRole = 'normal' | 'follower';

export class SyncReadOnly extends Error {
  constructor(what: string) {
    super(`this device is a read-only copy: ${what}`);
    this.name = 'SyncReadOnly';
  }
}

export function readRoleSync(conn: BetterSqlite3.Database): SyncRole {
  const r = conn.prepare(`SELECT role FROM sync_state`).get() as
    | { role: SyncRole }
    | undefined;
  return r?.role ?? 'normal';
}

export async function readSyncRole(db: AppDb): Promise<SyncRole> {
  const rows = await db.all(`SELECT role FROM sync_state`);
  return (rows[0]?.role as SyncRole | undefined) ?? 'normal';
}

const idleHandle = (): Handle => ({
  status: 'paused',
  stats: async () => ({ pending: 0, done: 0, skipped: 0, failed: 0, deferred: 0 }),
  stop: async () => undefined,
});

const REFUSED = [
  'connect',
  'reconnect',
  'applyScope',
  'remove',
  'pause',
  'resume',
  'updateConfig',
  'setOption',
] as const;

/** Everything that starts work goes through these, whichever path calls them:
 *  boot's attachWorker, the bundled workers and the cadence tick. */
export function applyFollowerGate(engine: {
  run: unknown;
  attach: unknown;
  rerunDeferred: unknown;
}): void {
  const e = engine as Record<string, unknown>;
  e.run = () => idleHandle();
  e.attach = () => idleHandle();
  e.rerunDeferred = async () => undefined;
  for (const m of REFUSED) {
    e[m] = async () => {
      throw new SyncReadOnly(m);
    };
  }
}

/** A follower sends nothing, whichever path asks: the master owns every effect
 *  outside the device (spec 7.6). Finding no sender is what callers already
 *  handle for an account that can't send. */
export function followerLookup<T extends { get(id: string): unknown }>(
  lookup: T,
  readOnly: boolean,
): T {
  if (!readOnly) return lookup;
  const gated = Object.create(lookup) as T;
  gated.get = (() => undefined) as T['get'];
  return gated;
}
