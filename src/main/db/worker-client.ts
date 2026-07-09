import { Worker } from 'node:worker_threads';
import type { AppDb } from './app-db';
import { createDbClient } from './bridge';

/**
 * Open the corpus database inside a worker thread and return an AppDb whose
 * calls are RPCs to it. Every better-sqlite3 operation is synchronous; hosting
 * the connection off-thread is what keeps multi-ms statements (checkpoint,
 * VACUUM, cold queries, giant transactions) from freezing the UI event loop.
 *
 * `workerFile` is the bundled worker entry emitted next to the main bundle
 * (webpack entry `dbWorker`); migrations run inside the worker before `ready`.
 */
export async function openDbInWorker(
  dbPath: string,
  workerFile: string,
): Promise<AppDb> {
  const worker = new Worker(workerFile, { workerData: { dbPath } });

  await new Promise<void>((resolve, reject) => {
    const onMessage = (m: unknown) => {
      const msg = m as { t?: string; message?: string };
      if (msg?.t === 'ready') {
        cleanup();
        resolve();
      } else if (msg?.t === 'open-error') {
        cleanup();
        reject(new Error(`db worker failed to open: ${msg.message}`));
        void worker.terminate();
      }
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onExit = (code: number) => {
      cleanup();
      reject(new Error(`db worker exited before ready (code ${code})`));
    };
    function cleanup() {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    }
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });

  const client = createDbClient(worker);
  worker.on('error', (e) => client._markDead(e));
  worker.on('exit', (code) => {
    client._markDead(new Error(`db worker exited (code ${code})`));
  });

  return {
    ...client,
    close: async () => {
      try {
        await client.close();
      } finally {
        await worker.terminate();
      }
    },
  };
}
