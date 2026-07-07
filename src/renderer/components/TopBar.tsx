import React from 'react';
import { useAppState } from '@renderer/state/app-state';
import { useView } from '@renderer/state/view';
import { Icon } from '@shared/web-ui/icon-sprite';
import { Wordmark, Pill } from '@shared/web-ui/components';
import type { AppState } from '@shared/contracts';

// Narrow selector: TopBar renders on every screen that opts in, so it must
// only re-render when one of these derived numbers actually changes — not on
// every state push (e.g. a single account's doc count ticking up).
function selectTopBarSlice(s: AppState): {
  erroringCount: number;
  liveCount: number;
  totalDocs: number;
  mcpPort: number | null;
} {
  let erroringCount = 0;
  let liveCount = 0;
  let totalDocs = 0;
  for (const a of s.accounts) {
    if (a.account.status === 'error' || a.account.status === 'needsReauth') {
      erroringCount += 1;
    } else if (a.account.status === 'live' || a.account.status === 'backfilling') {
      liveCount += 1;
    }
    totalDocs += a.docCount;
  }
  return { erroringCount, liveCount, totalDocs, mcpPort: s.mcp.port };
}

export function TopBar(): React.ReactElement {
  const { erroringCount, liveCount, totalDocs, mcpPort } =
    useAppState(selectTopBarSlice);
  const { view, navigate } = useView();

  const mcpOnline = mcpPort != null;
  const isSourcesActive = view === 'sources';
  const isConnectionActive = view === 'connection';
  const isMarketplaceActive = view === 'marketplace';

  return (
    <div className="dash-topbar">
      <Wordmark />
      {erroringCount > 0 ? (
        <Pill variant="error">
          {erroringCount}{' '}
          {erroringCount === 1 ? 'source needs' : 'sources need'} attention
        </Pill>
      ) : (
        <Pill variant="live">
          {liveCount} live · {totalDocs.toLocaleString()} docs
        </Pill>
      )}
      <div style={{ flex: 1 }} />
      <NavTab
        label="Sources"
        icon="database"
        active={isSourcesActive}
        onClick={() => navigate('sources')}
      />
      <NavTab
        label="Marketplace"
        icon="search"
        active={isMarketplaceActive}
        onClick={() => navigate('marketplace')}
      />
      <NavTab
        label="Connection"
        icon="link"
        active={isConnectionActive}
        onClick={() => navigate('connection')}
        badge={mcpOnline ? 'on' : 'off'}
        badgeTitle={
          mcpOnline
            ? `Local server online · 127.0.0.1:${mcpPort}/mcp`
            : 'Local server offline'
        }
      />
      <button
        type="button"
        className="btn ghost sm"
        aria-label="Settings"
        onClick={() => navigate('settings')}
      >
        <Icon name="settings" size={14} />
      </button>
    </div>
  );
}

function NavTab(props: {
  label: string;
  icon: string;
  active: boolean;
  onClick: () => void;
  badge?: 'on' | 'off';
  badgeTitle?: string;
}): React.ReactElement {
  const badgeAria = props.badge === 'on' ? 'online' : 'offline';
  const ariaLabel = props.badge ? `${props.label} ${badgeAria}` : props.label;
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={props.onClick}
      title={props.badgeTitle}
      className={`kg-tab${props.active ? ' active' : ''}`}
    >
      <Icon name={props.icon} size={13} />
      <span>{props.label}</span>
      {props.badge && (
        <span
          className={`tab-dot ${props.badge}`}
          aria-label={`${props.label} ${badgeAria}`}
        />
      )}
    </button>
  );
}
