/** A follower reads, and applies what the master sends, and writes nothing
 *  else (spec 7.6). The role is set by the swap at boot and read once, so no
 *  device changes role while running. */
import type BetterSqlite3 from 'better-sqlite3';

import type { Handle, LeaseSnapshot, SyncRoleWire } from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import { isDeviceOwned } from './sources';

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
  /** This device led with change tracking on before it stopped. */
  tracking: boolean;
}

export const gateFrom = (g: Pick<SyncGate, 'role' | 'joining'>): boolean =>
  g.role === 'follower' || g.joining;

export type SyncPhase =
  | 'alone'
  | 'joining'
  | 'leader'
  | 'leader-fenced'
  | 'follower';

/** The phase of this device from its sync_state row and the write fence. */
export function phaseOf(g: {
  role: SyncRole;
  joining: boolean;
  joined: boolean;
  tracking: boolean;
  fenced: boolean;
}): SyncPhase {
  if (g.role === 'follower') return 'follower';
  if (g.joining) return 'joining';
  if (g.tracking) return g.fenced ? 'leader-fenced' : 'leader';
  return 'alone';
}

/** The phase a device wakes in, from one `sync_state` read. A tracking leader
 *  wakes fenced (another device may lead by now); a seed (tracking 0) and a
 *  follower are never fenced. The writer worker and main both ask this. */
export const bootPhase = (g: SyncGate): SyncPhase =>
  phaseOf({ ...g, fenced: g.tracking && !gateFrom(g) });

export const canWrite = (p: SyncPhase): boolean =>
  p === 'alone' || p === 'leader';

/** The one leader fact, from the phase and the lease snapshot (spec K2). */
export function roleOf(i: {
  phase: SyncPhase;
  lease: LeaseSnapshot | null;
}): Pick<SyncRoleWire, 'leader' | 'follower' | 'reason'> {
  const { phase, lease } = i;
  switch (phase) {
    case 'follower':
    case 'joining':
      return {
        leader: false,
        follower: true,
        reason: lease?.reason ?? 'follower-copy',
      };
    case 'leader-fenced':
      if (!lease)
        return { leader: false, follower: false, reason: 'fenced-boot' };
      return {
        leader: false,
        follower: lease.isMaster ? false : lease.multiDevice,
        reason: lease.reason,
      };
    case 'leader':
      return { leader: true, follower: false, reason: lease?.reason ?? 'solo' };
    default: // 'alone'
      if (!lease) return { leader: true, follower: false, reason: 'solo' };
      return lease.isMaster
        ? { leader: true, follower: false, reason: lease.reason }
        : { leader: false, follower: lease.multiDevice, reason: lease.reason };
  }
}

export class SyncEpochBehind extends Error {
  constructor(
    message = 'a grant is never older than what this copy applied from',
  ) {
    super(message);
    this.name = 'SyncEpochBehind';
  }
}

export class SyncNotLeader extends Error {
  constructor(message = 'open() on a follower or a joining device') {
    super(message);
    this.name = 'SyncNotLeader';
  }
}

export class SyncHeadPending extends Error {
  constructor(message = "open('lease') while head_pending = 1") {
    super(message);
    this.name = 'SyncHeadPending';
  }
}

const toGate = (
  r:
    | { role?: SyncRole; joining?: number; joined?: number; tracking?: number }
    | undefined,
): SyncGate => ({
  role: r?.role ?? 'normal',
  joining: r?.joining === 1,
  joined: r?.joined === 1,
  tracking: r?.tracking === 1,
});

export function readGateSync(conn: BetterSqlite3.Database): SyncGate {
  return toGate(
    conn
      .prepare(`SELECT role, joining, joined, tracking FROM sync_state`)
      .get() as
      | { role: SyncRole; joining: number; joined: number; tracking: number }
      | undefined,
  );
}

export async function readSyncGate(db: AppDb): Promise<SyncGate> {
  const rows = await db.all(
    `SELECT role, joining, joined, tracking FROM sync_state`,
  );
  return toGate(
    rows[0] as
      | { role: SyncRole; joining: number; joined: number; tracking: number }
      | undefined,
  );
}

