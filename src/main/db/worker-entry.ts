/**
 * Entry point for the DB worker thread (webpack entry `dbWorker`). Owns the
 * one writable better-sqlite3 connection so its synchronous calls block THIS
 * thread, never the main process event loop. The main process talks to it
 * through the bridge protocol (see ./bridge.ts) via openDbInWorker.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { CommitBatch, ExternalRef, Seq } from '@shared/contracts';
import { detectLanguages } from '@main/core/language';
import { repopulateSearchIndex } from '@main/core/store/schema';
import {
  createWriteTx,
  type FolderScopeInput,
} from '@main/core/store/write-tx';
import { openDb } from './app-db';
import { attachDbHost } from './bridge';
import { createDbCoordinator } from './coordinator';
import { openPluginConnection } from './plugin-connections';
import { createPluginOperationHandler, type PluginDbRequest } from './plugin-operations';

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
    const pluginConnections = new Map<string, Awaited<ReturnType<typeof openPluginConnection>>>();
    const coordinator = createDbCoordinator({ onOwnerFailure: async (owner) => {
      if (owner.kind !== 'plugin') return;
      const key = owner.handle ?? owner.extensionId;
      const connection = pluginConnections.get(key);
      pluginConnections.delete(key);
      try { await connection?.close(); } catch { /* preserve the rollback failure */ }
    } });
    const pluginHandler = createPluginOperationHandler(coordinator, pluginConnections);
    attachDbHost(
      parentPort!,
      db,
      () => {
        // close() handled and acknowledged — nothing left to serve.
        process.exit(0);
      },
      {
        commit: (args) => writeTx.commit(args as CommitBatch),
        // The reconcile pass runs entirely on this connection: its staging
        // table is TEMP (connection-scoped), and the point of the whole
        // procedure set is that neither the listing nor the deletion set ever
        // crosses back over this boundary. See core/store/write-tx.ts.
        reconcileBegin: (args) => {
          writeTx.reconcileBegin((args as { accountId: string }).accountId);
          return null;
        },
        reconcileStage: (args) => {
          const a = args as { accountId: string; refs: ExternalRef[] };
          writeTx.reconcileStage(a.accountId, a.refs);
          return null;
        },
        reconcileDiff: (args) => {
          const a = args as { accountId: string; startSeq: Seq };
          return writeTx.reconcileDiff(a.accountId, a.startSeq);
        },
        reconcileArchive: (args) => {
          const a = args as { accountId: string; startSeq: Seq };
          return writeTx.reconcileArchive(a.accountId, a.startSeq);
        },
        reconcileEnd: (args) => {
          writeTx.reconcileEnd((args as { accountId: string }).accountId);
          return null;
        },
        // ONE transaction: config + cursor + archival. Counts only come back —
        // the whole point of hosting it here (see core/store/write-tx.ts).
        applyFolderScope: (args) =>
          writeTx.applyFolderScope(args as FolderScopeInput),
        rebuildSearchIndex: () => {
          repopulateSearchIndex(db._conn!);
          return null;
        },
      },
      {
        coordinator,
        coreOwner: { kind: 'core', handle: 'core' },
        plugin: async (request: PluginDbRequest, signal?: AbortSignal) => {
          if (request.op === 'open') {
            if (request.owner.kind !== 'plugin') throw new Error('plugin owner required');
            const connection = await openPluginConnection(dbPath, {
              pluginId: request.pluginId,
              tables: request.tables,
              indexes: request.indexes,
              views: request.views,
              triggers: request.triggers,
            });
            pluginConnections.set(request.owner.handle ?? request.owner.extensionId, connection);
            return { opened: true };
          }
          return pluginHandler(request, signal);
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
