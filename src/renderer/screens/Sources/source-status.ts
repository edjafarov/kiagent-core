// A source's status in words, and the one thing that fixes it. The list's
// last column, the panel and the source page all say the same thing.
import type { Account } from '@shared/contracts';
import type { StatusTone } from '@shared/web-ui/ui';

export type SourceFix = 'reconnect' | 'retry' | 'resume';

export interface SourceProblemWords {
  kind: string;
  title: string;
  sub: string;
}

export interface SourceStatusWords {
  /** `null` when all is well: the row shows its last item instead. */
  label: string | null;
  tone: StatusTone;
  /** What fixes it, the main fix first; empty when nothing is wrong. */
  fixes: SourceFix[];
  /** The problem in a sentence, for the source's page. */
  problem: SourceProblemWords | null;
  /** Share of the first import, 0–100, while one runs with a known total. */
  importPercent: number | null;
}

export function sourceStatus(
  a: Pick<Account, 'status' | 'progress' | 'lastError'>,
): SourceStatusWords {
  switch (a.status) {
    case 'needsReauth':
      return {
        label: 'Signed out',
        tone: 'err',
        fixes: ['reconnect'],
        problem: {
          kind: 'Error',
          title: 'Signed out',
          sub: 'Nothing new arrives until you sign in again. What’s already here stays searchable.',
        },
        importPercent: null,
      };
    case 'error':
      // R4: an error can be a dead sign-in, so it can also sign in again.
      return {
        label: 'Error',
        tone: 'err',
        fixes: ['retry', 'reconnect'],
        problem: {
          kind: 'Error',
          title: 'Stopped by an error',
          sub: a.lastError || 'Nothing new arrives until it runs again.',
        },
        importPercent: null,
      };
    case 'paused':
      return {
        label: 'Paused',
        tone: 'off',
        fixes: ['resume'],
        problem: {
          kind: 'Paused',
          title: 'Paused',
          sub: 'Nothing new arrives until you resume it.',
        },
        importPercent: null,
      };
    case 'connecting':
      return {
        label: 'Connecting…',
        tone: 'work',
        fixes: [],
        problem: null,
        importPercent: null,
      };
    case 'backfilling': {
      const total = a.progress?.totalEstimate;
      const done = a.progress?.done ?? 0;
      return {
        label: null,
        tone: 'work',
        fixes: [],
        problem: null,
        importPercent:
          total != null && total > 0
            ? Math.max(0, Math.min(100, Math.round((done / total) * 100)))
            : null,
      };
    }
    case 'live':
    default:
      return {
        label: null,
        tone: 'ok',
        fixes: [],
        problem: null,
        importPercent: null,
      };
  }
}

/** A status that asks something of the user. */
export function needsYou(a: Pick<Account, 'status'>): boolean {
  return a.status === 'needsReauth' || a.status === 'error';
}
