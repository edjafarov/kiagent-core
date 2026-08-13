import React, { useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import { useView } from '@renderer/state/view';
import { Icon } from '@shared/web-ui/icon-sprite';
import { AccountMenu } from '@renderer/components/AccountMenu';
import type { AppState } from '@shared/contracts';
import './Sidebar.css';

const COLLAPSE_KEY = 'kia.sidebar.collapsed';
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
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(COLLAPSE_KEY) === '1',
  );

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem(COLLAPSE_KEY, v ? '0' : '1');
      return !v;
    });
  };

  const mcpOnline = mcpPort != null;

  return (
    <aside
      className={`kg-sidebar${collapsed ? ' collapsed' : ''}${isMac ? ' mac' : ''}`}
    >
      <div className="kg-sb-head">
        <span className="kg-sb-brand">
          <Icon name="spark" size={14} />
          {!collapsed && <span className="kg-sb-wordmark">KIAgent</span>}
        </span>
        <button
          type="button"
          className="kg-sb-collapse"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleCollapsed}
        >
          <Icon name="chevs-left" size={12} />
        </button>
      </div>

      <nav className="kg-sb-nav">
        <SideNavItem
          label="Sources"
          icon="database"
          active={view === 'sources'}
          collapsed={collapsed}
          onClick={() => navigate('sources')}
        />
        <SideNavItem
          label="Outbox"
          icon="mail"
          active={view === 'outbox'}
          collapsed={collapsed}
          onClick={() => navigate('outbox')}
        />
        <SideNavItem
          label="Connection"
          icon="link"
          active={view === 'connection'}
          collapsed={collapsed}
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
          collapsed={collapsed}
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
            {!collapsed && (
              <span>
                {erroringCount}{' '}
                {erroringCount === 1 ? 'source needs' : 'sources need'}{' '}
                attention
              </span>
            )}
          </button>
        ) : (
          <div className="kg-sb-status">
            <span className="dot" />
            {!collapsed && (
              <span>
                {liveCount} live · {totalDocs.toLocaleString()} docs
              </span>
            )}
          </div>
        )}
        {identity && (
          <AccountMenu
            identity={identity}
            collapsed={collapsed}
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
  collapsed: boolean;
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
      title={props.collapsed ? props.label : props.badgeTitle}
      className={`side-item kg-sb-item${props.active ? ' active' : ''}`}
    >
      <Icon name={props.icon} size={13} />
      {!props.collapsed && <span>{props.label}</span>}
      {props.badge && (
        <span
          className={`tab-dot ${props.badge}`}
          aria-label={`${props.label} ${badgeAria}`}
        />
      )}
    </button>
  );
}
