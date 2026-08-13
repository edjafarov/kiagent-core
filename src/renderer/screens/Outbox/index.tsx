import React, { useCallback, useEffect, useState } from 'react';
import { Busy, Pill, type PillVariant } from '@shared/web-ui/components';
import type { OutboxPanelRow } from '@shared/ipc';
import { formatRelativeCompact } from '@renderer/screens/Sources/format';
import './Outbox.css';

/**
 * Outbox history (spec §10) — what the outbound layer has done lately.
 * Confirmation itself happens on the app-served pages (spec §13, user
 * decision): every action here either opens one of those pages or writes a
 * row's status; there is no in-app Send button.
 *
 * Refetches on mount (App keys screens on `${view}:${epoch}`, so
 * re-navigating remounts this) and after every action — no push channel.
 *
 * All failure classification arrives pre-computed on the wire
 * (`canRetry` / `deliveryUncertain`): error-copy.ts is main-process code and
 * must not be imported here.
 */

const STATUS_PILL: Record<
  OutboxPanelRow['status'],
  { v: PillVariant; label: string }
> = {
  draft: { v: 'info', label: 'Pending' },
  sending: { v: 'working', label: 'Sending' },
  sent: { v: 'live', label: 'Sent' },
  failed: { v: 'error', label: 'Failed' },
  discarded: { v: 'paused', label: 'Discarded' },
  expired: { v: 'paused', label: 'Expired' },
  delivery_unknown: { v: 'error', label: 'Delivery unknown' },
};

type RowAction =
  | 'review' // pending: Review & send + two-click Discard
  | 'retry' // provably-not-sent failure: re-confirm the SAME row
  | 'redraft' // one-click Draft again
  | 'redraft-guarded' // Draft again behind a two-click confirm
  | 'none';

/** Electron rejects an invoke as `Error invoking remote method '<ch>': Error:
 *  <msg>` — a developer wrapper that must never sit beside main's shaped
 *  sentences. Main-side messages are human sentences by contract, so the
 *  stripped tail is displayable as-is. */
function stripIpcWrapper(message: string): string {
  return message.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    '',
  );
}

function actionFor(r: OutboxPanelRow): RowAction {
  if (r.status === 'draft') return 'review';
  if (r.status === 'failed') {
    // Re-confirming the same row is CAS-gated on its observed status
    // (service.ts:706-734), so it can never duplicate a send. Re-drafting
    // can. So a failure that PROVES pre-delivery rejection gets the shipped
    // Try-again page, never a fresh draft.
    if (r.canRetry) return 'retry';
    // 'Delivery uncertain': the message MAY have gone out. A one-click
    // Draft again here is exactly the double-send invitation
    // routes.ts:126-132 and service.ts:370-378 were written to prevent, so
    // it sits behind the same friction as Discard.
    return r.deliveryUncertain ? 'redraft-guarded' : 'redraft';
  }
  if (r.status === 'expired' || r.status === 'discarded') {
    // Belt-and-suspenders: main never sets `deliveryUncertain` on these
    // statuses today, so this is behaviour-identical — it makes "no
    // maybe-delivered row ever gets a one-click re-draft" an invariant of
    // THIS function instead of a convention of the mapper that future drift
    // could quietly break. Deliberately NOT hoisted to the top of the
    // function: a leading `deliveryUncertain` check would hand
    // 'delivery_unknown' rows a redraft action, and they must stay 'none'.
    return r.deliveryUncertain ? 'redraft-guarded' : 'redraft';
  }
  // 'sent', 'sending', and 'delivery_unknown' offer nothing. The last one is
  // deliberate: the service refuses to re-draft it, and the row's own stored
  // sentence already tells the user to check their Sent folder.
  return 'none';
}

