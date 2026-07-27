/**
 * One classifier for outbound send failures, used at BOTH ends (spec §2):
 * fail-time — service.ts stores `summary` in row.error (short technical
 * one-liner, never the raw multi-KB API body); render-time — routes re-run
 * it on the stored summary to pick page copy and gate the Try-again button.
 * Summaries are produced by this module, so re-classification is a fixed
 * point: shape(shape(x).summary) preserves kind/canRetry (tested).
 */
export type OutboundErrorKind =
  | 'transient'
  | 'auth'
  | 'unsupported'
  | 'unknown';

export interface ShapedOutboundError {
  kind: OutboundErrorKind;
  /** Short technical one-liner — stored in row.error, shown in <details>. */
  summary: string;
  /** Human sentence for the confirm/result page. */
  message: string;
  /** Try-again eligible: only failure classes that PROVE the message was
   *  never accepted (quota/rate rejections; auth rejections happen
   *  pre-send). */
  canRetry: boolean;
}

const QUOTA_MARKERS =
  /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|^rate-limited:/i;
// bearerFetch failure format is `${errorPrefix} ${status} ${url} ${body}`.
const HTTP_STATUS = /^\S+ (\d{3}) /;
const SMTP_TRANSIENT = /^smtp transient (\d{3}):/;
const AUTH_MARKERS =
  /reconnect|no Gmail credentials|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i;
const UNSUPPORTED = /is not supported yet/;

const BUSY_MESSAGE =
  'The mail service is busy right now — this message was NOT sent. ' +
  'Try again in a moment.';
const UNKNOWN_MESSAGE =
  'Something went wrong and the app could not confirm delivery. If this ' +
  'was a network problem the message MAY still have been sent — check ' +
  'your Sent folder before re-sending.';

function singleLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

export function shapeOutboundError(raw: string): ShapedOutboundError {
  const text = (raw ?? '').trim();
  if (!text) {
    return {
      kind: 'unknown',
      summary: 'send failed with no error message',
      message: UNKNOWN_MESSAGE,
      canRetry: false,
    };
  }

  const smtp = SMTP_TRANSIENT.exec(text);
  if (smtp) {
    return {
      kind: 'transient',
      summary: `rate-limited: the mail server deferred the send (SMTP ${smtp[1]}) — nothing was sent`,
      message: BUSY_MESSAGE,
      canRetry: true,
    };
  }
  // A re-shaped summary starts with `rate-limited:` and carries its own
  // `(SMTP nnn)` / `(HTTP nnn)` — preserve that status on re-shape.
  const status =
    HTTP_STATUS.exec(text)?.[1] ?? /\((?:HTTP|SMTP) (\d{3})\)/.exec(text)?.[1];
  if (QUOTA_MARKERS.test(text) || status === '429') {
    if (/^rate-limited:/.test(text)) {
      return {
        kind: 'transient',
        summary: text,
        message: BUSY_MESSAGE,
        canRetry: true,
      };
    }
    return {
      kind: 'transient',
      summary: `rate-limited: the mail service rejected the send (HTTP ${status ?? '403'}) — nothing was sent`,
      message: BUSY_MESSAGE,
      canRetry: true,
    };
  }
  if (status === '401' || AUTH_MARKERS.test(text)) {
    const summary = truncate(singleLine(text), 200);
    return {
      kind: 'auth',
      summary,
      message: `${summary}. Then tap Try again.`,
      canRetry: true,
    };
  }
  if (UNSUPPORTED.test(text)) {
    return {
      kind: 'unsupported',
      summary: truncate(singleLine(text), 200),
      message:
        'This account type cannot send messages yet — ask your assistant to use a supported account.',
      canRetry: false,
    };
  }
  const already = /^send failed: /.test(text);
  return {
    kind: 'unknown',
    summary: already ? text : `send failed: ${truncate(singleLine(text), 200)}`,
    message: UNKNOWN_MESSAGE,
    canRetry: false,
  };
}
