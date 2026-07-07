import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAppState } from '@renderer/state/app-state';
import { useView } from '@renderer/state/view';
import { Icon } from '@shared/web-ui/icon-sprite';
import { Wordmark, Pill } from '@shared/web-ui/components';
import type { AppState, LogLevel, LogRecord } from '@shared/contracts';
import './Logs.css';

// Filter semantics: minimum severity threshold (e.g. "info" shows info+warn+error).
// Unlike the legacy renderer, the contract has no 'debug' level.
const LEVEL_FILTERS: readonly LogLevel[] = ['info', 'warn', 'error'];
const LEVEL_RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const MAX_RECORDS = 1000;

function fmtTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function stringifyValue(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function fieldsText(rec: LogRecord): string {
  if (!rec.fields) return '';
  return Object.entries(rec.fields)
    .map(([k, v]) => `${k}=${stringifyValue(v)}`)
    .join(' ');
}

function recordToPlainText(rec: LogRecord): string {
  return [
    fmtTs(rec.ts),
    rec.level.toUpperCase(),
    rec.scope,
    rec.msg,
    fieldsText(rec),
  ]
    .filter(Boolean)
    .join(' ');
}

function matchesSearch(rec: LogRecord, q: string): boolean {
  if (q === '') return true;
  const needle = q.toLowerCase();
  if (rec.msg.toLowerCase().includes(needle)) return true;
  if (rec.scope.toLowerCase().includes(needle)) return true;
  if (rec.fields) {
    for (const v of Object.values(rec.fields)) {
      if (stringifyValue(v).toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}

function selectLogsTopBarSlice(s: AppState): {
  live: number;
  totalDocs: number;
} {
  let live = 0;
  let totalDocs = 0;
  for (const a of s.accounts) {
    if (a.account.status === 'live' || a.account.status === 'backfilling')
      live += 1;
    totalDocs += a.docCount;
  }
  return { live, totalDocs };
}

export function Logs(): React.ReactElement {
  const [records, setRecords] = useState<LogRecord[]>([]);
  // Frozen snapshot taken when the user pauses — the underlying stream keeps
  // accumulating in the background; Resume drops the snapshot.
  const [frozen, setFrozen] = useState<LogRecord[] | null>(null);
  const [levelFilter, setLevelFilter] = useState<LogLevel>('info');
  const [scopeFilter, setScopeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.kiagent
      .invoke('logs:recent', undefined)
      .then((recent) => {
        if (!cancelled) setRecords(recent.slice(-MAX_RECORDS));
      })
      .catch(() => {
        /* seed failure must not block live tailing below */
      });
    const off = window.kiagent.on('push:logs', (batch) => {
      setRecords((prev) => {
        const combined = prev.concat(batch);
        return combined.length > MAX_RECORDS
          ? combined.slice(combined.length - MAX_RECORDS)
          : combined;
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const source = frozen ?? records;
  const paused = frozen !== null;

  const scopes = useMemo(() => {
    const set = new Set<string>();
    for (const r of source) set.add(r.scope);
    return Array.from(set).sort();
  }, [source]);

  const visible = useMemo(() => {
    const minRank = LEVEL_RANK[levelFilter];
    return source
      .filter((r) => {
        if (LEVEL_RANK[r.level] < minRank) return false;
        if (scopeFilter !== 'all' && r.scope !== scopeFilter) return false;
        if (!matchesSearch(r, search.trim())) return false;
        return true;
      })
      .slice()
      .reverse(); // newest first
  }, [source, levelFilter, scopeFilter, search]);

  const togglePause = useCallback(() => {
    setFrozen((current) => (current === null ? records : null));
  }, [records]);

  const clear = useCallback(() => {
    setRecords([]);
    setFrozen(null);
  }, []);

  const copy = useCallback(() => {
    const text = visible.map(recordToPlainText).join('\n');
    void navigator.clipboard?.writeText(text);
  }, [visible]);

  const doExport = useCallback(() => {
    setExportMsg('Exporting…');
    window.kiagent
      .invoke('logs:export', undefined)
      .then((path) => setExportMsg(`Exported to ${path}`))
      .catch((err) =>
        setExportMsg(
          `Export failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }, []);

  const { live, totalDocs } = useAppState(selectLogsTopBarSlice);
  const { back, navigate } = useView();

  return (
    <div className="logs-shell">
      <div className="dash-topbar">
        <button type="button" className="btn ghost sm" onClick={back}>
          ← Back
        </button>
        <Wordmark />
        <Pill variant="live">
          {live} live · {totalDocs.toLocaleString()} docs
        </Pill>
        <span className="t-meta" style={{ marginLeft: 8 }}>
          Diagnostic log stream
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn ghost sm" onClick={doExport}>
          <Icon name="external" size={13} />
          <span style={{ color: 'var(--text-secondary)' }}>Export logs</span>
        </button>
        <button
          type="button"
          className="btn ghost sm"
          aria-label="Settings"
          onClick={() => navigate('settings')}
        >
          <Icon name="settings" size={14} />
        </button>
      </div>

      <div className="logs-body">
        <div className="logs-toolbar">
          <span className="lbl-section">Filter</span>

          <label className="logs-select">
            <span className="k">Level:</span>
            <select
              aria-label="Filter by level"
              value={levelFilter}
              onChange={(e) => setLevelFilter(e.target.value as LogLevel)}
            >
              {LEVEL_FILTERS.map((l) => (
                <option key={l} value={l}>
                  {l}+
                </option>
              ))}
            </select>
          </label>

          <label className="logs-select">
            <span className="k">Scope:</span>
            <select
              aria-label="Filter by scope"
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value)}
            >
              <option value="all">All scopes</option>
              {scopes.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>

          <label className="logs-search">
            <Icon name="search" size={12} />
            <input
              type="text"
              placeholder="Search messages…"
              aria-label="Search messages"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          <div className="div-v" />

          <span className="t-meta">tail</span>
          <button
            type="button"
            className="btn sm"
            onClick={togglePause}
            aria-pressed={paused}
          >
            <Icon name={paused ? 'play' : 'pause'} size={12} />
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="btn ghost sm" onClick={copy}>
            <Icon name="copy" size={12} />
            <span style={{ color: 'var(--text-secondary)' }}>Copy</span>
          </button>

          <div style={{ flex: 1 }} />

          <button type="button" className="btn ghost sm" onClick={clear}>
            <Icon name="trash" size={12} />
            <span style={{ color: 'var(--text-secondary)' }}>Clear</span>
          </button>
        </div>

        <div className="logs-table" ref={tableRef}>
          {visible.length === 0 ? (
            <div className="logs-empty">
              {source.length === 0
                ? 'Waiting for log activity…'
                : 'No records match the current filters.'}
            </div>
          ) : (
            visible.map((rec, i) => (
              <LogRow key={`${rec.ts}-${i}-${rec.msg}`} rec={rec} />
            ))
          )}
        </div>

        <div className="footbar">
          <span className="mono">{exportMsg ?? ' '}</span>
          <div style={{ flex: 1 }} />
          <span>
            {visible.length} of{' '}
            <span className="mono">{source.length.toLocaleString()}</span>{' '}
            {source.length === 1 ? 'line' : 'lines'}
          </span>
          <span
            className={paused ? 'stream-pill paused' : 'stream-pill'}
            aria-live="polite"
          >
            <span className="dot" />
            {paused ? 'Paused' : 'Streaming'}
          </span>
        </div>
      </div>
    </div>
  );
}

// Memoized: records are immutable, so a default shallow props compare skips
// re-rendering untouched rows when a batch lands.
const LogRow = React.memo(function LogRow(props: {
  rec: LogRecord;
}): React.ReactElement {
  const { rec } = props;
  const rowClass =
    rec.level === 'error'
      ? 'log-row err'
      : rec.level === 'warn'
        ? 'log-row warn-bg'
        : 'log-row';
  return (
    <div className={rowClass}>
      <span className="ts">{fmtTs(rec.ts)}</span>
      <span className={`lvl ${rec.level}`}>{rec.level.toUpperCase()}</span>
      <span className="src">{rec.scope}</span>
      <span className="msg">
        {rec.msg}
        {rec.fields &&
          Object.entries(rec.fields).map(([k, v]) => (
            <React.Fragment key={k}>
              {' '}
              <span className="k">{k}=</span>
              <span className="v">{stringifyValue(v)}</span>
            </React.Fragment>
          ))}
      </span>
    </div>
  );
});
