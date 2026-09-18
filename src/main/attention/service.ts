import type { ExtensionSnapshot } from '@shared/contracts';
import type { AttentionItemWire } from '@shared/attention';

import type { AppDb } from '../db/app-db';
import {
  ATTENTION_ACTION_POLICY,
  type AttentionActionPolicy,
} from './action-policy';
import {
  createAttentionTx,
  type AttentionTx,
  type AttentionTxResult,
} from './attention-tx';
import { validateBatch } from './validate';

const TICK_MS = 60_000;

export interface AttentionTimers {
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AttentionServiceDeps {
  db: AppDb;
  policy?: AttentionActionPolicy;
  clock?: () => number;
  log?: (message: string) => void;
  onChanged: () => void;
  timers?: AttentionTimers;
}

export interface AttentionPublishResult {
  rejected: Array<{ id: string; reason: string }>;
}

export interface AttentionService {
  publish(producer: string, rawItems: unknown): Promise<AttentionPublishResult>;
  resolve(
    producer: string,
    id: string,
    revision?: number,
  ): Promise<AttentionPublishResult>;
  list(kinds?: AttentionItemWire['kind'][]): Promise<AttentionItemWire[]>;
  act(request: { id: string; action: 'dismiss' }): Promise<void>;
  dismiss(id: string): Promise<void>;
  setExtensions(snapshot: readonly ExtensionSnapshot[]): void;
  notifyReset(): void;
  dispose(): Promise<void>;
}

interface AttentionError extends Error {
  code: string;
}

function codedError(code: string, message: string): AttentionError {
  return Object.assign(new Error(message), { code });
}

function errorMessage(error: unknown): string {
  try {
    if (error instanceof Error) return error.message;
    if (error && typeof error === 'object') {
      const { message } = error as { message?: unknown };
      if (typeof message === 'string') return message;
    }
    return String(error);
  } catch {
    return 'attention operation failed';
  }
}

function isAvailable(snapshot: ExtensionSnapshot): boolean {
  return snapshot.enabled === true && snapshot.status === 'activated';
}

function isKnownPreDispatchFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code !== undefined)
    return code === 'DB_COORDINATOR_CLOSED' || code === 'DB_WORKER_DEAD';
  // worker-client.ts intentionally leaves this terminal close rejection
  // code-less. Do not broaden this to other DB-looking messages: only these
  // three failures guarantee that the proc did not execute (design §7).
  return errorMessage(error) === 'db worker closed';
}

/**
 * The attention service is the ownership boundary for these transactions.
 * In particular, it never wraps a tx op in an AppDb batch: design §6 R5/R6
 * require the transaction result to mean that the attention op itself has
 * committed, not merely that an outer savepoint accepted it.
 */