export function Outbox(): React.ReactElement {
  const [rows, setRows] = useState<OutboxPanelRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const refresh = useCallback(() => {
    // Cleared up-front so a successful re-read (including the Retry button's)
    // drops the failure state on its own.
    setLoadFailed(false);
    void window.kiagent
      .invoke('outbox:list', {})
      .then(setRows)
      .catch(() => {
        // A failed read must NEVER fall through to the empty state: "no
        // recent drafts" is an assertion about the user's outbox, and this
        // panel's whole job is truthful reporting. Say we couldn't load it.
        setRows([]);
        setLoadFailed(true);
      });
  }, []);

  useEffect(() => refresh(), [refresh]);

  async function withBusy(id: string, run: () => Promise<unknown>) {
    setBusyId(id);
    setRowError(null);
    try {
      await run();
    } catch (e) {
      setRowError({
        id,
        message: stripIpcWrapper(e instanceof Error ? e.message : String(e)),
      });
    } finally {
      setBusyId(null);
      setConfirmingId(null);
      refresh(); // re-read actual state — a failed write stays as it was
    }
  }

  const openConfirm = (id: string) =>
    void withBusy(id, () =>
      window.kiagent.invoke('outbox:open-confirm', { draftId: id }),
    );
  const discard = (id: string) =>
    void withBusy(id, () =>
      window.kiagent.invoke('outbox:discard', { draftId: id }),
    );
  const redraft = (id: string) =>
    void withBusy(id, () =>
      window.kiagent.invoke('outbox:redraft', { draftId: id }),
    );

  return (
    <div className="outbox-screen">
      {/* Title lives in the shell's .kg-topline; only the explainer here. */}
      <p className="t-meta">
        Recent outbound drafts. Nothing is sent without your confirmation —
        pending drafts wait for you on their own review page.
      </p>
      {rows === null ? (
        <Busy label="Loading outbox…" />
      ) : loadFailed ? (
        <div className="outbox-load-error">
          <span className="t-meta">Couldn’t load the outbox.</span>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              // Back to the loading state first: `refresh` clears the flag
              // up-front, so without this the stale `[]` would flash the
              // empty-state copy — the same false claim — for the length of
              // the round-trip. Busy's 200ms delay means a fast retry shows
              // nothing at all.
              setRows(null);
              refresh();
            }}
          >
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p className="t-meta outbox-empty">
          No recent outbound drafts — ask your assistant to draft a reply.
        </p>
      ) : (
        <div className="outbox-list">
          {rows.map((r) => {
            const pill = STATUS_PILL[r.status];
            const action = actionFor(r);
            const busy = busyId === r.draftId;
            const confirming = confirmingId === r.draftId;
            return (
              <div className="outbox-row" key={r.draftId}>
                <div className="outbox-main">
                  <div className="outbox-target">
                    <span className="outbox-recipient">
                      {r.recipientDisplay}
                    </span>
                    {r.subject && (
                      <span className="t-meta"> — {r.subject}</span>
                    )}
                  </div>
                  <div className="t-meta outbox-preview">{r.bodyPreview}</div>
                  {r.error && (
                    <div className="outbox-error">
                      {r.error}
                      {r.errorDetail && (
                        <details className="outbox-detail">
                          <summary>Technical details</summary>
                          {r.errorDetail}
                        </details>
                      )}
                    </div>
                  )}
                  {rowError?.id === r.draftId && (
                    <div className="outbox-error">{rowError.message}</div>
                  )}
                </div>
                <div className="t-meta outbox-when">
                  {formatRelativeCompact(r.sentAt ?? r.createdAt)}
                </div>
                <Pill variant={pill.v} title={r.accountLabel}>
                  {pill.label}
                </Pill>
                <div className="outbox-actions">
                  {action === 'review' && !confirming && (
                    <>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => openConfirm(r.draftId)}
                      >
                        {busy ? 'Opening…' : 'Review & send'}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() => setConfirmingId(r.draftId)}
                      >
                        Discard
                      </button>
                    </>
                  )}
                  {action === 'review' && confirming && (
                    <>
                      <button
                        type="button"
                        className="btn destructive sm"
                        disabled={busy}
                        onClick={() => discard(r.draftId)}
                      >
                        {busy ? 'Discarding…' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {action === 'retry' && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => openConfirm(r.draftId)}
                    >
                      {busy ? 'Opening…' : 'Try again'}
                    </button>
                  )}
                  {action === 'redraft' && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => redraft(r.draftId)}
                    >
                      {busy ? 'Drafting…' : 'Draft again'}
                    </button>
                  )}
                  {action === 'redraft-guarded' && !confirming && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy}
                      onClick={() => setConfirmingId(r.draftId)}
                    >
                      Draft again
                    </button>
                  )}
                  {action === 'redraft-guarded' && confirming && (
                    <>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => redraft(r.draftId)}
                      >
                        {busy ? 'Drafting…' : 'Confirm new draft'}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
