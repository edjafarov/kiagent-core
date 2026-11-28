/** A follower reads, and applies what the master sends, and writes nothing
 *  else (spec 7.6). The role flips while the app runs (lease loss, promotion);
 *  the gate follows it and the running work is held or resumed with it. */
import type BetterSqlite3 from 'better-sqlite3';

import type {
  Account,
  AccountId,
  Connected,
  Credentials,
  FolderScopeUpdate,
  Handle,
  LeaseSnapshot,
  SyncRoleWire,
} from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import { isDeviceOwned } from './sources';

export type SyncRole = 'normal' | 'follower';

export class SyncReadOnly extends Error {
  readonly code = 'SYNC_READ_ONLY';

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
  'adopt',
  'commitReauth',
  'remove',
  'pause',
  'resume',
  'updateConfig',
  'setOption',
] as const;

/** What a read-only copy hands to the leader instead of refusing: the commit
 *  half of a connect or a reconnect, a folder-scope change, and a usable
 *  login for a flow that reads the provider. */
/** Names an account for its queue: by id, or by what a connect will create. */
export type AccountRef =
  | { accountId: string }
  | { source: string; identifier: string };

export interface RelayContext {
  /** Shown while a finished sign-in waits for the leader. */
  status?(msg: string): void;
  /** The flow's cancel: it ends the wait. */
  signal?: AbortSignal;
  /** False once this device leads: the wait ends with `LeadsNow` and the
   *  gate commits the result here. */
  stillCopy?(): boolean;
}

/** This device started leading while a finished sign-in waited for the
 *  leader: there is nobody to send it to, and no need. */
export class LeadsNow extends Error {
  constructor() {
    super('this device leads now');
    this.name = 'LeadsNow';
  }
}

