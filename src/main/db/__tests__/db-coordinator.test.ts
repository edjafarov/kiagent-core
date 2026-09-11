/** @jest-environment node */
import { createDbCoordinator } from '../coordinator';

describe('shared database coordinator', () => {
  it('admits a foreign begin after queued core work and the active owner commits', async () => {
    const coordinator = createDbCoordinator({ leaseMs: 1000 });
    const order: string[] = [];
    const rows: number[] = [];
    const ownerA = { kind: 'plugin' as const, extensionId: 'one', handle: 'one-1' };
    const ownerB = { kind: 'plugin' as const, extensionId: 'two', handle: 'two-1' };
    const core = { kind: 'core' as const, handle: 'core' };
    const nativeBeginB = jest.fn(async () => { order.push('b-native-begin'); });

    const tokenA = await coordinator.begin(ownerA, async () => {
      order.push('a-native-begin');
    });
    await coordinator.run(ownerA, tokenA, async () => {
      rows.push(1);
      order.push('a-insert');
    });

    // The core write is deliberately enqueued before the foreign begin. It
    // must retain FIFO order once the active token continuation releases the
    // coordinator.
    const coreWrite = coordinator.run(core, undefined, async () => {
      rows.push(2);
      order.push('core-write');
    });
    const tokenBPromise = coordinator.begin(ownerB, async () => {
      nativeBeginB();
      order.push('b-native-begin-work');
    });
    await Promise.resolve();
    expect(nativeBeginB).not.toHaveBeenCalled();

    await coordinator.finish(ownerA, tokenA, async () => {
      order.push('a-commit');
    });
    await coreWrite;
    const tokenB = await tokenBPromise;
    await coordinator.run(ownerB, tokenB, async () => {
      rows.push(3);
      order.push('b-insert');
    });
    await coordinator.finish(ownerB, tokenB, async () => {
      order.push('b-commit');
    });

    expect(rows).toEqual([1, 2, 3]);
    expect(order).toEqual([
      'a-native-begin',
      'a-insert',
      'a-commit',
      'core-write',
      'b-native-begin',
      'b-native-begin-work',
      'b-insert',
      'b-commit',
    ]);
    expect(nativeBeginB).toHaveBeenCalledTimes(1);
    await coordinator.close();
  });

  it('serializes independently constructed adapters that share one owner handle', async () => {
    const coordinator = createDbCoordinator();
    const order: string[] = [];
    const ownerFromFirstAdapter = { kind: 'plugin' as const, extensionId: 'one', handle: 'shared' };
    const ownerFromSecondAdapter = { kind: 'plugin' as const, extensionId: 'one', handle: 'shared' };
    const makeAdapter = (owner: typeof ownerFromFirstAdapter, label: string) => ({
      begin: () => coordinator.begin(owner, async () => { order.push(`${label}:begin`); }),
      commit: (token: string) => coordinator.finish(owner, token, async () => { order.push(`${label}:commit`); }),
    });
    const first = makeAdapter(ownerFromFirstAdapter, 'first');
    const second = makeAdapter(ownerFromSecondAdapter, 'second');

    const firstToken = await first.begin();
    const secondTokenPromise = second.begin();
    await Promise.resolve();
    expect(order).toEqual(['first:begin']);

    await first.commit(firstToken);
    const secondToken = await secondTokenPromise;
    await second.commit(secondToken);
    expect(order).toEqual(['first:begin', 'first:commit', 'second:begin', 'second:commit']);
    await coordinator.close();
  });

  it('queues a second begin while the first native begin is still awaiting admission', async () => {
    const coordinator = createDbCoordinator();
    const order: string[] = [];
    const ownerA = { kind: 'plugin' as const, extensionId: 'one' };
    const ownerB = { kind: 'plugin' as const, extensionId: 'two' };
    let releaseFirstBegin!: () => void;
    const firstBeginGate = new Promise<void>((resolve) => { releaseFirstBegin = resolve; });
    let firstBeginStarted!: () => void;
    const firstBeginEntered = new Promise<void>((resolve) => { firstBeginStarted = resolve; });
    const secondNativeBegin = jest.fn(async () => { order.push('second-begin'); });

    const firstTokenPromise = coordinator.begin(ownerA, async () => {
      firstBeginStarted();
      await firstBeginGate;
      order.push('first-begin-complete');
    });
    await firstBeginEntered;
    const secondTokenPromise = coordinator.begin(ownerB, async () => {
      secondNativeBegin();
      order.push('second-begin-work');
    });
    await Promise.resolve();
    expect(secondNativeBegin).not.toHaveBeenCalled();
    releaseFirstBegin();

    const firstToken = await firstTokenPromise;
    expect(order).toEqual(['first-begin-complete']);
    await coordinator.finish(ownerA, firstToken, async () => { order.push('first-commit'); });
    const secondToken = await secondTokenPromise;
    await coordinator.finish(ownerB, secondToken, async () => { order.push('second-commit'); });
    expect(order).toEqual([
      'first-begin-complete',
      'first-commit',
      'second-begin',
      'second-begin-work',
      'second-commit',
    ]);
    await coordinator.close();
  });

  it('cancels a queued begin before native work and removes its abort listener', async () => {
    const coordinator = createDbCoordinator();
    const ownerA = { kind: 'plugin' as const, extensionId: 'one' };
    const ownerB = { kind: 'plugin' as const, extensionId: 'two' };
    const tokenA = await coordinator.begin(ownerA, async () => undefined);
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
    const nativeBegin = jest.fn(async () => undefined);
    const beginWithSignal = coordinator.begin as unknown as (
      owner: typeof ownerB,
      work: () => Promise<unknown> | unknown,
      rollback?: () => Promise<unknown> | unknown,
      abortSignal?: AbortSignal,
    ) => Promise<string>;
    const waiting = beginWithSignal(ownerB, nativeBegin, undefined, signal);

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'DB_OPERATION_CANCELLED' });
    expect(nativeBegin).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
    await coordinator.finish(ownerA, tokenA, async () => undefined);
    await coordinator.close();
  });

  it('rejects a queued begin released by its owner without starting native work', async () => {
    const coordinator = createDbCoordinator();
    const ownerA = { kind: 'plugin' as const, extensionId: 'one' };
    const ownerB = { kind: 'plugin' as const, extensionId: 'two' };
    const tokenA = await coordinator.begin(ownerA, async () => undefined);
    const nativeBegin = jest.fn(async () => undefined);
    const waiting = coordinator.begin(ownerB, nativeBegin);

    await coordinator.release(ownerB);
    await expect(waiting).rejects.toMatchObject({ code: 'DB_OWNER_RELEASED' });
    expect(nativeBegin).not.toHaveBeenCalled();
    await coordinator.finish(ownerA, tokenA, async () => undefined);
    await coordinator.close();
  });

  it('rejects queued begins on close without starting native work', async () => {
    const coordinator = createDbCoordinator();
    const ownerA = { kind: 'plugin' as const, extensionId: 'one' };
    const ownerB = { kind: 'plugin' as const, extensionId: 'two' };
    const tokenA = await coordinator.begin(ownerA, async () => undefined);
    const nativeBegin = jest.fn(async () => undefined);
    const waiting = coordinator.begin(ownerB, nativeBegin);

    await coordinator.close();
    await expect(waiting).rejects.toMatchObject({ code: 'DB_COORDINATOR_CLOSED' });
    expect(nativeBegin).not.toHaveBeenCalled();
    await expect(coordinator.finish(ownerA, tokenA, async () => undefined)).rejects.toMatchObject({ code: 'DB_TX_TOKEN_INVALID' });
  });

  it('poisons queued begins for an owner after rollback failure before foreign work', async () => {
    const coordinator = createDbCoordinator();
    const bad = { kind: 'plugin' as const, extensionId: 'bad', handle: 'bad-1' };
    const good = { kind: 'plugin' as const, extensionId: 'good', handle: 'good-1' };
    const token = await coordinator.begin(bad, async () => undefined, async () => { throw new Error('rollback failed'); });
    const poisonedNativeBegin = jest.fn(async () => undefined);
    const poisonedBegin = coordinator.begin(bad, poisonedNativeBegin);
    const foreignWork = coordinator.run(good, undefined, async () => 'foreign-ok');

    await expect(coordinator.release(bad)).rejects.toThrow('rollback failed');
    await expect(poisonedBegin).rejects.toMatchObject({ code: 'DB_OWNER_POISONED' });
    await expect(foreignWork).resolves.toBe('foreign-ok');
    expect(poisonedNativeBegin).not.toHaveBeenCalled();
    await coordinator.close();
  });

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
