/** What a sync extension calls (spec 7.6). Writes go to the one writer. Building
 *  a delta, a snapshot, and hashing up to 14 GB run on their own query-only
 *  worker, so neither the window nor ingest waits for them. */
import fs from 'node:fs';

import type {
  ForwardRequestWire,
  ForwardResultWire,
  OfferedSettingsWire,
  LeaseSnapshot,
  SecretWire,
  SyncRoleWire,
  SyncStatusWire,
} from '@shared/contracts';
import type { AppDb } from '../../db/app-db';
import { openDbInWorker } from '../../db/worker-client';
import type { CoreStore } from '../store/store';
import type { ImportSourcesResult } from '../store/write-tx';
import type { DeltaResult, SyncCursor } from './delta';
import {
  MAX_HANDLER_ATTEMPTS,
  QUEUED_SETTINGS_SQL,
  queuedSettingsOf,
  type QueuedSetting,
} from './settings-queue';
import {
  DEVICE_OWNED_SOURCES,
  exportSources,
  isDeviceOwned,
  isStableIdentity,
  deviceSuffix,
  OWNER_OPEN_SQL,
  ownedByThisDeviceSql,
  PAUSE_MOVED_SQL,
  type ExportSources,
  type OfferedSource,
} from './sources';
import {
  canWrite,
  phaseOf,
  roleOf,
  SyncHeadPending,
  SyncNotLeader,
  type SyncPhase,
  type SyncRole,
} from './role';
import { archiveFiles, swapOutcomePath } from './status';
import { dropPendingSwap } from './swap';

export type Secret = SecretWire;
export type ForwardRequest = ForwardRequestWire;
export type ForwardResult = ForwardResultWire;

/** What an applied delta carried besides table names. */
export interface AppliedMeta {
  prefKeys: string[];
  pullStartedAt?: number;
}

/** A keyed row of `sync_outbound` left the queue. */
export interface QueueChange {
  kind: 'delivered' | 'discarded';
  rowId: number;
  coalesceKey: string | null;
}

export type Forwarder = (req: ForwardRequest) => Promise<ForwardResult>;

/** What the leader runs for a forwarded request. Bound once, by main, after the
 *  extension platform exists. */
export interface ForwardRunners {
  ui(extensionId: string, name: string, payload: unknown): Promise<unknown>;
  core(name: string, payload: unknown): Promise<unknown>;
  commit(payload: unknown): Promise<unknown>;
}

/** One shape: the wire type. */
export type DeviceSyncStatus = SyncStatusWire;

