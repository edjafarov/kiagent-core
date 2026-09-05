import React, { useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import type { AccountId } from '@shared/contracts';
import { Icon } from '@shared/web-ui/icon-sprite';
import { StatusPill } from './StatusPill';
import { AccountRowActions } from './AccountRowActions';
import { AddSourcePanel } from './AddSourcePanel';
import { useSourceDescriptors } from './sources-registry';
import { Overview } from './sections/Overview';
import { TrackedFolders } from './sections/TrackedFolders';
import { TrackedContent } from './sections/TrackedContent';
import { Cadence } from './sections/Cadence';
import { ConnectorConfig } from './sections/ConnectorConfig';
import { Outbound } from './sections/Outbound';
import { RecentActivity } from './sections/RecentActivity';
import { DangerZone } from './sections/DangerZone';

export function SourceDetail(props: {
  accountId: AccountId;
  onBack: () => void;
}): React.ReactElement {
  const entry = useAppState((s) =>
    s.accounts.find((a) => a.account.id === props.accountId),
  );
  const descriptors = useSourceDescriptors();
  const [reconnecting, setReconnecting] = useState(false);
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
  // `descriptors` is null while loading and [] when sources:list failed
  // (sources-registry swallows the error) — both mean "no folder card yet",
  // never "this source has no folder scope".
  const descriptor = descriptors?.find((d) => d.id === a.source);
  // R4: Reconnect is offered for needsReauth and error only. It is deliberately
  // NOT offered on a healthy account — an OAuth round trip there can only lose
  // information. ErrorCard's own gate stays needsReauth-only (ErrorCard.test.tsx:51):
  // on the LIST, Retry is the primary action for a plain error.
  const canReconnect = a.status === 'needsReauth' || a.status === 'error';

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
        {canReconnect && (
          <button
            type="button"
            className="btn primary sm"
            onClick={() => setReconnecting(true)}
          >
            <Icon name="link" size={12} />
            Reconnect
          </button>
        )}
        <AccountRowActions account={a} hideSyncNow />
      </div>
      <div className="detail-body">
        {reconnecting ? (
          <AddSourcePanel
            reconnect={{
              accountId: a.id,
              sourceId: a.source,
              identifier: a.identifier,
            }}
            onDone={() => setReconnecting(false)}
          />
        ) : (
          <>
            <Overview
              account={a}
              docCount={entry.docCount}
              lastDocumentAt={entry.recent[0]?.ts}
            />
            {descriptor?.folderScope === true && <TrackedFolders account={a} />}
            <TrackedContent account={a} />
            <Cadence account={a} />
            <ConnectorConfig account={a} />
            {a.source === 'imap' && <Outbound account={a} />}
            <RecentActivity account={a} recent={entry.recent} />
            <DangerZone account={a} />
          </>
        )}
      </div>
    </>
  );
}
