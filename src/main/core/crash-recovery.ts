import type { CorePlatform } from './boot';
import type { LogSink } from './engine/engine';

export interface CrashRecoveryDeps {
  platform: Pick<CorePlatform, 'readOnly' | 'afterPromote'>;
  /** calendarOut.recover(): creating drafts → unknown, overdue expire. */
  recoverCalendar(): Promise<void>;
  /** store.outbox.recoverOrphanedSending(): sending → delivery_unknown. */
  recoverOutbox(): Promise<void>;
  logSink: Pick<LogSink, 'log'>;
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Registers the sweeps with afterPromote and runs them now when the device can write.
 *
 * `onOpen` runs the hooks on a fence lift (sync/service.ts open) and on every
 * promotion (promote), never on a plain writable boot: a writable boot sweeps once from
 * this call, a fenced or follower boot once from the hook, and a later re-promotion
 * sweeps again. The sweeps are conservative, not a proof of quiescence: they move rows
 * whose outcome this process cannot know ('sending', 'creating') to an unknown state.
 */
// slice-2: the registration stays on afterPromote; the one-leader-fact spec changes only
// where the role is read.
export async function installCrashRecovery(
  d: CrashRecoveryDeps,
): Promise<void> {
  // No once-guard: the hooks run before platform.promote() resumes the accounts (boot.ts),
  // so a row still 'sending'/'creating' at a promotion was left by a run that can no longer
  // finish it (a fenced completion, or the old leader); marking it unknown is the honest outcome.
  const run = async (): Promise<void> => {
    try {
      // A 'creating' event draft also means a process died mid-create.
      await d.recoverCalendar();
    } catch (err) {
      d.logSink.log('calendar-out', 'error', 'boot-time recover failed', {
        error: message(err),
      });
    }
    try {
      await d.recoverOutbox();
    } catch (err) {
      d.logSink.log(
        'outbound',
        'error',
        'boot-time recoverOrphanedSending sweep failed — sending rows left in place for the next boot',
        { error: message(err) },
      );
    }
  };
  d.platform.afterPromote(run);
  if (!d.platform.readOnly()) await run();
}
