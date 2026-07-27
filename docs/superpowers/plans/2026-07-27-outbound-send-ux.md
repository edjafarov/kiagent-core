# Outbound Send UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safe automatic retry for provably-not-sent send failures, a human error taxonomy, Try-again from the failure page, and a mobile-first design pass with sending/sent/failed states on the outbox confirm pages.

**Architecture:** `bearerFetch` gains a retry-predicate override so gmail send can retry ONLY request-rejections (429 / quota-403); SMTP gets the same policy via a tiny shared helper. One classifier (`error-copy.ts`) shapes raw errors into short summaries at fail-time and page copy + Try-again gating at render-time. `confirmByToken` accepts retryable `failed` rows through the same CAS gate. Pages stay server-rendered `sh-min` shell + a ~40-line inline script that flips the page into a Sending state while the native form POST proceeds.

**Tech Stack:** TypeScript, Node http, jest. No new npm dependencies (icons are inline SVG, script is inline JS).

**Spec:** `docs/superpowers/specs/2026-07-27-outbound-send-ux-design.md`

## Global Constraints

- Repo: `/Users/edjafarov/work/kiagent-core`, branch `dev` (work directly on it — user-approved). Repo is PUBLIC: no secrets, tokens, private URLs, or internal infra details in code, comments, or tests.
- Commits: conventional messages, NO `Co-Authored-By` trailer, no promo lines, never `--no-verify`, never amend/rebase/reset.
- The safety rule (spec §1): a send may be auto-retried ONLY when the failure proves the request was rejected (HTTP 429; 403 with Google quota markers; SMTP 421/450/451/452). Timeouts, network errors, and 5xx are NEVER auto-retried.
- Backoff everywhere: `Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250`; 4 total attempts.
- Every existing `bearerFetch` caller must remain byte-for-byte behavior-identical when the new opts are absent.
- Confirm-token semantics, tunnel allowlist, and `/outbox/api` exposure are UNCHANGED.
- Copy rules: quota/SMTP-transient failures must say the message "was NOT sent"; `unknown` failures must say it "MAY still have been sent — check your Sent folder". Never render a raw multi-KB error body anywhere.
- Run targeted jest per task (`npx jest src/main/<path>`); the FULL suite (`npx jest`) runs once at the end (known wandering single-suite load-flake: re-run once if a suite fails to load with 0 failing tests).

---

### Task 1: bearerFetch retry-predicate + net-error opt-out