export interface AccountRelay {
  adopt(c: Connected, ctx?: RelayContext): Promise<Account>;
  commitReauth(
    r: { accountId: AccountId; credentials: Credentials | null },
    ctx?: RelayContext,
  ): Promise<void>;
  applyScope(
    accountId: AccountId,
    update: FolderScopeUpdate,
    configAtOpen: string,
  ): Promise<{ archived: number }>;
  credentials(accountId: AccountId): Promise<Credentials | null>;
}

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
  log: (level: 'info' | 'warn' | 'error', msg: string) => void = () =>
    undefined,
  /** Asked per call: with none, a copy refuses as it always did. */
  relay: () => AccountRelay | null = () => null,
  /** Runs a commit that happens on this device in the account's queue, so it
   *  never overlaps another change to the same account (`account-ops`). */
  serial: <T>(ref: AccountRef, fn: () => Promise<T>) => Promise<T> = (
    _ref,
    fn,
  ) => fn(),
): {
  attachHeld(): Promise<void>;
  closeWriter(): Promise<void>;
  /** Ends the hold, so a resume's account runs start. `attachHeld` calls it. */
  release(): Promise<void>;
  holding(): boolean;
} {
  const e = engine as Record<string, (...a: unknown[]) => unknown>;
  const real = { ...e };
  // Attach proxies waiting for `attachHeld`, and the proxies with work running.
  const held: GatedHandle[] = [];
  const live = new Set<GatedHandle>();
  // A `Handle` has no completion signal, so a run is replaced by the next run
  // for the same account (the engine stops its previous handle itself).
  const runs = new Map<string, GatedHandle>();
  let holding = false;
  // The quiesce in flight: a resume waits for it, or it finds `held` empty.
  let closing: Promise<void> | null = null;
  const start = (p: GatedHandle, fn: () => unknown): GatedHandle => {
    p.inner = fn() as Handle;
    live.add(p);
    return p;
  };
  e.run = (...a) => {
    const id = (a[0] as { id: string } | undefined)?.id ?? '';
    const p = new GatedHandle('run', a[0], (h) => live.delete(h));
    if (holding || owned.ownedByOther?.(id)) return p;
    if (readOnly() && !owned.ownsAccount(id)) return p;
    const prev = runs.get(id);
    if (prev) live.delete(prev);
    runs.set(id, p);
    return start(p, () => real.run.apply(engine, a));
  };
  e.attach = (...a) => {
    const p = new GatedHandle('attach', a[0], (h) => live.delete(h));
    if (holding || readOnly()) {
      held.push(p);
      return p;
    }
    return start(p, () => real.attach.apply(engine, a));
  };
  e.rerunDeferred = async (...a) =>
    readOnly() || holding ? undefined : real.rerunDeferred.apply(engine, a);
  // A flow on a copy that reads the provider (the folder list) uses the
  // mirrored login while it is good and asks the leader when it is about to
  // expire: a copy never refreshes or saves a login.
  if (typeof real.session === 'function')
    e.session = (...a) => {
      const account = a[0] as { id?: string } | undefined;
      // Asked on every call for a login, not when the session was made: the
      // role can change while a folder picker is open.
      return real.session.call(engine, a[0], a[1], a[2], () => {
        const r = relay();
        return r && readOnly() && account?.id && !owned.ownsAccount(account.id)
          ? r.credentials(account.id as AccountId)
          : undefined;
      });
    };
  /** Does this device own what the call names? `connect` and `adopt` name a
   *  source; every other verb names an account. */
  const mineOf = (m: string, a: unknown[]): boolean => {
    const first = a[0] as
      | { descriptor?: { id?: string }; sourceId?: string; accountId?: string }
      | string
      | undefined;
    if (m === 'connect')
      return owned.ownsSource(
        (first as { descriptor?: { id?: string } } | undefined)?.descriptor
          ?.id ?? '',
      );
    if (m === 'adopt')
      return owned.ownsSource(
        (first as { sourceId?: string } | undefined)?.sourceId ?? '',
      );
    if (m === 'commitReauth')
      return owned.ownsAccount(
        (first as { accountId?: string } | undefined)?.accountId ?? '',
      );
    return typeof first === 'string' && owned.ownsAccount(first);
  };
  /** Another device writes for this call. Asked again at every step of a
   *  flow: the role can change while the person signs in. */
  const elsewhere = (m: string, a: unknown[]): boolean =>
    readOnly() && !mineOf(m, a);
  for (const m of REFUSED) {
    e[m] = async (...a) => {
      // Connect and reconnect always run in two halves, whoever leads when
      // they start: the person's part first (it writes nothing), and then the
      // commit goes to whoever writes at that moment. A sign-in takes minutes
      // and the role can change either way while it runs.
      if (
        (m === 'connect' || m === 'reconnect') &&
        typeof real[m === 'connect' ? 'connectAuth' : 'reauth'] === 'function'
      ) {
        const half = m === 'connect' ? 'connectAuth' : 'reauth';
        const commit = m === 'connect' ? 'adopt' : 'commitReauth';
        // No sign-in is started that nobody could take.
        if (elsewhere(m, a) && !relay()) throw new SyncReadOnly(m);
        const auth = a[1] as RelayContext | undefined;
        const produced = await real[half].apply(engine, a);
        const r = relay();
        if (!elsewhere(m, a)) return e[commit](produced);
        if (!r) throw new SyncReadOnly(m);
        const ctx: RelayContext = {
          status: (msg) => auth?.status?.(msg),
          signal:
            m === 'connect' ? auth?.signal : (a[2] as AbortSignal | undefined),
          stillCopy: () => elsewhere(m, a),
        };
        try {
          return m === 'connect'
            ? await r.adopt(produced as Connected, ctx)
            : await r.commitReauth(
                produced as {
                  accountId: AccountId;
                  credentials: Credentials | null;
                },
                ctx,
              );
        } catch (err) {
          if (err instanceof LeadsNow) return e[commit](produced);
          throw err;
        }
      }
      if (elsewhere(m, a)) {
        // Every other verb reaches the leader as its whole handler
        // (forward-core), so called directly it is still refused.
        const r = relay();
        if (r && m === 'applyScope')
          return r.applyScope(
            a[0] as AccountId,
            a[1] as FolderScopeUpdate,
            a[2] as string,
          );
        throw new SyncReadOnly(m);
      }
      // The three commits take their place in the account's queue here, so
      // the leader's own flow, a copy's relayed commit and a plain handler
      // (pause, options) never overlap on one account.
      const first = a[0] as
        | { sourceId?: string; identifier?: string; accountId?: string }
        | string
        | undefined;
      let ref: AccountRef | null = null;
      if (m === 'adopt' && typeof first === 'object')
        ref = {
          source: first.sourceId ?? '',
          identifier: first.identifier ?? '',
        };
      else if (m === 'commitReauth' && typeof first === 'object')
        ref = { accountId: first.accountId ?? '' };
      else if (m === 'applyScope' && typeof first === 'string')
        ref = { accountId: first };
      const result = ref
        ? await serial(ref, async () => {
            // Asked again when its turn comes: a commit that waited in the
            // queue while this device stopped leading saves nothing here.
            if (elsewhere(m, a)) throw new SyncReadOnly(m);
            return real[m].apply(engine, a);
          })
        : await real[m].apply(engine, a);
      if (readOnly()) await owned.loadOwned?.();
      return result;
    };
  }
  const closeNow = async (): Promise<void> => {
    holding = true;
    const proxies = [...live];
    // Every stop is called before any is awaited.
    const stops = proxies.map((p) => {
      try {
        return Promise.resolve(p.inner?.stop());
      } catch (err) {
        return Promise.reject(err);
      }
    });
    const settled = await Promise.allSettled(stops);
    const errors = settled.flatMap((r) =>
      r.status === 'rejected' ? [r.reason] : [],
    );
    for (const p of proxies) {
      live.delete(p);
      if (p.kind === 'run')
        for (const [k, v] of runs) if (v === p) runs.delete(k);
      p.inner = null;
      if (p.kind === 'attach' && !p.stopped && !held.includes(p)) {
        held.push(p);
      }
    }
    if (errors.length) {
      log(
        'warn',
        `closeWriter: ${errors.length} handle(s) failed to stop: ${errors
          .map(String)
          .join('; ')}`,
      );
    }
  };

  const release = async (): Promise<void> => {
    // A closeWriter started during the await replaces `closing`: wait for it too.
    while (closing) await closing;
    holding = false;
  };

  return {
    holding: () => holding,
    /** Safe to call twice: a second call re-stops the same inners, and stop is
     *  idempotent. */
    closeWriter() {
      const run: Promise<void> = closeNow().finally(() => {
        if (closing === run) closing = null;
      });
      closing = run;
      return run;
    },
    release,
    async attachHeld() {
      await release();
      // Still read-only (a cancelled join on a follower): keep them held.
      if (readOnly()) return;
      for (const p of held.splice(0)) {
        if (p.stopped) continue;
        start(p, () => real.attach.call(engine, p.worker));
      }
    },
  };
}

/** What `run` and `attach` return: a proxy over the real handle, so the gate
 *  can stop the work and, for an attach, start it again later. */
export class GatedHandle {
  inner: Handle | null = null;

  stopped = false;

  constructor(
    readonly kind: 'run' | 'attach',
    readonly worker: unknown,
    private readonly release: (h: GatedHandle) => void,
  ) {}

  get status(): Handle['status'] {
    return this.inner ? this.inner.status : 'paused';
  }

  stats(): ReturnType<Handle['stats']> {
    return this.inner ? this.inner.stats() : idleHandle().stats();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.release(this);
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
