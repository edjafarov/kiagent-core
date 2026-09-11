import { randomUUID } from 'node:crypto';

export type DbOwner =
  | { kind: 'core'; handle?: string; incarnation?: number }
  | {
      kind: 'plugin';
      extensionId: string;
      handle?: string;
      incarnation?: number;
    };
export type TxToken = string;
export interface CoordinatorMetrics {
  queued: number;
  active: boolean;
  owner?: DbOwner;
  operations: Array<{
    owner: DbOwner;
    operation: string;
    count: number;
    queueWaitMs: number;
    executionMs: number;
    slowestMs: number;
  }>;
}
export interface DbCoordinator {
  run<T>(
    owner: DbOwner,
    token: TxToken | undefined,
    work: () => Promise<T> | T,
    signal?: AbortSignal,
    operation?: string,
  ): Promise<T>;
  begin(
    owner: DbOwner,
    work: () => Promise<unknown> | unknown,
    rollback?: () => Promise<unknown> | unknown,
    signal?: AbortSignal,
    operation?: string,
  ): Promise<TxToken>;
  finish<T>(
    owner: DbOwner,
    token: TxToken,
    work: () => Promise<T> | T,
    operation?: string,
  ): Promise<T>;
  release(owner: DbOwner): Promise<void>;
  close(): Promise<void>;
  metrics(): CoordinatorMetrics;
}

type Job<T> = {
  owner: DbOwner;
  token?: TxToken;
  work: () => Promise<T> | T;
  signal?: AbortSignal;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
  cleanup?: () => void;
  settled?: boolean;
  enqueuedAt: number;
  operation: string;
};
type Active = {
  owner: DbOwner;
  token: TxToken;
  rollback?: () => Promise<unknown> | unknown;
  expires: number;
  timer?: ReturnType<typeof setTimeout>;
};

const error = (message: string, code: string): Error & { code: string } =>
  Object.assign(new Error(message), { code });
const sameOwner = (a: DbOwner, b: DbOwner) => {
  if (a.kind !== b.kind) return false;
  if (
    a.kind === 'plugin' &&
    a.extensionId !== (b as { extensionId: string }).extensionId
  )
    return false;
  if (a.handle || b.handle)
    return !!a.handle && !!b.handle && a.handle === b.handle;
  return (
    a.incarnation === undefined ||
    b.incarnation === undefined ||
    a.incarnation === b.incarnation
  );
};