**Files:**
- Modify: `src/main/sources/gmail/bearer-fetch.ts`
- Test: `src/main/sources/gmail/__tests__/bearer-fetch.test.ts` (extend; follow the file's existing fetch-mock/timer harness exactly)

**Interfaces:**
- Consumes: nothing new.
- Produces: `BearerFetchOpts.retryOn?: (status: number, body: string) => boolean` and `BearerFetchOpts.retryNetErrors?: boolean` (default `true`). Task 3 depends on both.

- [ ] **Step 1: Write failing tests** (extend the existing test file, reusing its mock-fetch helpers/patterns):

```ts
// 1. retryOn override wins over the default classifier: a 500 (default-retryable)
//    with retryOn: () => false throws immediately — exactly 1 fetch call.
// 2. retryOn can retry what the default refuses: first response 403 with body
//    'rateLimitExceeded', retryOn: (s, b) => s === 403 && /rateLimitExceeded/.test(b),
//    second response 200 {ok:1} → resolves, exactly 2 fetch calls.
// 3. retryNetErrors: false → a rejected fetch (new TypeError('fetch failed'))
//    throws immediately, exactly 1 fetch call.
// 4. default path unchanged: same rejected fetch WITHOUT retryNetErrors retries
//    (assert ≥2 calls) — guards the default.
```

- [ ] **Step 2: Run to verify they fail**: `npx jest src/main/sources/gmail/__tests__/bearer-fetch.test.ts`

- [ ] **Step 3: Implement.** In `BearerFetchOpts` add (after `maxAttempts`):

```ts
  /** Override the default HTTP-failure retry classifier
   *  (isRetryableGoogleFailure). Non-idempotent calls pass a stricter
   *  predicate that only matches proven request-rejections. */
  retryOn?: (status: number, body: string) => boolean;
  /** Retry network errors / timeouts (default true). Pass false for
   *  non-idempotent calls — a timed-out request may have been processed. */
  retryNetErrors?: boolean;
```

In the net-error branch, insert the opt-out between the abort rethrow and the retry check:

```ts
    if (netError) {
      if (opts.signal?.aborted) throw netError;
      if (opts.retryNetErrors === false) throw netError;
      if (attempt < attemptCap) {
```

In the HTTP-failure branch, swap the classifier call:

```ts
    const { status, body, retryAfter } = httpFail!;
    const retryable = (opts.retryOn ?? isRetryableGoogleFailure)(status, body);
    if (attempt < attemptCap && retryable) {
```

- [ ] **Step 4: Run tests to verify pass**: same command.
- [ ] **Step 5: Commit**: `feat(gmail): bearerFetch retryOn predicate + retryNetErrors opt-out`

---

### Task 2: error taxonomy module

**Files:**
- Create: `src/main/outbound/error-copy.ts`
- Test: `src/main/outbound/__tests__/error-copy.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `shapeOutboundError(raw: string): ShapedOutboundError` with `{ kind: 'transient'|'auth'|'unsupported'|'unknown'; summary: string; message: string; canRetry: boolean }`. Tasks 5 and 6 import it from `../error-copy` / `./error-copy`.

- [ ] **Step 1: Write failing tests** covering the classification matrix:

```ts
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
    expect(shapeOutboundError('gmail 401 https://x token expired').kind).toBe('auth');
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
    expect(shapeOutboundError('').summary).toBe('send failed with no error message');
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
```

- [ ] **Step 2: Run to verify fail**: `npx jest src/main/outbound/__tests__/error-copy.test.ts`

- [ ] **Step 3: Implement** `src/main/outbound/error-copy.ts`:

```ts
/**
 * One classifier for outbound send failures, used at BOTH ends (spec §2):
 * fail-time — service.ts stores `summary` in row.error (short technical
 * one-liner, never the raw multi-KB API body); render-time — routes re-run
 * it on the stored summary to pick page copy and gate the Try-again button.
 * Summaries are produced by this module, so re-classification is a fixed
 * point: shape(shape(x).summary) preserves kind/canRetry (tested).
 */
export type OutboundErrorKind = 'transient' | 'auth' | 'unsupported' | 'unknown';

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
  const status = HTTP_STATUS.exec(text)?.[1] ?? /\((?:HTTP|SMTP) (\d{3})\)/.exec(text)?.[1];
  if (QUOTA_MARKERS.test(text) || status === '429') {
    if (/^rate-limited:/.test(text)) {
      return { kind: 'transient', summary: text, message: BUSY_MESSAGE, canRetry: true };
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
```

Note the auth-summary fixed point: an auth summary is the truncated raw
reconnect copy, which still matches `AUTH_MARKERS` on re-shape (the word
`reconnect` survives truncation because sender copy leads with it early);
the appended `. Then tap Try again.` lives only in `message`, never in
`summary`. If a test shows otherwise, fix the summary, not the test.

- [ ] **Step 4: Run tests to verify pass.**
- [ ] **Step 5: Commit**: `feat(outbound): error taxonomy — shapeOutboundError classifier + copy`

---

### Task 3: gmail send-safe retry wiring

**Files:**
- Modify: `src/main/sources/gmail/gmail-api.ts` (sendGmailMessage + new exports)
- Test: `src/main/sources/gmail/__tests__/gmail-api.test.ts` (extend, following its existing harness)

**Interfaces:**
- Consumes: Task 1's `retryOn` / `retryNetErrors`.
- Produces: `isSendSafeRetry(status, body)` (exported for tests).

- [ ] **Step 1: Write failing tests**:

```ts
// isSendSafeRetry matrix:
//   (429, '') → true
//   (403, '<the verbatim smoke-test body from Task 2's SMOKE_403 payload>') → true
//   (403, '{"error":{"status":"PERMISSION_DENIED","message":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}}') → false
//   (500, 'rateLimitExceeded') → false  (5xx is ambiguous — may have delivered)
//   (200, ...) n/a; (401, 'rateLimitExceeded') → false
// sendGmailMessage behavior (mock fetch, following the file's harness):
//   - first response 403 quota body, second 200 {id,threadId} → resolves; 2 calls.
//   - four 403 quota responses → throws; exactly 4 calls (attempt cap).
//   - fetch rejection (network) → throws immediately; exactly 1 call.
```

- [ ] **Step 2: Run to verify fail**: `npx jest src/main/sources/gmail/__tests__/gmail-api.test.ts`

- [ ] **Step 3: Implement.** Replace the `sendGmailMessage` doc comment and opts:

```ts
const SEND_RETRY_MARKERS =
  /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i;

/** Send-safe retry predicate: ONLY proven request-rejections. A 429 or a
 *  quota-403 means Google refused the request — nothing was sent, so a
 *  retry can never double-deliver. Everything else (5xx, other 403s,
 *  network errors, timeouts) is ambiguous and must fail fast. */
export function isSendSafeRetry(status: number, body: string): boolean {
  return status === 429 || (status === 403 && SEND_RETRY_MARKERS.test(body));
}

/** POST users/me/messages/send. `raw` is the full RFC822 message; `threadId`
 *  (the Gmail API thread id, NOT an RFC Message-ID) threads the reply.
 *  Retried ONLY via isSendSafeRetry (quota/rate rejections, with backoff +
 *  Retry-After via bearerFetch); never on ambiguous failures — a retried
 *  timeout/5xx could double-deliver. 30s per-attempt timeout: a hang must
 *  not pin the confirm page for bearerFetch's default 90s. */
export function sendGmailMessage(
  auth: { credentials(): Promise<Credentials | null> },
  raw: Buffer,
  threadId?: string,
): Promise<GmailSendResult> {
  return bearerFetch<GmailSendResult>(
    `${BASE}/messages/send`,
    () => tokenFor(auth),
    {
      errorPrefix: 'gmail',
      logTag: '[gmail]',
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        raw: raw.toString('base64url'),
        ...(threadId ? { threadId } : {}),
      }),
      maxAttempts: 4,
      timeoutMs: 30_000,
      retryNetErrors: false,
      retryOn: isSendSafeRetry,
    },
  );
}
```

- [ ] **Step 4: Run tests to verify pass.** Also run Task 1's test file (same module surface).
- [ ] **Step 5: Commit**: `feat(gmail): retry send on proven request-rejections only (429/quota-403)`

---

### Task 4: SMTP transient retry

**Files:**
- Create: `src/main/outbound/senders/retry.ts`
- Modify: `src/main/outbound/senders/smtp.ts`
- Test: `src/main/outbound/senders/__tests__/retry.test.ts` (new), `src/main/outbound/senders/__tests__/smtp.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `withTransientRetry<T>(fn, opts)`; the `smtp transient <code>:` error marker consumed by Task 2's classifier (already merged — keep the marker format EXACT).

- [ ] **Step 1: Write failing tests**:

```ts
// retry.test.ts (inject sleep: async () => {} — no fake timers needed):
//   - transient error twice then success → resolves; fn called 3×; sleep 2×.
//   - non-transient error → throws immediately; fn called 1×; sleep 0×.
//   - always-transient → throws after 4 calls (default cap).
//   - maxAttempts: 2 → 2 calls.
// smtp.test.ts additions (reuse the existing createTransport test seam):
//   - sendMail rejects once with err.responseCode = 451 then resolves →
//     send succeeds; sendMail called 2×.
//   - sendMail always rejects with responseCode 451 → send() rejects with
//     message matching /^smtp transient 451: /.
//   - sendMail rejects with responseCode 550 → rejects once, message does
//     NOT start with 'smtp transient'; sendMail called 1×.
// The retry must inject a no-op sleep in tests: thread a `sleep` seam
// through createSmtpSender deps (default undefined → real sleep).
```

- [ ] **Step 2: Run to verify fail**: `npx jest src/main/outbound/senders/__tests__/`

- [ ] **Step 3: Implement** `retry.ts`:

```ts
/**
 * Minimal transient-failure retry for non-HTTP senders (SMTP). Mirrors
 * bearerFetch's backoff (1s/2s/4s + jitter, spec §1) without its HTTP
 * machinery. `isTransient` must ONLY match failures that prove the
 * message was never accepted — anything ambiguous propagates on the
 * first throw.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: {
    isTransient: (err: unknown) => boolean;
    /** Total attempts including the first; default 4. */
    maxAttempts?: number;
    /** Test seam; defaults to real setTimeout sleep. */
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxAttempts - 1 || !opts.isTransient(err)) throw err;
      await sleep(Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250);
    }
  }
}
```

In `smtp.ts`, add near `bareAddress`:

```ts
// SMTP transient pre-acceptance rejections (RFC 5321 4yz): the server
// refused to take the message NOW but a retry may succeed. Connection
// and timeout errors are deliberately absent — ambiguous once DATA has
// started (spec §1).
const TRANSIENT_SMTP_CODES = new Set([421, 450, 451, 452]);

function transientSmtpCode(err: unknown): number | null {
  const code = (err as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === 'number' && TRANSIENT_SMTP_CODES.has(code)
    ? code
    : null;
}
```

Add `sleep?: (ms: number) => Promise<void>` to `createSmtpSender` deps (test seam, pass-through to `withTransientRetry`). Replace the bare `await transport.sendMail({...})` with:

```ts
      try {
        await withTransientRetry(
          () =>
            transport.sendMail({
              envelope: {
                from: fromAddress,
                to: [...to, ...(cc ?? [])].map(bareAddress),
              },
              raw,
            }),
          { isTransient: (err) => transientSmtpCode(err) !== null, sleep: deps.sleep },
        );
      } catch (err) {
        const code = transientSmtpCode(err);
        // Label exhausted-transient failures so the error-copy classifier
        // (and the Try-again gate) can recognize a provably-unsent failure;
        // raw nodemailer messages are not reliably regexable.
        if (code !== null) {
          throw new Error(
            `smtp transient ${code}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        throw err;
      }
