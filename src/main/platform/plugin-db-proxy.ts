import type { PluginDb, PluginDbParams, PluginDbSession, PluginDbStep } from '@shared/plugin-db';

import type { RpcEndpoint } from './transport';
import { hostCallContext, type HostCallContext } from './host-call-context';

function callDb(
  endpoint: RpcEndpoint,
  method: string,
  args: unknown[],
  transactionId?: string,
): Promise<unknown> {
  return endpoint.call('db', method, args, { transactionId });
}

function txSession(endpoint: RpcEndpoint, token: string): PluginDbSession {
  return {
    async exec(sql: string, params?: PluginDbParams): Promise<void> {
      await callDb(endpoint, 'exec', [token, sql, params], token);
    },
    query<Row = Record<string, unknown>>(sql: string, params?: PluginDbParams) {
      return callDb(endpoint, 'query', [token, sql, params], token) as Promise<Row[]>;
    },
    batch(steps: readonly PluginDbStep[]) {
      return callDb(endpoint, 'batch', [token, steps], token) as Promise<unknown[][]>;
    },
  };
}

export function createPluginDbProxy(
  endpoint: RpcEndpoint,
  context: HostCallContext = hostCallContext,
): PluginDb {
  const assertOutside = () => {
    if (context.current()) context.assertAllowed('db');
  };
  return {
    identifier(name) {
      if (!/^[a-z][a-z0-9_]*$/.test(name))
        throw new Error('invalid logical identifier');
      return name;
    },
    exec(sql, params) {
      assertOutside();
      return callDb(endpoint, 'exec', [sql, params]) as Promise<void>;
    },
    query<Row = Record<string, unknown>>(sql: string, params?: PluginDbParams) {
      assertOutside();
      return callDb(endpoint, 'query', [sql, params]) as Promise<Row[]>;
    },
    batch(steps) {
      assertOutside();
      return callDb(endpoint, 'batch', [steps]) as Promise<unknown[][]>;
    },
    async migrate(module, version, statements) {
      assertOutside();
      await callDb(endpoint, 'migrate', [module, version, statements]);
    },
    async transaction<T>(work: (tx: PluginDbSession) => Promise<T>) {
      if (context.current()) context.assertAllowed('db');
      const token = (await callDb(endpoint, 'begin', [])) as string;
      const tx = txSession(endpoint, token);
      try {
        const value = await context.run(token, () => work(tx));
        await callDb(endpoint, 'commit', [token], token);
        return value;
      } catch (error) {
        try {
          await callDb(endpoint, 'rollback', [token], token);
        } catch (rollbackError) {
          if (error && typeof error === 'object')
            (error as Record<string, unknown>).rollbackError = rollbackError;
        }
        throw error;
      }
    },
  };
}

export function callHost(
  endpoint: RpcEndpoint,
  namespace: string,
  method: string,
  args: unknown[],
  context: HostCallContext = hostCallContext,
): Promise<unknown> {
  context.assertAllowed(namespace);
  return endpoint.call(namespace, method, args, {
    transactionId: context.current(),
  });
}
