// A source's status in words, and the one thing that fixes it. The list's
// last column, the panel and the source page all say the same thing.
import type { Account } from '@shared/contracts';
import type { StatusTone } from '@shared/web-ui/ui';

export type SourceFix = 'reconnect' | 'retry' | 'resume';

export interface SourceStatusWords {
  /** `null` when all is well: the row shows its last item instead. */
  label: string | null;
  tone: StatusTone;
  fix: SourceFix | null;
  /** Share of the first import, 0–100, while one runs with a known total. */
  importPercent: number | null;
}

export function sourceStatus(
  a: Pick<Account, 'status' | 'progress'>,
): SourceStatusWords {
  switch (a.status) {
    case 'needsReauth':
      return {
        label: 'Signed out',
        tone: 'err',
        fix: 'reconnect',
        importPercent: null,
      };
    case 'error':
      return { label: 'Error', tone: 'err', fix: 'retry', importPercent: null };
    case 'paused':
      return {
        label: 'Paused',
        tone: 'off',
        fix: 'resume',
        importPercent: null,
      };
    case 'connecting':
      return {
        label: 'Connecting…',
        tone: 'work',
        fix: null,
        importPercent: null,
      };
    case 'backfilling': {
      const total = a.progress?.totalEstimate;
      const done = a.progress?.done ?? 0;
      return {
        label: null,
        tone: 'work',
        fix: null,
        importPercent:
          total != null && total > 0
            ? Math.max(0, Math.min(100, Math.round((done / total) * 100)))
            : null,
      };
    }
    case 'live':
    default:
      return { label: null, tone: 'ok', fix: null, importPercent: null };
  }
}

/** A status that asks something of the user. */
export function needsYou(a: Pick<Account, 'status'>): boolean {
  return a.status === 'needsReauth' || a.status === 'error';
}
