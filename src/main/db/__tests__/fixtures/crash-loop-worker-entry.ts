/**
 * Test-only worker entry for the crash-loop-exhaustion case in
 * db-worker-respawn.test.ts. The FIRST spawn (the initial open done by
 * openDbInWorker itself) behaves exactly like respawn-worker-entry.ts:
 * it opens fine, registers a `crash` procedure, and posts 'ready'. EVERY
 * spawn after that (i.e. every respawn attempt) dies before ever reaching
 * 'ready' — simulating a worker that keeps failing to come back up (e.g. a
 * corrupted DB file left behind by the crash) so the supervisor's bounded
 * restart budget gets exhausted.
 *
 * Spawn count is tracked in a sidecar file next to the DB (`${dbPath}.spawns`)
 * since each spawn is a fresh thread with no shared in-memory state.
 */
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../../app-db';
import { attachDbHost } from '../../bridge';

if (!parentPort) {
  throw new Error('crash-loop-worker-entry must run inside a worker thread');
}

const { dbPath } = workerData as { dbPath: string };
const counterPath = `${dbPath}.spawns`;

(async () => {
  let spawnIndex = 0;
  try {
    if (fs.existsSync(counterPath)) {
      spawnIndex = Number(fs.readFileSync(counterPath, 'utf8')) || 0;
    }
  } catch {
    // treat unreadable counter as "first spawn"
  }
  fs.writeFileSync(counterPath, String(spawnIndex + 1));

  if (spawnIndex > 0) {
    // Every respawn attempt dies before 'ready' — never recovers.
    process.exit(1);
  }

  try {
    const db = await openDb(dbPath);
    attachDbHost(
      parentPort!,
      db,
      () => {
        process.exit(0);
      },
      {
        crash: () => {
          process.exit(1);
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
