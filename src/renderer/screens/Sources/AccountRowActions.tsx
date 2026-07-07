import React, { useState } from 'react';
import type { AccountId } from '@shared/contracts';
import { RowMenu, type RowMenuAction } from './RowMenu';
import { RemoveAccountModal } from './RemoveAccountModal';

/**
 * Kebab menu for an account row — "Sync now" (hidden on SourceDetail, which
 * already has an inline Sync now button) + "Remove". The legacy menu also
 * carried "Re-run backfill"; the new `Invokes` surface has no equivalent
 * command (only `accounts:sync-now`, which resumes the existing cursor
 * rather than restarting a backfill from scratch), so that entry is dropped
 * rather than wired to the wrong verb.
 */
export function AccountRowActions(props: {
  account: { id: AccountId; identifier: string };
  buttonStyle?: React.CSSProperties;
  hideSyncNow?: boolean;
}): React.ReactElement {
  const { account, buttonStyle, hideSyncNow } = props;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const withPending =
    (label: string, fn: () => Promise<unknown>) => async (): Promise<void> => {
      setPending(label);
      try {
        await fn();
      } finally {
        setPending(null);
      }
    };

  const actions: RowMenuAction[] = [];
  if (!hideSyncNow) {
    actions.push({
      label: pending === 'sync' ? 'Syncing…' : 'Sync now',
      icon: 'refresh-cw',
      onSelect: withPending('sync', () =>
        window.kiagent.invoke('accounts:sync-now', { accountId: account.id }),
      ),
    });
  }
  actions.push({
    label: 'Remove',
    icon: 'trash',
    destructive: true,
    onSelect: () => setConfirmRemove(true),
  });

  return (
    <>
      <RowMenu
        ariaLabel={`Actions for ${account.identifier}`}
        actions={actions}
        buttonStyle={buttonStyle}
      />
      {confirmRemove && (
        <RemoveAccountModal
          identifier={account.identifier}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            setConfirmRemove(false);
            void window.kiagent.invoke('accounts:remove', {
              accountId: account.id,
            });
          }}
        />
      )}
    </>
  );
}