const idleHandle = (): Handle => ({
  status: 'paused',
  stats: async () => ({
    pending: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    deferred: 0,
  }),
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
  owned: {
    ownsAccount(id: string): boolean;
    ownsSource(source: string): boolean;
    /** Another device owns this account: it never runs here, whatever the
     *  role, so a master cannot scan a follower's path. */
    ownedByOther?(id: string): boolean;
    /** Re-reads who owns what; called after a verb that may have created or
     *  removed an owned account. */
    loadOwned?(): Promise<void>;
  } = {
    ownsAccount: () => false,
    ownsSource: () => false,
  },
): { attachHeld(): Promise<void> } {
  const e = engine as Record<string, (...a: unknown[]) => unknown>;
  const real = { ...e };
  const held: { worker: unknown; proxy: HeldHandle }[] = [];
  e.run = (...a) => {
    const id = (a[0] as { id: string } | undefined)?.id ?? '';
    if (owned.ownedByOther?.(id)) return idleHandle();
    return readOnly() && !owned.ownsAccount(id)
      ? idleHandle()
      : real.run.apply(engine, a);
  };
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
            ? owned.ownsSource(
                (a[0] as { descriptor?: { id?: string } } | undefined)
                  ?.descriptor?.id ?? '',
              )
            : typeof a[0] === 'string' && owned.ownsAccount(a[0]);
        if (!mine) throw new SyncReadOnly(m);
      }
      const result = await real[m].apply(engine, a);
      if (readOnly()) await owned.loadOwned?.();
      return result;
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

/** Who may send for a device-owned account. A WhatsApp socket lives on the
 *  device that paired it, so its send runs there whatever that device's role
 *  and nowhere else (step 4, decision 5). */
export interface SendOwnership {
  /** A joined follower runs this device-owned account (from memory). */
  ownsAccount(accountId: string): boolean;
  /** `accounts.owner_device_id` of the account, or null when it has none. */
  ownerOf(accountId: string): Promise<string | null>;
  /** This device's id, once it has one. */
  deviceId(): string | null;
  /** What to call a device in the refusal; its short id when unknown. */
  deviceName?(deviceId: string): string;
}

/** The sentence a send off the owner is refused with. It starts `not sent: `,
 *  the outbound layer's mark for a failure proven to precede any delivery, and
 *  names a device, never a login. */
export const sendFromMessage = (device: string): string =>
  `not sent: Send from ${device}`;

/** A sender of a device-owned source, gated per account instead of per role. */
function ownedSender<S extends { send(...a: never[]): Promise<unknown> }>(
  real: S,
  readOnly: () => boolean,
  owner: SendOwnership,
): S {
  const gated = Object.create(real) as S;
  (gated as { send: unknown }).send = async (
    intent: { accountId: string },
    ctx?: unknown,
  ) => {
    const id = intent?.accountId;
    if (!owner.ownsAccount(id)) {
      const ownerId = await owner.ownerOf(id);
      const mine = ownerId === null || ownerId === owner.deviceId();
      // The leader sends for an account it paired or that has no owner yet;
      // a follower sends only for what ownsAccount said above.
      if (!mine || readOnly()) {
        const name = ownerId
          ? (owner.deviceName?.(ownerId) ?? ownerId.slice(0, 8))
          : 'the device that paired it';
        throw new Error(sendFromMessage(name));
      }
    }
    return (real.send as (...a: unknown[]) => Promise<unknown>).call(
      real,
      intent,
      ctx,
    );
  };
  return gated;
}

/** A follower sends nothing, whichever path asks: the master owns every effect
 *  outside the device (spec 7.6). Finding no sender is what callers already
 *  handle for an account that can't send. Asked per call (step 2). A
 *  device-owned source is the exception (step 4): its sender is always found
 *  and refuses per account, because the owner sends at any role. */
export function followerLookup<T extends { get(id: string): unknown }>(
  lookup: T,
  readOnly: () => boolean,
  owner?: SendOwnership,
): T {
  const gated = Object.create(lookup) as T;
  gated.get = ((id: string) => {
    const real = lookup.get(id);
    if (owner && real && isDeviceOwned(id)) {
      return ownedSender(real as never, readOnly, owner);
    }
    return readOnly() ? undefined : real;
  }) as T['get'];
  return gated;
}