export function createDbCoordinator(
  options: {
    leaseMs?: number;
    onOwnerFailure?: (owner: DbOwner) => Promise<void> | void;
  } = {},
): DbCoordinator {
  const leaseMs = options.leaseMs ?? 30_000;
  const queue: Job<unknown>[] = [];
  let active: Active | undefined;
  const failedOwners = new Set<string>();
  let closed = false;
  let pumping = false;
  const measurements = new Map<
    string,
    {
      owner: DbOwner;
      operation: string;
      count: number;
      queueWaitMs: number;
      executionMs: number;
      slowestMs: number;
    }
  >();
  const MAX_MEASUREMENTS = 64;

  const ownerKey = (owner: DbOwner): string =>
    owner.kind === 'plugin'
      ? (owner.handle ?? owner.extensionId)
      : (owner.handle ?? 'core');

  const settleJob = (
    job: Job<unknown>,
    outcome: 'resolve' | 'reject',
    value: unknown,
  ): void => {
    if (job.settled) return;
    job.settled = true;
    job.cleanup?.();
    if (outcome === 'resolve') job.resolve(value);
    else job.reject(value);
  };

  const rejectQueued = (
    predicate: (job: Job<unknown>) => boolean,
    reason: unknown,
  ): void => {
    for (let i = queue.length - 1; i >= 0; i--) {
      const job = queue[i];
      if (!predicate(job)) continue;
      queue.splice(i, 1);
      settleJob(job, 'reject', reason);
    }
  };

  const poisonOwner = async (owner: DbOwner): Promise<void> => {
    failedOwners.add(ownerKey(owner));
    rejectQueued(
      (job) => sameOwner(job.owner, owner),
      error(
        'database owner is unusable after rollback failure',
        'DB_OWNER_POISONED',
      ),
    );
    try {
      await options.onOwnerFailure?.(owner);
    } catch {
      /* cleanup must not strand the queue */
    }
  };

  const clearActive = (target: Active): void => {
    if (active !== target) return;
    if (target.timer) clearTimeout(target.timer);
    active = undefined;
  };

  const rollbackActive = async (target: Active): Promise<void> => {
    try {
      await target.rollback?.();
    } catch {
      await poisonOwner(target.owner);
    }
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (closed) break;
        if (active && Date.now() > active.expires) {
          const expired = active;
          rejectQueued(
            (job) => job.token === expired.token,
            error('transaction lease expired', 'DB_TX_EXPIRED'),
          );
          await rollbackActive(expired);
          clearActive(expired);
        }
        const index = queue.findIndex((job) => (job.token ? true : !active));
        if (index < 0) break;
        const [job] = queue.splice(index, 1);
        const startedAt = Date.now();
        if (
          job.token &&
          (!active ||
            active.token !== job.token ||
            !sameOwner(job.owner, active.owner))
        ) {
          settleJob(
            job,
            'reject',
            error(
              'invalid or foreign transaction token',
              'DB_TX_TOKEN_INVALID',
            ),
          );
          continue;
        }
        if (job.signal?.aborted) {
          settleJob(
            job,
            'reject',
            error('database operation cancelled', 'DB_OPERATION_CANCELLED'),
          );
          continue;
        }
        try {
          settleJob(job, 'resolve', await job.work());
        } catch (e) {
          settleJob(job, 'reject', e);
        } finally {
          const key = `${ownerKey(job.owner)}\0${job.operation}`;
          let metric = measurements.get(key);
          if (!metric) {
            if (measurements.size >= MAX_MEASUREMENTS) {
              const otherKey = '__other__\0other';
              metric = measurements.get(otherKey);
              if (!metric) {
                metric = {
                  owner: { kind: 'core', handle: '__other__' },
                  operation: 'other',
                  count: 0,
                  queueWaitMs: 0,
                  executionMs: 0,
                  slowestMs: 0,
                };
                measurements.set(otherKey, metric);
              }
            } else {
              metric = {
                owner: job.owner,
                operation: job.operation,
                count: 0,
                queueWaitMs: 0,
                executionMs: 0,
                slowestMs: 0,
              };
              measurements.set(key, metric);
            }
          }
          const executionMs = Date.now() - startedAt;
          metric.count += 1;
          metric.queueWaitMs += startedAt - job.enqueuedAt;
          metric.executionMs += executionMs;
          metric.slowestMs = Math.max(metric.slowestMs, executionMs);
        }
      }
    } finally {
      pumping = false;
    }
  };

  const enqueue = <T>(
    owner: DbOwner,
    token: TxToken | undefined,
    work: () => Promise<T> | T,
    signal?: AbortSignal,
    operation = 'run',
  ): Promise<T> => {
    if (closed)
      return Promise.reject(
        error('database coordinator is closed', 'DB_COORDINATOR_CLOSED'),
      );
    if (failedOwners.has(ownerKey(owner)))
      return Promise.reject(
        error(
          'database owner is unusable after rollback failure',
          'DB_OWNER_POISONED',
        ),
      );
    if (
      token &&
      (!active || active.token !== token || !sameOwner(owner, active.owner))
    )
      return Promise.reject(
        error('invalid or foreign transaction token', 'DB_TX_TOKEN_INVALID'),
      );
    return new Promise<T>((resolve, reject) => {
      const job = {
        owner,
        token,
        work,
        signal,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
        operation,
      } as Job<T>;
      if (signal) {
        const cancel = () => {
          const index = queue.indexOf(job as Job<unknown>);
          if (index >= 0) {
            queue.splice(index, 1);
            settleJob(
              job as Job<unknown>,
              'reject',
              error('database operation cancelled', 'DB_OPERATION_CANCELLED'),
            );
          }
        };
        if (signal.aborted) {
          reject(
            error('database operation cancelled', 'DB_OPERATION_CANCELLED'),
          );
          return;
        }
        job.cleanup = () => signal.removeEventListener('abort', cancel);
        signal.addEventListener('abort', cancel, { once: true });
      }
      queue.push(job as Job<unknown>);
      void pump();
    });
  };

  return {
    run: enqueue,
    begin: (owner, work, rollback, signal, operation = 'begin') => {
      return enqueue(
        owner,
        undefined,
        async () => {
          const token = randomUUID();
          const started: Active = {
            owner,
            token,
            rollback,
            expires: Date.now() + leaseMs,
          };
          active = started;
          started.timer = setTimeout(() => {
            void pump();
          }, leaseMs + 1);
          started.timer.unref?.();
          try {
            await work();
          } catch (e) {
            await rollbackActive(started);
            clearActive(started);
            throw e;
          }
          return token;
        },
        signal,
        operation,
      );
    },
    finish: async (owner, token, work, operation = 'finish') => {
      if (!active || active.token !== token || !sameOwner(owner, active.owner))
        return Promise.reject(
          error('invalid or foreign transaction token', 'DB_TX_TOKEN_INVALID'),
        );
      const finished = active;
      try {
        return await enqueue(
          owner,
          token,
          async () => {
            try {
              return await work();
            } finally {
              rejectQueued(
                (job) => job.token === finished.token,
                error(
                  'invalid or foreign transaction token',
                  'DB_TX_TOKEN_INVALID',
                ),
              );
            }
          },
          undefined,
          operation,
        );
      } catch (e) {
        // A deferred-FK COMMIT can fail while SQLite keeps the native
        // transaction open. Repair it before releasing admission, preserving
        // the original COMMIT error for the caller.
        if (active === finished) await rollbackActive(finished);
        throw e;
      } finally {
        rejectQueued(
          (job) => job.token === finished.token,
          error('invalid or foreign transaction token', 'DB_TX_TOKEN_INVALID'),
        );
        clearActive(finished);
        void pump();
      }
    },
    release: async (owner) => {
      let rollbackError: unknown;
      if (active && sameOwner(owner, active.owner)) {
        const released = active;
        if (released.timer) clearTimeout(released.timer);
        try {
          await released.rollback?.();
        } catch (e) {
          rollbackError = e;
          await poisonOwner(owner);
        }
        clearActive(released);
      }
      rejectQueued(
        (job) => sameOwner(job.owner, owner),
        error('database owner released', 'DB_OWNER_RELEASED'),
      );
      await pump();
      if (rollbackError) throw rollbackError;
    },
    close: async () => {
      closed = true;
      const closing = active;
      let rollbackError: unknown;
      if (closing) {
        if (closing.timer) clearTimeout(closing.timer);
        try {
          await closing.rollback?.();
        } catch (e) {
          rollbackError = e;
          await poisonOwner(closing.owner);
        }
        clearActive(closing);
      }
      while (queue.length)
        settleJob(
          queue.shift()!,
          'reject',
          error('database coordinator is closed', 'DB_COORDINATOR_CLOSED'),
        );
      if (rollbackError) throw rollbackError;
    },
    metrics: () => ({
      queued: queue.length,
      active: !!active,
      owner: active?.owner,
      operations: [...measurements.values()].map((metric) => ({ ...metric })),
    }),
  };
}
