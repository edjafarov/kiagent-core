import type { WorkerSession } from '@shared/contracts';

/** Main-process memory gate for large-file work (large-file spec, Rollout).
 *  maxRSS is a high-water mark (KiB), so the increase is exact even when a
 *  synchronous parse blocks the event loop. It is process-wide: concurrent
 *  work inflates it, so the gate is read on a quiet dev app. */
export function peakIncreaseMB(
  rssBefore: number,
  usage: { maxRSS: number } = process.resourceUsage(),
): number {
  return Math.max(
    0,
    Math.round((usage.maxRSS * 1024 - rssBefore) / (1024 * 1024)),
  );
}

export function logPeak(
  session: WorkerSession,
  what: string,
  bytes: number,
  rssBefore: number,
): void {
  session.log(
    'info',
    `mem: ${what} ${Math.round(bytes / 1048576)} MB → peak +${peakIncreaseMB(rssBefore)} MB`,
  );
}
