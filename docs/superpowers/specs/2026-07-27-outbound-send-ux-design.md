# Outbound Send UX: Safe Retry, Error Shaping, Confirm-Page States

**Date:** 2026-07-27
**Status:** Approved (user, 2026-07-27)
**Builds on:** `2026-07-23-unified-outbound-design.md` (phases 1–5, shipped in v0.55.0)

## Problem

First human smoke of gmail send hit a Google per-minute quota rejection
(`403 rateLimitExceeded` on `users.messages.send`) and surfaced two defects:

1. **No retry for safely-retryable failures.** `sendGmailMessage` passes
   `maxAttempts: 1` to `bearerFetch`, so a transient quota rejection —
   where Google rejected the request and *nothing was sent* — immediately
   produces a terminal `failed` row. The only recovery is asking the
   assistant for a whole new draft.
2. **Raw error dump, no send states.** The confirm page is a zero-JS form
   POST: while sending, the phone shows only the browser's native loading
   bar; on failure the page renders the raw error string (a multi-KB JSON
   blob) verbatim. There is no sending state, no retry feedback, no
   human-readable failure copy, and the result pages are unstyled
   title+paragraph.

Root-cause note on the incident: a send costs 100 Gmail quota units and
the readonly sync polls the same per-user quota bucket, so a send landing
mid-sync-burst will recur naturally. Backoff genuinely fixes it; no
console/quota action is needed.

## User decisions

- **Approach B** for progress display: progressive enhancement. Keep the
  plain form POST navigation; a small inline script flips the page into a
  Sending state on submit while the browser waits for the same POST
  response. No new endpoints, no JSON response mode, no-JS fallback keeps
  working. (Rejected: A = server-retry only with no visible state; C =
  async accept + status-polling endpoint — new tunnel surface, overkill.)
- **Try again button: yes.** A `failed` row whose failure class is
  known-not-sent may be re-confirmed from the failure page.

## Design

### 1. Send-safe server retry

**The safety rule:** retry a send only when the failure proves the message
was never accepted. Quota/rate rejections (HTTP 429, and 403 whose body
carries Google quota markers) are documented request-rejections — retrying
them can never double-deliver. Timeouts, network errors, and 5xx stay
fail-fast: the message may already be on the wire.

**`bearerFetch` (`src/main/sources/gmail/bearer-fetch.ts`)** gains two
opts, both defaulting to current behavior so every existing caller is
byte-for-byte unchanged:

```ts
/** Override the default HTTP-failure retry classifier
 *  (isRetryableGoogleFailure). */
retryOn?: (status: number, body: string) => boolean;
/** Retry network errors / timeouts (default true). Pass false for
 *  non-idempotent calls — a timed-out request may have been processed. */
retryNetErrors?: boolean;
```

**`sendGmailMessage` (`src/main/sources/gmail/gmail-api.ts`)** switches to:

```ts
maxAttempts: 4,
timeoutMs: 30_000,          // a hang must not pin the phone for 90s
retryNetErrors: false,
retryOn: isSendSafeRetry,   // exported for tests
```

```ts
const SEND_RETRY_MARKERS =
  /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i;
function isSendSafeRetry(status: number, body: string): boolean {
  return status === 429 || (status === 403 && SEND_RETRY_MARKERS.test(body));
}
```

(The case-insensitive regex also covers the `RATE_LIMIT_EXCEEDED`
ErrorInfo reason observed in the smoke.) Backoff, jitter, and
`Retry-After` honoring come from `bearerFetch` unchanged (1s/2s/4s +
jitter; realistic retry window ≈ 8s while the user watches the page).

**SMTP** gets the same policy through a small shared helper
`src/main/outbound/senders/retry.ts`:

```ts
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: {
    isTransient: (err: unknown) => boolean;
    maxAttempts?: number;              // total, default 4
    sleep?: (ms: number) => Promise<void>; // test seam
  },
): Promise<T>;
```

