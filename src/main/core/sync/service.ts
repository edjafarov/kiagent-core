/** What a sync extension calls (spec 7.6). Writes go to the one writer. Building
 *  a delta, a snapshot, and hashing up to 14 GB run on their own query-only
 *  worker, so neither the window nor ingest waits for them. */
import fs from 'node:fs';

import type { Source } from '@shared/contracts';
import type { AppDb } from '../../db/app-db';
import { openDbInWorker } from '../../db/worker-client';
import type { CoreStore } from '../store/store';
import type { ImportSourcesResult } from '../store/write-tx';
import type { DeltaResult, SyncCursor } from './delta';
import type { SyncRole } from './role';
import {
  DEVICE_OWNED_SOURCES,
  exportSources,
  isDeviceOwned,
  isStableIdentity,
  PAUSE_MOVED_SQL,
  type OfferedSource,
} from './sources';
import { archiveFiles, swapOutcomePath } from './status';
import { dropPendingSwap } from './swap';

export interface SyncStatus {
  role: SyncRole;
  tracking: boolean;
  historyId: string | null;
  masterDeviceId: string | null;
  after: SyncCursor;
  head: SyncCursor;
  schemaVersion: number;
  /** Mid-join: searches, but reads no source and writes nothing (spec 7.7). */
  joining: boolean;
  /** Set once the join finished; a joined device ignores `join_from` for good. */
  joined: boolean;
  /** Documents that are not archived: the heartbeat's `doc_count`. */
  documents: number;
  /** The last boot swap's result, until finishJoin or leaveJoin clears it. */
  lastSwap: 'swapped' | 'abandoned' | null;
  /** Size of the old database a join set aside, 0 when none. */
  archiveBytes: number;
}

export interface SyncService {
  status(): Promise<SyncStatus>;
  enableTracking(): Promise<void>;
  disableTracking(): Promise<void>;
  buildDelta(after: SyncCursor, out: string, capBytes: number): Promise<DeltaResult>;
  buildSnapshot(out: string): Promise<{ bytes: number; target: SyncCursor; sha256: string }>;
  applyDelta(stagePath: string): Promise<{ applied: number; target: SyncCursor }>;
  prepareSwap(
    file: string,
    sha256: string,
    masterDeviceId: string,
  ): Promise<'ready' | 'no-disk' | 'invalid'>;
  /** Next boot, this device goes back to its archived data. */
  prepareRestore(): Promise<'ready' | 'no-archive'>;
  /** The id this device is known by to its siblings. The extension that owns
   *  the device key supplies it at every activation. */
  setDeviceId(id: string): void;
  /** Sets `joining=1` and nothing else: the caller restarts, because the
   *  gates are read at boot (spec 7.7). */
  beginJoin(): Promise<void>;
  /** What to offer `toDevice`. Records the moveable accounts in `sync_moved`
   *  first, so a crash after the offer can't lose track of a login. */
  exportSources(toDevice: string): Promise<OfferedSource[]>;
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
  /** Why this device must not restart or be interrupted right now, if so. */
  isBusy(): string | null;
  /** Deletes the old database a join set aside. Restoring it is then gone. */
  deleteArchive(): Promise<void>;
  close(): Promise<void>;
}

export interface SyncServiceDeps {
  db: AppDb;
  store: Pick<CoreStore, 'applySyncDelta' | 'importSyncSources' | 'read' | 'vault'>;
  dbPath: string;
  workerFile: string;
  execArgv?: string[];
  /** This device's id, when the extension that owns it has told us. */
  deviceId?: () => string | null;
  /** Like `encrypt`, but throws where that one falls back to obfuscation. */
  encryptStrict?: (plain: string) => Buffer;
  keystoreAvailable?: () => boolean;
  /** Is this source's connector installed here? Absent: yes. */
  isInstalled?: (source: string) => boolean;
  /** Connectors, for their optional `prepareExport` hook. */
  sources?: { get(id: string): Partial<Pick<Source, 'prepareExport'>> | undefined };
  /** Starts an account that just arrived, with no restart. */
  start?: (accountId: string) => void | Promise<void>;
  /** The busy registry's first reason, or null. */
  busy?: () => string | null;
  /** This device is a follower or joining: it takes no offers. */
  readOnly?: () => boolean;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export function createSyncService(deps: SyncServiceDeps): SyncService {
  let deviceId: string | null = null;
  const me = (): string => {
    const id = deviceId ?? deps.deviceId?.() ?? null;
    if (!id) throw new Error('this device has no id yet');
    return id;
  };
  const log = deps.log ?? (() => undefined);
  let worker: Promise<AppDb> | null = null;
  const onWorker = async <T>(name: string, args: unknown = {}): Promise<T> => {
    worker ??= openDbInWorker(deps.dbPath, deps.workerFile, {
      role: 'sync',
      execArgv: deps.execArgv,
    });
    return (await (await worker).proc!(name, args)) as T;
  };
  return {
    status: () => onWorker('status'),
    enableTracking: async () => {
      await deps.db.proc!('syncTracking', { on: true });
    },
    disableTracking: async () => {
      await deps.db.proc!('syncTracking', { on: false });
    },
    buildDelta: (after, out, capBytes) => onWorker('buildDelta', { after, out, capBytes }),
    buildSnapshot: (out) => onWorker('buildSnapshot', { out }),
    applyDelta: (stagePath) => deps.store.applySyncDelta(stagePath),
    prepareSwap: (file, sha256, masterDeviceId) =>
      onWorker('prepareSwap', { file, sha256, masterDeviceId }),
    prepareRestore: () => onWorker('prepareRestore'),
    setDeviceId: (id) => {
      deviceId = id;
    },
    beginJoin: async () => {
      await deps.db.run(`UPDATE sync_state SET joining = 1`);
    },
    exportSources: async (toDevice) => {
      const list = await exportSources(deps.store, me(), log, deps.sources);
      const owned = DEVICE_OWNED_SOURCES.map(() => '?').join(', ');
      await deps.db.run(
        `INSERT OR REPLACE INTO sync_moved(account_id, to_device)
         SELECT id, ? FROM accounts
          WHERE source <> 'worker' AND source NOT IN (${owned})
            AND id IN (SELECT account_id FROM vault)`,
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
      fs.rmSync(swapOutcomePath(deps.dbPath), { force: true });
    },
    leaveJoin: async () => {
      dropPendingSwap(deps.dbPath);
      await deps.db.run(`UPDATE sync_state SET joining = 0`);
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
    canAcceptSources: () => !deps.readOnly?.() && deps.keystoreAvailable?.() === true,
    importSources: async (offerId, list, from) => {
      if (deps.readOnly?.()) throw new Error('this device is not the seed and takes no sources');
      if (deps.keystoreAvailable?.() !== true || !deps.encryptStrict) {
        throw new Error('no keystore on this device: its logins can not be stored safely');
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
          o.credentials === null || o.credentials === undefined || isDeviceOwned(o.source)
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
    isBusy: () => deps.busy?.() ?? null,
    deleteArchive: async () => {
      for (const f of archiveFiles(deps.dbPath)) fs.rmSync(f, { force: true });
    },
    close: async () => {
      if (worker) await (await worker).close();
      worker = null;
    },
  };
}
