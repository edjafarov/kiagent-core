import React from 'react';
import type { Account } from '@shared/contracts';
import { formatRelative } from '../format';
import { useSourceDescriptors } from '../sources-registry';
import { sourceLabel } from '../connector-meta';

export function Overview(props: {
  account: Account;
  docCount: number;
  lastDocumentAt: string | undefined;
}): React.ReactElement {
  const { account: a, docCount, lastDocumentAt } = props;
  const descriptors = useSourceDescriptors();
  const total = a.progress?.totalEstimate;
  const done = a.progress?.done ?? 0;
  const backfilling = a.status === 'backfilling';
  const pct =
    backfilling && total != null && total > 0
      ? Math.max(0, Math.min(100, (done / total) * 100))
      : null;

  return (
    <section className="detail-card">
      <div className="lbl-section">Overview</div>
      <dl className="kv">
        <dt>Identifier</dt>
        <dd className="mono">{a.identifier}</dd>
        <dt>Indexed</dt>
        <dd>
          {docCount.toLocaleString()} documents
          {backfilling && total != null && total > done && (
            <span className="t-meta" style={{ marginLeft: 6 }}>
              · {done.toLocaleString()} of ~{total.toLocaleString()} estimated
            </span>
          )}
        </dd>
        <dt>Last sync</dt>
        <dd>{formatRelative(a.lastSyncAt)}</dd>
        <dt>Last document</dt>
        <dd>{formatRelative(lastDocumentAt)}</dd>
      </dl>
      {pct != null && (
        <div className="ov-progress">
          <div className="progress">
            <i style={{ width: `${pct.toFixed(1)}%` }} />
          </div>
          <div className="t-meta">
            Backfilling {sourceLabel(a.source, descriptors)} —{' '}
            {done.toLocaleString()} / ~{(total ?? 0).toLocaleString()} (
            {pct.toFixed(pct < 10 ? 1 : 0)}%).
            {/* No ETA field in AccountProgress (contracts.ts) — the legacy
                "Estimated Xh Ym remaining" line has no backend source here. */}
          </div>
        </div>
      )}
    </section>
  );
}