```

(`import { withTransientRetry } from './retry';` at top.) The Sent-append block below stays untouched.

- [ ] **Step 4: Run tests to verify pass.**
- [ ] **Step 5: Commit**: `feat(outbound): retry SMTP transient (4yz) rejections with backoff`

---

### Task 5: service — store summaries, allow retryable failed→sending

**Files:**
- Modify: `src/main/outbound/service.ts` (the `fail` closure and the status gate in `confirmByToken`)
- Test: `src/main/outbound/__tests__/service.test.ts` (extend, using its existing fixture/store harness)

**Interfaces:**
- Consumes: Task 2's `shapeOutboundError`.
- Produces: `confirmByToken` now re-sends retryable `failed` rows; `row.error` is always a shaped summary. Task 6's routes rely on both.

- [ ] **Step 1: Write failing tests** (extend service.test.ts with its existing helpers):

```ts
// 1. fail() stores the SHAPED summary: make the sender throw the verbatim
//    SMOKE_403 payload (import/duplicate from error-copy.test.ts) → after
//    confirmByToken, row.error === 'rate-limited: the mail service rejected
//    the send (HTTP 403) — nothing was sent' (NOT the raw blob).
// 2. Retryable failed row re-confirms: drive a draft to 'failed' with a
//    quota error (sender throws SMOKE_403), then make the sender succeed and
//    call confirmByToken with the SAME token → kind 'sent', row.status 'sent'.
// 3. Permanent failed row stays terminal: drive to 'failed' with
//    'completely novel explosion' → second confirmByToken returns
//    kind 'already' and the row stays 'failed'; sender NOT called again.
// 4. CAS uses the observed status: with the row in 'failed' (retryable),
//    stub store.outbox.transition to record its `from` argument — the call
//    from confirmByToken must be exactly ['failed'] (never ['draft','failed']).
```

- [ ] **Step 2: Run to verify fail**: `npx jest src/main/outbound/__tests__/service.test.ts`

- [ ] **Step 3: Implement.** Import `{ shapeOutboundError }` from `./error-copy`. In the `fail` closure replace the errMsg line:

```ts
        // Store the classifier's short summary, never the raw error — the
        // page, list_outbox, and logs all read this column, and render-time
        // re-classification of the summary gates the Try-again button
        // (fixed-point property tested in error-copy.test.ts).
        const errMsg = shapeOutboundError(message).summary;
