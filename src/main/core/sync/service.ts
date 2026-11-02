/** What a sync extension calls (spec 7.6). Writes go to the one writer. Building
 *  a delta, a snapshot, and hashing up to 14 GB run on their own query-only
 *  worker, so neither the window nor ingest waits for them. */
import type { AppDb } from '../../db/app-db';
import { openDbInWorker } from '../../db/worker-client';
import type { CoreStore } from '../store/store';
import type { DeltaResult, SyncCursor } from './delta';
import type { SyncRole } from './role';

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
  close(): Promise<void>;
}

export function createSyncService(deps: {
  db: AppDb;
  store: Pick<CoreStore, 'applySyncDelta'>;
  dbPath: string;
  workerFile: string;
  execArgv?: string[];
}): SyncService {
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
    close: async () => {
      if (worker) await (await worker).close();
      worker = null;
    },
  };
}