export interface SyncService {
  status(): Promise<DeviceSyncStatus>;
  /** `fromEpoch`: the epoch the asker last applied from; absent, none is
   *  rewound. */
  buildDelta(
    after: SyncCursor,
    out: string,
    capBytes: number,
    fromEpoch?: number,
  ): Promise<DeltaResult>;
  buildSnapshot(
    out: string,
  ): Promise<{ bytes: number; target: SyncCursor; sha256: string }>;
  /** `pullStartedAt`: when the pull that fetched the stage began, so a queued
   *  setting the leader acknowledged later is not released by an older delta. */
  applyDelta(
    stagePath: string,
    opts?: { pullStartedAt?: number },
  ): Promise<{
    applied: number;
    target: SyncCursor;
    tables: string[];
    prefKeys: string[];
  }>;
  /** Tells `cb` which copied tables each applied delta touched, so extensions
   *  can refresh (platform bus event `sync.applied`). Core-internal. */
  onApplied(cb: (tables: string[], meta: AppliedMeta) => void): void;
  prepareSwap(
    file: string,
    sha256: string,
    masterDeviceId: string,
  ): Promise<'ready' | 'no-disk' | 'invalid'>;
  /** Next boot, this device goes back to its archived data. */
  prepareRestore(): Promise<'ready' | 'no-archive'>;
  /** Hands a write to the leader through the forwarder `remote-mcp` installed.
   *  No forwarder, or one that throws, is `no-master`: never an exception. */
  forward(req: ForwardRequest): Promise<ForwardResult>;
  setForwarder(f: Forwarder | null): void;
  /** Installed by main once the preferences and the extension platform exist:
   *  how this device reads its offerable settings and adds a joiner's. */
  setSettingsOffer(h: SettingsOffer | null): void;
  /** What this device would add to a join offer (spec 7.9 rule 6). */
  exportSettings(): Promise<OfferedSettingsWire>;
  /** Master side: adds the keys and connectors this device lacks, once per
   *  offer id. Master wins; a follower refuses. */
  importSettings(
    offerId: string,
    settings: OfferedSettingsWire,
  ): Promise<{ prefs: string[]; extensions: string[] }>;
  setRunners(r: ForwardRunners | null): void;
  /** Runs a forwarded request on the leader, with no ledger: every forwarded
   *  handler is an idempotent upsert. A follower refuses. */
  runForwarded(req: ForwardRequest): Promise<ForwardResult>;
  /** Writes `sync_outbound`: a result that waits for a reachable leader.
   *  Returns the row id. With a `coalesceKey` the older row of that key is
   *  replaced in the same transaction. */
  enqueue(req: ForwardRequest, opts?: { coalesceKey: string }): Promise<number>;
  /** Tells `cb` when a keyed row was delivered or discarded. Core-internal. */
  onQueueChange(cb: (e: QueueChange) => void): void;
  /** The settings still waiting, one per key, newest. */
  queuedSettings(): Promise<QueuedSetting[]>;
  /** Drops a waiting setting. Only a keyed row can be dropped. */
  discardQueued(rowId: number): Promise<void>;
  /** Sends each waiting row, in order, to the leader (or runs it here when
   *  this device leads now). A row is deleted only on success. */
  drainOutbound(): Promise<{ sent: number; waiting: number }>;
  /** The keys the swap kept for an owner-capture table. */
  retained(table: string): Promise<string[]>;
  /** The id this device is known by to its siblings. The extension that owns
   *  the device key supplies it at every activation. */
  setDeviceId(id: string): Promise<void>;
  /** After an account batch committed here: when this device is a follower and
   *  owns the account, queue it (split under 16 MiB) for the leader. `gone` is
   *  the account row read before a removal. True when something was queued. */
  /** Reads the stored device id and the accounts this device owns, once at
   *  boot, before any account starts. */
  loadOwned(): Promise<void>;
  /** Is this account run by this device (device-owned and mine)? From memory. */
  ownsAccount(accountId: string): boolean;
  /** Is this source device-owned? */
  ownsSource(source: string): boolean;
  /** The extension that owns the device list tells core what to call each
   *  device. Replaces the previous list. */
  setDeviceNames(list: { deviceId: string; label: string }[]): Promise<void>;
  /** What to call a device: its label, else its first 8 characters. */
  deviceName(deviceId: string): string;
  /** The leader's name, when this device follows one. From memory. */
  masterName(): string | null;
  /** Does another device own this account? It never runs here, whatever this
   *  device's role (final review). From memory. */
  ownedByOther(accountId: string): boolean;
  /** Sets `joining=1` and nothing else: the caller restarts, because the
   *  gates are read at boot (spec 7.7). */
  beginJoin(): Promise<void>;
  /** What to offer `toDevice`. Records the moveable accounts in `sync_moved`
   *  first, so a crash after the offer can't lose track of a login. */
  exportSources(toDevice: string): Promise<OfferedSource[]>;
  /** Does this device hold a login it could move? A vault row on a moveable
   *  account, or a connector hook that can mint one. Reads only. */
  hasMoveableLogins(): Promise<boolean>;
  /** After the swap: the moved logins are deleted by their original ids, the
   *  device counts as joined for good, and its own device-owned accounts run
   *  again as their owner. Safe to repeat. */
  finishJoin(): Promise<void>;
  /** Stop syncing: drop a pending swap and clear `joining`. Accounts in
   *  `sync_moved` boot paused. */
  leaveJoin(): Promise<void>;
  /** The seed is gone: its accounts run here again. */
  forgetMoved(): Promise<void>;
  /** Can this device take someone else's logins right now? */
  canAcceptSources(): boolean;
  /** Takes an offer from `from` (the authenticated sibling). Encrypts first
   *  with the strict encrypt, then imports in one transaction. */
  importSources(
    offerId: string,
    list: OfferedSource[],
    from: string,
  ): Promise<ImportSourcesResult>;
  /** The logins stamped above `after`, decrypted here in main; a removed login
   *  has `value: null`. Meant for the secrets route only, over the mutually
   *  authenticated channel: never written to a file or a log. */
  exportSecrets(after: { epoch: number; n: number }): Promise<Secret[]>;
  /** Stores logins from the leader, each encrypted with the strict keystore
   *  first: if one fails nothing is written. Only a follower takes them. */
  importSecrets(list: Secret[]): Promise<{ applied: number }>;
  /** Why this device must not restart or be interrupted right now, if so. */
  isBusy(): string | null;
  /** Follower, joining or fenced, answered from memory. Every gate on the main
   *  side (engine, sender lookup, scheduled sends) asks this on each call. */
  readOnly(): boolean;
  /** The lease snapshot registration last reported. A device that leads but is
   *  not the master closes at once (and stays closed until `open`). */
  setLease(s: LeaseSnapshot): Promise<void>;
  /** Starts leading: promotes a follower into `epoch` (left fenced, its head
   *  pending) or seeds a lone device. Never opens the fence. */
  lead(opts: { epoch: number; relayImported?: boolean }): Promise<void>;
  /** The one exit from the fence. `'head-acked'` clears a promotion's pending
   *  acknowledgement; `'lease'` refuses while one is pending. */
  open(kind: 'head-acked' | 'lease'): Promise<void>;
  /** Stops leading: a follower of `masterDeviceId`. The caller relaunches. */
  demote(masterDeviceId: string): Promise<void>;
  /** This device's id, once known. */
  deviceId(): string | null;
  /** The one leader fact, from memory. */
  role(): SyncRoleWire;
  /** Tells `cb` when the role changes. Core-internal. */
  onRole(cb: (r: SyncRoleWire) => void): void;
  /** The last lease snapshot, or null before the first. */
  lease(): LeaseSnapshot | null;
  /** Deletes the old database a join set aside. Restoring it is then gone. */
  deleteArchive(): Promise<void>;
  close(): Promise<void>;
}

