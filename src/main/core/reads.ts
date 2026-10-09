/**
 * The foreground read plane: a read-only DB worker (Task 3) behind a thin
 * proxy, with the writer as the answer to every reader failure (spec §3.5).
 * `bootCore` opens it AFTER the writer's `openDbInWorker` resolved — the writer
 * migrates, readers never do.
 */
import type { Query } from '@shared/contracts';

import type { AppDb } from '../db/app-db';
import { openDbInWorker } from '../db/worker-client';
import {
  createReadProxy,
  createReadStats,
  withWriterFallback,
  type ReadCaller,
  type ReadMode,
  type ReadStats,
} from './store/read-proxy';

export const READ_CACHE_KIB = 8192;
/** SQLite's own default (-2000 KiB): weak hosts keep their memory. */
export const READ_CACHE_KIB_WEAK = 2048;

export const readCacheKiB = (weak: boolean): number =>
  weak ? READ_CACHE_KIB_WEAK : READ_CACHE_KIB;

export interface Reads {
  /** The foreground read path, attributed to caller 'other'. */
  reads: Query;
  readsFor(caller: ReadCaller): Query;
  stats: ReadStats;
  mode(): ReadMode;
  close(): Promise<void>;
}

export async function openReads(deps: {
  dbPath: string;
  workerFile: string;
  execArgv?: string[];
  writer: Query;
  weak: boolean;
  log(level: 'warn' | 'error', msg: string): void;
}): Promise<Reads> {
  const stats = createReadStats();
  let readDb: AppDb | null = null;
  let openError: string | undefined;
  try {
    readDb = await openDbInWorker(deps.dbPath, deps.workerFile, {
      role: 'read',
      cacheKiB: readCacheKiB(deps.weak),
      execArgv: deps.execArgv,
    });
  } catch (e) {
    openError = e instanceof Error ? e.message : String(e);
  }
  const opened = readDb;
  const router = withWriterFallback({
    proxy: opened ? (caller) => createReadProxy(opened, stats, caller) : null,
    writer: deps.writer,
    stats,
    log: deps.log,
    openError,
  });
  return {
    reads: router.for('other'),
    readsFor: (caller) => router.for(caller),
    stats,
    mode: router.mode,
    close: async () => {
      if (opened) await opened.close();
    },
  };
}
