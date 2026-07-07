import React, { useState } from 'react';
import type { Account } from '@shared/contracts';
import { Icon } from '@shared/web-ui/icon-sprite';
import { RemoveAccountModal } from '../RemoveAccountModal';

/**
 * Danger zone: Pause/Resume + Remove. The legacy section also had a
 * "Re-run backfill" button (`connector:retry-backfill`) — the new `Invokes`
 * surface has no equivalent command, so it's dropped rather than mapped to
 * `accounts:sync-now` (which resumes the existing cursor, not a fresh
 * backfill — a different operation the button's label would misrepresent).
 */
export function DangerZone(props: { account: Account }): React.ReactElement {
  const a = props.account;
  const [showRemove, setShowRemove] = useState(false);
  const [pausePending, setPausePending] = useState(false);
  const paused = a.status === 'paused';

  return (
    <section className="detail-card">
      <div className="lbl-section danger">Danger zone</div>
      <div className="dz-actions">
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
          <Icon name={paused ? 'play' : 'pause'} size={11} />
          {pausePending
            ? paused
              ? 'Resuming…'
              : 'Pausing…'
            : paused
              ? 'Resume'
              : 'Pause'}
        </button>
        <button
          type="button"
          className="btn destructive sm"
          onClick={() => setShowRemove(true)}
        >
          <Icon name="trash" size={11} />
          Remove…
        </button>
      </div>
      {showRemove && (
        <RemoveAccountModal
          identifier={a.identifier}
          onCancel={() => setShowRemove(false)}
          onConfirm={async () => {
            await window.kiagent.invoke('accounts:remove', { accountId: a.id });
            setShowRemove(false);
          }}
        />
      )}
    </section>
  );
}
