import React, { useState } from 'react';
import type { McpActivityRecord } from '@shared/contracts';
import { Card, CardHeader, clientBrand, cx } from '@shared/web-ui/ui';
import { useMcpActivity } from './use-mcp-activity';
import './Requests.css';

/**
 * Requests: one row per MCP tool call, newest first — the literal summary,
 * the app that made it and when (useMcpActivity). A row with
 * document titles or an error expands in place; titles are all it ever
 * shows of a document.
 */
export function Requests(): React.ReactElement {
  const recs = useMcpActivity();
  const [expanded, setExpanded] = useState<McpActivityRecord | null>(null);

  const visible = recs.slice().reverse(); // newest first

  return (
    <Card className="conn-req">
      <CardHeader label="Requests" meta="every call, newest first" />
      {visible.length === 0 ? (
        <p className="conn-req-empty">
          No requests yet — connect an app and ask it something.
        </p>
      ) : (
        <ul className="conn-req-list">
          {visible.map((rec, i) => (
            <RequestRow
              // eslint-disable-next-line react/no-array-index-key
              key={`${rec.ts}-${i}`}
              rec={rec}
              expanded={expanded === rec}
              onToggle={() => setExpanded(expanded === rec ? null : rec)}
            />
          ))}
        </ul>
      )}
    </Card>
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

// Records are immutable, so untouched rows skip re-rendering when a batch
// lands.
const RequestRow = React.memo(function RequestRow(props: {
  rec: McpActivityRecord;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const { rec, expanded, onToggle } = props;
  const brand = clientBrand(rec.client ?? rec.transport);
  const expandable = Boolean(rec.detail?.length || rec.error);
  const line = (
    <>
      <span className="conn-req-sum">{rec.summary}</span>
      <span className="conn-req-app">
        {brand.name} · <span className="conn-req-when">{fmtWhen(rec.ts)}</span>
      </span>
    </>
  );
  return (
    <li
      className={cx('conn-req-row', !rec.ok && 'is-err')}
      style={{ '--conn-app': brand.color } as React.CSSProperties}
    >
      {expandable ? (
        <button
          type="button"
          className="conn-req-line"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {line}
        </button>
      ) : (
        <div className="conn-req-line">{line}</div>
      )}
      {expanded && (
        <div className="conn-req-detail">
          {rec.error ? <div className="conn-req-error">{rec.error}</div> : null}
          {rec.detail?.map((t, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i}>{t}</div>
          ))}
        </div>
      )}
    </li>
  );
});
