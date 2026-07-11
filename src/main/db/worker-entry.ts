/**
 * Entry point for the DB worker thread (webpack entry `dbWorker`). Owns the
 * one writable better-sqlite3 connection so its synchronous calls block THIS
 * thread, never the main process event loop. The main process talks to it
 * through the bridge protocol (see ./bridge.ts) via openDbInWorker.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { CommitBatch } from '@shared/contracts';
import { detectLanguages } from '@main/core/language';
import { repopulateSearchIndex } from '@main/core/store/schema';
import { createWriteTx } from '@main/core/store/write-tx';
import { openDb } from './app-db';
import { attachDbHost } from './bridge';

if (!parentPort) {
  throw new Error('db worker-entry must run inside a worker thread');
}

const { dbPath } = workerData as { dbPath: string };

(async () => {
  try {
    const db = await openDb(dbPath);
    // The corpus `commit` is procedural with read-your-own-writes, so it runs
    // as a host procedure on the worker's RAW connection — the SAME
    // createWriteTx the in-process store builds — not as a static batch().
    const writeTx = createWriteTx(db._conn!, {
      detectLanguages,
      now: () => new Date().toISOString(),
    });
    attachDbHost(
      parentPort!,
      db,
      () => {
        // close() handled and acknowledged — nothing left to serve.
        process.exit(0);
      },
      {
        commit: (args) => writeTx.commit(args as CommitBatch),
        rebuildSearchIndex: () => {
          repopulateSearchIndex(db._conn!);
          return null;
        },
      },
    );
    parentPort!.postMessage({ t: 'ready' });
  } catch (e) {
    parentPort!.postMessage({
      t: 'open-error',
      message: (e as Error).message ?? String(e),
    });
  }
})();
