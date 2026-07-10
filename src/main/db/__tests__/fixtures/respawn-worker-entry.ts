/**
 * Test-only worker entry for db-worker-respawn.test.ts. Mirrors the real
 * ../../worker-entry.ts (open + migrate + attachDbHost) but skips the corpus
 * `commit` procedure (not needed here) and adds a `crash` procedure that
 * kills the thread with `process.exit(1)` — the test's way of triggering an
 * unexpected worker death on demand, without reaching into worker-client.ts's
 * internals (which deliberately keeps the worker instance private).
 *
 * Every spawn (initial open AND every respawn) behaves identically here, so
 * this fixture is for the "crash, then respawn successfully" tests. See
 * crash-loop-worker-entry.ts for the "every respawn also fails" fixture.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../../app-db';
import { attachDbHost } from '../../bridge';

if (!parentPort) {
  throw new Error('respawn-worker-entry must run inside a worker thread');
}

const { dbPath } = workerData as { dbPath: string };

(async () => {
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
          // Exit before a reply is posted — the in-flight `proc('crash', …)`
          // call itself is the request that never gets a response and must
          // be rejected by the client's death handling.
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
