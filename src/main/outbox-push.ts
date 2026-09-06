import type { Pushes, PushChannel } from '@shared/ipc';

import type { OutboxStore } from './core/store/outbox';

/** At most one `push:outbox-changed` broadcast per this many ms — see
 *  issue #113's IPC surface table. */
const COALESCE_MS = 50;

/**
 * Wires `OutboxStore.onChange` to a coalesced `push:outbox-changed`
 * broadcast: a burst of onChange fires inside COALESCE_MS produces exactly
 * one broadcast, timed from the FIRST fire in the burst (not reset on every
 * fire) — a leading-edge-scheduled, trailing-edge-fired coalesce, so a
 * steady stream of changes still broadcasts periodically rather than being
 * starved forever.
 *
 * Every `onChange` fire is a "may have changed" hint, never a precise
 * delta (see outbox.ts's `create`/`transition`/`expireOverdue` callers and
 * store.ts's unconditional fire on `removeAccount`) — this wiring adds no
 * precision of its own; it only reduces how often the renderer is told to
 * re-read.
 *
 * Returns the `onChange` unsubscribe (mirrors `OutboxStore.onChange`'s own
 * contract). main.ts does not currently call it — the process owns this
 * subscription for its lifetime — but returning it keeps the function
 * testable and cleanly disposable in isolation.
 */
export function wireOutboxPush(
  store: { outbox: Pick<OutboxStore, 'onChange'> },
  broadcast: <C extends PushChannel>(channel: C, payload: Pushes[C]) => void,
): () => void {
  let pending: ReturnType<typeof setTimeout> | null = null;
  return store.outbox.onChange(() => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      broadcast('push:outbox-changed', undefined);
    }, COALESCE_MS);
  });
}
