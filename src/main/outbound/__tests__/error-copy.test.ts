import { shapeOutboundError } from '../error-copy';

const SMOKE_403 =
  'gmail 403 https://gmail.googleapis.com/gmail/v1/users/me/messages/send ' +
  '{ "error": { "code": 403, "message": "Quota exceeded for quota metric ' +
  "'Queries' and limit 'Previous quota: Units per minute per user'\", " +
  '"errors": [ { "reason": "rateLimitExceeded", "domain": "usageLimits" } ], ' +
  '"status": "PERMISSION_DENIED" } }';

// A genuine `unknown` failure whose body happens to quote a DIFFERENT
// failure's status in parens — must never let re-shaping promote it to
// transient (that would flip canRetry false→true for a send never proven
// pre-delivery-rejected).
const EMBEDDED_STATUS_DECOY =
  'gmail 500 https://x {"error":{"message":"upstream returned (HTTP 429) after retry"}}';
// Contains the substring `reconnect` but not one of the app's own
// generated reconnect phrases — must not be classified as auth.
const UNRELATED_RECONNECT_WORD =
  'smtp permanent 550: mailbox unavailable, contact reconnect-notify@vendor.com for help';
// An embedded newline splits the bearerFetch head token from its status on
// the RAW input; once flattened to a single line by the classifier, "429"
// becomes the second token — must classify as transient/true on BOTH the
// raw pass and the re-shaped pass (no unsupported/false → transient/true
// flip from per-branch normalization).
const REPRO_MULTILINE_STATUS_TOKEN =
  'gmail\n429 https://x is not supported yet';
// An embedded newline splits the auth reconnect phrase across two lines on
// the RAW input; once flattened, the full `reconnect … in Settings` phrase
// is present — must classify as auth/true on BOTH passes (no
// unknown/false → auth/true flip).
const REPRO_MULTILINE_AUTH_PHRASE = 'boom reconnect x\nin Settings';
// A stack-trace-shaped raw with "429" embedded deep in the body, NOT at
// the trusted bearerFetch head-token position — must stay unknown/false
// on both passes (the anchored HTTP_STATUS regex must not do a raw
// substring search).
const STACK_TRACE_WITH_EMBEDDED_429 =
  'Error: x\n    at foo (bar.ts:1:2)\n    429';
// `rateLimitExceeded` on its own line, unrelated to the head-token
// position — QUOTA_MARKERS' bare-word alternative is unanchored so this
// was already immune, but it belongs in the corpus as a regression guard.
const QUOTA_MARKER_ON_OWN_LINE =
  'some upstream error\nrateLimitExceeded\nplease retry';
// A genuine 5xx (server-side, NOT a proven quota rejection) whose body
// happens to also mention a quota-shaped marker word — the bearerFetch
// head-token status (503) disqualifies the QUOTA_MARKERS branch, so this
// must stay unknown/false on BOTH the raw pass and the re-shaped pass (the
// `already` guard keeps the disqualification a fixed point even though
// re-shaping's `send failed: ` prefix pushes "503" out of the anchored
// head-token position that `status` reads).
const QUOTA_MARKER_WITH_DISQUALIFYING_STATUS =
  'gmail 503 https://x internal error quotaExceeded backend';

