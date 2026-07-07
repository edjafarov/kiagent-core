import React, { useEffect, useState } from 'react';
import type { McpActivityRecord } from '@shared/contracts';
import { MCP_ACTIVITY_RECENT_MAX } from '@shared/contracts';

/**
 * The data-access trail: one row per MCP tool call, newest first, fed by
 * mcp-activity:recent (seed) + push:mcp-activity (live batches) — the same
 * recent+push idiom as Logs.tsx. Rows with detail (document titles) or an
 * error expand on click. Titles are all the panel ever shows of a document.
 */
export function ActivityPanel(): React.ReactElement {
  const [recs, setRecs] = useState<McpActivityRecord[]>([]);
  const [expanded, setExpanded] = useState<McpActivityRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.kiagent
      .invoke('mcp-activity:recent', undefined)
      .then((recent) => {
        if (!cancelled) setRecs(recent.slice(-MCP_ACTIVITY_RECENT_MAX));
      })
      .catch(() => {
        /* seed failure must not block the live push below */
      });
    const off = window.kiagent.on('push:mcp-activity', (batch) => {
      setRecs((prev) => {
        const combined = prev.concat(batch);
        return combined.length > MCP_ACTIVITY_RECENT_MAX
          ? combined.slice(combined.length - MCP_ACTIVITY_RECENT_MAX)
          : combined;
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const visible = recs.slice().reverse(); // newest first

  return (
    <aside className="conn-activity" aria-label="MCP activity">
      <div className="act-head">
        <h2 className="h-section">Activity</h2>
        <p className="t-meta">
          Every MCP request from connected clients, newest first.
        </p>
      </div>
      <div className="act-list">
        {visible.length === 0 ? (
          <div className="act-empty t-meta">
            No MCP activity yet — connect a client and run a query.
          </div>
        ) : (
          visible.map((rec, i) => (
            <ActivityRow
              key={`${rec.ts}-${i}`}
              rec={rec}
              expanded={expanded === rec}
              onToggle={() => setExpanded(expanded === rec ? null : rec)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay
    ? hm
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

// Memoized like Logs.tsx's LogRow: records are immutable, so untouched rows
// skip re-rendering when a batch lands.
const ActivityRow = React.memo(function ActivityRow(props: {
  rec: McpActivityRecord;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const { rec, expanded, onToggle } = props;
  const expandable = Boolean(rec.detail?.length || rec.error);
  return (
    <button
      type="button"
      className={rec.ok ? 'act-row' : 'act-row err'}
      onClick={expandable ? onToggle : undefined}
      aria-expanded={expandable ? expanded : undefined}
    >
      <div className="act-line">
        <span className="act-when mono">{fmtWhen(rec.ts)}</span>
        <span className="act-client">{rec.client ?? rec.transport}</span>
      </div>
      <div className="act-summary">{rec.summary}</div>
      {expanded && (
        <div className="act-detail">
          {rec.error ? <div className="act-error">{rec.error}</div> : null}
          {rec.detail?.map((t, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="act-title">
              {t}
            </div>
          ))}
        </div>
      )}
    </button>
  );
});
