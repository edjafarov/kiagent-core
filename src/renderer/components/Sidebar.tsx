import React from 'react';
import { useAppState } from '@renderer/state/app-state';
import { useView } from '@renderer/state/view';
import { ICON_NAMES } from '@shared/web-ui/icon-sprite';
import { contributedNavRows } from '@renderer/components/contributed-nav';
import { BracketMark } from '@shared/web-ui/components';
import { NavItem, SidebarFrame, Status } from '@shared/web-ui/ui';
import { AccountMenu } from '@renderer/components/AccountMenu';
import type { AppState } from '@shared/contracts';

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
  const extensions = useAppState((s) => s.extensions);
  const { view, navigate, openSettings } = useView();

  const mcpOnline = mcpPort != null;
  const needs = `${erroringCount} ${erroringCount === 1 ? 'source needs' : 'sources need'} attention`;

  return (
    <SidebarFrame
      brand={
        <>
          <BracketMark size={20} />
          <span>KIAgent</span>
        </>
      }
      foot={
        <>
          {erroringCount > 0 ? (
            <button
              type="button"
              className="ui-sb-line"
              aria-label={needs}
              onClick={() => navigate('sources')}
            >
              <Status tone="err">{needs}</Status>
            </button>
          ) : (
            <span className="ui-sb-line">
              <Status tone="off">
                {liveCount} live · {totalDocs.toLocaleString()} docs
              </Status>
            </span>
          )}
          {identity && (
            <AccountMenu
              identity={identity}
              collapsed={false}
              onOpenSettings={() => openSettings()}
            />
          )}
        </>
      }
    >
      <NavItem
        label="Sources"
        icon="database"
        active={view === 'sources'}
        onClick={() => navigate('sources')}
      />
      <NavItem
        label="Outbox"
        icon="mail"
        active={view === 'outbox'}
        onClick={() => navigate('outbox')}
      />
      <NavItem
        label="Connection"
        icon="link"
        active={view === 'connection'}
        onClick={() => navigate('connection')}
        dot={
          mcpOnline
            ? { tone: 'ok', label: 'online' }
            : { tone: 'off', label: 'offline' }
        }
        title={
          mcpOnline
            ? `Local server online · 127.0.0.1:${mcpPort}/mcp`
            : 'Local server offline'
        }
      />
      <NavItem
        label="Marketplace"
        icon="puzzle"
        active={view === 'marketplace'}
        onClick={() => navigate('marketplace')}
      />
      {/* Core's sidebar has no groups, so a row's group is ignored here. */}
      {contributedNavRows(extensions ?? [], ICON_NAMES).map((row) => (
        <NavItem
          key={row.view}
          label={row.label}
          icon={row.icon}
          active={view === row.view}
          onClick={() => navigate(row.view)}
        />
      ))}
    </SidebarFrame>
  );
}
