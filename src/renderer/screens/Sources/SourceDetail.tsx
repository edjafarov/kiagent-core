import React, { useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import type { AccountId } from '@shared/contracts';
import { Icon } from '@shared/web-ui/icon-sprite';
import { StatusPill } from './StatusPill';
import { AccountRowActions } from './AccountRowActions';
import { Overview } from './sections/Overview';
import { TrackedFolders, trackedFolderPaths } from './sections/TrackedFolders';
import { TrackedContent } from './sections/TrackedContent';
import { Cadence } from './sections/Cadence';
import { ConnectorConfig } from './sections/ConnectorConfig';
import { RecentActivity } from './sections/RecentActivity';
import { DangerZone } from './sections/DangerZone';

export function SourceDetail(props: {
  accountId: AccountId;
  onBack: () => void;
}): React.ReactElement {
  const entry = useAppState((s) =>
    s.accounts.find((a) => a.account.id === props.accountId),
  );
  const [syncPending, setSyncPending] = useState(false);
  const [pausePending, setPausePending] = useState(false);

  if (!entry) {
    return (
      <>
        <div className="dash-topbar">
          <button type="button" className="btn ghost sm" onClick={props.onBack}>
            ← Sources
          </button>
        </div>
        <div style={{ padding: 20 }} className="t-meta">
          Source not found.
        </div>
      </>
    );
  }

  const a = entry.account;
  const paused = a.status === 'paused';

  return (
    <>
      <div className="dash-topbar" style={{ gap: 10 }}>
        <button type="button" className="btn ghost sm" onClick={props.onBack}>
          ← Sources
        </button>
        <span className="h-section mono" style={{ fontSize: 13 }}>
          {a.identifier}
        </span>
        <StatusPill account={a} />
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn sm"
          disabled={syncPending}
          onClick={() => {
            setSyncPending(true);
            void window.kiagent
              .invoke('accounts:sync-now', { accountId: a.id })
              .finally(() => setSyncPending(false));
          }}
        >
          <Icon name="refresh-cw" size={12} />
          {syncPending ? 'Syncing…' : 'Sync now'}
        </button>
        <button
          type="button"
          className="btn sm"
          disabled={pausePending}
          onClick={() => {
            setPausePending(true);
            void window.kiagent
              .invoke(paused ? 'accounts:resume' : 'accounts:pause', {
                accountId: a.id,
              })
              .finally(() => setPausePending(false));
          }}
        >
          <Icon name={paused ? 'play' : 'pause'} size={12} />
          {pausePending
            ? paused
              ? 'Resuming…'
              : 'Pausing…'
            : paused
              ? 'Resume'
              : 'Pause'}
        </button>
        <AccountRowActions account={a} hideSyncNow />
      </div>
      <div className="detail-body">
        <Overview
          account={a}
          docCount={entry.docCount}
          lastDocumentAt={entry.recent[0]?.ts}
        />
        {trackedFolderPaths(a).length > 0 && <TrackedFolders account={a} />}
        <TrackedContent account={a} />
        <Cadence account={a} />
        <ConnectorConfig account={a} />
        <RecentActivity account={a} recent={entry.recent} />
        <DangerZone account={a} />
      </div>
    </>
  );
}
