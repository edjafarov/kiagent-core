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

/** What a device may do is decided by two facts: its role, and whether it is
 *  mid-join (spec 7.7). A joining device is read-only like a follower, and
 *  stays so across restarts until the swap or Stop syncing clears it. */
export interface SyncGate {
  role: SyncRole;
  joining: boolean;
  joined: boolean;
}

export const gateFrom = (g: Pick<SyncGate, 'role' | 'joining'>): boolean =>
  g.role === 'follower' || g.joining;

const toGate = (r: { role?: SyncRole; joining?: number; joined?: number } | undefined): SyncGate => ({
  role: r?.role ?? 'normal',
  joining: r?.joining === 1,
  joined: r?.joined === 1,
});

export function readGateSync(conn: BetterSqlite3.Database): SyncGate {
  return toGate(
    conn.prepare(`SELECT role, joining, joined FROM sync_state`).get() as
      | { role: SyncRole; joining: number; joined: number }
      | undefined,
  );
}

export async function readSyncGate(db: AppDb): Promise<SyncGate> {
  const rows = await db.all(`SELECT role, joining, joined FROM sync_state`);
  return toGate(rows[0] as { role: SyncRole; joining: number; joined: number } | undefined);
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
 *  boot's attachWorker, the bundled workers and the cadence tick. The role is
 *  asked on every call, so a promotion opens the same engine without a
 *  restart. A worker attached while read-only is remembered, and `attachHeld`
 *  attaches it for real; the handle given back at the time follows it. */
export function gateEngine(
  engine: { run: unknown; attach: unknown; rerunDeferred: unknown },
  readOnly: () => boolean,
  /** Device-owned accounts run on their owner whatever its role (step 3):
   *  asked per call, so a promotion or a new folder changes nothing here. */
  owned: { ownsAccount(id: string): boolean; ownsSource(source: string): boolean } = {
    ownsAccount: () => false,
    ownsSource: () => false,
  },
): { attachHeld(): Promise<void> } {
  const e = engine as Record<string, (...a: unknown[]) => unknown>;
  const real = { ...e };
  const held: { worker: unknown; proxy: HeldHandle }[] = [];
  e.run = (...a) =>
    readOnly() && !owned.ownsAccount((a[0] as { id: string } | undefined)?.id ?? '')
      ? idleHandle()
      : real.run.apply(engine, a);
  e.attach = (...a) => {
    if (!readOnly()) return real.attach.apply(engine, a);
    const proxy = new HeldHandle();
    held.push({ worker: a[0], proxy });
    return proxy;
  };
  e.rerunDeferred = async (...a) =>
    readOnly() ? undefined : real.rerunDeferred.apply(engine, a);
  for (const m of REFUSED) {
    e[m] = async (...a) => {
      if (readOnly()) {
        // `connect` names a source; every other verb names an account.
        const mine =
          m === 'connect'
            ? owned.ownsSource((a[0] as { descriptor?: { id?: string } } | undefined)?.descriptor?.id ?? '')
            : typeof a[0] === 'string' && owned.ownsAccount(a[0]);
        if (!mine) throw new SyncReadOnly(m);
      }
      return real[m].apply(engine, a);
    };
  }
  return {
    async attachHeld() {
      for (const h of held.splice(0)) {
        if (h.proxy.stopped) continue;
        h.proxy.inner = real.attach.call(engine, h.worker) as Handle;
      }
    },
  };
}

/** What `attach` returned while the device was read-only. */
class HeldHandle {
  inner: Handle | null = null;
  stopped = false;
  get status(): Handle['status'] {
    return this.inner ? this.inner.status : 'paused';
  }
  stats(): ReturnType<Handle['stats']> {
    return this.inner ? this.inner.stats() : idleHandle().stats();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.inner?.stop();
  }
}

/** A follower sends nothing, whichever path asks: the master owns every effect
 *  outside the device (spec 7.6). Finding no sender is what callers already
 *  handle for an account that can't send. Asked per call (step 2). */
export function followerLookup<T extends { get(id: string): unknown }>(
  lookup: T,
  readOnly: () => boolean,
): T {
  const gated = Object.create(lookup) as T;
  gated.get = ((id: string) => (readOnly() ? undefined : lookup.get(id))) as T['get'];
  return gated;
}
