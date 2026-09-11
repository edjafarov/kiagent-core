/**
 * Entry point for the DB worker thread (webpack entry `dbWorker`). Owns the
 * one writable better-sqlite3 connection so its synchronous calls block THIS
 * thread, never the main process event loop. The main process talks to it
 * through the bridge protocol (see ./bridge.ts) via openDbInWorker.
 */
import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
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
import { importLegacyPluginStorage } from './plugin-import';
import {
  closePluginConnectionForOwner,
  createPluginOperationHandler,
  type PluginDbRequest,
} from './plugin-operations';
import { createPluginRegistry } from './plugin-registry';

if (!parentPort) {
  throw new Error('db worker-entry must run inside a worker thread');
}

const { dbPath, pluginSources } = workerData as {
  dbPath: string;
  pluginSources?: Record<string, string>;
};
const trustedPluginSources = new Map(
  Object.entries(pluginSources ?? {}).map(([pluginId, source]) => [
    pluginId,
    path.resolve(source),
  ]),
);

function trustedLegacyPath(pluginId: string): string {
  const source = trustedPluginSources.get(pluginId);
  if (!source || path.basename(source) !== 'private.db') {
    throw Object.assign(
      new Error(`no trusted legacy source is registered for ${pluginId}`),
      { code: 'PLUGIN_DB_LEGACY_SOURCE_UNAVAILABLE' },
    );
  }
  return source;
}

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
    const pluginConnections = new Map<
      string,
      Awaited<ReturnType<typeof openPluginConnection>>
    >();
    const registry = createPluginRegistry(db._conn!, { filename: dbPath });
    const coordinator = createDbCoordinator({
      onOwnerFailure: (owner) =>
        closePluginConnectionForOwner(owner, pluginConnections),
    });
    const pluginHandler = createPluginOperationHandler(
      coordinator,
      pluginConnections,
      { registry },
    );
    const preparations = new Map<string, Promise<unknown>>();
    attachDbHost(
      parentPort!,
      db,
      () => {
        // close() handled and acknowledged — close the second native handle
        // before releasing the worker, so no registry WAL handle survives.
        void registry.close().finally(() => process.exit(0));
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
          if (request.op === 'register') {
            const legacyPath = trustedLegacyPath(request.pluginId);
            return coordinator.run(
              { kind: 'core', handle: 'core' },
              undefined,
              () =>
                registry.register({
                  pluginId: request.pluginId,
                  descriptor: request.descriptor,
                  legacyPath,
                }),
              signal,
            );
          }
          if (request.op === 'prepare') {
            const prior = preparations.get(request.pluginId);
            if (prior) {
              await coordinator.run(
                { kind: 'core', handle: 'core' },
                undefined,
                () =>
                  registry.preparePluginStorage({
                    pluginId: request.pluginId,
                    descriptor: request.descriptor,
                  }),
                signal,
              );
              return prior;
            }
            const task = (async () => {
              const metadata = await coordinator.run(
                { kind: 'core', handle: 'core' },
                undefined,
                () =>
                  registry.preparePluginStorage({
                    pluginId: request.pluginId,
                    descriptor: request.descriptor,
                  }),
                signal,
              );
              if (metadata.state === 'active') return metadata;
              const descriptor = await coordinator.run(
                { kind: 'core', handle: 'core' },
                undefined,
                () => registry.descriptor(request.pluginId),
                signal,
              );
              const legacyPath = trustedLegacyPath(request.pluginId);
              return importLegacyPluginStorage(
                registry,
                { pluginId: request.pluginId, descriptor, legacyPath },
                {
                  admit: (work) =>
                    coordinator.run(
                      { kind: 'core', handle: 'core' },
                      undefined,
                      work,
                      signal,
                    ),
                },
              ).then(() =>
                coordinator.run(
                  { kind: 'core', handle: 'core' },
                  undefined,
                  () => registry.diagnostics(request.pluginId),
                  signal,
                ),
              );
            })();
            preparations.set(request.pluginId, task);
            try {
              return await task;
            } finally {
              if (preparations.get(request.pluginId) === task)
                preparations.delete(request.pluginId);
            }
          }
          if (request.op === 'open') {
            if (request.owner.kind !== 'plugin')
              throw new Error('plugin owner required');
            const registration = await coordinator.run(
              { kind: 'core', handle: 'core' },
              undefined,
              () =>
                registry.open({
                  pluginId: request.pluginId,
                  owner: request.owner,
                }),
              signal,
            );
            const connection = await openPluginConnection(dbPath, registration);
            pluginConnections.set(
              request.owner.handle ?? request.owner.extensionId,
              connection,
            );
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
