/** A follower's copied tables change under the open pages when a delta lands
 *  (spec 7.8, final review): tell the renderer to read again. Extensions hear
 *  the same event through the platform bus (`sync.applied`). */
import type { PushChannel, Pushes } from '@shared/ipc';

/** Copied tables the app state shows: its accounts, their counts and recent
 *  items. A follower's apply writes them without feed changes, so the app
 *  projection is read again instead. */
const APP_STATE_TABLES = ['accounts', 'documents'];

/** At most one app-state read per this window; deltas inside it fold into one
 *  read at its end. A follower in catch-up applies many deltas a second. */
export const REPROJECT_MIN_MS = 3000;

export function wireSyncAppliedPush(
  sync: { onApplied(cb: (tables: string[]) => void): void },
  push: {
    attentionHint(): void;
    broadcast<C extends PushChannel>(channel: C, payload: Pushes[C]): void;
    /** Reads the app state (accounts, counts, recent items) again. */
    reproject?(): void;
  },
  timers: {
    setTimeout(fn: () => void, ms: number): unknown;
  } = { setTimeout: (fn, ms) => setTimeout(fn, ms).unref?.() },
): void {
  let waiting = false;
  let again = false;
  const reproject = (): void => {
    if (waiting) {
      again = true;
      return;
    }
    push.reproject?.();
    waiting = true;
    timers.setTimeout(() => {
      waiting = false;
      if (again) {
        again = false;
        reproject();
      }
    }, REPROJECT_MIN_MS);
  };
  sync.onApplied((tables) => {
    if (tables.some((t) => t.startsWith('attention_'))) push.attentionHint();
    if (tables.includes('outbox')) push.broadcast('push:outbox-changed', undefined);
    if (tables.includes('event_drafts')) push.broadcast('push:calendar-out-changed', undefined);
    if (tables.some((t) => APP_STATE_TABLES.includes(t))) reproject();
  });
}
