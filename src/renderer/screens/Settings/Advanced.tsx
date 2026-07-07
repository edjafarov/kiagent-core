import React, { useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import { Icon } from '@shared/web-ui/icon-sprite';
import type { AppPrefs, LogLevel } from '@shared/contracts';

const LOG_LEVELS: readonly LogLevel[] = ['info', 'warn', 'error'];

/**
 * Advanced pane — prefs toggles + log export. Per the task brief the single
 * destructive action this rebuild exposes (`maintenance:reset-all`) lives on
 * the Storage pane instead of a duplicate danger zone here; this contract
 * also has no separate "purge archived" channel like the legacy screen did.
 */
export function Advanced(): React.ReactElement {
  const prefs = useAppState((s) => s.prefs);
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const patch = (delta: Partial<AppPrefs>) => {
    void window.kiagent.invoke('prefs:patch', delta);
  };

  const exportLogs = () => {
    if (exporting) return;
    setExporting(true);
    setExportMsg(null);
    window.kiagent
      .invoke('logs:export', undefined)
      .then((path) =>
        window.kiagent.invoke('app:open-path', { path }).then(() => path),
      )
      .then((path) => setExportMsg(`Exported to ${path}`))
      .catch((e: unknown) =>
        setExportMsg(
          `Export failed: ${e instanceof Error ? e.message : 'unknown error'}`,
        ),
      )
      .finally(() => setExporting(false));
  };

  return (
    <>
      <div>
        <h2 className="h-screen">Advanced</h2>
        <div className="t-meta">
          Configuration, logs, and destructive actions.
        </div>
      </div>
      <div className="div-h" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div className="lbl-section">Diagnostics</div>

        <div className="field-row">
          {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
          <label htmlFor="adv-log-level" className="lbl">
            Log level
          </label>
          <select
            id="adv-log-level"
            className="cadence-select"
            value={prefs.logLevel}
            onChange={(e) => patch({ logLevel: e.target.value as LogLevel })}
          >
            {LOG_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </div>

        <div className="pref-list">
          <ToggleRow
            label="Launch at login"
            desc="Start KIAgent automatically when you sign in."
            checked={prefs.launchAtLogin}
            onChange={(v) => patch({ launchAtLogin: v })}
          />
          <ToggleRow
            label="Show in menu bar"
            desc="Display the tray icon for quick status and search."
            checked={prefs.showInMenuBar}
            onChange={(v) => patch({ showInMenuBar: v })}
          />
          <ToggleRow
            label="Browser history"
            desc="Allow the browser connector to read history for indexing."
            checked={prefs.privacy.browserHistory}
            onChange={(v) =>
              patch({ privacy: { ...prefs.privacy, browserHistory: v } })
            }
          />
          <ToggleRow
            label="Send anonymous diagnostics"
            desc="Crash reports and performance metrics. No corpus content."
            checked={prefs.privacy.sendDiagnostics}
            onChange={(v) =>
              patch({ privacy: { ...prefs.privacy, sendDiagnostics: v } })
            }
          />
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="btn sm"
            disabled={exporting}
            onClick={exportLogs}
          >
            <Icon name="external" size={12} />{' '}
            {exporting ? 'Exporting…' : 'Export logs'}
          </button>
          {exportMsg && <span className="t-meta">{exportMsg}</span>}
        </div>
      </div>
    </>
  );
}

function ToggleRow(props: {
  label: string;
  desc: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.ReactElement {
  const { label, desc, checked, onChange } = props;
  return (
    <div className="pref-row">
      <div className="pref-meta">
        <span className="pref-label">{label}</span>
        <span className="pref-desc">{desc}</span>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={checked ? 'toggle on' : 'toggle'}
        onClick={() => onChange(!checked)}
      >
        <span className="knob" />
      </button>
    </div>
  );
}
