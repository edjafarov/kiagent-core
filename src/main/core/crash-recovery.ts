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

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Registers the sweeps with afterPromote and runs them now when the device can write.
 *
 * `onPromoted` runs the hooks only on a fence lift (sync/service.ts setFenced) and on a
 * promotion (promote), never on a plain writable boot, so a writable boot sweeps once
 * from this call and a fenced or follower boot once from the hook.
 */
// slice-2: the lead API owns this registration (one-leader-fact spec).
export async function installCrashRecovery(d: CrashRecoveryDeps): Promise<void> {
  // No once-guard: onPromoted runs these hooks before platform.promote() resumes the accounts (boot.ts), so nothing of this process is in flight when a later promotion re-runs the sweeps; a 'sending'/'creating' row then is an orphan again.
  const run = async (): Promise<void> => {
    try {
      // A 'creating' event draft also means a process died mid-create.
      await d.recoverCalendar();
    } catch (err) {
      d.logSink.log('calendar-out', 'error', 'boot-time recover failed', { error: message(err) });
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