```

In `confirmByToken`, replace the `row.status !== 'draft'` gate and the CAS call:

```ts
      if (row.status !== 'draft') {
        // A failed row may be re-confirmed (Try again, spec §3) ONLY when
        // its stored error classifies as provably-not-sent — ambiguous
        // failures stay terminal so a duplicate can never be user-invited.
        const retryableFailed =
          row.status === 'failed' &&
          shapeOutboundError(row.error ?? '').canRetry;
        if (!retryableFailed) return { kind: 'already', row };
      }

      // The atomicity primitive (spec's CAS gate): only the caller that wins
      // this UPDATE proceeds to send. The from-state is the OBSERVED status
      // — never the union ['draft','failed'] — so a confirm that read
      // 'draft' can't steal a row that concurrently became 'failed' and
      // bypass the canRetry gate above. A losing concurrent confirm re-reads
      // the row (now owned by the winner) and reports 'already' — it never
      // reaches the Sender.
      const moved = await deps.store.outbox.transition(
        row.id,
        [row.status],
        'sending',
      );
```

(The existing `if (!moved) { … 'already' }` block stays as-is.)

- [ ] **Step 4: Run tests to verify pass** (service + error-copy files).
- [ ] **Step 5: Commit**: `feat(outbound): shaped error summaries + Try-again re-confirm for provably-unsent failures`

---

### Task 6: confirm pages design pass + routes wiring

**Files:**
- Modify: `src/main/outbound/pages.ts` (rewrite the render functions; keep the css()/loadShellCss plumbing untouched)
- Modify: `src/main/outbound/routes.ts` (gonePage/postConfirm/invalid/500 pages)
- Test: `src/main/outbound/__tests__/pages.test.ts` (new)

**Interfaces:**
- Consumes: `shapeOutboundError` (Task 2); shipped `resultPage`/`linkPage`/`reviewPage` call sites in routes.ts.
- Produces: `pages.ts` exports `reviewPage(row, p)`, `linkPage(row, p)`, `failedPage(row, p: { shaped: ShapedOutboundError; confirmPath: string })`, `resultPage(title, message, opts?: { icon?: OutboxIcon; detail?: string; footNote?: string })` with `type OutboxIcon = 'success'|'warn'|'error'|'info'`.

- [ ] **Step 1: Write failing tests** (`pages.test.ts`; pages render with empty CSS under jest if loadShellCss resolves — assert on markup, not styles):

```ts
// reviewPage: contains recipientDisplay, subject, body text, a form with
//   method="POST" action=confirmPath and id="ob-send", a button with
//   id="ob-send-btn" and classes btn primary ob-btn, a cancel form to
//   cancelPath, a div id="ob-status", and the inline <script>. Body/subject
//   containing `<script>` is escaped (esc()).
// linkPage: recipient + send form + script; NO body preview.
// failedPage retryable (shaped from 'rate-limited: … (HTTP 403) …'):
//   title 'Not sent', the human message, a Try again form POSTing
//   confirmPath, <details> containing the summary, warn icon svg present.
// failedPage permanent (shaped from 'send failed: boom'): NO form, NO
//   'Try again', check-Sent copy present, error icon present.
// resultPage with icon 'success' and footNote: renders svg + footNote text.
// resultPage back-compat: resultPage('T', 'M') (no opts) still renders.
```

- [ ] **Step 2: Run to verify fail**: `npx jest src/main/outbound/__tests__/pages.test.ts`

- [ ] **Step 3: Implement pages.ts.** Keep the header comment, `css()` plumbing, and `recipientBlock` concept; replace inline styles with classes. Add after the `css()` helper:

```ts
export type OutboxIcon = 'success' | 'warn' | 'error' | 'info';

