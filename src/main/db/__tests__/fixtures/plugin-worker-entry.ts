import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../../app-db';
import { attachDbHost } from '../../bridge';
if (!parentPort) throw new Error('worker port required');
(async () => {
  const db = await openDb((workerData as { dbPath: string }).dbPath);
  attachDbHost(parentPort!, db, () => process.exit(0), undefined, { plugin: async (request) => ({ op: request.op }) });
  parentPort!.postMessage({ t: 'ready' });
})();
