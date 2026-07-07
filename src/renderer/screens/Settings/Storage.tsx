import React, { useEffect, useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import { Icon } from '@shared/web-ui/icon-sprite';
import { Busy } from '@shared/web-ui/components';
import type { StorageStats } from '@shared/ipc';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

type Op = 'compact' | 'export' | 'reset';

/**
 * Storage pane. Per the rebuild's `StorageStats` contract this is just
 * `{dbBytes, docCount, accountCount, dataDir}` — much thinner than the
 * legacy screen's per-connector segment breakdown (segments/FTS size/
 * embedding count/deep-extraction backlog). Rather than fabricate a
 * distribution bar with no underlying data, that section is omitted; see
 * the task report for this and other noted gaps.
 */
export function Storage(): React.ReactElement {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<Op | null>(null);
  // Cheap "something changed" signal to re-fetch stats — re-used from the
  // live projection instead of a bespoke push subscription.
  const seqSignal = useAppState((s) => s.accounts.length + s.processing.done);

  useEffect(() => {
    let alive = true;
    window.kiagent
      .invoke('storage:stats', undefined)
      .then((s) => {
        if (alive) {
          setStats(s);
          setError(false);
        }
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on the cheap signal above
  }, [seqSignal]);

  const openInFinder = () => {
    if (!stats) return;
    void window.kiagent.invoke('app:open-path', { path: stats.dataDir });
  };
  const copyPath = () => {
    if (!stats) return;
    void navigator.clipboard?.writeText(stats.dataDir).catch(() => {
      /* clipboard may be unavailable — ignore */
    });
  };

  const compact = () => {
    if (busy) return;
    if (
      !window.confirm(
        'Compact the database now? Safe to run at any time, but may take a minute on large databases.',
      )
    ) {
      return;
    }
    setBusy('compact');
    void window.kiagent
      .invoke('maintenance:compact', undefined)
      .then(() => window.alert('Database compacted.'))
      .catch((e: unknown) =>
        window.alert(`Failed: ${e instanceof Error ? e.message : 'unknown error'}`),
      )
      .finally(() => setBusy(null));
  };

  const exportData = () => {
    if (busy) return;
    setBusy('export');
    // Empty destDir asks main to show a directory picker.
    void window.kiagent
      .invoke('maintenance:export', { destDir: '' })
      .then(() => window.alert('Export complete.'))
      .catch((e: unknown) =>
        window.alert(`Failed: ${e instanceof Error ? e.message : 'unknown error'}`),
      )
      .finally(() => setBusy(null));
  };

  const resetAll = () => {
    if (busy) return;
    if (
      !window.confirm(
        'Reset ALL data? This will wipe everything and cannot be undone.',
      )
    ) {
      return;
    }
    setBusy('reset');
    void window.kiagent
      .invoke('maintenance:reset-all', undefined)
      .then(() => window.alert('All local data was wiped.'))
      .catch((e: unknown) =>
        window.alert(`Failed: ${e instanceof Error ? e.message : 'unknown error'}`),
      )
      .finally(() => setBusy(null));
  };

  return (
    <>
      <div>
        <h2 className="h-screen">Storage</h2>
        <div className="t-meta">Where your indexed data lives.</div>
      </div>
      <div className="div-h" />

      {error && stats == null ? (
        <div className="t-meta" style={{ color: 'var(--error-solid)' }}>
          Couldn&rsquo;t load storage stats.
        </div>
      ) : stats == null ? (
        <Busy label="Loading storage stats…" />
      ) : (
        <>
          <div className="metric-grid">
            <MetricTile label="Total documents" value={stats.docCount.toLocaleString()} sub="indexed" />
            <MetricTile label="Database size" value={formatBytes(stats.dbBytes)} sub="SQLite on disk" />
            <MetricTile
              label="Accounts"
              value={stats.accountCount.toLocaleString()}
              sub={stats.accountCount === 1 ? 'source connected' : 'sources connected'}
            />
          </div>

          <div className="div-h" />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="lbl-section">Data folder</div>
            <div className="path-row">
              <span className="lbl">Location</span>
              <span className="mono" data-testid="data-folder-path" style={{ flex: 1 }}>
                {stats.dataDir}
              </span>
              <button type="button" className="btn sm" onClick={openInFinder}>
                <Icon name="folder" size={12} /> Show in Finder
              </button>
              <button
                type="button"
                className="btn ghost sm icon-only"
                title="Copy path"
                aria-label="Copy path"
                onClick={copyPath}
              >
                <Icon name="copy" size={12} />
              </button>
            </div>
          </div>

          <div className="div-h" />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="lbl-section">Maintenance</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn sm" disabled={!!busy} onClick={compact}>
                <Icon name="database" size={12} /> {busy === 'compact' ? 'Compacting…' : 'Compact database'}
              </button>
              <button type="button" className="btn sm" disabled={!!busy} onClick={exportData}>
                <Icon name="external" size={12} /> {busy === 'export' ? 'Exporting…' : 'Export data'}
              </button>
            </div>
            <div className="t-meta">
              Compacting reclaims unused pages from soft-deleted rows. Safe to run at any time.
            </div>
          </div>

          <div className="div-h" />

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="lbl-section" style={{ color: 'var(--error-solid)' }}>
              Danger zone
            </div>
            <div className="danger-list">
              <div className="danger-item">
                <div className="copy">
                  <div className="h">Reset all data</div>
                  <div className="d">
                    Wipe the entire local corpus and start over. Cannot be undone.
                  </div>
                </div>
                <button
                  type="button"
                  className="btn destructive sm"
                  disabled={!!busy}
                  onClick={resetAll}
                >
                  <Icon name="trash" size={12} /> {busy === 'reset' ? 'Resetting…' : 'Reset all'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

function MetricTile(props: { label: string; value: string; sub: string }): React.ReactElement {
  return (
    <div className="metric-tile">
      <span className="label">{props.label}</span>
      <span className="value">{props.value}</span>
      <span className="sub">{props.sub}</span>
    </div>
  );
}