// Local status colors: tokens.css is a single light palette with no
// success/warn entries (see spec §4) — these stay scoped to outbox pages.
const OUTBOX_CSS = `
.ob { display: flex; flex-direction: column; gap: 14px; }
.sh-min__card { max-width: 520px; width: 100%; }
.ob-to-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.06em; }
.ob-to-name { font-size: 17px; font-weight: 600; overflow-wrap: anywhere; }
.ob-to-list { font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
.ob-subject { font-size: 15px; font-weight: 600; }
.ob-body { white-space: pre-wrap; font-family: inherit; font-size: 14px; line-height: 1.55;
  color: var(--text-primary); background: var(--bg-muted);
  border: 1px solid var(--border-subtle); border-radius: 8px;
  padding: 12px 14px; max-height: 50vh; overflow: auto; margin: 0; }
.ob-actions { display: flex; flex-direction: column; gap: 10px;
  position: sticky; bottom: 0; background: var(--bg-canvas); padding: 10px 0 2px; }
.ob-actions form { margin: 0; }
.ob-btn { height: 48px; width: 100%; font-size: 16px; border-radius: 10px; }
.ob-btn-secondary { height: 44px; width: 100%; font-size: 15px; border-radius: 10px; }
.ob-status { min-height: 20px; display: flex; gap: 8px; align-items: center;
  justify-content: center; font-size: 13px; color: var(--text-secondary); }
.ob-icon { width: 44px; height: 44px; }
.ob-msg { font-size: 14px; line-height: 1.6; color: var(--text-primary); margin: 0; }
.ob-note { font-size: 13px; color: var(--text-secondary); margin: 0; }
.ob-detail { font-size: 12px; color: var(--text-secondary); }
.ob-detail summary { cursor: pointer; }
.ob-detail pre { white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: var(--font-mono); font-size: 11px; background: var(--bg-muted);
  border: 1px solid var(--border-subtle); border-radius: 6px;
  padding: 8px 10px; margin: 6px 0 0; }
@media (max-width: 480px) {
  .sh-min { align-items: flex-start; padding-top: 40px; }
}
`;

