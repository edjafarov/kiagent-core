import type { DbCoordinator, DbOwner, TxToken } from './coordinator';
import type { PluginConnection } from './plugin-connections';

export type PluginDbRequest =
  | { op: 'register'; owner?: never; pluginId?: string; tables?: string[] }
  | { op: 'open'; owner: DbOwner; pluginId: string; tables: string[]; indexes?: string[]; views?: string[]; triggers?: string[] }
  | { op: 'exec' | 'query' | 'batch'; owner: DbOwner; token?: TxToken; sql?: string; params?: unknown[]; steps?: readonly { sql: string; params?: unknown[]; mode?: 'exec' | 'query' }[] }
  | { op: 'begin'; owner: DbOwner }
  | { op: 'commit' | 'rollback'; owner: DbOwner; token: TxToken }
  | { op: 'migrate'; owner: DbOwner; module: string; version: number; statements: readonly string[] }
  | { op: 'release'; owner: DbOwner }
  | { op: 'diagnostics' };

export function createPluginOperationHandler(coordinator: DbCoordinator, connections: Map<string, PluginConnection>) {
  return async (request: PluginDbRequest): Promise<unknown> => {
    if (request.op === 'diagnostics') return coordinator.metrics();
    if (request.op === 'register') throw Object.assign(new Error('plugin registration is host-owned'), { code: 'PLUGIN_REGISTRATION_HOST_ONLY' });
    const scoped = request as Extract<PluginDbRequest, { owner: DbOwner }>;
    if (scoped.op === 'release') {
      await coordinator.release(scoped.owner);
      const key = scoped.owner.kind === 'plugin' ? (scoped.owner.handle ?? scoped.owner.extensionId) : 'core';
      const connection = connections.get(key);
      if (connection) { await connection.close(); connections.delete(key); }
      return;
    }
    const connection = connections.get(scoped.owner.kind === 'plugin' ? (scoped.owner.handle ?? scoped.owner.extensionId) : 'core');
    if (!connection) throw Object.assign(new Error('plugin database is not open'), { code: 'PLUGIN_DB_NOT_OPEN' });
    if (scoped.op === 'exec') return coordinator.run(scoped.owner, scoped.token, () => connection.exec(scoped.sql!, scoped.params));
    if (scoped.op === 'query') return coordinator.run(scoped.owner, scoped.token, () => connection.query(scoped.sql!, scoped.params));
    if (scoped.op === 'batch') return coordinator.run(scoped.owner, scoped.token, () => connection.batch(scoped.steps ?? []));
    if (scoped.op === 'begin') return coordinator.begin(scoped.owner, () => connection.begin(), () => connection.rollback());
    if (scoped.op === 'commit') return coordinator.finish(scoped.owner, scoped.token, () => connection.commit());
    if (scoped.op === 'rollback') return coordinator.finish(scoped.owner, scoped.token, () => connection.rollback());
    if (scoped.op === 'migrate') throw Object.assign(new Error('registered migrations are supplied by the host registry'), { code: 'PLUGIN_MIGRATION_NOT_REGISTERED' });
    return undefined;
  };
}
