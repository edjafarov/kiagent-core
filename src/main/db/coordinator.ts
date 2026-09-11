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

export function createDbCoordinator(options: { leaseMs?: number } = {}): DbCoordinator {
  const leaseMs = options.leaseMs ?? 30_000;
  const queue: Job<unknown>[] = [];
  let active: Active | undefined;
  let pendingBegin = false;
  const failedOwners = new Set<string>();
  let closed = false;
  let pumping = false;

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        if (closed) break;
        if (active && Date.now() > active.expires) {
          const expired = active;
          active = undefined;
          for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].token === expired.token) queue.splice(i, 1)[0].reject(error('transaction lease expired', 'DB_TX_EXPIRED'));
          }
        if (expired.rollback) {
          try {
            await expired.rollback();
          } catch {
            const key = expired.owner.kind === 'plugin'
              ? expired.owner.handle ?? expired.owner.extensionId
              : expired.owner.handle ?? 'core';
            failedOwners.add(key);
          }
        }
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
    const ownerKey = owner.kind === 'plugin' ? owner.handle ?? owner.extensionId : owner.handle ?? 'core';
    if (failedOwners.has(ownerKey)) return Promise.reject(error('database owner is unusable after rollback failure', 'DB_OWNER_POISONED'));
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
        active = { owner, token, rollback, expires: Date.now() + leaseMs };
        active.timer = setTimeout(() => { void pump(); }, leaseMs + 1);
        active.timer.unref?.();
        await work();
        return undefined;
      }); return token; } finally { pendingBegin = false; }
    },
    finish: async (owner, token, work) => {
      if (!active || active.token !== token || !sameOwner(owner, active.owner)) return Promise.reject(error('invalid or foreign transaction token', 'DB_TX_TOKEN_INVALID'));
      try { return await enqueue(owner, token, work); } finally { if (active?.timer) clearTimeout(active.timer); active = undefined; void pump(); }
    },
    release: async (owner) => {
      if (active && sameOwner(owner, active.owner)) { const rollback = active.rollback; const key = owner.kind === 'plugin' ? owner.handle ?? owner.extensionId : owner.handle ?? 'core'; if (active.timer) clearTimeout(active.timer); active = undefined; if (rollback) { try { await rollback(); } catch (e) { failedOwners.add(key); throw e; } } }
      for (let i = queue.length - 1; i >= 0; i--) if (sameOwner(queue[i].owner, owner)) queue.splice(i, 1).forEach((job) => job.reject(error('database owner released', 'DB_OWNER_RELEASED')));
      await pump();
    },
    close: async () => { closed = true; const rollback = active?.rollback; if (active?.timer) clearTimeout(active.timer); active = undefined; if (rollback) await rollback(); while (queue.length) queue.shift()!.reject(error('database coordinator is closed', 'DB_COORDINATOR_CLOSED')); },
    metrics: () => ({ queued: queue.length, active: !!active, owner: active?.owner }),
  };
}
