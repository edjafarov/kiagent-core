/** @jest-environment node */
import { openDb } from '@main/db/app-db';
import { attachDbHost, createDbClient } from '@main/db/bridge';
import { MessageChannel } from 'node:worker_threads';

describe('plugin bridge requests', () => {
  it('routes a host-authorized plugin request through AppDb.plugin', async () => {
    const db = await openDb(':memory:');
    const channel = new MessageChannel();
    attachDbHost(channel.port1, db, undefined, undefined, {
      plugin: async (request) => ({ accepted: request.op }),
    });
    const client = createDbClient(channel.port2);
    await expect(client.plugin?.({ op: 'diagnostics' })).resolves.toEqual({
      accepted: 'diagnostics',
    });
    await db.close();
    channel.port1.close();
    channel.port2.close();
  });
});
