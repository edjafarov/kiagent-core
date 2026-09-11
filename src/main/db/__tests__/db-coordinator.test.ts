/** @jest-environment node */
import { createDbCoordinator } from '../coordinator';

describe('shared database coordinator', () => {
  it('keeps a transaction owner admitted while foreign work waits', async () => {
    const coordinator = createDbCoordinator({ leaseMs: 1000 });
    const order: string[] = [];
    const owner = { kind: 'plugin' as const, extensionId: 'one' };
    const other = { kind: 'plugin' as const, extensionId: 'two' };
    const tx = await coordinator.begin(owner, async () => {
      order.push('begin');
      return 'token';
    });
    const waiting = coordinator.run(other, undefined, async () => {
      order.push('other');
      return 2;
    });
    await coordinator.run(owner, tx, async () => {
      order.push('continuation');
      return 1;
    });
    await coordinator.finish(owner, tx, async () => {
      order.push('commit');
    });
    await waiting;
    expect(order).toEqual(['begin', 'continuation', 'commit', 'other']);
    await coordinator.close();
  });

  it('rejects a token belonging to another owner without ending the transaction', async () => {
    const coordinator = createDbCoordinator();
    const one = { kind: 'plugin' as const, extensionId: 'one' };
    const two = { kind: 'plugin' as const, extensionId: 'two' };
    const token = await coordinator.begin(one, async () => 'token');
    await expect(coordinator.run(two, token, async () => 1)).rejects.toMatchObject({
      code: 'DB_TX_TOKEN_INVALID',
    });
    await coordinator.finish(one, token, async () => undefined);
    await coordinator.close();
  });

  it('skips an aborted queued operation and releases an owner with rollback', async () => {
    const coordinator = createDbCoordinator();
    const one = { kind: 'plugin' as const, extensionId: 'one' };
    const two = { kind: 'plugin' as const, extensionId: 'two' };
    let rolledBack = false;
    const token = await coordinator.begin(one, async () => 'token', async () => { rolledBack = true; });
    const controller = new AbortController();
    const waiting = coordinator.run(two, undefined, async () => 'must not run', controller.signal);
    controller.abort();
    await coordinator.release(one);
    await expect(waiting).rejects.toMatchObject({ code: 'DB_OPERATION_CANCELLED' });
    expect(rolledBack).toBe(true);
    await coordinator.close();
  });

  it('rolls back an expired transaction and admits the next owner', async () => {
    const coordinator = createDbCoordinator({ leaseMs: 5 });
    const one = { kind: 'plugin' as const, extensionId: 'one' };
    const two = { kind: 'plugin' as const, extensionId: 'two' };
    let rolledBack = false;
    await coordinator.begin(one, async () => undefined, async () => { rolledBack = true; });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await expect(coordinator.run(two, undefined, async () => 'ok')).resolves.toBe('ok');
    expect(rolledBack).toBe(true);
    await coordinator.close();
  });

  it('treats a reactivated owner handle as distinct from its stale incarnation', async () => {
    const coordinator = createDbCoordinator();
    const oldOwner = { kind: 'plugin' as const, extensionId: 'one', handle: 'old', incarnation: 1 };
    const newOwner = { kind: 'plugin' as const, extensionId: 'one', handle: 'new', incarnation: 2 };
    const token = await coordinator.begin(oldOwner, async () => undefined);
    await expect(coordinator.release(newOwner)).resolves.toBeUndefined();
    await expect(coordinator.finish(oldOwner, token, async () => undefined)).resolves.toBeUndefined();
    await coordinator.close();
  });

  it('poisons an owner after rollback failure while allowing another owner to proceed', async () => {
    const coordinator = createDbCoordinator();
    const bad = { kind: 'plugin' as const, extensionId: 'bad', handle: 'bad-1' };
    const good = { kind: 'plugin' as const, extensionId: 'good', handle: 'good-1' };
    const token = await coordinator.begin(bad, async () => undefined, async () => { throw new Error('rollback failed'); });
    await expect(coordinator.release(bad)).rejects.toThrow('rollback failed');
    await expect(coordinator.run(bad, token, async () => 1)).rejects.toMatchObject({ code: 'DB_OWNER_POISONED' });
    await expect(coordinator.run(good, undefined, async () => 2)).resolves.toBe(2);
    await coordinator.close();
  });

  it('removes coordinator abort listeners whenever queued jobs settle', async () => {
    const queueScenario = async (
      work: () => unknown,
      settle: (coordinator: ReturnType<typeof createDbCoordinator>, owner: { kind: 'plugin'; extensionId: string }, token: string, waiting: Promise<unknown>, controller: AbortController) => Promise<void>,
    ) => {
      const coordinator = createDbCoordinator();
      const owner = { kind: 'plugin' as const, extensionId: 'one' };
      const other = { kind: 'plugin' as const, extensionId: 'two' };
      const token = await coordinator.begin(owner, async () => undefined);
      const controller = new AbortController();
      const listeners = new Set<EventListenerOrEventListenerObject>();
      const signal = controller.signal;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((type: 'abort', listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
        if (!listener) return;
        listeners.add(listener);
        return add(type, listener, options);
      }) as typeof signal.addEventListener;
      signal.removeEventListener = ((type: 'abort', listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
        if (!listener) return;
        listeners.delete(listener);
        return remove(type, listener, options);
      }) as typeof signal.removeEventListener;
      const waiting = coordinator.run(other, undefined, work, signal);
      await settle(coordinator, owner, token, waiting, controller);
      expect(listeners.size).toBe(0);
      await coordinator.close().catch(() => undefined);
    };

    await queueScenario(() => 1, async (coordinator, owner, token, waiting) => {
      await coordinator.finish(owner, token, async () => undefined);
      await expect(waiting).resolves.toBe(1);
    });
    await queueScenario(() => { throw new Error('queued failure'); }, async (coordinator, owner, token, waiting) => {
      await coordinator.finish(owner, token, async () => undefined);
      await expect(waiting).rejects.toThrow('queued failure');
    });
    await queueScenario(() => 1, async (coordinator, owner, _token, waiting, controller) => {
      controller.abort();
      await expect(waiting).rejects.toMatchObject({ code: 'DB_OPERATION_CANCELLED' });
      await coordinator.release(owner);
    });
    await queueScenario(() => 1, async (coordinator, owner, _token, waiting) => {
      await coordinator.release(owner);
      await expect(waiting).resolves.toBe(1);
    });
    await queueScenario(() => 1, async (coordinator, _owner, _token, waiting) => {
      await coordinator.close();
      await expect(waiting).rejects.toMatchObject({ code: 'DB_COORDINATOR_CLOSED' });
    });
  });
});
