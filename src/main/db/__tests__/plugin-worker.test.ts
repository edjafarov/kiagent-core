/** @jest-environment node */
import { openDb } from '@main/db/app-db';
import { attachDbHost, createDbClient } from '@main/db/bridge';
import { MessageChannel } from 'node:worker_threads';
import { createDbCoordinator } from '../coordinator';

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

  it('parks core work behind a plugin transaction on the production bridge', async () => {
    const db = await openDb(':memory:');
    await db.exec('CREATE TABLE t(v INTEGER)');
    const coordinator = createDbCoordinator();
    const owner = { kind: 'plugin' as const, extensionId: 'p', handle: 'h1' };
    const core = { kind: 'core' as const, handle: 'core' };
    const channel = new MessageChannel();
    let token: string | undefined;
    attachDbHost(channel.port1, db, undefined, undefined, {
      coordinator,
      coreOwner: core,
      plugin: async (request) => {
        if (request.op === 'begin') return (token = await coordinator.begin(owner, async () => undefined));
        if (request.op === 'exec') return coordinator.run(owner, request.token, () => db.run(request.sql!, request.params as never));
        if (request.op === 'commit') return coordinator.finish(owner, request.token, async () => undefined);
        return undefined;
      },
    });
    const client = createDbClient(channel.port2);
    token = (await client.plugin?.({ op: 'begin', owner })) as string;
    const waiting = client.all('SELECT COUNT(*) AS c FROM t');
    await client.plugin?.({ op: 'commit', owner, token });
    await expect(waiting).resolves.toEqual([{ c: 0 }]);
    await client.close();
    await coordinator.close();
    channel.port1.close();
    channel.port2.close();
  });
});
