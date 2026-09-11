import { AsyncLocalStorage } from 'node:async_hooks';

export interface HostCallContext {
  run<T>(transactionId: string, work: () => Promise<T>): Promise<T>;
  current(): string | undefined;
  assertAllowed(namespace: string): void;
}

export class HostCallInTransactionError extends Error {
  readonly code = 'HOST_CALL_IN_TRANSACTION' as const;

  constructor(namespace: string) {
    super(`host.${namespace} is unavailable inside a database transaction`);
    this.name = 'HostCallInTransactionError';
  }
}

export function createHostCallContext(): HostCallContext {
  const storage = new AsyncLocalStorage<string>();
  return {
    run<T>(transactionId: string, work: () => Promise<T>): Promise<T> {
      return storage.run(transactionId, work);
    },
    current() {
      return storage.getStore();
    },
    assertAllowed(namespace) {
      if (storage.getStore() && namespace !== 'db')
        throw new HostCallInTransactionError(namespace);
    },
  };
}

export const hostCallContext = createHostCallContext();