export interface SettingsOffer {
  export(): Promise<OfferedSettingsWire>;
  import(
    s: OfferedSettingsWire,
  ): Promise<{ prefs: string[]; extensions: string[] }>;
}

export interface SyncServiceDeps {
  db: AppDb;
  store: Pick<
    CoreStore,
    | 'applySyncDelta'
    | 'importSyncSources'
    | 'importSyncSecrets'
    | 'read'
    | 'vault'
  >;
  dbPath: string;
  workerFile: string;
  execArgv?: string[];
  /** This device's id, when the extension that owns it has told us. */
  deviceId?: () => string | null;
  /** Like `encrypt`, but throws where that one falls back to obfuscation. */
  encryptStrict?: (plain: string) => Buffer;
  /** Reads a vault blob with this device's keystore (for `exportSecrets`). */
  decrypt?: (blob: Buffer) => string;
  keystoreAvailable?: () => boolean;
  /** Is this source's connector installed here? Absent: yes. */
  isInstalled?: (source: string) => boolean;
  /** Connectors, for their optional `prepareExport` hook. */
  sources?: ExportSources;
  /** Starts an account that just arrived, with no restart. */
  start?: (accountId: string) => void | Promise<void>;
  /** The busy registry's first reason, or null. */
  busy?: () => string | null;
  /** This device is a follower or joining: it takes no offers. An extra hold
   *  on top of what `sync_state` says; the service tracks that itself. */
  readOnly?: () => boolean;
  /** Milliseconds, for the delivery queue's backoff. */
  nowMs?: () => number;
  /** What `sync_state` said at boot (follower or joining). */
  initialReadOnly?: boolean;
  /** An old master (tracking on) wakes fenced: another device may lead by now.
   *  Only `open` lifts it. */
  fencedAtBoot?: boolean;
  /** The fence lifted: start what only a leader runs. Once per `open`. */
  onOpen?: () => void | Promise<void>;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  let deviceId: string | null = null;
  let settingsOffer: SettingsOffer | null = null;
  const me = (): string => {
    const id = deviceId ?? deps.deviceId?.() ?? null;
    if (!id) throw new Error('this device has no id yet');
    return id;
  };
  const log = deps.log ?? (() => undefined);
  // Mirrors `sync_state` (role or joining) and the fence, so the answer is
  // synchronous. Every method below that changes the table refreshes it.
  let gated = deps.initialReadOnly ?? false;
  let fenced = deps.fencedAtBoot ?? false;
  let row = {
    role: (gated ? 'follower' : 'normal') as SyncRole,
    joining: false,
    joined: false,
    tracking: fenced,
    headPending: false,
    epoch: 0,
  };
  let leaseNow: LeaseSnapshot | null = null;
  if (fenced)
    void deps.db.proc?.('syncFence', { on: true })?.catch(() => undefined);
  const phase = (): SyncPhase => phaseOf({ ...row, fenced });
  const readOnly = (): boolean =>
    !canWrite(phase()) || (deps.readOnly?.() ?? false);
  const roleNow = (): SyncRoleWire => ({
    ...roleOf({ phase: phase(), lease: leaseNow }),
    multiDevice: leaseNow?.multiDevice ?? false,
    epoch: leaseNow?.epoch ?? row.epoch,
    priorRenewedAt: leaseNow?.priorRenewedAt ?? null,
  });
  const roleListeners: ((r: SyncRoleWire) => void)[] = [];
  let lastRole: SyncRoleWire | null = null;
  const publishRole = (): void => {
    const r = roleNow();
    if (
      lastRole &&
      (Object.keys(r) as (keyof SyncRoleWire)[]).every(
        (k) => lastRole![k] === r[k],
      )
    )
      return;
    lastRole = r;
    for (const cb of roleListeners) cb(r);
  };
  // Bumped by every close, so an `open` that was awaiting can tell a newer
  // loss from the state it started from: the loss wins.
  let fenceGen = 0;
  const setFence = (on: boolean): void => {
    if (on) fenceGen += 1;
    fenced = on;
    // The writer lives in a worker: the message is queued ahead of any write
    // sent after this call.
    void deps.db.proc?.('syncFence', { on })?.catch(() => undefined);
  };
  const refreshGate = async (): Promise<void> => {
    const rows = await deps.db.all(
      `SELECT role, joining, joined, tracking, head_pending, epoch FROM sync_state`,
    );
    const r = rows[0] as
      | {
          role: SyncRole;
          joining: number;
          joined: number;
          tracking: number;
          head_pending: number;
          epoch: number;
        }
      | undefined;
    row = {
      role: r?.role ?? 'normal',
      joining: r?.joining === 1,
      joined: r?.joined === 1,
      tracking: r?.tracking === 1,
      headPending: r?.head_pending === 1,
      epoch: r?.epoch ?? 0,
    };
    gated = row.role === 'follower' || row.joining;
    await refreshOwned();
  };
  /** Accounts this device runs whatever its role: device-owned and mine. */
  let ownedIds = new Set<string>();
  let ownerOpen = false;
  let foreignIds = new Set<string>();
  let names = new Map<string, string>();
  let masterId: string | null = null;
  const refreshOwned = async (): Promise<void> => {
    const self = deviceId;
    masterId =
      (
        (
          await deps.db.all(`SELECT master_device_id AS m FROM sync_state`)
        )[0] as { m: string | null } | undefined
      )?.m ?? null;
    const foreign = await deps.db.all(
      `SELECT id FROM accounts WHERE owner_device_id IS NOT NULL AND owner_device_id <> ?`,
      [self ?? ''],
    );
    foreignIds = new Set((foreign as { id: string }[]).map((r) => r.id));
    const rows = await deps.db.all(ownedByThisDeviceSql(false), [
      ...DEVICE_OWNED_SOURCES,
    ]);
    ownedIds = new Set((rows as { id: string }[]).map((r) => r.id));
    ownerOpen = (await deps.db.all(OWNER_OPEN_SQL)).length > 0;
  };
  const appliedListeners: ((tables: string[], meta: AppliedMeta) => void)[] =
    [];
  let forwarder: Forwarder | null = null;
  let runners: ForwardRunners | null = null;
  const dispatch = async (req: ForwardRequest): Promise<ForwardResult> => {
    if (!runners)
      return {
        ok: false,
        code: 'handler',
        message: 'no handlers are bound on this device',
      };
    try {
      const value =
        req.kind === 'ui'
          ? await runners.ui(req.extensionId ?? '', req.name, req.payload)
          : req.kind === 'core'
            ? await runners.core(req.name, req.payload)
            : await runners.commit(req.payload);
      return { ok: true, value };
    } catch (err) {
      return {
        ok: false,
        code: 'handler',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  };
  const forward = async (req: ForwardRequest): Promise<ForwardResult> => {
    if (!forwarder)
      return {
        ok: false,
        code: 'no-master',
        message: 'no leader is reachable',
      };
    try {
      return await forwarder(req);
    } catch {
      return {
        ok: false,
        code: 'no-master',
        message: 'no leader is reachable',
      };
    }
  };
  let draining: Promise<{ sent: number; waiting: number }> | null = null;
  const nowMs = deps.nowMs ?? Date.now;
  /** A refusing handler is retried this many times, with a growing wait, and
   *  then left in the queue for good: kept, never sent again, never blocking. */
  const backoffMs = (attempts: number): number =>
    Math.min(30_000 * 2 ** (attempts - 1), 60 * 60_000);
  const retryAt = new Map<number, number>();
  const spentLogged = new Set<number>();
  const sourceName = (req: ForwardRequest): string => {
    if (req.kind === 'ui') return req.extensionId ?? req.name;
    if (req.kind === 'commit') {
      const p = req.payload as
        | { account?: { source?: string; identifier?: string } }
        | undefined;
      return p?.account?.source
        ? `${p.account.source} (${p.account.identifier ?? '?'})`
        : req.name;
    }
    return req.name;
  };
  const queueListeners: ((e: QueueChange) => void)[] = [];
  const fireQueue = (e: QueueChange): void => {
    for (const cb of queueListeners) {
      try {
        cb(e);
      } catch (err) {
        log('warn', `sync: a queue listener failed: ${String(err)}`);
      }
    }
  };
  const drainOnce = async (): Promise<{ sent: number; waiting: number }> => {
    let sent = 0;
    const waitingNow = async (): Promise<number> =>
      Number(
        (
          (await deps.db.all(`SELECT count(*) AS n FROM sync_outbound`))[0] as {
            n: number;
          }
        ).n,
      );
    // Rows in id order; a spent row is skipped, so it never blocks the rest.
    // A refused or backing-off row without a key holds back the later rows
    // without one (order kept) but never a settings row; the same on a keyed
    // row skips only that row.
    let blockedUnkeyed = false;
    let after = 0;
    for (;;) {
      const next = (
        await deps.db.all(
          `SELECT id, payload, attempts, coalesce_key FROM sync_outbound WHERE id > ? ORDER BY id LIMIT 1`,
          [after],
        )
      )[0] as
        | {
            id: number;
            payload: Buffer;
            attempts: number;
            coalesce_key: string | null;
          }
        | undefined;
      if (!next) break;
      after = next.id;
      const isKeyed = next.coalesce_key !== null;
      const req = JSON.parse(
        Buffer.from(next.payload).toString('utf8'),
      ) as ForwardRequest;
      if (next.attempts >= MAX_HANDLER_ATTEMPTS) {
        if (!spentLogged.has(next.id)) {
          spentLogged.add(next.id);
          log(
            'error',
            `sync: giving up on a queued ${req.name} from ${sourceName(req)} after ${next.attempts} refusals; it stays in the queue`,
          );
        }
        continue;
      }
      if (!isKeyed && blockedUnkeyed) continue;
      if ((retryAt.get(next.id) ?? 0) > nowMs()) {
        if (!isKeyed) blockedUnkeyed = true;
        continue;
      }
      // The role is read now: a row queued as a follower runs as the leader's
      // own after a promotion (ruling 3).
      const r = readOnly() ? await forward(req) : await dispatch(req);
      if (r.ok) {
        await deps.db.run(`DELETE FROM sync_outbound WHERE id = ?`, [next.id]);
        retryAt.delete(next.id);
        sent += 1;
        fireQueue({
          kind: 'delivered',
          rowId: next.id,
          coalesceKey: next.coalesce_key,
        });
      } else if (r.code === 'handler') {
        // The leader's handler refused. Keep the row: a later version of the
        // handler or the data may accept it. Back off, and after the last try
        // stop waiting on it.
        const attempts = next.attempts + 1;
        await deps.db.run(
          `UPDATE sync_outbound SET attempts = ? WHERE id = ?`,
          [attempts, next.id],
        );
        retryAt.set(next.id, nowMs() + backoffMs(attempts));
        log(
          'warn',
          `sync: a queued ${req.name} from ${sourceName(req)} was refused (${attempts}/${MAX_HANDLER_ATTEMPTS}): ${r.message}`,
        );
        if (attempts < MAX_HANDLER_ATTEMPTS) {
          if (!isKeyed) blockedUnkeyed = true;
          continue;
        }
        spentLogged.add(next.id);
        log(
          'error',
          `sync: giving up on a queued ${req.name} from ${sourceName(req)}; it stays in the queue`,
        );
      } else {
        // No leader reachable: nothing was tried, so nothing is counted.
        break;
      }
    }
    return { sent, waiting: await waitingNow() };
  };
  let worker: Promise<AppDb> | null = null;
  const onWorker = async <T>(name: string, args: unknown = {}): Promise<T> => {
    worker ??= openDbInWorker(deps.dbPath, deps.workerFile, {
      role: 'sync',
      execArgv: deps.execArgv,
    });
    return (await (
      await worker
    ).proc!(name, args)) as T;
  };

  // One drain at a time: a pull, the timer, a fence lift and a promotion all
  // join the drain in flight instead of sending its rows a second time.
  let opening: Promise<void> | null = null;
  const drainOutbound = (): Promise<{ sent: number; waiting: number }> => {
    draining ??= drainOnce().finally(() => {
      draining = null;
    });
    return draining;
  };

  return {
    status: () => onWorker('status'),
    buildDelta: (after, out, capBytes, fromEpoch) =>
      onWorker('buildDelta', {
        after,
        out,
        capBytes,
        fromEpoch: fromEpoch ?? Number.MAX_SAFE_INTEGER,
      }),
    buildSnapshot: (out) => onWorker('buildSnapshot', { out }),
    applyDelta: async (stagePath, opts) => {
      const r = await deps.store.applySyncDelta(stagePath);
      const meta: AppliedMeta = {
        prefKeys: r.prefKeys ?? [],
        pullStartedAt: opts?.pullStartedAt,
      };
      if (r.tables.includes('accounts')) await refreshOwned();
      if (r.tables.length)
        for (const cb of appliedListeners) cb(r.tables, meta);
      return { ...r, prefKeys: meta.prefKeys };
    },
    onApplied: (cb) => {
      appliedListeners.push(cb);
    },
    prepareSwap: (file, sha256, masterDeviceId) =>
      onWorker('prepareSwap', { file, sha256, masterDeviceId }),
    prepareRestore: () => onWorker('prepareRestore'),
    forward,
    setForwarder: (f) => {
      forwarder = f;
    },
    setSettingsOffer: (h) => {
      settingsOffer = h;
    },
    exportSettings: async () =>
      (await settingsOffer?.export()) ?? { prefs: {}, extensions: {} },
    importSettings: async (offerId, settings) => {
      if (readOnly())
        throw new Error('this device is not the seed and takes no settings');
      if (!settingsOffer)
        throw new Error('settings are not ready on this device yet');
      // Its own marker beside the sources': both ride one offer id.
      const marker = `settings:${offerId}`;
      const seen = await deps.db.all(
        `SELECT 1 FROM sync_offers WHERE offer_id = ?`,
        [marker],
      );
      if (seen.length > 0) return { prefs: [], extensions: [] };
      const isObj = (v: unknown): v is Record<string, unknown> =>
        !!v && typeof v === 'object' && !Array.isArray(v);
      const r = await settingsOffer.import({
        prefs: isObj(settings?.prefs) ? settings.prefs : {},
        extensions: isObj(settings?.extensions)
          ? (settings.extensions as OfferedSettingsWire['extensions'])
          : {},
      });
      await deps.db.run(
        `INSERT OR IGNORE INTO sync_offers(offer_id, at) VALUES(?, ?)`,
        [marker, new Date().toISOString()],
      );
      log(
        'info',
        `sync: offer ${offerId.slice(0, 8)}: ${r.prefs.length} settings and ${r.extensions.length} connectors added to the set`,
      );
      return r;
    },
    setRunners: (r) => {
      runners = r;
    },
    runForwarded: async (req) => {
      if (readOnly()) {
        return {
          ok: false,
          code: 'no-master',
          message: 'this device is not the leader',
        };
      }
      return dispatch(req);
    },
    enqueue: async (req, opts) => {
      const kind = req.kind === 'commit' ? 'core.commitBatch' : req.name;
      const params = [
        kind,
        req.extensionId ?? null,
        Buffer.from(JSON.stringify(req), 'utf8'),
        new Date().toISOString(),
        opts?.coalesceKey ?? null,
      ];
      const insert = `INSERT INTO sync_outbound(kind, extension_id, payload, created_at, coalesce_key) VALUES(?, ?, ?, ?, ?) RETURNING id`;
      // The replace is one transaction: a failing insert leaves the older row.
      const results = opts
        ? await deps.db.batch([
            {
              sql: `DELETE FROM sync_outbound WHERE coalesce_key = ?`,
              params: [opts.coalesceKey],
            },
            { sql: insert, params },
          ])
        : await deps.db.batch([{ sql: insert, params }]);
      return Number(results[results.length - 1].row?.id);
    },
    onQueueChange: (cb) => {
      queueListeners.push(cb);
    },
    queuedSettings: async () =>
      queuedSettingsOf(
        (await deps.db.all(QUEUED_SETTINGS_SQL)) as Parameters<
          typeof queuedSettingsOf
        >[0],
      ),
    discardQueued: async (rowId) => {
      const row = (
        await deps.db.all(
          `SELECT coalesce_key FROM sync_outbound WHERE id = ? AND coalesce_key IS NOT NULL`,
          [rowId],
        )
      )[0] as { coalesce_key: string } | undefined;
      if (!row) return;
      await deps.db.run(`DELETE FROM sync_outbound WHERE id = ?`, [rowId]);
      retryAt.delete(rowId);
      spentLogged.delete(rowId);
      fireQueue({ kind: 'discarded', rowId, coalesceKey: row.coalesce_key });
    },
    drainOutbound,
    retained: async (table) =>
      (
        await deps.db.all(
          `SELECT pk FROM sync_retained WHERE tbl = ? ORDER BY pk`,
          [table],
        )
      ).map((r) => (r as { pk: string }).pk),
    setDeviceId: async (id) => {
      deviceId = id;
      await deps.db.run(`UPDATE sync_state SET device_id = ?`, [id]);
      const st = (
        await deps.db.all(
          `SELECT role, joined, joining, adopted_at FROM sync_state`,
        )
      )[0] as
        | {
            role: string;
            joined: number;
            joining: number;
            adopted_at: string | null;
          }
        | undefined;
      // Once, on a device that has never joined: its device-owned accounts get
      // this device's suffix and owner, so `UNIQUE(source, identifier)` holds
      // across devices. A joined device's rows arrived suffixed and owned.
      if (
        st &&
        !st.adopted_at &&
        st.role === 'normal' &&
        st.joined !== 1 &&
        st.joining !== 1
      ) {
        const marks = DEVICE_OWNED_SOURCES.map(() => '?').join(', ');
        await deps.db.run(
          `UPDATE accounts SET identifier = identifier || '#' || ?, owner_device_id = ?
            WHERE source IN (${marks}) AND owner_device_id IS NULL`,
          [deviceSuffix(id), id, ...DEVICE_OWNED_SOURCES],
        );
        await deps.db.run(`UPDATE sync_state SET adopted_at = ?`, [
          new Date().toISOString(),
        ]);
      }
      await refreshOwned();
    },
    loadOwned: async () => {
      if (!deviceId) {
        const row = (
          await deps.db.all(`SELECT device_id FROM sync_state`)
        )[0] as { device_id: string | null } | undefined;
        if (row?.device_id) deviceId = row.device_id;
      }
      await refreshOwned();
    },
    ownsAccount: (accountId) => !fenced && ownedIds.has(accountId),
    ownsSource: (source) => !fenced && ownerOpen && isDeviceOwned(source),
    ownedByOther: (accountId) => foreignIds.has(accountId),
    setDeviceNames: async (list) => {
      names = new Map(
        list.filter((d) => d.label).map((d) => [d.deviceId, d.label]),
      );
    },
    deviceName: (id) => names.get(id) ?? id.slice(0, 8),
    masterName: () =>
      masterId ? (names.get(masterId) ?? masterId.slice(0, 8)) : null,
    beginJoin: async () => {
      await deps.db.run(`UPDATE sync_state SET joining = 1`);
      await refreshGate();
    },
    hasMoveableLogins: async () => {
      const owned = DEVICE_OWNED_SOURCES.map(() => '?').join(', ');
      const rows = (await deps.db.all(
        `SELECT a.source AS source,
                EXISTS(SELECT 1 FROM vault v WHERE v.account_id = a.id AND length(v.blob) > 0) AS has
           FROM accounts a
          WHERE a.source <> 'worker' AND a.source NOT IN (${owned})`,
        [...DEVICE_OWNED_SOURCES],
      )) as { source: string; has: number }[];
      return rows.some(
        (r) =>
          r.has === 1 ||
          !!deps.sources?.get(r.source)?.prepareExport ||
          deps.sources?.advertisesPrepareExport?.(r.source) === true,
      );
    },
    exportSources: async (toDevice) => {
      const list = await exportSources(deps.store, me(), log, deps.sources);
      const owned = DEVICE_OWNED_SOURCES.map(() => '?').join(', ');
      await deps.db.run(
        `INSERT OR REPLACE INTO sync_moved(account_id, to_device)
         SELECT id, ? FROM accounts
          WHERE source <> 'worker' AND source NOT IN (${owned})
            AND id IN (SELECT account_id FROM vault WHERE length(blob) > 0)`,
        [toDevice, ...DEVICE_OWNED_SOURCES],
      );
      return list;
    },
    finishJoin: async () => {
      await deps.db.run(
        `DELETE FROM vault WHERE account_id IN (SELECT account_id FROM sync_moved)`,
      );
      const id = deviceId ?? deps.deviceId?.() ?? null;
      if (id) {
        await deps.db.run(
          `UPDATE accounts SET status = 'connecting', last_error = NULL
            WHERE owner_device_id = ? AND status = 'paused'`,
          [id],
        );
      }
      await deps.db.run(`UPDATE sync_state SET joined = 1, joining = 0`);
      await refreshGate();
      fs.rmSync(swapOutcomePath(deps.dbPath), { force: true });
    },
    leaveJoin: async () => {
      dropPendingSwap(deps.dbPath);
      await deps.db.run(`UPDATE sync_state SET joining = 0`);
      await refreshGate();
      await deps.db.run(PAUSE_MOVED_SQL);
    },
    forgetMoved: async () => {
      await deps.db.run(
        `UPDATE accounts SET status = 'connecting', last_error = NULL
          WHERE id IN (SELECT account_id FROM sync_moved)
            AND status = 'paused' AND last_error LIKE 'Moved to %'`,
      );
      await deps.db.run(`DELETE FROM sync_moved`);
    },
    canAcceptSources: () => !readOnly() && deps.keystoreAvailable?.() === true,
    importSources: async (offerId, list, from) => {
      if (readOnly())
        throw new Error('this device is not the seed and takes no sources');
      if (deps.keystoreAvailable?.() !== true || !deps.encryptStrict) {
        throw new Error(
          'no keystore on this device: its logins can not be stored safely',
        );
      }
      const installed = deps.isInstalled ?? (() => true);
      // Everything is encrypted before the writer sees any of it: a failure
      // here refuses the whole offer and stores nothing, not even obfuscated.
      const entries = list.map((o) => ({
        source: o.source,
        identifier: o.identifier,
        config: o.config,
        cadence: o.cadence,
        blob:
          o.credentials === null ||
          o.credentials === undefined ||
          isDeviceOwned(o.source)
            ? null
            : deps.encryptStrict!(JSON.stringify(o.credentials)),
        ownerDeviceId: o.owner_device_id,
        stable: isStableIdentity(o.source),
        installed: installed(o.source),
      }));
      const r = await deps.store.importSyncSources({ offerId, from, entries });
      log(
        'info',
        `sync: offer ${offerId.slice(0, 8)}: ${r.created.length} added, ${r.existing.length} already here, ${r.needsConnector.length} waiting for a connector`,
      );
      if (deps.start) {
        const accounts = await deps.store.read.accounts();
        for (const id of r.created) {
          const a = accounts.find((x) => x.id === id);
          if (a && a.status === 'connecting') await deps.start(id);
        }
      }
      return r;
    },
    exportSecrets: async (after) => {
      const { decrypt } = deps;
      if (!decrypt)
        throw new Error('no decrypt on this device: logins can not be read');
      const rows = await deps.db.all(
        // A device-owned account's login never leaves its owner (r16 ruling 5).
        `SELECT account_id, epoch, n, blob FROM vault
          WHERE (epoch > ? OR (epoch = ? AND n > ?))
            AND account_id NOT IN (SELECT id FROM accounts WHERE source IN (${DEVICE_OWNED_SOURCES.map(() => '?').join(', ')}))
          ORDER BY epoch, n`,
        [after.epoch, after.epoch, after.n, ...DEVICE_OWNED_SOURCES],
      );
      const out: Secret[] = [];
      for (const r of rows as {
        account_id: string;
        epoch: number;
        n: number;
        blob: Buffer;
      }[]) {
        if (r.blob.length === 0) {
          out.push({
            accountId: r.account_id,
            epoch: r.epoch,
            n: r.n,
            value: null,
          });
          continue;
        }
        try {
          out.push({
            accountId: r.account_id,
            epoch: r.epoch,
            n: r.n,
            value: decrypt(r.blob),
          });
        } catch {
          // Named by account id only; the value is never in the message.
          log(
            'warn',
            `sync: a login for account ${r.account_id} could not be read here and is not sent`,
          );
        }
      }
      return out;
    },
    importSecrets: async (list) => {
      await refreshGate();
      if (!gated)
        throw new Error('only a follower takes logins from the leader');
      if (deps.keystoreAvailable?.() !== true || !deps.encryptStrict) {
        throw new Error(
          'no keystore on this device: its logins can not be stored safely',
        );
      }
      // Everything is encrypted before the writer sees any of it.
      const entries = list.map((s) => ({
        accountId: s.accountId,
        epoch: s.epoch,
        n: s.n,
        blob: s.value === null ? Buffer.alloc(0) : deps.encryptStrict!(s.value),
      }));
      const r = await deps.store.importSyncSecrets(entries);
      log(
        'info',
        `sync: ${r.applied} of ${list.length} logins from the leader were newer`,
      );
      return r;
    },
    isBusy: () => deps.busy?.() ?? null,
    readOnly,
    setLease: async (snap) => {
      leaseNow = snap;
      await refreshGate();
      if (
        snap.reason === 'fenced' ||
        (!snap.isMaster && row.role === 'normal' && row.tracking)
      )
        setFence(true);
      publishRole();
    },
    lead: async (o) => {
      await refreshGate();
      const wasFenced = fenced;
      // A follower becomes a leader here: nothing may write until it opens.
      const fromFollower = row.role === 'follower';
      if (fromFollower) setFence(true);
      let done: unknown;
      try {
        done = await deps.db.proc!('syncLead', o);
      } catch (err) {
        if (fromFollower && !wasFenced) setFence(false);
        throw err;
      }
      if (done === 'promoted') setFence(true);
      await refreshGate();
      publishRole();
    },
    open: async (kind) => {
      if (opening) return opening;
      const gen = fenceGen;
      await refreshGate();
      if (opening) return opening;
      if (fenceGen !== gen) return;
      if (row.role === 'follower' || row.joining) throw new SyncNotLeader();
      if (!fenced) return;
      if (kind === 'lease' && row.headPending) throw new SyncHeadPending();
      opening = (async () => {
        if (kind === 'head-acked') {
          await deps.db.proc!('syncOpen', {});
          row = { ...row, headPending: false };
          if (fenceGen !== gen) {
            publishRole();
            return;
          }
        }
        setFence(false);
        publishRole();
        await Promise.resolve(deps.onOpen?.()).catch((err) =>
          log('warn', `sync: could not open after the fence: ${String(err)}`),
        );
        // What waited for a leader runs here now.
        await drainOutbound().catch((err) =>
          log('warn', `sync: the queue did not drain: ${String(err)}`),
        );
      })().finally(() => {
        opening = null;
      });
      return opening;
    },
    demote: async (masterDeviceId) => {
      setFence(true);
      await deps.db.proc!('syncDemote', { masterDeviceId });
      await refreshGate();
      publishRole();
    },
    role: roleNow,
    onRole: (cb) => void roleListeners.push(cb),
    lease: () => leaseNow,
    deviceId: () => deviceId ?? deps.deviceId?.() ?? null,
    deleteArchive: async () => {
      for (const f of archiveFiles(deps.dbPath)) fs.rmSync(f, { force: true });
    },
    close: async () => {
      if (worker) await (await worker).close();
      worker = null;
    },
  };
}
