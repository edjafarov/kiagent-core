/** @jest-environment node */
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';
import { createPluginDbProxy } from '../plugin-db-proxy';
import { callHost } from '../plugin-db-proxy';

describe('plugin DB proxy', () => {
  it('uses an explicit token and rolls back when the callback fails', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    const childEp = createRpcEndpoint(child);
    const rows: number[] = [];
    const calls: string[] = [];
    const tokens = new Set<string>();
    mainEp.onCall(async (_ns, method, args, context) => {
      calls.push(method);
      if (method === 'begin') {
        const token = `tx-${tokens.size + 1}`;
        tokens.add(token);
        return token;
      }
      const token = args[0] as string;
      expect(tokens.has(token)).toBe(true);
      expect(context.transactionId).toBe(token);
      if (method === 'exec') {
        rows.push(args[2] as number);
        return undefined;
      }
      if (method === 'rollback') {
        rows.pop();
        return undefined;
      }
      throw new Error(`unexpected ${method}`);
    });
    const db = createPluginDbProxy(childEp);
    await expect(
      db.transaction(async (tx) => {
        await tx.exec('INSERT INTO {{items}} VALUES (?)', [1]);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(calls).toEqual(['begin', 'exec', 'rollback']);
    expect(rows).toEqual([]);
  });

  it('rejects ordinary host calls inside a transaction before dispatch', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    const childEp = createRpcEndpoint(child);
    const seen: string[] = [];
    mainEp.onCall(async (ns, method) => {
      seen.push(`${ns}.${method}`);
      if (method === 'begin') return 'tx-1';
      if (method === 'rollback') return undefined;
      throw new Error('network should not run');
    });
    const host = { db: createPluginDbProxy(childEp), net: { fetch: () => callHost(childEp, 'net', 'fetch', []) } };
    await expect(
      host.db.transaction(async () => host.net.fetch()),
    ).rejects.toMatchObject({ code: 'HOST_CALL_IN_TRANSACTION' });
    expect(seen).toEqual(['db.begin', 'db.rollback']);
  });
});
