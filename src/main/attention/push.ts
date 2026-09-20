import type { PushChannel, Pushes } from '@shared/ipc';

const COALESCE_MS = 50;

/** Returned handle: call `hint` to schedule a push and `dispose` to disable it. */
export interface AttentionPush {
  hint(): void;
  dispose(): void;
}

/** Coalesces attention invalidation hints using outbox's leading-edge window. */
export function wireAttentionPush(
  broadcast: <C extends PushChannel>(channel: C, payload: Pushes[C]) => void,
): AttentionPush {
  let pending: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  return {
    hint() {
      if (disposed || pending) return;
      pending = setTimeout(() => {
        pending = null;
        if (!disposed) broadcast('push:attention-changed', undefined);
      }, COALESCE_MS);
    },
    dispose() {
      disposed = true;
      if (pending) {
        clearTimeout(pending);
        pending = null;
      }
    },
  };
}
