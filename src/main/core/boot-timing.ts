/**
 * #140 acceptance evidence: `[boot] <step> +<ms>ms` lines, ms since process
 * start (performance.now()'s origin), written through the caller's logger.
 */
import type { ExtensionSnapshot } from '@shared/contracts';

export interface BootTimer {
  mark(step: string, detail?: string): void;
  /** Feed every platform snapshot; logs each extension's first 'activated'
   *  (handshake retries included) until settlement. */
  observe(snapshot: readonly ExtensionSnapshot[]): void;
  /** Every start has been issued: 'all settled' is written by the first
   *  snapshot with no entry still 'activating' (decided from statuses, never
   *  from start() returning — a host resolves start() on a scheduled retry). */
  armSettled(snapshot: readonly ExtensionSnapshot[]): void;
}

export function createBootTimer(
  write: (line: string) => void,
  now: () => number = () => performance.now(),
): BootTimer {
  const seen = new Set<string>();
  let armed = false;
  let settled = false;
  const mark = (step: string, detail?: string): void => {
    write(
      `[boot] ${step} +${Math.round(now())}ms${detail ? ` (${detail})` : ''}`,
    );
  };
  const observe = (snapshot: readonly ExtensionSnapshot[]): void => {
    if (settled) return;
    for (const e of snapshot) {
      if (e.status !== 'activated' || seen.has(e.id)) continue;
      seen.add(e.id);
      mark(`extension ${e.id} activated`);
    }
    if (armed && !snapshot.some((e) => e.status === 'activating')) {
      settled = true;
      mark('all settled');
    }
  };
  return {
    mark,
    observe,
    armSettled(snapshot) {
      armed = true;
      observe(snapshot);
    },
  };
}
