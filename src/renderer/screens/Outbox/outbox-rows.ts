// The Outbox's pure parts: which action a row offers, its status word and
// its words. Every failure verdict arrives pre-computed on the wire
// (`canRetry` / `deliveryUncertain`) — error-copy.ts is main-process code.
import type { OutboxPanelRow } from '@shared/ipc';
import type { StatusTone } from '@shared/web-ui/ui';

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

/** The value a time picker starts at: the next whole hour, at least
 *  30 minutes away, as `datetime-local` wants it (local, no zone). */
export function defaultSendLater(nowMs: number): string {
  const d = new Date(nowMs + 30 * 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "14:00" today, "Thu 09:00" on another day — a send time, short. */
export function whenLabel(ms: number, nowMs: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (d.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
}

/** "Suggested for Thu 14:12" — a time an AI app suggested, local. */
export function suggestedFor(iso: string, nowMs: number): string {
  return `Suggested for ${whenLabel(Date.parse(iso), nowMs)}`;
}

export interface SendPreset {
  key: string;
  label: string;
  /** Epoch ms, local wall time. */
  at: number;
}

/** The Send ▾ choices at `nowMs` (spec 2026-10-21 §4): soon, later today
 *  while it is still ahead, tomorrow, and Monday unless that is tomorrow. */
export function sendPresets(nowMs: number): SendPreset[] {
  const now = new Date(nowMs);
  const inMin = (m: number) =>
    Math.ceil((nowMs + m * 60_000) / 60_000) * 60_000;
  const at = (days: number, hour: number) => {
    const x = new Date(now);
    x.setDate(x.getDate() + days);
    x.setHours(hour, 0, 0, 0);
    return x.getTime();
  };
  const out: SendPreset[] = [
    { key: 'in15', label: 'In 15 minutes', at: inMin(15) },
    { key: 'in60', label: 'In 1 hour', at: inMin(60) },
    { key: 'in180', label: 'In 3 hours', at: inMin(180) },
  ];
  if (now.getHours() < 13)
    out.push({ key: 'afternoon', label: 'This afternoon', at: at(0, 14) });
  if (now.getHours() < 17)
    out.push({ key: 'evening', label: 'This evening', at: at(0, 18) });
  out.push(
    { key: 'tomorrow-am', label: 'Tomorrow morning', at: at(1, 9) },
    { key: 'tomorrow-pm', label: 'Tomorrow afternoon', at: at(1, 14) },
  );
  const toMonday = (8 - now.getDay()) % 7 || 7;
  if (toMonday !== 1)
    out.push({ key: 'monday', label: 'Monday morning', at: at(toMonday, 9) });
  return out;
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
