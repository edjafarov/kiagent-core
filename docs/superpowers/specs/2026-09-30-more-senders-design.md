# More senders: ms365 mail, Telegram, WhatsApp, Instagram

Status: r2 (design review round 1 folded in) · 2026-09-30

## Goal

Kia can already draft → user confirms → send for Gmail, IMAP (bundled senders)
and Slack (extension sender). Add the same for four marketplace connectors:

| Source | Reply | New message (compose) |
|---|---|---|
| ms365 mail | yes (reply + reply-all) | yes (email addresses) |
| Telegram | yes (chat, or in reply to one message) | no |
| WhatsApp | yes (chat level) | no |
| Instagram | yes (1:1 threads, Meta's 24 h window) | no |

Compose for chat sources is out of scope (needs a grounded "start a chat
with X" target concept — separate design).

## The contract every sender plugs into (unchanged)

- Kia only drafts. Drafts are frozen outbox rows; only the confirmation gate
  (page / in-app review / chat-mode `send_draft`) reaches a Sender.
- A non-email-bundled source addresses replies ONLY through the
  `metadata.outbound` its own `toDocument` wrote. The model picks a document
  (and optionally a stored target key); it never supplies a ref or address.
- Extension Sender = `send(intent, ctx) → { externalMessageId? }`, runs in
  the extension child; manifest needs the `send` cap + `contributes.senders`.
  Core wraps the RPC in a 60 s timeout that does NOT cancel the child call.
- Classification is by message text (`error-copy.ts`):
  `reconnect … in Settings` → auth (Try again); `rate-limited:` →
  transient (Try again); anything else → "may have been sent" (no Try again).

**Sender rules (all four connectors, named test requirements):**
- R1 A send call is never retried on network error or 5xx — neither the
  status loop nor the network-error loop. 429/throttle may be retried or
  surfaced as `rate-limited:` (rejected before processing).
- R2 Success means the service ACCEPTED the message, not "bytes written".
- R3 A sender finishes (success or throw) well inside core's 60 s, or it
  cancels its own in-flight work first; nothing may go out after core has
  recorded the row as failed.
- R4 Every provable pre-delivery failure maps to one of the three markers
  (`reconnect … in Settings`, `rate-limited:`, `not sent:`); the connector
  rewraps its own auth errors (e.g. `InstagramAuthError`, `Ms365AuthError`)
  rather than passing them through.

## Core changes (kiagent-core)

1. **Refreshed credentials for extension senders (bug fix).** The sender
   wrapper in `extension-platform.ts` hands `vault.load()` straight to the
   sender; an OAuth token older than ~1 h is expired (ms365 would fail every
   send after the first hour). Extract the engine's `session.credentials()`
   refresh (60 s margin, vault save, auth-coded failure propagates) into one
   helper used by both. At the SEND boundary only, an auth-coded refresh
   failure is rethrown as `<source> sign-in expired — reconnect <identifier>
   in Settings` so it classifies auth/Try again (the raw
   `microsoft oauth token request failed: invalid_grant` would classify
   unknown). Engine callers keep the typed error.

2. **Email-shaped outbound metadata.** `metadata.outbound` (and each
   variant) may carry `to?: string[]`, `cc?: string[]` (validated email
   addresses). When present, core copies them onto the frozen row and the
   SendIntent (so list_outbox / chat / Outbox UI show real recipients); the
   sender reads `intent.to/cc` like `gmail.ts`. `ref` stays opaque.

3. **Reply-all for extension refs.** `metadata.outbound.replyAll =
   { ref, display, to?, cc? }`. `draft_reply` with `reply_all: true` uses it
   when present (validated like `targets`); absent → default (as for Slack
   today). `target` wins over `reply_all`.

4. **Compose for extension email sources.** New optional descriptor field
   `SourceDescriptor.compose?: 'email'` ("accounts of this source can
   originate email; the Sender handles From"). `draft_message` accepts such
   an account (same address validation, `kind: 'new'`, no From lookup);
   other extension sources keep the "reply-only" refusal. The outbound
   service gets `descriptorFor(sourceId)` over the source registry. Bundled
   imap/gmail keep the identity.ts path.

5. **`not sent:` marker.** Anchored `^not sent:`, checked FIRST in
   `shapeOutboundError` (before quota/auth/status) → kind `transient`,
   canRetry true, summary = text (fixed point), page copy = the text. For
   failures that are certainly pre-delivery but not auth/quota (WhatsApp
   socket not open, Instagram 24 h window, target message deleted).
   Documented next to AUTH_MARKERS as a cross-repo contract.

6. `draft_reply` description: "email or chat document"; target example
   mentions Telegram message ids.

7. SDK regen (connector-sdk minor) for `compose`, outbound `to/cc/replyAll`
   at release; connectors compile against 1.3.0 meanwhile via a local type
   extension.

## ms365 connector (2.3.0)

- **Scope:** `SCOPES = ['Mail.Read', 'Mail.Send', 'User.Read']`. Existing
  accounts lack Mail.Send → Graph 403 (`ErrorAccessDenied` /
  `AccessDenied` / `Authorization_RequestDenied`) → `this Microsoft 365
  account was connected before sending existed — reconnect <id> in Settings
  to grant send permission`. (No `creds.scope` fast-fail: the Microsoft
  refresher does not carry scope.)
- **Fetch:** `CONV_SELECT` adds `replyTo,isDraft`.
- **Reply target** (pure toDocument; `selfAddress` stamped on the item from
  `session.account.identifier`, like `tenantKind`). Drafts are discarded
  before anything is chosen. Mirrors `resolve-gmail.ts` exactly:
  - reply: target = last message whose From is not self; address = its
    Reply-To unless that is self, else From. If every message is from self
    → last message's To minus self (warning-free; display says so).
  - replyAll: target = last message; `to` = (Reply-To ?? From) + To minus
    self, `cc` = Cc minus self.
  - `ref = { messageId: <raw GraphMessage.id of the target> }` — the
    immutable Graph id, NOT `parsed.messageId` (that is the RFC Message-ID).
  - `outbound = { ref, display, to, cc, replyAll: { ref, display, to, cc } }`;
    omitted when no non-self recipient exists.
- **Sender:** reply = `POST /me/messages/{messageId}/reply` with
  `{ message: { toRecipients, ccRecipients, body: { contentType: 'Text', content } } }`
  — Graph threads it; recipients are exactly the frozen `intent.to/cc`
  (verify live with a self-target that recipient replacement holds).
  Compose = `POST /me/sendMail` with `{ message: {subject, body Text,
  toRecipients, ccRecipients}, saveToSentItems: true }`. Both 202, no id.
  GraphClient gains `method`/`body` and a `send` mode: no retry on
  network/5xx (R1), 429 retried (Retry-After ≤ 20 s, else `rate-limited:`).
  404 `ErrorItemNotFound` on the target → `not sent: the original message
  no longer exists in the mailbox`. 401 → `reconnect … in Settings`.
- **Descriptor:** `compose: 'email'`. Manifest: `send` cap, senders
  `["ms365"]`.
- **Backfill:** rename the one-time rescan flag to `rescan: 2` (cursor
  `attachments: 1` or absent → re-enumerate once). Cost: a second full
  re-enumeration for 2.2.0 users (2.2.0 is released).

## Telegram connector

- **Reply target:** `ChatInfo` gains `peer: {peer, accessHash?}` from
  `peerOfEntity(chat.entity)` (the IncludedChat is available on both the
  walker and the live path). Day doc: `outbound = { ref: {chatId, peer,
  accessHash}, display: chat name, targets: one per non-system message
  { key: String(msgId), ref: {…, replyTo: <positive integer>}, display:
  "<chat> (reply to <sender> · HH:mm)" } }`. `replyTo` is stored as a
  number and re-validated as a positive integer in the sender (teleproto
  rejects strings). Omitted when the peer is unknown.
- **Sender uses a FRESH short-lived client**, not the live runtime:
  `host.query.accounts()` → the account's `config.authFile` → auth blob →
  client with `floodSleepThreshold: 0` (a FLOOD_WAIT surfaces immediately
  instead of sleeping past core's timeout — R3) → `sendMessage(inputPeerFor(ref),
  { message, replyTo })` → disconnect. Same pattern `fetchBytes` already
  uses; no registry, no lifecycle coupling with pull restarts. An overall
  40 s deadline disconnects the client (cancels teleproto's internal
  retries, which reuse one `random_id` and are therefore not duplicates).
  FloodWait → `rate-limited: Telegram asked to wait Ns — nothing was sent`;
  auth-loss codes → `…reconnect … in Settings`; deadline → plain error
  (unknown/"may have been sent").
- **Backfill:** the walker re-walks each chat's last 6 h relative to its
  newest message on every start (`walker.ts` CATCH_UP_OVERLAP_MS), so every
  chat's newest day doc is re-flushed with a target on first start. Older
  days: core's existing "no reply target" error.

## WhatsApp connector

- **Reply target:** day doc `outbound = { ref: { jid }, display: chat name }`
  for user and group jids only. No per-message quoting.
- **Sender MUST reuse the runtime's open socket** (a second socket on the
  same linked-device creds replaces the connection). Module-level registry
  `Map<accountId, runtime>`: `pull()` registers after construction; removal
  in `finally` only when `registry.get(id) === runtime`. `WhatsAppSocket`
  gains an `open` flag (set on `connection: 'open'`, cleared on `'close'`
  and synchronously in `stop()`), and sends through the CURRENT `sock`.
  Not registered / not open / stopping → `not sent: WhatsApp isn't
  connected right now — try again in a moment`.
- **Acceptance (R2):** message id pre-generated (`generateMessageID`); a
  listener on the socket's `CB:ack,class:message` is attached BEFORE
  `sendMessage(jid, { text }, { messageId })`; success = the server ack for
  that id without an `error` attr. Ack with `error` → plain error (unknown —
  the server received it). No ack within 20 s or socket closes meanwhile →
  plain error (unknown, "may have been sent").
- **Backfill (migration):** cursor gains `outbound: 1`. When absent, pull()
  first pages `host.query.search({ type, account, orderBy: 'newest' })` and
  re-emits (a) the newest day doc of every chat and (b) every day doc from
  the last 30 days, rebuilding the item from the stored doc (jid =
  `chat_key`, type = `chat_type`, name = title minus the ` — Mon D, YYYY`
  suffix, messages = stored ledger) — then commits `outbound: 1`. Does not
  depend on server history replay. `chat_name` is added to metadata going
  forward.
- **Risk note** in README: Baileys is an unofficial client; every send is
  user-confirmed and one at a time.

## Instagram connector

- **Reply target frozen at sync:** `listThreads` keeps participant ids
  (`participants.data[].id`); `pull()` stamps `selfId` (=
  `config.ig_user_id`) on the item. Day doc `outbound = { ref: {
  recipientId }, display: thread name }` ONLY when exactly one non-self
  participant id exists (the Messaging API is 1:1; anything else → no
  target). No send-time lookups.
- **Sender:** token from `ctx.credentials.password`. `POST /me/messages
  { recipient: {id}, message: {text} }` → `message_id`. New client `post()`
  with no retries (R1). Explicit mapping: HTTP 401 or code 190 →
  `…reconnect … in Settings`; codes 4/17/32/613 or HTTP 429 →
  `rate-limited: Instagram is throttling sends — nothing was sent`; code 10
  / subcode 2534022 → `not sent: Instagram only allows replies within 24
  hours of the other person's last message`; everything else → plain error.
  (Subcode verified live; a wrong code only degrades to unknown.)
- **Backfill:** cursor gains `outbound: 1`; without it the sweep re-reads
  all threads once (≤20 messages each).

## Tests (named requirements)

Core: refreshed creds reach an extension sender (expired → refresher
called, vault saved); auth-coded refresh failure → reconnect wording that
classifies auth/canRetry end to end; outbound `to/cc` copied to row and
intent; `reply_all` picks `outbound.replyAll`, falls back without it,
`target` wins; compose accepted for `compose:'email'` and refused otherwise;
`not sent:` classifies canRetry, beats a body containing `429`, fixed point.
ms365: target selection (Reply-To honored, self Reply-To ignored, drafts
skipped, all-self thread, no-recipient → no outbound); raw Graph id in ref;
exact reply/sendMail request bodies; R1 on both loops; 403 → reconnect;
404 → not sent; rescan flag migration.
Telegram: ref/targets shape (numeric replyTo); sender builds the peer from
the ref, passes a number, uses floodSleepThreshold 0, disconnects on every
path and on deadline; FloodWait → rate-limited; auth-loss → reconnect.
WhatsApp: registry identity-guarded removal (old cleanup after replacement
registration keeps the new one); not-open → not sent; success only on the
matching server ack; ack error / timeout → unknown; migration re-emits
newest-per-chat + 30 days and sets the flag once.
Instagram: 1:1 target only; recipientId frozen; error mapping table; no
retry on POST; cursor re-sweep once.
Per-test mutation evidence.

## Rollout

Core release (minor) + SDK regen → alpha-cent core.lock bump → connector
releases (ms365 2.3.0; telegram/whatsapp/instagram minor). Ask before each
release/tag/lock bump. Live smoke on the dev app with self-targets only
(email to self, Telegram Saved Messages, WhatsApp self-chat, Instagram test
thread) — each real send confirmed by the user first.