const ICON_SVGS: Record<OutboxIcon, string> = {
  success: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m8.2 12.4 2.6 2.6 5-5.4"/></svg>`,
  warn: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5 21.5 20h-19L12 3.5Z"/><path d="M12 10v4.5"/><path d="M12 17.4v.1"/></svg>`,
  error: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#e11d48" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="m9 9 6 6M15 9l-6 6"/></svg>`,
  info: `<svg class="ob-icon" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M12 11v5"/><path d="M12 7.6v.1"/></svg>`,
};

// Progressive enhancement (spec §4): flip the page into a Sending state on
// submit and LET THE NATIVE POST NAVIGATION PROCEED — no fetch, no JSON
// mode. The staged status text is time-based; its schedule matches the
// server's real backoff (first retry ~1s, exhausted ~8s). The disable is
// deferred a tick: disabling a submit button synchronously inside its own
// submit event can cancel form submission in some engines. `pageshow`
// resets state when bfcache restores the page after back-navigation.
const CONFIRM_SCRIPT = `<script>(function () {
  var form = document.getElementById('ob-send');
  if (!form) return;
  var statusEl = document.getElementById('ob-status');
  var timers = [];
  function controls() { return document.querySelectorAll('.ob-disable'); }
  function sendBtn() { return document.getElementById('ob-send-btn'); }
  form.addEventListener('submit', function (e) {
    if (form.dataset.busy) { e.preventDefault(); return; }
    form.dataset.busy = '1';
    setTimeout(function () {
      var els = controls();
      for (var i = 0; i < els.length; i += 1) els[i].setAttribute('disabled', '');
      var b = sendBtn();
      if (b) b.innerHTML = '<span class="spinner"></span>\\u00a0Sending\\u2026';
      if (statusEl) {
        statusEl.textContent = 'Sending\\u2026';
        timers.push(setTimeout(function () {
          statusEl.textContent = 'The mail service is busy \\u2014 retrying\\u2026';
        }, 4000));
        timers.push(setTimeout(function () {
          statusEl.textContent = 'Still working\\u2026';
        }, 12000));
      }
    }, 0);
  });
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    delete form.dataset.busy;
    for (var i = 0; i < timers.length; i += 1) clearTimeout(timers[i]);
    timers = [];
    var els = controls();
    for (var j = 0; j < els.length; j += 1) els[j].removeAttribute('disabled');
    var b = sendBtn();
    if (b) b.textContent = b.dataset.label || 'Send';
    if (statusEl) statusEl.textContent = '';
  });
}());</script>`;

