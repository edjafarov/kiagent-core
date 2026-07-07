import React, { useCallback, useState } from 'react';
import { useAppState } from '@renderer/state/app-state';
import { Icon } from '@shared/web-ui/icon-sprite';
import type { Account, AccountId } from '@shared/contracts';
import { ErrorCard } from './ErrorCard';
import { SourceTable, type SourceTableEntry } from './SourceTable';
import { AddSourcePanel } from './AddSourcePanel';
import { GetStartedPanel } from './GetStartedPanel';

function countConnectors(accounts: Account[]): number {
  return new Set(accounts.map((a) => a.source)).size;
}

export function SourcesList(props: {
  onOpenDetail: (accountId: AccountId) => void;
  onOpenConnection: () => void;
}): React.ReactElement {
  const accountEntries = useAppState((s) => s.accounts);
  const [adding, setAdding] = useState(false);
  // Drives the refresh-icon spin for a fixed beat so "Sync all" reads as a
  // real action even when every accounts:sync-now call resolves near-instantly.
  const [syncSpin, setSyncSpin] = useState(false);

  const onRowClick = useCallback(
    (id: AccountId) => props.onOpenDetail(id),
    [props],
  );

  const accounts = accountEntries.map((e) => e.account);
  const erroring = accounts.filter(
    (a) => a.status === 'error' || a.status === 'needsReauth',
  );
  const healthyEntries: SourceTableEntry[] = accountEntries
    .filter(
      (e) => e.account.status !== 'error' && e.account.status !== 'needsReauth',
    )
    .map((e) => ({
      account: e.account,
      docCount: e.docCount,
      lastDocumentAt: e.recent[0]?.ts,
    }));

  const connectorCount = countConnectors(accounts);
  const accountCount = accounts.length;

  function syncAll(): void {
    setSyncSpin(true);
    window.setTimeout(() => setSyncSpin(false), 700);
    // No `accountId: null` "sync everything" verb in the new Invokes surface
    // (accounts:sync-now requires one accountId) — fan out client-side.
    for (const a of accounts) {
      void window.kiagent.invoke('accounts:sync-now', { accountId: a.id });
    }
  }

  return (
    <div className="dash-body">
      <GetStartedPanel onOpenConnection={props.onOpenConnection} />
      <div className="row-flex">
        <span className="h-section">Sources</span>
        <span className="t-meta">
          {connectorCount} {connectorCount === 1 ? 'type' : 'types'} ·{' '}
          {accountCount} {accountCount === 1 ? 'source' : 'sources'}
        </span>
        <div style={{ flex: 1 }} />
        {!adding && (
          <>
            <button
              type="button"
              className="btn sm"
              disabled={syncSpin || accountCount === 0}
              onClick={syncAll}
            >
              <Icon
                name="refresh-cw"
                size={13}
                className={syncSpin ? 'i kg-spin' : 'i'}
              />
              Sync all
            </button>
            <button
              type="button"
              className="btn primary sm"
              onClick={() => setAdding(true)}
            >
              <Icon name="plus" size={13} />
              Add
            </button>
          </>
        )}
      </div>

      {adding ? (
        <AddSourcePanel
          onDone={(accountId) => {
            setAdding(false);
            if (accountId) props.onOpenDetail(accountId);
          }}
        />
      ) : (
        <>
          {erroring.map((a) => (
            <ErrorCard key={a.id} account={a} />
          ))}
          {healthyEntries.length > 0 || erroring.length > 0 ? (
            <SourceTable entries={healthyEntries} onRowClick={onRowClick} />
          ) : (
            <div className="src-empty">
              <Icon
                name="database"
                size={20}
                style={{ color: 'var(--text-tertiary)' }}
              />
              <div className="t-meta">
                No sources connected yet — add one to get started.
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
