import React, { useEffect, useState } from 'react';
import { Spark } from '@shared/web-ui/Spark';
import { Icon } from '@shared/web-ui/icon-sprite';
import type { UpdateState } from '@shared/ipc';

const REPO_URL = 'https://github.com/edjafarov/kiagent-core';
const REPO_LABEL = 'github.com/edjafarov/kiagent-core';

/**
 * Human-readable line for the current updater state. Covers the full
 * `UpdateStatus` union (the state machine also emits `idle`/`up-to-date`).
 */
function statusLine(u: UpdateState | null): string {
  switch (u?.status) {
    case 'checking':
      return 'Checking for updates…';
    case 'available':
      return `Update available${u.version ? ` (v${u.version})` : ''}, downloading…`;
    case 'downloading':
      return `Downloading${
        typeof u.percent === 'number' ? ` ${Math.round(u.percent)}%` : '…'
      }`;
    case 'downloaded':
      return `Update ready${u.version ? ` (v${u.version})` : ''}.`;
    case 'error':
      return `Update check failed: ${u.error ?? 'unknown error'}`;
    case 'disabled':
      return u.reason === 'dev'
        ? 'Updates are disabled in development.'
        : u.reason === 'unsigned-macos'
          ? 'Automatic updates are not yet available on macOS.'
          : 'Updates are disabled.';
    case 'up-to-date':
    case 'idle':
    default:
      return 'You’re up to date.';
  }
}

/**
 * About pane. Wired to the real core updater: `update:get-state` seeds the
 * initial state, `push:update-state` streams live transitions, `update:check`
 * kicks off a check, and `update:quit-and-install` restarts into a downloaded
 * build.
 */
export function About(): React.ReactElement {
  const [info, setInfo] = useState<{
    version: string;
    platform: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<UpdateState | null>(null);

  useEffect(() => {
    void window.kiagent.invoke('app:info', undefined).then(setInfo);
    void window.kiagent.invoke('update:get-state', undefined).then(setUpdate);
    const off = window.kiagent.on('push:update-state', (s) => {
      setUpdate(s);
      if (s.status !== 'checking') setChecking(false);
    });
    return off;
  }, []);

  const checkForUpdates = () => {
    setChecking(true);
    void window.kiagent
      .invoke('update:check', undefined)
      .then(setUpdate)
      .finally(() => setChecking(false));
  };

  return (
    <div className="about-shell">
      <span className="about-mark">
        <Spark size="app" />
      </span>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          alignItems: 'center',
        }}
      >
        <span className="about-name">KIAcore</span>
        <span className="about-version">
          {info ? `v${info.version}` : 'v—'}
        </span>
      </div>

      <p className="about-tag">
        A local-first connector and indexer for your communications. Everything
        stays on this machine.
      </p>

      <div className="about-actions">
        <button
          type="button"
          className="btn sm"
          onClick={() => window.open(REPO_URL, '_blank')}
        >
          <Icon name="external" size={12} /> GitHub
        </button>
        <button
          type="button"
          className="btn sm"
          onClick={() => window.open(`${REPO_URL}/releases`, '_blank')}
        >
          <Icon name="external" size={12} /> Release notes
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={
            checking ||
            update?.status === 'checking' ||
            update?.status === 'downloading' ||
            update?.status === 'disabled'
          }
          onClick={checkForUpdates}
        >
          <Icon name="refresh-cw" size={12} />{' '}
          {checking || update?.status === 'checking'
            ? 'Checking…'
            : 'Check for updates'}
        </button>
        {update?.status === 'downloaded' && (
          <button
            type="button"
            className="btn sm primary"
            onClick={() =>
              void window.kiagent.invoke('update:quit-and-install', undefined)
            }
          >
            <Icon name="refresh-cw" size={12} /> Restart to update
          </button>
        )}
      </div>

      <div className="about-update-status">
        <span className="value">{statusLine(update)}</span>
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
        © 2026 KIAcore contributors. Made with care for offline-first knowledge
        work.
      </div>
    </div>
  );
}