Backoff 1s/2s/4s + jitter, mirroring bearerFetch. The SMTP sender wraps
**only** `transporter.sendMail` (never the best-effort IMAP Sent-append),
with `isTransient` = nodemailer error `responseCode` in
{421, 450, 451, 452} — SMTP transient pre-acceptance rejections.
Connection-stage and timeout errors are NOT retried (ambiguous). When
transient retries exhaust, the SMTP sender rethrows with an explicit
marker the classifier can key on:
`new Error(`smtp transient ${code}: ${original message}`)` — raw
nodemailer messages are not reliably classifiable by regex, so the
sender labels them at the throw site.

### 2. Error taxonomy — one classifier, used twice

New module `src/main/outbound/error-copy.ts`:

```ts
export type OutboundErrorKind =
  | 'transient'    // quota / rate limit / SMTP 4xx — retry will likely work
  | 'auth'         // reconnect the account, then retry works
  | 'unsupported'  // source has no sender
  | 'unknown';

export interface ShapedOutboundError {
  kind: OutboundErrorKind;
  /** Short technical one-liner — stored in row.error, shown in <details>,
   *  returned by list_outbox. Never the raw multi-KB body. */
  summary: string;
  /** Human sentence for the page. */
  message: string;
  /** Try-again eligible: transient and auth only (both prove the message
   *  was never accepted — quota/scope rejections happen before send). */
  canRetry: boolean;
}

export function shapeOutboundError(raw: string): ShapedOutboundError;
```

Classification (first match wins), against the raw thrown message:

| kind | matches | summary shape | page message |
|---|---|---|---|
| `transient` | `SEND_RETRY_MARKERS`, or a bearerFetch 429 (message format is `${errorPrefix} ${status} ${url} …` → `/^\S+ 429 /`), or the SMTP marker `/^smtp transient \d{3}:/` | `rate-limited: <service> rejected the send (HTTP <status>) — nothing was sent` (SMTP: `rate-limited: the mail server deferred the send (SMTP <code>) — nothing was sent`) | "The mail service is busy right now — this message was NOT sent. Try again in a moment." |
| `auth` | the sender's own reconnect copy (`reconnect .* in Settings`, `no Gmail credentials`, `insufficientPermissions`, `ACCESS_TOKEN_SCOPE_INSUFFICIENT`) | first line of the raw message (already human-written by the sender) | the summary itself (it already says what to do), plus "then tap Try again." |
| `unsupported` | `is not supported yet` | first line of raw | raw sender copy + "ask your assistant to use a supported account." |
| `unknown` | everything else | `send failed: ` + raw truncated to 200 chars, single line | "Something went wrong and this message was not delivered by the app. If this was a network problem it MAY still have been sent — check your Sent folder before re-sending." |

**Fail-time use:** `service.ts`'s `fail(message)` stores
`shapeOutboundError(message).summary` in `row.error` (instead of the raw
message). This shrinks the page, `list_outbox`, dashboards, and logs.
**Render-time use:** routes re-run `shapeOutboundError(row.error)` on the
stored summary to pick copy and gate Try-again. Summaries are generated by
the same classifier, so the markers (`rate-limited:`, reconnect copy, …)
are stable inputs for re-classification. No DB migration.

### 3. Try again — `failed → sending` re-confirm

`confirmByToken` (`src/main/outbound/service.ts`): where it currently
rejects any non-`draft` row with `already`, it now also accepts a
`failed` row **iff** `shapeOutboundError(row.error).canRetry`. The CAS
transition passes the exact observed status —
`transition(row.id, [row.status], 'sending')` where `row.status` is
`'draft'` or `'failed'` — never the union `['draft','failed']`, so a
confirm that read `draft` can never steal a row that concurrently became
`failed` (which would bypass the canRetry gate and risk re-sending an
ambiguous failure). Losing racers re-read and report `already`, exactly
as today.

