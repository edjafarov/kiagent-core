import { parentPort, workerData } from 'node:worker_threads';
import path from 'node:path';
import { openDb } from '../../app-db';
import { attachDbHost } from '../../bridge';
import { createDbCoordinator } from '../../coordinator';
import { openPluginConnection } from '../../plugin-connections';
import {
  createPluginOperationHandler,
  closePluginConnectionForOwner,
  type PluginDbRequest,
} from '../../plugin-operations';
import { importLegacyPluginStorage } from '../../plugin-import';
import { createPluginRegistry } from '../../plugin-registry';

if (!parentPort)
  throw new Error('respawn-plugin-worker-entry must run in a worker');

const { dbPath, pluginSources } = workerData as {
  dbPath: string;
  pluginSources?: Record<string, string>;
};

(async () => {
  try {
    const db = await openDb(dbPath);
    const sources = new Map(
      Object.entries(pluginSources ?? {}).map(([id, source]) => [
        id,
        path.resolve(source),
      ]),
    );
    const connections = new Map<
      string,
      Awaited<ReturnType<typeof openPluginConnection>>
    >();
    const registry = createPluginRegistry(db._conn!, { filename: dbPath });
    const coordinator = createDbCoordinator({
      onOwnerFailure: (owner) =>
        closePluginConnectionForOwner(owner, connections),
    });
    const handler = createPluginOperationHandler(coordinator, connections, {
      registry,
    });
    const preparations = new Map<string, Promise<unknown>>();
    const plugin = async (
      request: PluginDbRequest,
      signal?: AbortSignal,
    ): Promise<unknown> => {
      const core = { kind: 'core' as const, handle: 'core' };
      if (request.op === 'register-source') {
        const source = path.resolve(request.legacyPath);
        if (path.basename(source) !== 'private.db')
          throw Object.assign(new Error('invalid source'), {
            code: 'PLUGIN_DB_LEGACY_PATH_INVALID',
          });
        sources.set(request.pluginId, source);
        return coordinator.run(
          core,
          undefined,
          () =>
            registry.register({
              pluginId: request.pluginId,
              legacyPath: source,
              descriptor: request.descriptor,
            }),
          signal,
          'core.plugin.register-source',
        );
      }
      if (request.op === 'prepare') {
        const prior = preparations.get(request.pluginId);
        if (prior) return prior;
        const task = (async () => {
          const metadata = await coordinator.run(
            core,
            undefined,
            () =>
              registry.preparePluginStorage({
                pluginId: request.pluginId,
                descriptor: request.descriptor,
              }),
            signal,
            'core.plugin.prepare',
          );
          if (metadata.state === 'active' || metadata.state === 'tombstoned')
            return metadata;
          const source = sources.get(request.pluginId);
          if (!source)
            throw Object.assign(new Error('source unavailable'), {
              code: 'PLUGIN_DB_LEGACY_SOURCE_UNAVAILABLE',
            });
          const descriptor = await coordinator.run(
            core,
            undefined,
            () => registry.descriptor(request.pluginId),
            signal,
            'core.plugin.descriptor',
          );
          await importLegacyPluginStorage(
            registry,
            { pluginId: request.pluginId, descriptor, legacyPath: source },
            {
              admit: (work) =>
                coordinator.run(
                  core,
                  undefined,
                  work,
                  signal,
                  'core.plugin.import',
                ),
            },
          );
          return registry.diagnostics(request.pluginId);
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
        const registration = await coordinator.run(
          core,
          undefined,
          () =>
            registry.open({ pluginId: request.pluginId, owner: request.owner }),
          signal,
          'core.plugin.open',
        );
        if (request.owner.kind !== 'plugin')
          throw new Error('plugin owner required');
        connections.set(
          request.owner.handle ?? request.owner.extensionId,
          await openPluginConnection(dbPath, registration),
        );
        return { opened: true };
      }
      return handler(request, signal);
    };
    attachDbHost(
      parentPort!,
      db,
      () => {
        void registry.close().finally(() => process.exit(0));
      },
      { crash: () => process.exit(1) },
      { coordinator, coreOwner: { kind: 'core', handle: 'core' }, plugin },
    );
    parentPort!.postMessage({ t: 'ready' });
  } catch (e) {
    parentPort!.postMessage({
      t: 'open-error',
      message: (e as Error).message ?? String(e),
    });
  }
})();
