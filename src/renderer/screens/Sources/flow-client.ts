import type { ConnectEvent } from '@shared/ipc';

/**
 * Starts a main-side flow and forwards its `push:connect` events to `onEvent`.
 * Subscribes BEFORE invoking `start`: a flow that prompts or opens a picker
 * immediately emits its first event before the invoke's response tells us the
 * flowId — for `manageFolders`, whose whole job is to call `pickFolders`, this
 * is the COMMON case, not a rare race. Events arriving before the flowId is
 * known are buffered here and replayed once it is.
 *
 *  - `onSubscribed` fires synchronously, before the invoke, so the caller can
 *    record `unsubscribe` immediately (matching this function's own
 *    subscribe-before-invoke ordering).
 *  - `onFlowId` fires the instant the flowId is known, BEFORE the buffered
 *    replay — a caller whose `onEvent` is a no-op until its own flow state
 *    exists would otherwise silently drop the replayed events.
 */
export async function openFlow(
  start: () => Promise<{ flowId: string }>,
  onEvent: (evt: ConnectEvent) => void,
  hooks?: {
    onSubscribed?: (unsubscribe: () => void) => void;
    onFlowId?: (flowId: string) => void;
  },
): Promise<{ flowId: string; unsubscribe: () => void }> {
  let flowId: string | null = null;
  const buffered: ConnectEvent[] = [];
  const unsubscribe = window.kiagent.on('push:connect', (evt) => {
    if (flowId === null) {
      buffered.push(evt);
      return;
    }
    if (evt.flowId !== flowId) return; // another window/flow's event
    onEvent(evt);
  });
  hooks?.onSubscribed?.(unsubscribe);
  try {
    const res = await start();
    flowId = res.flowId;
    hooks?.onFlowId?.(flowId);
    for (const evt of buffered) {
      if (evt.flowId === flowId) onEvent(evt);
    }
    buffered.length = 0;
    return { flowId, unsubscribe };
  } catch (err) {
    unsubscribe();
    throw err;
  }
}