Scope guards:
- Token TTL is unchanged and bounds the retry window; an expired token
  hits the existing invalid-link page ("ask your assistant … for a fresh
  confirmation link").
- `expireOverdue` semantics unchanged (failed rows are terminal for the
  sweep; only the token gates access).
- The MCP `list_outbox` surface is unchanged apart from `error` now being
  the short summary.

### 4. Confirm-page states (progressive enhancement)

All pages stay on the existing brand system: `renderShell` variant
`minimal` (`sh-min` card, tokens.css, components.css `.btn`/`.spinner`,
Spark). `pages.ts` adds one `OUTBOX_CSS` const emitted as a `<style>`
block inside the body — no loader changes.

**Layout (mobile-first):** card max-width 520px; recipient block stays
the load-bearing element; scrollable body preview (`max-height: 50vh`);
action area with a full-width **48px** primary Send button and a
secondary Cancel button; result pages get an inline SVG status icon
(success check / warning / error / info — hand-rolled, no new deps).

**States:**

| state | page | content |
|---|---|---|
| review (mode B) | `reviewPage` | To/Cc card, subject, body preview, Send (primary, 48px, full-width), Cancel (secondary) |
| link (mode A) | `linkPage` | To/Cc card, Send button |
| sending | in-page (JS) | Send button content swaps to `.spinner` + "Sending…"; both buttons disabled; staged status line below: 0s "Sending…" → 4s "The mail service is busy — retrying…" → 12s "Still working…" (time-based; wall-clock matches the server's real backoff schedule) |
| sent | `resultPage` | success icon, "Message sent", "Sent to {recipient} ({time})", "You can close this page." |
| failed, canRetry | failed page | warning icon, "Not sent", human message from taxonomy, **Try again** primary button (form POST, same confirm path), collapsed `<details>Technical details</details>` with the stored summary |
| failed, permanent | failed page | error icon, "Not sent" (or "Delivery uncertain" copy for `unknown`), human message, NO retry button, collapsed technical details |
| cancelled / expired / already-sent / delivery-unknown / invalid-link | `resultPage` | existing copy, restyled with matching icon |

**The inline script (~40 lines, no deps, in review/link pages):** on
`submit` of the confirm form: if already busy, `preventDefault` (double-
tap guard — the server CAS remains the real guard); otherwise mark busy,
disable both buttons, swap the Send button content to spinner+"Sending…",
start the staged status-line timers, and let the native submit proceed
(NO `preventDefault` — the browser navigation carries the result page).
A `pageshow` handler resets the busy state when bfcache restores the page
(back-button after a send). Without JS, behavior degrades to today's
native form POST plus the server-side retry and better result pages.

`gonePage(row)` becomes `gonePage(row, { confirmPath })` so the failed
branch can render the Try-again form; both call sites (`getConfirm`,
`postConfirm`) already hold the token.

Dark mode and `prefers-reduced-motion` come free from
tokens.css/components.css.

### 5. Out of scope

- No async send / status-polling endpoint (approach C).
- No changes to the tunnel allowlist (`/outbox/confirm`, `/outbox/cancel`
  only — unchanged), no new npm dependencies (so no alpha-cent
  release/app dependency mirroring is needed).
- No per-attempt server→page progress channel; staged text is time-based.
- No abort/cancel of an in-flight send.
- SMTP `secure`/config changes, reply-all, attachments: separate arcs.

## Testing

- **bearer-fetch:** `retryOn` override respected (send-safe predicate
  retries 429 and quota-403, refuses 500/network); `retryNetErrors:
  false` throws immediately on timeout/network error; defaults preserve
  existing behavior (existing tests stay green untouched).
- **gmail-api:** `isSendSafeRetry` matrix including the verbatim 403 body
  from the smoke (retried) and a 403 `insufficientPermissions` (not);
  `sendGmailMessage` retries a quota-403 then succeeds; exhausts at 4.
- **retry.ts:** transient responseCodes retried with backoff (fake
  sleep), non-transient thrown immediately, attempt cap.
- **smtp sender:** transient 451 then success; permanent 550 fails once.
- **error-copy:** classification matrix incl. re-classifying its own
  summaries (fixed point: `shape(shape(x).summary).kind === shape(x).kind`).
- **service:** `failed`+retryable row re-confirms (failed→sending→sent);
  `failed`+permanent row returns `already`; CAS uses observed status
  (draft-read racer cannot steal a concurrently-failed row); `fail()`
  stores the summary, not the raw message.
- **routes/pages:** failed page shows Try again only for retryable kinds;
  sent page shows recipient; review/link pages carry the confirm form,
  the inline script, and no raw error blobs anywhere.
