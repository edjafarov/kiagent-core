import type { DbCoordinator, DbOwner, TxToken } from './coordinator';
import type { PluginConnection } from './plugin-connections';
import type { PluginRegistry } from './plugin-registry';

export type PluginDbRequest =
  | {
      op: 'register-source';
      pluginId: string;
      legacyPath: string;
      descriptor: import('@main/platform/database-descriptor').PluginDatabaseDescriptor;
    }
  | {
      op: 'register';
      owner?: never;
      pluginId: string;
      descriptor: import('@main/platform/database-descriptor').PluginDatabaseDescriptor;
    }
  | {
      op: 'prepare';
      owner?: never;
      pluginId: string;
      descriptor?: import('@main/platform/database-descriptor').PluginDatabaseDescriptor;
    }
  | {
      op: 'open';
      owner: DbOwner;
      pluginId: string;
      /** legacy fields are ignored; host registry supplies immutable names */ tables?: string[];
      indexes?: string[];
      views?: string[];
      triggers?: string[];
    }
  | {
      op: 'exec' | 'query' | 'batch';
      owner: DbOwner;
      token?: TxToken;
      sql?: string;
      params?: unknown[];
      steps?: readonly {
        sql: string;
        params?: unknown[];
        mode?: 'exec' | 'query';
      }[];
    }
  | { op: 'begin'; owner: DbOwner }
  | { op: 'commit' | 'rollback'; owner: DbOwner; token: TxToken }
  | {
      op: 'migrate';
      owner: DbOwner;
      token?: TxToken;
      module: string;
      version: number;
      statements: readonly string[];
    }
  | { op: 'release'; owner: DbOwner }
  | { op: 'reset' | 'rearm'; pluginId: string }
  | { op: 'diagnostics' };

/** Remove and close a failed plugin handle before the coordinator admits work
 * belonging to another owner. Closing the native handle is what releases any
 * transaction that could not be rolled back. */
export async function closePluginConnectionForOwner(
  owner: DbOwner,
  connections: Map<string, PluginConnection>,
): Promise<void> {
  if (owner.kind !== 'plugin') return;
  const key = owner.handle ?? owner.extensionId;
  const connection = connections.get(key);
  connections.delete(key);
  try {
    await connection?.close();
  } catch {
    /* preserve the original failure */
  }
}

export function createPluginOperationHandler(
  coordinator: DbCoordinator,
  connections: Map<string, PluginConnection>,
  options: { registry?: PluginRegistry } = {},
) {
  return async (
    request: PluginDbRequest,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (request.op === 'diagnostics') return coordinator.metrics();
    if (request.op === 'register')
      throw Object.assign(new Error('plugin registration is host-owned'), {
        code: 'PLUGIN_REGISTRATION_HOST_ONLY',
      });
    const scoped = request as Extract<PluginDbRequest, { owner: DbOwner }>;
    if (scoped.op === 'release') {
      const key =
        scoped.owner.kind === 'plugin'
          ? (scoped.owner.handle ?? scoped.owner.extensionId)
          : 'core';
      const connection = connections.get(key);
      try {
        await coordinator.release(scoped.owner);
      } finally {
        if (connection) {
          await connection.close();
          connections.delete(key);
        }
      }
      return undefined;
    }
    const connection = connections.get(
      scoped.owner.kind === 'plugin'
        ? (scoped.owner.handle ?? scoped.owner.extensionId)
        : 'core',
    );
    if (!connection)
      throw Object.assign(new Error('plugin database is not open'), {
        code: 'PLUGIN_DB_NOT_OPEN',
      });
    if (scoped.op === 'exec')
      return coordinator.run(
        scoped.owner,
        scoped.token,
        () => connection.exec(scoped.sql!, scoped.params),
        signal,
        'plugin.db.exec',
      );
    if (scoped.op === 'query')
      return coordinator.run(
        scoped.owner,
        scoped.token,
        () => connection.query(scoped.sql!, scoped.params),
        signal,
        'plugin.db.query',
      );
    if (scoped.op === 'batch')
      return coordinator.run(
        scoped.owner,
        scoped.token,
        () => connection.batch(scoped.steps ?? []),
        signal,
        'plugin.db.batch',
      );
    if (scoped.op === 'begin')
      return coordinator.begin(
        scoped.owner,
        () => connection.begin(),
        () => connection.rollback(),
        signal,
        'plugin.db.begin',
      );
    if (scoped.op === 'commit')
      return coordinator.finish(
        scoped.owner,
        scoped.token,
        () => connection.commit(),
        'plugin.db.commit',
      );
    if (scoped.op === 'rollback')
      return coordinator.finish(
        scoped.owner,
        scoped.token,
        () => connection.rollback(),
        'plugin.db.rollback',
      );
    if (scoped.op === 'migrate') {
      if (!options.registry || scoped.owner.kind !== 'plugin')
        throw Object.assign(
          new Error('registered migrations are supplied by the host registry'),
          { code: 'PLUGIN_MIGRATION_NOT_REGISTERED' },
        );
      return coordinator.run(
        scoped.owner,
        scoped.token,
        () =>
          options.registry!.migrate({
            pluginId:
              scoped.owner.kind === 'plugin' ? scoped.owner.extensionId : '',
            module: scoped.module,
            version: scoped.version,
            statements: scoped.statements,
          }),
        signal,
        'plugin.db.migrate',
      );
    }
    return undefined;
  };
}
