import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useView } from '@renderer/state/view';
import { Icon } from '@shared/web-ui/icon-sprite';
import { Button, Page, Select, Status, TextField } from '@shared/web-ui/ui';
import type { LogLevel, LogRecord } from '@shared/contracts';
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

/** The row's time: the clock with seconds (the full stamp is in Copy). */
function clockTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

// A stable React key per record, assigned the first time a record is seen.
// Records keep their object identity while they sit in state, so a new batch
// (prepended to the newest-first list) doesn't shift existing rows' keys —
// an index-based key would remount every row on every batch.
const recordKeys = new WeakMap<LogRecord, number>();
let nextRecordKey = 0;
export function logRecordKey(rec: LogRecord): number {
  let key = recordKeys.get(rec);
  if (key === undefined) {
    key = nextRecordKey++;
    recordKeys.set(rec, key);
  }
  return key;
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

  // Typing stays responsive: filtering up to MAX_RECORDS rows runs at a
  // lower priority than the keystroke itself.
  const deferredSearch = useDeferredValue(search);

  const visible = useMemo(() => {
    const minRank = LEVEL_RANK[levelFilter];
    return source
      .filter((r) => {
        if (LEVEL_RANK[r.level] < minRank) return false;
        if (scopeFilter !== 'all' && r.scope !== scopeFilter) return false;
        if (!matchesSearch(r, deferredSearch.trim())) return false;
        return true;
      })
      .slice()
      .reverse(); // newest first
  }, [source, levelFilter, scopeFilter, deferredSearch]);

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

  const { back, openSettings } = useView();

  return (
    <Page
      className="logs-page"
      crumb={{
        parent: 'Settings',
        current: 'Logs',
        onBack: back,
        onParent: () => openSettings(),
      }}
    >
      <div className="logs-toolbar">
        <span className="logs-lbl">Filter</span>
        <Select
          aria-label="Filter by level"
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as LogLevel)}
        >
          {LEVEL_FILTERS.map((l) => (
            <option key={l} value={l}>
              Level: {l}+
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by scope"
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
        >
          <option value="all">Scope: All scopes</option>
          {scopes.map((sc) => (
            <option key={sc} value={sc}>
              Scope: {sc}
            </option>
          ))}
        </Select>
        <TextField
          search
          className="logs-search"
          placeholder="Search messages…"
          aria-label="Search messages"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button size="sm" onClick={togglePause} aria-pressed={paused}>
          <Icon name={paused ? 'play' : 'pause'} size={12} />
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" variant="ghost" onClick={copy}>
          <Icon name="copy" size={12} /> Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={doExport}>
          <Icon name="external" size={12} /> Export
        </Button>
        <Button size="sm" variant="ghost" onClick={clear}>
          <Icon name="trash" size={12} /> Clear
        </Button>
      </div>

      <div className="logs-table" ref={tableRef}>
        {visible.length === 0 ? (
          <div className="logs-empty">
            {source.length === 0
              ? 'Waiting for log activity…'
              : 'No records match the current filters.'}
          </div>
        ) : (
          visible.map((rec) => <LogRow key={logRecordKey(rec)} rec={rec} />)
        )}
      </div>

      <div className="logs-foot">
        <span className="mono">
          {visible.length} of {source.length.toLocaleString()}{' '}
          {source.length === 1 ? 'line' : 'lines'}
        </span>
        <span aria-live="polite">
          <Status tone={paused ? 'off' : 'ok'}>
            {paused ? 'Paused' : 'Streaming'}
          </Status>
        </span>
        {exportMsg && <span className="mono">{exportMsg}</span>}
      </div>
    </Page>
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
      <span className="ts" title={fmtTs(rec.ts)}>
        {clockTs(rec.ts)}
      </span>
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
