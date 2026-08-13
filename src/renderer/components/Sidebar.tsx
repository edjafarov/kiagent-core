import React from 'react';
import { useAppState } from '@renderer/state/app-state';
import { useView } from '@renderer/state/view';
import { Icon } from '@shared/web-ui/icon-sprite';
import { BracketMark } from '@shared/web-ui/components';
import { AccountMenu } from '@renderer/components/AccountMenu';
import type { AppState } from '@shared/contracts';
import './Sidebar.css';

const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

// Narrow selector (moved from TopBar): re-render only when a derived number
// changes, not on every state push.
function selectSidebarSlice(s: AppState): {
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
    } else if (
      a.account.status === 'live' ||
      a.account.status === 'backfilling'
    ) {
      liveCount += 1;
    }
    totalDocs += a.docCount;
  }
  return { erroringCount, liveCount, totalDocs, mcpPort: s.mcp.port };
}

export function Sidebar(): React.ReactElement {
  const { erroringCount, liveCount, totalDocs, mcpPort } =
    useAppState(selectSidebarSlice);
  const identity = useAppState((s) => s.identity);
  const { view, navigate, openSettings } = useView();

  const mcpOnline = mcpPort != null;

  return (
    <aside className={`kg-sidebar${isMac ? ' mac' : ''}`}>
      <div className="kg-sb-head">
        <span className="kg-sb-brand">
          <BracketMark size={22} />
          <span className="kg-sb-wordmark">KIAgent</span>
        </span>
      </div>

      <nav className="kg-sb-nav">
        <SideNavItem
          label="Sources"
          icon="database"
          active={view === 'sources'}
          onClick={() => navigate('sources')}
        />
        <SideNavItem
          label="Outbox"
          icon="mail"
          active={view === 'outbox'}
          onClick={() => navigate('outbox')}
        />
        <SideNavItem
          label="Connection"
          icon="link"
          active={view === 'connection'}
          onClick={() => navigate('connection')}
          badge={mcpOnline ? 'on' : 'off'}
          badgeTitle={
            mcpOnline
              ? `Local server online · 127.0.0.1:${mcpPort}/mcp`
              : 'Local server offline'
          }
        />
        <SideNavItem
          label="Marketplace"
          icon="puzzle"
          active={view === 'marketplace'}
          onClick={() => navigate('marketplace')}
        />
      </nav>

      <div className="kg-sb-foot">
        <div className="kg-sb-divider" />
        {erroringCount > 0 ? (
          <button
            type="button"
            className="kg-sb-status error"
            aria-label={`${erroringCount} ${erroringCount === 1 ? 'source needs' : 'sources need'} attention`}
            onClick={() => navigate('sources')}
          >
            <span className="dot" />
            <span>
              {erroringCount}{' '}
              {erroringCount === 1 ? 'source needs' : 'sources need'} attention
            </span>
          </button>
        ) : (
          <div className="kg-sb-status">
            <span className="dot" />
            <span>
              {liveCount} live · {totalDocs.toLocaleString()} docs
            </span>
          </div>
        )}
        {identity && (
          <AccountMenu
            identity={identity}
            collapsed={false}
            onOpenSettings={openSettings}
          />
        )}
      </div>
    </aside>
  );
}

function SideNavItem(props: {
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
      className={`side-item kg-sb-item${props.active ? ' active' : ''}`}
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
