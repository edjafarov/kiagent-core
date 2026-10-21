// The Outbox's pure parts: which action a row offers, its status word and
// its words. Every failure verdict arrives pre-computed on the wire
// (`canRetry` / `deliveryUncertain`) — error-copy.ts is main-process code.
import type { OutboxPanelRow } from '@shared/ipc';
import type { StatusTone } from '@shared/web-ui/ui';

import { whenLabel } from '@shared/send-presets';

export {
  defaultSendLater,
  sendPresets,
  type SendPreset,
  whenLabel,
} from '@shared/send-presets';

export type RowAction =
  | 'review' // waiting: Review & send + Discard
  | 'retry' // provably-not-sent failure: re-send the SAME row
  | 'redraft' // one-click Draft again
  | 'redraft-guarded' // Draft again behind a confirmation
  | 'none';

export function actionFor(r: OutboxPanelRow): RowAction {
  if (r.status === 'draft') return 'review';
  if (r.status === 'failed') {
    // Re-sending the same row is CAS-gated on its observed status
    // (service.ts confirmRow), so it can never duplicate a send. Re-drafting
    // can. So a failure that PROVES pre-delivery rejection gets Try again,
    // never a fresh draft.
    if (r.canRetry) return 'retry';
    // The message MAY have gone out: a one-click Draft again is exactly the
    // double-send invitation routes.ts and service.ts were written to
    // prevent, so it sits behind a confirmation.
    return r.deliveryUncertain ? 'redraft-guarded' : 'redraft';
  }
  // An expired draft comes back to review as it is (`outbox:reopen`).
  if (r.status === 'expired') return 'retry';
  if (r.status === 'discarded') {
    // Belt-and-suspenders: main never sets `deliveryUncertain` here today;
    // this keeps "no maybe-delivered row gets a one-click re-draft" an
    // invariant of THIS function rather than of the mapper.
    return r.deliveryUncertain ? 'redraft-guarded' : 'redraft';
  }
  // 'sent', 'sending' and 'delivery_unknown' offer nothing. The last is
  // deliberate: the service refuses to re-draft it, and its stored sentence
  // already says to check the Sent folder.
  return 'none';
}

/** The word a history row shows beside its action — none for a `sent`
 *  row Kia sent. A
 *  `tone` word is a `Status` (with its dot); the rest are plain and muted. */
export function statusWord(
  r: OutboxPanelRow,
): { label: string; tone?: StatusTone } | null {
  switch (r.status) {
    case 'sending':
      return { label: 'Sending…', tone: 'work' };
    case 'failed':
      // A failure that may still have gone out says what matters to the
      // user: nobody knows whether it arrived.
      return r.deliveryUncertain
        ? { label: 'Delivery unknown', tone: 'work' }
        : { label: 'Failed', tone: 'err' };
    case 'delivery_unknown':
      return { label: 'Delivery unknown', tone: 'work' };
    case 'discarded':
      return { label: 'Discarded' };
    case 'expired':
      return { label: 'Expired' };
    case 'sent':
      // Sent from the mail app, not from Kia: say so.
      return r.mirror?.sentElsewhere
        ? { label: `Sent from ${r.mirror.provider ?? 'your mail app'}` }
        : null;
    default:
      return null;
  }
}

/** The review's line on where the draft also lives: "In Gmail Drafts", or
 *  why it is not there. Null when the account can't keep drafts. */
export function mirrorLine(r: OutboxPanelRow): string | null {
  const m = r.mirror;
  if (!m || r.status !== 'draft') return null;
  if (m.synced)
    return m.provider ? `In ${m.provider} Drafts` : "In your mail app's Drafts";
  return m.error ? `Not synced: ${m.error}` : null;
}

/** "Scheduled for Tue 21 Oct, 09:00" — a draft's send time, local. */
export function scheduledFor(iso: string): string {
  const when = new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `Scheduled for ${when}`;
}

/** "Suggested for Thu 14:12" — a time an AI app suggested, local. */
export function suggestedFor(iso: string, nowMs: number): string {
  return `Suggested for ${whenLabel(Date.parse(iso), nowMs)}`;
}

/** A row that did not go out reads faint (its mark and words). */
export function isFaint(r: OutboxPanelRow): boolean {
  return r.status === 'discarded' || r.status === 'expired';
}

/** Electron rejects an invoke as `Error invoking remote method '<ch>':
 *  Error: <msg>` — a developer wrapper that must never sit beside main's
 *  shaped sentences. */
export function stripIpcWrapper(message: string): string {
  return message.replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    '',
  );
}

export function quoted(preview: string): string {
  return `“${preview}”`;
}
