import React, { useEffect, useState } from 'react';
import { Spark } from '@shared/web-ui/Spark';
import { Icon } from '@shared/web-ui/icon-sprite';

const REPO_URL = 'https://github.com/edjafarov/alpha-cent';
const REPO_LABEL = 'github.com/edjafarov/alpha-cent';

/**
 * About pane. `update:get-state`/`update:check` are OSS stubs
 * (`{status: 'idle'}`, no real updater wired up — see ipc.ts) so the update
 * section always renders as "up to date" per the task brief rather than
 * fabricating download-progress/version states the backend can't produce.
 */
export function About(): React.ReactElement {
  const [info, setInfo] = useState<{ version: string; platform: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    void window.kiagent.invoke('app:info', undefined).then(setInfo);
    // Idle stub — resolves immediately, no push channel exists for update
    // state in this contract's Pushes union.
    void window.kiagent.invoke('update:get-state', undefined);
  }, []);

  const checkForUpdates = () => {
    setChecking(true);
    void window.kiagent
      .invoke('update:check', undefined)
      .finally(() => {
        setChecking(false);
        setChecked(true);
      });
  };

  return (
    <div className="about-shell">
      <span className="about-mark">
        <Spark size="app" />
      </span>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
        <span className="about-name">KIAgent</span>
        <span className="about-version">{info ? `v${info.version}` : 'v—'}</span>
      </div>

      <p className="about-tag">
        A local-first connector and indexer for your communications. Everything stays on this
        machine.
      </p>

      <div className="about-actions">
        <button type="button" className="btn sm" onClick={() => window.open(REPO_URL, '_blank')}>
          <Icon name="external" size={12} /> GitHub
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => window.open(`${REPO_URL}/releases`, '_blank')}
        >
          <Icon name="external" size={12} /> Release notes
        </button>
        <button type="button" className="btn sm" disabled={checking} onClick={checkForUpdates}>
          <Icon name="refresh-cw" size={12} /> {checking ? 'Checking…' : 'Check for updates'}
        </button>
      </div>

      <div className="about-update-status">
        <span className="value">{checking ? 'Checking for updates…' : "You’re up to date."}</span>
        {checked && !checking && <span className="t-meta"> (last checked just now)</span>}
      </div>

      <div className="about-list">
        <div className="row">
          <span className="label">Version</span>
          <span className="value mono">{info?.version ?? '—'}</span>
        </div>
        <div className="row">
          <span className="label">Platform</span>
          <span className="value mono">{info?.platform ?? '—'}</span>
        </div>
        <div className="row">
          <span className="label">Repository</span>
          <span className="value mono">{REPO_LABEL}</span>
        </div>
      </div>

      <div className="about-foot">
        © 2026 KIAgent contributors. Made with care for offline-first knowledge work.
      </div>
    </div>
  );
}