function chrome(inner: string): string {
  return `<style>${OUTBOX_CSS}</style><div class="ob">${inner}</div>`;
}

function sendForm(confirmPath: string, label: string): string {
  return `<form id="ob-send" method="POST" action="${esc(confirmPath)}">
    <button id="ob-send-btn" type="submit" class="btn primary ob-btn ob-disable" data-label="${esc(label)}">${esc(label)}</button>
  </form>
  <div id="ob-status" class="ob-status" role="status" aria-live="polite"></div>`;
}

function detailBlock(summary: string): string {
  return `<details class="ob-detail"><summary>Technical details</summary><pre>${esc(summary)}</pre></details>`;
}
```

`recipientBlock` reworked to classes:

```ts
function recipientBlock(row: OutboxRow): string {
  const cc = row.cc.length
    ? `<div class="ob-to-list">Cc: ${esc(row.cc.join(', '))}</div>`
    : '';
  return `<div>
    <div class="ob-to-label">To</div>
    <div class="ob-to-name">${esc(row.recipientDisplay)}</div>
    ${row.to.length > 1 ? `<div class="ob-to-list">${esc(row.to.join(', '))}</div>` : ''}
    ${cc}
  </div>`;
}
```

The page functions:

```ts
export function reviewPage(
  row: OutboxRow,
  p: { confirmPath: string; cancelPath: string },
): string {
  const body = chrome(`
  ${recipientBlock(row)}
  ${row.subject ? `<div class="ob-subject">${esc(row.subject)}</div>` : ''}
  <pre class="ob-body">${esc(row.bodyMarkdown)}</pre>
  <div class="ob-actions">
    ${sendForm(p.confirmPath, 'Confirm & send')}
    <form method="POST" action="${esc(p.cancelPath)}"><button type="submit" class="btn ob-btn-secondary ob-disable">Cancel</button></form>
  </div>`) + CONFIRM_SCRIPT;
  return renderShell(css(), { title: 'Review and send', variant: 'minimal', body });
}

export function linkPage(row: OutboxRow, p: { confirmPath: string }): string {
  const body = chrome(`
  ${recipientBlock(row)}
  <div class="ob-actions">${sendForm(p.confirmPath, 'Send')}</div>`) + CONFIRM_SCRIPT;
  return renderShell(css(), { title: 'Send message?', variant: 'minimal', body });
}

