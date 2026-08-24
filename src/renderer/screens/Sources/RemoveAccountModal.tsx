import React, { useEffect, useState } from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';
import { Spinner } from '@shared/web-ui/components';

/**
 * Confirm-remove dialog. The legacy modal offered "keep indexed data" vs
 * "delete indexed data" (two distinct backend verbs). The new `accounts:remove`
 * command is ONE cascade — `removeAccount` tombstones every document the
 * account contributed in the same transaction (contracts.ts `CommitBatch`) —
 * so there is no "keep the data" option to offer; this is a single,
 * destructive confirmation.
 *
 * `onConfirm` may be async: the modal stays open in a "Removing…" state
 * (cancel/escape/backdrop disabled — the cascade is already running and
 * can't be called back) until it settles, so a large account's purge shows
 * progress feedback instead of a silently lingering card.
 *
 * This dialog is the ONLY progress signal the removal can have. `removeAccount`
 * (write-tx.ts) deletes every FTS row, every trigram row and every document
 * for the account inside one BEGIN..COMMIT in the DB worker; no intermediate
 * state is observable and no percentage can be computed. Measured on a real
 * corpus: ~5 minutes for 3.73M documents. Hence the explicit "this can take
 * several minutes / keep the app open" copy — a bare spinner would leave the
 * user unable to tell work from a hang, which is exactly what happened when
 * the kebab-menu caller closed this modal early.
 */
export function RemoveAccountModal(props: {
  identifier: string;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}): React.ReactElement {
  const { identifier, onCancel, onConfirm } = props;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  async function confirm(): Promise<void> {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Remove account"
      onClick={busy ? undefined : onCancel}
      className="ra-modal-backdrop"
    >
      <div onClick={(e) => e.stopPropagation()} className="tray-pop ra-modal">
        <div className="ra-modal-title">Remove {identifier}?</div>
        <div className="ra-modal-body" role={busy ? 'status' : undefined}>
          {busy
            ? `Deleting the documents and their search-index entries runs as a
               single database transaction, so there is nothing to report until
               it commits. For a large source this can take several minutes —
               keep the app open. Quitting now rolls the whole removal back.`
            : `This permanently deletes every document this account contributed
               to the index, plus its credentials and sync cursor. This cannot
               be undone.`}
        </div>
        <div className="ra-modal-actions">
          <button
            type="button"
            className="btn destructive sm"
            style={{ justifyContent: 'flex-start' }}
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? <Spinner /> : <Icon name="trash" size={12} />}
            {busy ? 'Removing…' : 'Remove and delete indexed data'}
          </button>
          <button
            type="button"
            className="btn ghost sm"
            style={{ justifyContent: 'flex-start' }}
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
