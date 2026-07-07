import React from 'react';
import type { Account } from '@shared/contracts';
import { Pill, type PillVariant } from '@shared/web-ui/components';

/** The one generic status pill — keyed only by `account.status`, matching
 *  the legacy renderer's StatusPill (no per-connector pill colors). */
export function StatusPill(props: { account: Account }): React.ReactElement {
  const { variant, label } = pillFor(props.account);
  return <Pill variant={variant}>{label}</Pill>;
}

function pillFor(a: Account): { variant: PillVariant; label: string } {
  switch (a.status) {
    case 'connecting':
      return { variant: 'working', label: 'Connecting…' };
    case 'paused':
      return { variant: 'paused', label: 'Paused' };
    case 'error':
      return { variant: 'error', label: 'Error' };
    case 'needsReauth':
      return { variant: 'error', label: 'Reconnect' };
    case 'backfilling': {
      const total = a.progress?.totalEstimate;
      const done = a.progress?.done ?? 0;
      if (total != null && total > 0) {
        const pct = Math.max(0, Math.min(100, (done / total) * 100));
        return {
          variant: 'working',
          label: `Backfilling ${done.toLocaleString()} / ~${total.toLocaleString()} (${pct.toFixed(pct < 10 ? 1 : 0)}%)`,
        };
      }
      return { variant: 'working', label: 'Backfilling' };
    }
    case 'live':
    default:
      return { variant: 'live', label: 'Live' };
  }
}