export function failedPage(
  row: OutboxRow,
  p: { shaped: ShapedOutboundError; confirmPath: string },
): string {
  const retry = p.shaped.canRetry
    ? `<div class="ob-actions">${sendForm(p.confirmPath, 'Try again')}</div>`
    : `<p class="ob-note">Ask your assistant to create a new draft.</p>`;
  const body =
    chrome(`
  ${ICON_SVGS[p.shaped.canRetry ? 'warn' : 'error']}
  <p class="ob-msg">${esc(p.shaped.message)}</p>
  <div class="ob-to-list">To ${esc(row.recipientDisplay)}</div>
  ${retry}
  ${detailBlock(p.shaped.summary)}`) + (p.shaped.canRetry ? CONFIRM_SCRIPT : '');
  return renderShell(css(), { title: 'Not sent', variant: 'minimal', body });
}

export function resultPage(
  title: string,
  message: string,
  opts?: { icon?: OutboxIcon; detail?: string; footNote?: string },
): string {
  const body = chrome(`
  ${opts?.icon ? ICON_SVGS[opts.icon] : ''}
  <p class="ob-msg">${esc(message)}</p>
  ${opts?.footNote ? `<p class="ob-note">${esc(opts.footNote)}</p>` : ''}
  ${opts?.detail ? detailBlock(opts.detail) : ''}`);
  return renderShell(css(), { title, variant: 'minimal', body });
}
```

(`import type { ShapedOutboundError } from './error-copy';` at top. The
`data-label` on the send button is what `pageshow` restores — so Try
again / Confirm & send labels survive back-navigation.)

- [ ] **Step 4: Wire routes.ts.** Import `shapeOutboundError` and `failedPage`. `gonePage` gains the confirm path:

```ts
function gonePage(row: OutboxRow, confirmPath: string): string {
  if (row.status === 'sent')
    return resultPage(
      'Already sent',
      `This message to ${row.recipientDisplay} was already sent${sentWhen(row)}.`,
      { icon: 'success' },
    );
  if (row.status === 'discarded')
    return resultPage('Cancelled', 'This draft was cancelled.', { icon: 'info' });
  if (row.status === 'failed')
    return failedPage(row, {
      shaped: shapeOutboundError(row.error ?? ''),
      confirmPath,
    });
  if (row.status === 'delivery_unknown')
    return resultPage(
      'Delivery uncertain',
      'The app closed while this message was being sent — it MAY have gone ' +
        'out. Check your Sent folder before creating a new draft.',
      { icon: 'warn' },
    );
  if (row.status === 'expired')
    return resultPage(
      'Draft expired',
      'Ask your assistant to create the draft again.',
      { icon: 'info' },
    );
  return resultPage('In progress', 'This draft is being sent.', { icon: 'info' });
}
```

Callers: in `getConfirm` and `postConfirm` build `const confirmPath = \`/outbox/confirm/${token}\`;` first and pass it to every `gonePage(...)` call (`postCancel` too). `postConfirm`'s sent branch becomes:

```ts
        html: resultPage(
          'Message sent',
          `Sent to ${out.row.recipientDisplay}${sentWhen(out.row)}.`,
          { icon: 'success', footNote: 'You can close this page.' },
        ),
```

`invalidPage()` gets `{ icon: 'error' }`; the three 500 catch pages get `{ icon: 'warn' }`. No routing/method/status-code changes of any kind.

- [ ] **Step 5: Run tests to verify pass**: `npx jest src/main/outbound/`
- [ ] **Step 6: Commit**: `feat(outbound): confirm-page design pass — send states, Try again, shaped errors`

---

### Task 7 (controller, not a subagent): gates + push

- [ ] Full suite: `npx jest` (re-run a load-flaked suite once), `npm run lint`, `npm run typecheck`.
- [ ] Secret-sweep the whole branch diff (public repo).
- [ ] Final whole-branch review, then push `dev` to origin.
