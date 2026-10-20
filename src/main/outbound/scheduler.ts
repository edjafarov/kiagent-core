/**
 * Scheduled send (alpha-cent
 * docs/superpowers/specs/2026-10-20-outbox-draft-sync-design.md §8): every
 * 30 s the drafts whose time has come are handed to the outbound service,
 * one at a time. The service decides under each draft's lock — sent, missed
 * (more than 5 min late), or skipped (cancelled or rescheduled meanwhile).
 * `start` runs a tick at once, so a schedule missed while the app was closed
 * is settled at boot.
 */
import type { LogSink } from '../core/engine/engine';
import type { CoreStore } from '../core/store/store';
import type { OutboundService } from './service';

export const SCHEDULE_TICK_MS = 30_000;

export interface OutboxScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<void>;
}

export function createOutboxScheduler(deps: {
  store: CoreStore;
  service: Pick<OutboundService, 'sendScheduled'>;
  logSink: LogSink;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (t: unknown) => void;
}): OutboxScheduler {
  const now = deps.now ?? Date.now;
  const every = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel =
    deps.clearInterval ??
    ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  let timer: unknown = null;
  let running: Promise<void> | null = null;

  const runOnce = async () => {
    const due = await deps.store.outbox.listDue(new Date(now()).toISOString());
    for (const { id, sendAt } of due) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await deps.service.sendScheduled(id, sendAt);
      } catch (e) {
        deps.logSink.log(
          'outbound',
          'warn',
          `draft ${id}: scheduled send failed (${e instanceof Error ? e.message : String(e)})`,
          { draftId: id },
        );
      }
    }
  };

  /** One tick at a time: a slow send never stacks a second pass. */
  const tick = () => {
    if (!running)
      running = runOnce()
        .catch((e) =>
          deps.logSink.log(
            'outbound',
            'warn',
            `scheduled sends: ${e instanceof Error ? e.message : String(e)}`,
          ),
        )
        .finally(() => {
          running = null;
        });
    return running;
  };

  return {
    start() {
      if (timer) return;
      void tick();
      timer = every(() => void tick(), SCHEDULE_TICK_MS);
    },
    stop() {
      if (timer) cancel(timer);
      timer = null;
    },
    tick,
  };
}
