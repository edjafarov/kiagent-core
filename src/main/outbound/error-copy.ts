/**
 * One classifier for outbound send failures, used at BOTH ends (spec §2):
 * fail-time — service.ts stores `summary` in row.error (short technical
 * one-liner, never the raw multi-KB API body); render-time — routes re-run
 * it on the stored summary to pick page copy and gate the Try-again button.
 * Summaries are produced by this module, so re-classification is a fixed
 * point: shape(shape(x).summary) preserves kind/canRetry (tested).
 *
 * DESIGN RULE (load-bearing — do not reintroduce per-branch normalization):
 * all classification happens on the single-line projection of the input,
 * computed ONCE at the top of `shapeOutboundError`. Every marker regex and
 * every summary construction reads that same normalized `text`, so pass 1
 * (raw input) and pass 2 (re-shaping the stored summary) always see the
 * same kind of view — a summary can only match what its raw input already
 * matched once flattened. Normalizing per-branch instead (as an earlier
 * version of this module did) lets an embedded newline defeat a marker on
 * pass 1 while the flattened summary satisfies it on pass 2, silently
 * flipping canRetry false→true for a send never proven pre-delivery
 * rejected.
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
// Scoped to the app's own generated reconnect phrases (senders/gmail.ts) —
// a bare `reconnect` would over-match unrelated text that merely contains
// that word (e.g. an SMTP bounce echoing a `reconnect-notify@` address).
const AUTH_MARKERS =
  /reconnect .* in Settings|no Gmail credentials|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i;
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
  // Normalize ONCE — every classifier below reads this same single-line
  // projection (see the module docstring's design rule).
  const text = singleLine((raw ?? '').trim());
  if (!text) {
    return {
      kind: 'unknown',
      summary: 'send failed with no error message',
      message: UNKNOWN_MESSAGE,
      canRetry: false,
    };
  }
  // Matches both the `send failed: <detail>` shape and the bare empty-input
  // placeholder (`send failed with no error message`), so re-shaping either
  // one is a no-op instead of double-prefixing on a second pass. Computed
  // once, up front (same reasoning as `text` above): a summary this module
  // already decided was `unknown` was, by construction, already run past
  // every other classifier on its ORIGINAL (unwrapped) text and rejected —
  // the quota-marker gate below relies on that to stay a fixed point (see
  // its comment). Nothing else in this codebase generates raw error text
  // that starts with `send failed` (only this function's own `unknown`
  // branch does, below) — so in practice `already` only ever fires on a
  // genuine re-shape. If that ever changes, a raw string wearing this
  // prefix by coincidence would be treated as already-shaped too, same as
  // the pre-existing empty-input placeholder case already is.
  const already = /^send failed( with no error message$|: )/.test(text);

  const smtp = SMTP_TRANSIENT.exec(text);
  if (smtp) {
    return {
      kind: 'transient',
      summary: `rate-limited: the mail server deferred the send (SMTP ${smtp[1]}) — nothing was sent`,
      message: BUSY_MESSAGE,
      canRetry: true,
    };
  }
  // A re-shaped `rate-limited:` summary returns early below, verbatim,
  // before `status` is ever read — so there is no re-shape case that needs
  // a status recovered from inside the text body. Do NOT add a fallback
  // that scans the whole string for a parenthesized `(HTTP nnn)` /
  // `(SMTP nnn)`: an unrelated error body can embed that exact substring
  // (e.g. an upstream message quoting a *different* failure's status),
  // which would silently reclassify an `unknown` summary as `transient` on
  // re-shape — flipping canRetry false→true for a send we never proved was
  // rejected pre-delivery. Only the bearerFetch head token format
  // (`${prefix} ${status} ${url} ...`) is trusted.
  //
  // A bare marker with NO head-token status (`status` undefined) keeps the
  // old behavior — unanchored marker words alone still mean transient. But
  // when a head-token status IS present, it must be '403' or '429' to let
  // QUOTA_MARKERS drive a transient classification: a marker word riding
  // along in a 5xx body (a genuine server-side failure, not a proven quota
  // rejection) must not be waved through as retryable just because it also
  // happens to mention a quota-shaped phrase. `!already` guards this: once
  // a marker+disqualifying-status body has been rejected to `unknown` and
  // wrapped in the `send failed: ` prefix, that prefix pushes the original
  // head token out of the anchored position `status` reads — without this
  // guard, the SAME marker word (unanchored, so still visible post-wrap)
  // would satisfy the condition again on re-shape with `status` now
  // undefined, flipping unknown/false → transient/true. Gating on `already`
  // instead of on `status` keeps this a fixed point: a body this module has
  // already rejected once stays rejected, no matter what the wrapper text
  // does to token positions.
  const status = HTTP_STATUS.exec(text)?.[1];
  const statusAllowsQuota =
    status === undefined || status === '403' || status === '429';
  if (
    !already &&
    ((QUOTA_MARKERS.test(text) && statusAllowsQuota) || status === '429')
  ) {
    if (/^rate-limited:/.test(text)) {
      return {
        kind: 'transient',
        summary: truncate(text, 200),
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
    const summary = truncate(text, 200);
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
      summary: truncate(text, 200),
      message:
        'This account type cannot send messages yet — ask your assistant to use a supported account.',
      canRetry: false,
    };
  }
  return {
    kind: 'unknown',
    summary: already
      ? truncate(text, 220)
      : `send failed: ${truncate(text, 200)}`,
    message: UNKNOWN_MESSAGE,
    canRetry: false,
  };
}
