import { shapeOutboundError } from '../error-copy';

const SMOKE_403 =
  'gmail 403 https://gmail.googleapis.com/gmail/v1/users/me/messages/send ' +
  '{ "error": { "code": 403, "message": "Quota exceeded for quota metric ' +
  "'Queries' and limit 'Previous quota: Units per minute per user'\", " +
  '"errors": [ { "reason": "rateLimitExceeded", "domain": "usageLimits" } ], ' +
  '"status": "PERMISSION_DENIED" } }';

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
    ]) {
      const first = shapeOutboundError(raw);
      const second = shapeOutboundError(first.summary);
      expect(second.kind).toBe(first.kind);
      expect(second.canRetry).toBe(first.canRetry);
    }
  });
});
