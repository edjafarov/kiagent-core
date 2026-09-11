import { randomUUID } from 'node:crypto';

export type DbOwner = { kind: 'core'; handle?: string; incarnation?: number } | { kind: 'plugin'; extensionId: string; handle?: string; incarnation?: number };
export type TxToken = string;
export interface CoordinatorMetrics { queued: number; active: boolean; owner?: DbOwner; }
export interface DbCoordinator {
  run<T>(owner: DbOwner, token: TxToken | undefined, work: () => Promise<T> | T, signal?: AbortSignal): Promise<T>;
  begin(owner: DbOwner, work: () => Promise<unknown> | unknown, rollback?: () => Promise<unknown> | unknown): Promise<TxToken>;
  finish<T>(owner: DbOwner, token: TxToken, work: () => Promise<T> | T): Promise<T>;
  release(owner: DbOwner): Promise<void>;
  close(): Promise<void>;
  metrics(): CoordinatorMetrics;
}

type Job<T> = { owner: DbOwner; token?: TxToken; work: () => Promise<T> | T; signal?: AbortSignal; resolve: (v: T) => void; reject: (e: unknown) => void };
type Active = { owner: DbOwner; token: TxToken; rollback?: () => Promise<unknown> | unknown; expires: number; timer?: ReturnType<typeof setTimeout> };

const error = (message: string, code: string): Error & { code: string } => Object.assign(new Error(message), { code });
const sameOwner = (a: DbOwner, b: DbOwner) => {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'plugin' && a.extensionId !== (b as { extensionId: string }).extensionId) return false;
  if (a.handle || b.handle) return !!a.handle && !!b.handle && a.handle === b.handle;
  return a.incarnation === undefined || b.incarnation === undefined || a.incarnation === b.incarnation;
};

export function createDbCoordinator(options: { leaseMs?: number; onOwnerFailure?: (owner: DbOwner) => Promise<void> | void } = {}): DbCoordinator {
  const leaseMs = options.leaseMs ?? 30_000;
  const queue: Job<unknown>[] = [];
  let active: Active | undefined;
  let pendingBegin = false;
  const failedOwners = new Set<string>();
  let closed = false;
  let pumping = false;

  const ownerKey = (owner: DbOwner): string => owner.kind === 'plugin'
    ? owner.handle ?? owner.extensionId
    : owner.handle ?? 'core';

  const poisonOwner = async (owner: DbOwner): Promise<void> => {
    failedOwners.add(ownerKey(owner));
    try { await options.onOwnerFailure?.(owner); } catch { /* cleanup must not strand the queue */ }
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
          for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].token === expired.token) queue.splice(i, 1)[0].reject(error('transaction lease expired', 'DB_TX_EXPIRED'));
          }
          await rollbackActive(expired);
          clearActive(expired);
        }
        const index = queue.findIndex((job) => !active || (job.token === active.token && sameOwner(job.owner, active.owner)));
        if (index < 0) break;
        const [job] = queue.splice(index, 1);
        if (job.signal?.aborted) { job.reject(error('database operation cancelled', 'DB_OPERATION_CANCELLED')); continue; }
        try { job.resolve(await job.work()); } catch (e) { job.reject(e); }
      }
    } finally { pumping = false; }
  };

  const enqueue = <T>(owner: DbOwner, token: TxToken | undefined, work: () => Promise<T> | T, signal?: AbortSignal): Promise<T> => {
    if (closed) return Promise.reject(error('database coordinator is closed', 'DB_COORDINATOR_CLOSED'));
    if (failedOwners.has(ownerKey(owner))) return Promise.reject(error('database owner is unusable after rollback failure', 'DB_OWNER_POISONED'));
    if (token && (!active || active.token !== token || !sameOwner(owner, active.owner))) return Promise.reject(error('invalid or foreign transaction token', 'DB_TX_TOKEN_INVALID'));
    return new Promise<T>((resolve, reject) => {
      const job = { owner, token, work, signal, resolve: resolve as (v: unknown) => void, reject } as Job<T>;
      if (signal) {
        const cancel = () => {
          const index = queue.indexOf(job as Job<unknown>);
          if (index >= 0) { queue.splice(index, 1); reject(error('database operation cancelled', 'DB_OPERATION_CANCELLED')); }
        };
        if (signal.aborted) { reject(error('database operation cancelled', 'DB_OPERATION_CANCELLED')); return; }
        signal.addEventListener('abort', cancel, { once: true });
      }
      queue.push(job as Job<unknown>);
      void pump();
    });
  };

  return {
    run: enqueue,
    begin: async (owner, work, rollback) => {
      if (active || pendingBegin) return Promise.reject(error('database transaction already active', 'DB_TX_BUSY'));
      pendingBegin = true;
      const token = randomUUID();
      try { await enqueue(owner, undefined, async () => {
        const started: Active = active = { owner, token, rollback, expires: Date.now() + leaseMs };
        started.timer = setTimeout(() => { void pump(); }, leaseMs + 1);
        started.timer.unref?.();
        try {
          await work();
        } catch (e) {
          await rollbackActive(started);
          clearActive(started);
          throw e;
        }
        return undefined;
      }); return token; } finally { pendingBegin = false; }
    },
    finish: async (owner, token, work) => {
      if (!active || active.token !== token || !sameOwner(owner, active.owner)) return Promise.reject(error('invalid or foreign transaction token', 'DB_TX_TOKEN_INVALID'));
      const finished = active;
      try {
        return await enqueue(owner, token, work);
      } catch (e) {
        // A deferred-FK COMMIT can fail while SQLite keeps the native
        // transaction open. Repair it before releasing admission, preserving
        // the original COMMIT error for the caller.
        if (active === finished) await rollbackActive(finished);
        throw e;
      } finally {
        clearActive(finished);
        void pump();
      }
    },
    release: async (owner) => {
      let rollbackError: unknown;
      if (active && sameOwner(owner, active.owner)) {
        const released = active;
        if (released.timer) clearTimeout(released.timer);
        try { await released.rollback?.(); } catch (e) { rollbackError = e; await poisonOwner(owner); }
        clearActive(released);
      }
      for (let i = queue.length - 1; i >= 0; i--) if (sameOwner(queue[i].owner, owner)) queue.splice(i, 1).forEach((job) => job.reject(error('database owner released', 'DB_OWNER_RELEASED')));
      await pump();
      if (rollbackError) throw rollbackError;
    },
    close: async () => {
      closed = true;
      const closing = active;
      let rollbackError: unknown;
      if (closing) {
        if (closing.timer) clearTimeout(closing.timer);
        try { await closing.rollback?.(); } catch (e) { rollbackError = e; await poisonOwner(closing.owner); }
        clearActive(closing);
      }
      while (queue.length) queue.shift()!.reject(error('database coordinator is closed', 'DB_COORDINATOR_CLOSED'));
      if (rollbackError) throw rollbackError;
    },
    metrics: () => ({ queued: queue.length, active: !!active, owner: active?.owner }),
  };
}
