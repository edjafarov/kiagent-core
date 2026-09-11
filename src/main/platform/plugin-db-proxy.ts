import type {
  PluginDb,
  PluginDbParams,
  PluginDbSession,
  PluginDbStep,
} from '@shared/plugin-db';

import { pluginIdentifier } from '@shared/plugin-sql';
import type { RpcCallOptions, RpcEndpoint } from './transport';
import {
  HostCallInTransactionError,
  hostCallContext,
  type HostCallContext,
} from './host-call-context';

function callDb(
  endpoint: RpcEndpoint,
  method: string,
  args: unknown[],
  options: Pick<RpcCallOptions, 'transactionId' | 'transactionBoundary'> = {},
): Promise<unknown> {
  return endpoint.call('db', method, args, options);
}

function txSession(endpoint: RpcEndpoint, token: string): PluginDbSession {
  return {
    async exec(sql: string, params?: PluginDbParams): Promise<void> {
      await callDb(endpoint, 'exec', [token, sql, params], {
        transactionId: token,
      });
    },
    query<Row = Record<string, unknown>>(sql: string, params?: PluginDbParams) {
      return callDb(endpoint, 'query', [token, sql, params], {
        transactionId: token,
      }) as Promise<Row[]>;
    },
    batch(steps: readonly PluginDbStep[]) {
      return callDb(endpoint, 'batch', [token, steps], {
        transactionId: token,
      }) as Promise<unknown[][]>;
    },
  };
}

export function createPluginDbProxy(
  endpoint: RpcEndpoint,
  pluginId: string,
  context: HostCallContext = hostCallContext,
): PluginDb {
  const assertOutside = () => {
    if (context.current()) throw new HostCallInTransactionError('db');
  };
  return {
    identifier(name) {
      if (!/^[a-z][a-z0-9_]*$/.test(name))
        throw new Error('invalid logical identifier');
      return pluginIdentifier(pluginId, name);
    },
    async exec(sql, params) {
      assertOutside();
      await callDb(endpoint, 'exec', [sql, params]);
    },
    async query<Row = Record<string, unknown>>(
      sql: string,
      params?: PluginDbParams,
    ) {
      assertOutside();
      return callDb(endpoint, 'query', [sql, params]) as Promise<Row[]>;
    },
    async batch(steps) {
      assertOutside();
      return callDb(endpoint, 'batch', [steps]) as Promise<unknown[][]>;
    },
    async migrate(module, version, statements) {
      assertOutside();
      await callDb(endpoint, 'migrate', [module, version, statements]);
    },
    async transaction<T>(work: (tx: PluginDbSession) => Promise<T>) {
      if (context.current()) throw new HostCallInTransactionError('db');
      const token = (await callDb(endpoint, 'begin', [], {
        transactionBoundary: true,
      })) as string;
      const tx = txSession(endpoint, token);
      try {
        const value = await context.run(token, () => work(tx));
        await callDb(endpoint, 'commit', [token], { transactionId: token });
        return value;
      } catch (error) {
        try {
          await callDb(endpoint, 'rollback', [token], {
            transactionId: token,
          });
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
  context?: HostCallContext,
  options?: Pick<RpcCallOptions, 'signal' | 'timeoutMs'>,
): Promise<unknown> {
  const effectiveContext = context ?? hostCallContext;
  effectiveContext.assertAllowed(namespace);
  return endpoint.call(namespace, method, args, {
    transactionId: effectiveContext.current(),
    ...options,
  });
}