describe('shapeOutboundError', () => {
  it('classifies the smoke-test quota 403 as transient/retryable', () => {
    const s = shapeOutboundError(SMOKE_403);
    expect(s.kind).toBe('transient');
    expect(s.canRetry).toBe(true);
    expect(s.summary).toBe(
      'rate-limited: the mail service rejected the send (HTTP 403) — nothing was sent',
    );
    expect(s.message).toMatch(/NOT sent/);
    expect(s.summary.length).toBeLessThan(120); // never the raw blob
  });
  it('classifies bearerFetch 429 as transient', () => {
    const s = shapeOutboundError('gmail 429 https://x {"error":{}}');
    expect(s.kind).toBe('transient');
    expect(s.summary).toContain('HTTP 429');
  });
  it('classifies the smtp transient marker', () => {
    const s = shapeOutboundError('smtp transient 451: Data command failed');
    expect(s.kind).toBe('transient');
    expect(s.canRetry).toBe(true);
    expect(s.summary).toBe(
      'rate-limited: the mail server deferred the send (SMTP 451) — nothing was sent',
    );
  });
  it('classifies reconnect copy as auth, retryable', () => {
    const raw =
      'this Gmail account was connected before sending existed — reconnect a@b.c in Settings to grant send permission';
    const s = shapeOutboundError(raw);
    expect(s.kind).toBe('auth');
    expect(s.canRetry).toBe(true);
    expect(s.summary).toBe(raw);
    expect(s.message).toMatch(/Try again/);
  });
  it('classifies a gmail 401 as auth', () => {
    expect(shapeOutboundError('gmail 401 https://x token expired').kind).toBe(
      'auth',
    );
  });
  it('classifies unsupported-source copy, not retryable', () => {
    const s = shapeOutboundError(
      "sending from 'slack' accounts is not supported yet — supported: gmail, imap",
    );
    expect(s.kind).toBe('unsupported');
    expect(s.canRetry).toBe(false);
  });
  it('unknown: truncated single-line summary, check-Sent copy, not retryable', () => {
    const s = shapeOutboundError(`boom\n${'x'.repeat(500)}`);
    expect(s.kind).toBe('unknown');
    expect(s.canRetry).toBe(false);
    expect(s.summary.startsWith('send failed: boom')).toBe(true);
    expect(s.summary.length).toBeLessThanOrEqual(220);
    expect(s.summary).not.toContain('\n');
    expect(s.message).toMatch(/Sent folder/);
  });
  it('empty input gets the placeholder summary', () => {
    expect(shapeOutboundError('').summary).toBe(
      'send failed with no error message',
    );
    expect(shapeOutboundError('').canRetry).toBe(false);
  });
  it('is a fixed point: re-shaping any summary preserves kind and canRetry', () => {
    for (const raw of [
      SMOKE_403,
      'gmail 429 https://x {}',
      'smtp transient 421: greeting',
      'no Gmail credentials — reconnect a@b.c',
      "sending from 'x' accounts is not supported yet — supported: gmail",
      'totally novel failure',
      '',
      EMBEDDED_STATUS_DECOY,
      UNRELATED_RECONNECT_WORD,
      REPRO_MULTILINE_STATUS_TOKEN,
      REPRO_MULTILINE_AUTH_PHRASE,
      STACK_TRACE_WITH_EMBEDDED_429,
      QUOTA_MARKER_ON_OWN_LINE,
      QUOTA_MARKER_WITH_DISQUALIFYING_STATUS,
    ]) {
      const first = shapeOutboundError(raw);
      const second = shapeOutboundError(first.summary);
      expect(second.kind).toBe(first.kind);
      expect(second.canRetry).toBe(first.canRetry);
    }
  });
  it('a marker split across lines by an embedded newline classifies identically on both passes (no false→true flip)', () => {
    for (const raw of [
      REPRO_MULTILINE_STATUS_TOKEN,
      REPRO_MULTILINE_AUTH_PHRASE,
    ]) {
      const first = shapeOutboundError(raw);
      const second = shapeOutboundError(first.summary);
      expect(second.kind).toBe(first.kind);
      expect(second.canRetry).toBe(first.canRetry);
    }
    // Pinned exact values (not just cross-pass equality): once flattened,
    // the marker IS present on pass 1 too — that's the fix, not a new bug.
    expect(shapeOutboundError(REPRO_MULTILINE_STATUS_TOKEN).kind).toBe(
      'transient',
    );
    expect(shapeOutboundError(REPRO_MULTILINE_STATUS_TOKEN).canRetry).toBe(
      true,
    );
    expect(shapeOutboundError(REPRO_MULTILINE_AUTH_PHRASE).kind).toBe('auth');
    expect(shapeOutboundError(REPRO_MULTILINE_AUTH_PHRASE).canRetry).toBe(true);
  });
  it('never lets an unrelated embedded "(HTTP nnn)" promote unknown to transient on re-shape', () => {
    const first = shapeOutboundError(EMBEDDED_STATUS_DECOY);
    expect(first.kind).toBe('unknown');
    expect(first.canRetry).toBe(false);
    const second = shapeOutboundError(first.summary);
    expect(second.kind).toBe('unknown');
    expect(second.canRetry).toBe(false);
  });
  it('a quota-shaped marker word riding along a disqualifying (non-403/429) head-token status stays unknown/false on BOTH passes', () => {
    const first = shapeOutboundError(QUOTA_MARKER_WITH_DISQUALIFYING_STATUS);
    expect(first.kind).toBe('unknown');
    expect(first.canRetry).toBe(false);
    const second = shapeOutboundError(first.summary);
    expect(second.kind).toBe('unknown');
    expect(second.canRetry).toBe(false);
  });
  it('the verbatim smoke-403 (head-token status 403) still classifies transient/retryable', () => {
    const s = shapeOutboundError(SMOKE_403);
    expect(s.kind).toBe('transient');
    expect(s.canRetry).toBe(true);
  });
  it('a bare quota marker with no head-token status at all still classifies transient/retryable', () => {
    const s = shapeOutboundError('rateLimitExceeded during send');
    expect(s.kind).toBe('transient');
    expect(s.canRetry).toBe(true);
  });
  it('does not classify an unrelated "reconnect" substring as auth', () => {
    const s = shapeOutboundError(UNRELATED_RECONNECT_WORD);
    expect(s.kind).toBe('unknown');
    expect(s.canRetry).toBe(false);
  });
  it('an extension-sender timeout stays unknown/not-retryable — delivery is unproven', () => {
    // The host's own timeout string for an out-of-process extension Sender.
    // Deliberately ambiguous: the extension may well have completed the send
    // before the host gave up, so this must NEVER offer Try again.
    const s = shapeOutboundError(
      "extension sender 'slack' timed out after 60s",
    );
    expect(s.kind).toBe('unknown');
    expect(s.canRetry).toBe(false);
  });

  it('treats the empty-input placeholder as already-shaped on re-shape', () => {
    const first = shapeOutboundError('');
    const second = shapeOutboundError(first.summary);
    expect(second.summary).toBe('send failed with no error message');
    expect(second.kind).toBe('unknown');
    expect(second.canRetry).toBe(false);
  });
});
