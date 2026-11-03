/** A follower's copied tables change under the open pages when a delta lands
 *  (spec 7.8, final review): tell the renderer to read again. Extensions hear
 *  the same event through the platform bus (`sync.applied`). */
import type { PushChannel, Pushes } from '@shared/ipc';

export function wireSyncAppliedPush(
  sync: { onApplied(cb: (tables: string[]) => void): void },
  push: {
    attentionHint(): void;
    broadcast<C extends PushChannel>(channel: C, payload: Pushes[C]): void;
  },
): void {
  sync.onApplied((tables) => {
    if (tables.some((t) => t.startsWith('attention_'))) push.attentionHint();
    if (tables.includes('outbox')) push.broadcast('push:outbox-changed', undefined);
    if (tables.includes('event_drafts')) push.broadcast('push:calendar-out-changed', undefined);
  });
}