export function createAttentionService(
  deps: AttentionServiceDeps,
): AttentionService {
  const policy = deps.policy ?? ATTENTION_ACTION_POLICY;
  const clock = deps.clock ?? Date.now;
  const timers = deps.timers ?? {
    setInterval: (callback: () => void, delay: number) =>
      setInterval(callback, delay),
    clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout),
  };
  const tx: AttentionTx | null = deps.db._conn
    ? createAttentionTx(deps.db._conn, { policy, now: clock })
    : null;

  let available = new Set<string>();
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const admitted = new Set<Promise<unknown>>();

  const safeLog = (result: AttentionTxResult): void => {
    if (!deps.log) return;
    for (const failure of result.rowFailures) {
      try {
        // Keep conversion and message construction inside the guarded call:
        // diagnostics are deliberately unable to replace the operation's
        // actual outcome (design §6 R6).
        deps.log(
          `attention row failure ${failure.producer}/${failure.id}: ${String(failure.message)}`,
        );
      } catch {
        // A diagnostic sink is not part of the data-plane outcome.
      }
    }
  };

  const notifyChanged = (): void => {
    try {
      deps.onChanged();
    } catch (error) {
      try {
        // Build the diagnostic inside the guarded callback too: a hostile
        // error value or sink must never alter the data-plane outcome.
        deps.log?.(
          `attention change notification failed: ${errorMessage(error)}`,
        );
      } catch {
        // Notification diagnostics are best effort.
      }
    }
  };

  const finish = <T>(
    result: AttentionTxResult,
    response: (result: Extract<AttentionTxResult, { ok: true }>) => T,
  ): T => {
    safeLog(result);
    if (!result.ok) {
      throw codedError('ATTENTION_TX_FAILED', result.error.message);
    }
    // Applies to successful reads too: a list that expired a row changed
    // state. Only FAILED reads are hint-free (see dispatch's `read` option).
    if (result.changed) notifyChanged();
    return response(result);
  };

  const dispatch = <T>(
    operation: () => AttentionTxResult | Promise<unknown>,
    response: (result: Extract<AttentionTxResult, { ok: true }>) => T,
    options: { read?: boolean } = {},
  ): Promise<T> => {
    if (disposed)
      return Promise.reject(
        codedError('ATTENTION_DISPOSED', 'attention service is disposed'),
      );
    if (!deps.db.isOpen())
      return Promise.reject(
        codedError('ATTENTION_DB_UNAVAILABLE', 'attention database is closed'),
      );

    let raw: AttentionTxResult | Promise<unknown>;
    try {
      // Capture the availability set and call the tx synchronously. For the
      // worker path this is the exact point at which the proc request enters
      // the FIFO; no await is allowed between validation and this dispatch.
      raw = operation();
    } catch (error) {
      if (isKnownPreDispatchFailure(error))
        return Promise.reject(
          codedError('ATTENTION_DB_UNAVAILABLE', errorMessage(error)),
        );
      const unknown = Promise.reject(
        codedError(
          options.read ? 'ATTENTION_READ_FAILED' : 'ATTENTION_OUTCOME_UNKNOWN',
          errorMessage(error),
        ),
      ).catch((errorValue) => {
        if (!options.read) notifyChanged();
        throw errorValue;
      });
      admitted.add(unknown);
      unknown.finally(() => admitted.delete(unknown)).catch(() => {});
      return unknown as Promise<T>;
    }

    const settled = Promise.resolve(raw).then(
      (result) => finish(result as unknown as AttentionTxResult, response),
      (error) => {
        if (isKnownPreDispatchFailure(error))
          throw codedError('ATTENTION_DB_UNAVAILABLE', errorMessage(error));
        if (!options.read) notifyChanged();
        throw codedError(
          options.read ? 'ATTENTION_READ_FAILED' : 'ATTENTION_OUTCOME_UNKNOWN',
          errorMessage(error),
        );
      },
    );
    const tracked = settled.finally(() => admitted.delete(tracked));
    admitted.add(tracked);
    return tracked as Promise<T>;
  };

  const availableAtDispatch = (): string[] => [...available];

  const disposedMutation = (): Promise<never> =>
    Promise.reject(
      codedError('ATTENTION_DISPOSED', 'attention service is disposed'),
    );

  const dismiss = (id: string): Promise<void> => {
    const captured = availableAtDispatch();
    return dispatch(
      () =>
        tx
          ? tx.dismiss({ id, availableProducers: captured })
          : deps.db.proc!('attention.dismiss', {
              id,
              availableProducers: captured,
            }),
      () => undefined,
    );
  };

  const tick = (): Promise<void> => {
    const captured = availableAtDispatch();
    return dispatch(
      () =>
        tx
          ? tx.tick({ availableProducers: captured })
          : deps.db.proc!('attention.tick', {
              availableProducers: captured,
            }),
      () => undefined,
    );
  };

  const interval = timers.setInterval(() => {
    void tick().catch((error) => {
      try {
        deps.log?.(`attention tick failed: ${errorMessage(error)}`);
      } catch {
        // Detached timer work must never become an unhandled rejection.
      }
    });
  }, TICK_MS);

  return {
    publish(producer, rawItems) {
      if (disposed) return disposedMutation();
      const validation = validateBatch(producer, rawItems, policy);
      if (validation.rejected.length)
        return Promise.resolve({ rejected: validation.rejected });
      const captured = availableAtDispatch();
      return dispatch(
        () =>
          tx
            ? tx.publish({
                producer,
                items: validation.valid,
                availableProducers: captured,
              })
            : deps.db.proc!('attention.publish', {
                producer,
                items: validation.valid,
                availableProducers: captured,
              }),
        () => ({ rejected: [] }),
      );
    },

    resolve(producer, id, revision) {
      if (disposed) return disposedMutation();
      if (
        !/^[a-z0-9-]+\.[a-z0-9-]+$/.test(producer) ||
        typeof id !== 'string' ||
        !id.startsWith(`${producer}:`) ||
        (revision !== undefined &&
          (!Number.isSafeInteger(revision) || revision <= 0))
      ) {
        return Promise.resolve({
          rejected: [
            {
              id: typeof id === 'string' ? id : '',
              reason: 'invalid attention resolve',
            },
          ],
        });
      }
      const captured = availableAtDispatch();
      return dispatch(
        () =>
          tx
            ? tx.resolve({
                producer,
                id,
                revision,
                availableProducers: captured,
              })
            : deps.db.proc!('attention.resolve', {
                producer,
                id,
                revision,
                availableProducers: captured,
              }),
        () => ({ rejected: [] }),
      );
    },

    list(kinds) {
      if (disposed) return Promise.resolve([]);
      const captured = availableAtDispatch();
      return dispatch(
        () =>
          tx
            ? tx.list({ kinds, availableProducers: captured })
            : deps.db.proc!('attention.list', {
                kinds,
                availableProducers: captured,
              }),
        (result) =>
          (result.items ?? []).filter((item) => available.has(item.producer)),
        { read: true },
      );
    },

    act(request) {
      if (disposed) return disposedMutation();
      if (request.action !== 'dismiss')
        return Promise.reject(
          codedError('ATTENTION_INVALID_ACTION', 'invalid attention action'),
        );
      return dismiss(request.id);
    },

    dismiss,

    setExtensions(snapshot) {
      const next = new Set(
        snapshot.filter(isAvailable).map((extension) => extension.id),
      );
      if (
        next.size === available.size &&
        [...next].every((id) => available.has(id))
      )
        return;
      available = next;
      notifyChanged();
    },

    notifyReset() {
      notifyChanged();
    },

    async dispose() {
      if (disposal) return disposal;
      disposed = true;
      timers.clearInterval(interval);
      disposal = (async () => {
        while (admitted.size) {
          await Promise.allSettled([...admitted]);
        }
      })();
      return disposal;
    },
  };
}
