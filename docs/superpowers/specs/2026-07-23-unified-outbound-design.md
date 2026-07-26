# Unified Outbound Layer — draft-first sending with confirmation modes

**Date:** 2026-07-23
**Status:** Draft for review
**Scope:** kiagent-core (primary) + alpha-cent overlay touches (Gmail consent, preload allowlist)

## 1. Problem and goal

KIAgent's read side already proves the thesis: one corpus + a handful of universal MCP
tools beats N per-service MCP servers (one auth story, one schema, cross-source search,
minimal tool-schema overhead). The outbound side has no equivalent: the app is uniformly
read-only end to end — all seven MCP tools are reads, the `Source` contract is pull-only,
and no connector holds send-capable credentials.

Goal: a **universal outbound layer** that lets an LLM client draft replies and messages
across every connected source through one tool surface, with the actual send gated by a
user-configurable confirmation flow. The corpus is the differentiator: because drafts are
grounded in stored documents, the LLM never fabricates an address, thread ID, or channel
ID — recipients and threading always resolve from a document the model just read.

### Non-goals (MVP)

- No fully-autonomous send mode. Every mode involves the user (page click, link click, or
  chat agreement).
- No chat compose-to-arbitrary-recipient. Compose-new is email-only; chat services are
  reply-only until a `resolveRecipient` extension RPC exists.
- No third-party marketplace senders shipped in the first release (the contract is
  plugin-ready from day one; a Slack pilot is the final phase).
- No inline draft editing in the confirm page (view + Confirm/Cancel only; editing is a
  fast follow).

## 2. Architecture overview

```
LLM client (local stdio / loopback / remote 7422)
   │  draft_reply / draft_message / list_outbox / send_draft
   ▼
MCP ToolRegistry ──▶ Outbox service ──▶ outbox table (corpus SQLite)
                          │
                          │ confirmation (mode A/B page, mode C tool)
                          ▼
                    Send pipeline ──▶ Sender implementations
                                        ├─ smtp (bundled, IMAP accounts)
                                        ├─ gmail (bundled, Gmail API)
                                        └─ extension senders (RPC, later: Slack pilot)
                          │
                          ▼
                    Sent message re-enters corpus via normal ingestion
```

Every path — all three modes — creates a frozen draft row first. Confirmation modes are
policies over the same state machine; they differ only in what moves a draft from
`draft` to `sent`.

## 3. Data model

New table in the corpus SQLite, forward-only migration in core `src/main/core/store/schema.ts`:

```
outbox (
  id TEXT PRIMARY KEY,            -- UUIDv7
  account_id TEXT NOT NULL,       -- FK accounts; the sending account
  kind TEXT NOT NULL,             -- 'reply' | 'new'
  reply_to_document_id TEXT,      -- FK documents, kind='reply' only
  outbound_ref TEXT,              -- opaque per-source reply target (see §6), kind='reply'
  recipient_display TEXT NOT NULL,-- human-readable target, shown in every confirm surface
  to_json TEXT, cc_json TEXT,     -- resolved addresses (email kinds)
  subject TEXT,
  body_markdown TEXT NOT NULL,
  threading_json TEXT,            -- e.g. {inReplyTo, references, gmailThreadId}
  status TEXT NOT NULL,           -- 'draft'|'sending'|'sent'|'failed'|'discarded'|'expired'
                                  -- (+ 'delivery_unknown', added in phase 1: interrupted
                                  --  mid-send at boot recovery — never auto-redriven)
  error TEXT,
  external_message_id TEXT,       -- transport's id after send
  created_via TEXT NOT NULL,      -- 'mcp-local' | 'mcp-remote'
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  expires_at INTEGER NOT NULL     -- draft TTL, default 24h
)
```

Decisions:
- **Dedicated table, not a document type.** Drafts are mutable workflow state; the
  documents table is append-oriented ingest content. The loop closes on the far side
  instead: sent messages re-enter the corpus through normal ingestion (Gmail re-pull
  picks up the reply in-thread; SMTP appends to the IMAP Sent mailbox which the existing
  pull ingests).
- **The outbox table is the audit log.** Sent/discarded/failed rows are retained.
- **Drafts are frozen at creation.** Confirm surfaces render from this row; nothing the
  model does after creation can alter what would be sent.
- **Pending cap:** max 20 rows in `draft` status per account; the draft tools return an
  error when full (anti-flooding, bounds injection blast radius).

## 4. MCP tool surface

Registered in core `buildBuiltinTools` beside the existing seven, identical on loopback
and remote transports:

| Tool | Effect | Notes |
| --- | --- | --- |
| `draft_reply(document_id, body, reply_all?)` | writes outbox row | host resolves recipients + threading from the doc; model supplies no address |
| `draft_message(account_id, to, subject, body)` | writes outbox row | email accounts only; free-form recipients |
| `list_outbox(limit?)` | read | recent drafts + statuses; re-issues confirm URLs for still-pending drafts |
| `send_draft(draft_id)` | sends | **only** honored for accounts configured in mode C; otherwise returns an error naming the account's mode |

Tool results carry mode-specific instructions for the model:

- **Mode A** result: `{draft_id, confirm_url, recipient_display}` + instruction to
  present the link ("review and send here").
- **Mode B** result: `{draft_id, confirm_url, recipient_display, to, subject, body}` +
  instruction to render the draft and recipient verbatim in chat, then present the link
  as the send button.
- **Mode C** result: `{draft_id, recipient_display, to, subject, body}` + instruction to
  render the draft, ask the user for agreement, and call `send_draft` only after an
  explicit yes.

`draft_reply` with `reply_all: true` on a document lacking per-message recipient
metadata (see §9) falls back to reply-to-sender and says so in the tool result — never a
guessed recipient list.

## 5. Confirmation modes

Per-account setting with a global default; default is **mode A**. Policy can only be
relaxed (A → B → C) by explicit per-account user action in Settings. Stored in the
existing account `config` JSON.

**Mode A — review page (default).** The confirm URL renders the full draft from the DB:
resolved recipient/channel (prominent), subject, body, link to the source thread, and
Confirm / Cancel buttons. What the user reviews is exactly what the app will send,
rendered by the app — a prompt-injected session cannot misrepresent it.

**Mode B — in-chat review, signed one-click link.** The model renders the draft in chat;
the link lands on a minimal page — one recipient line + a single Send button. The
recipient line is app-rendered, so the most damaging misrepresentation (wrong target) is
still caught even though the body review happened in model-controlled chat.

**Mode C — chat confirmation (opt-in).** The model renders the draft, asks, and calls
`send_draft` on agreement. Trust model stated plainly: the user's consent is observed by
the model, not the app; the app-side gate is the account's mode-C opt-in plus the MCP
client's own tool-approval prompt. This matches how existing write-capable MCP servers
behave and is why C is opt-in, never default. Rate limit (per-account sends/hour,
default 30) and audit rows still apply.

### Confirm URLs

- **Signed capability URLs:** `HMAC(secret, draft_id ‖ expires)` with a locally-generated
  secret stored beside other app secrets. No server-side token table; single-use falls
  out of the state machine (any non-`draft` status kills the link regardless of TTL).
- **TTL:** mode B default 5 minutes; mode A default 30 minutes. Expired links render an
  "expired" page; fresh links are re-issued via `list_outbox`. Draft itself expires at
  `expires_at` (24h) → status `expired`.
- **POST behind the button, always.** Link unfurlers and prefetchers (Slack, iMessage,
  claude.ai) fetch URLs the moment they render — inside any TTL. GET never sends; the
  send is a POST carrying the signed token, triggered by the page button. This holds in
  mode B too: the "one-click link" is one click on the landing page, not a GET side
  effect.
- **Routing:** tool calls arriving via local transports return `http://127.0.0.1:<port>/outbox/confirm/<token>`
  on the existing loopback server; calls via the remote transport return the device-
  subdomain HTTPS URL over the tunnel. *(As shipped in phase 4: no OAuth-middleware
  carve-out was needed — the remote Router applies JWT per-route to `/mcp` only, so
  `/outbox` mounts unauthenticated by construction, the same posture as `/oauth/consent`;
  each page is gated by its single-use signed token. The remote surface is
  `GET|POST /outbox/confirm/<token>` plus `POST /outbox/cancel/<token>` — cancel-over-
  tunnel is benign; worst case a URL holder discards a draft. `/outbox/api` is core-side
  allowlisted away from the remote entry point.)* Benefit: sends can be approved from a
  phone. Known exposure: the URL lives in the conversation transcript; TTL + single-use +
  POST-behind-button bound it.
- **CSRF/rebinding hygiene on loopback:** validate `Host`/`Origin` on the POST; token in
  path, not query params that leak via referrer. *(Decision, phase 4: no Host/Origin
  check over the tunnel — real TLS host semantics plus token gating make it redundant
  there; the loopback checks are unchanged.)*

## 6. Sender contract — plugin-universal from day one

New optional contract in core `src/shared/contracts.ts` beside `Source`, **RPC-serializable**
(plain data in/out, no callbacks) because third-party extensions run out-of-process over
the existing Connector RPC:

```ts
interface SendIntent {
  accountId: string
  kind: 'reply' | 'new'
  outboundRef?: unknown        // opaque, round-tripped verbatim (replies)
  to?: string[]; cc?: string[] // email kinds
  subject?: string
  bodyMarkdown: string
  threading?: Record<string, unknown>
}
interface SendResult { externalMessageId?: string }
interface Sender { send(intent: SendIntent): Promise<SendResult> }
```

**Opaque reply refs (the universality mechanism).** A source's `toDocument` may write
`metadata.outbound = { ref: <opaque blob>, display: "human-readable target" }`. On
`draft_reply`, the host copies `ref` into the outbox row and later passes it verbatim to
the *same extension's* sender; it never interprets it. This preserves the guarantee — "a
reply targets exactly the conversation this document came from" — for any service
(Slack channel IDs, WhatsApp JIDs, Telegram peers) without the host learning per-service
addressing. `display` is what every confirm surface shows as the recipient. Bundled
email resolution is the built-in instance of the same convention.

**Manifest:** new `send` cap in the `Cap` union (`src/main/platform/manifest.ts`) and a
`contributes.senders` section. The existing marketplace TOFU-pin + permission-delta
re-consent flow means a plugin update that adds `send` triggers explicit user re-consent
before activation. Extension senders are reachable **only** from the send pipeline —
i.e. only after a confirmation gate — never directly from the MCP plane.

**Trust boundary note:** the host cannot verify an opaque `ref`/`display` pair is honest,
but a plugin holding `net` + `query` caps can already exfiltrate silently; `send` adds
little marginal risk. The extension remains the trust boundary, consistent with the
existing model.

## 7. Bundled transports

**SMTP (IMAP accounts).** New minimal SMTP client (nodemailer or equivalent); SMTP
host/port added to IMAP account setup (sensible defaults derived from the IMAP host);
reuses the vault password. After send: append the message to the Sent mailbox over the
existing IMAP session so normal ingestion closes the loop. Threading from stored RFC822
`messageId` → `In-Reply-To` / `References`.

**Gmail API.** `users.messages.send` with `threadId` from stored `gmailThreadId`.
Requires adding `gmail.send` to the scope list in `sources/gmail/oauth.ts` — a
sensitive scope in Google's taxonomy (the restricted list covers the content-reading
Gmail scopes; the distinction is moot while the project stays in Testing) — acceptable
inside the Testing-project founding cohort and for BYO-client users, and it rides the
existing gmail-gate consent flow in the product overlay. Existing accounts need
re-consent — *as shipped in phase 5 that means a full reconnect (`prompt=consent`);
no incremental-auth machinery exists.* The tests that assert readonly-only scopes must
be updated deliberately, not mechanically.

## 8. Product-overlay touches (alpha-cent)

- Gmail-gate consent copy extended to cover send scope.
- Any new renderer-invoked IPC channels (Settings mode config, outbox history panel)
  added to `REMOTE_INVOKE_CHANNELS` in `build/apply-overlay.mjs` — standing gotcha: the
  preload silently rejects unlisted channels.
- Positioning note for GTM material: the trust story changes from "reads everything,
  touches nothing" to "nothing leaves without your explicit confirmation"; mode A default
  is the load-bearing claim.

## 9. Ingestion enrichment (Gmail reply-all)

Gmail thread docs currently keep per-message sender but not per-message `to`/`cc`.
Enrich `sources/gmail/to-document.ts` to store per-message recipients in `messages[]`.
Until a doc is re-pulled with enriched metadata, `reply_all` falls back per §4.

## 10. In-app Outbox history (deferred-late phase)

A simple history/pending list in the core renderer (drafts, statuses, resend/discard).
Not on the critical path — confirmation happens on the served pages — but valuable as
audit surface.

## 11. Testing

- **Resolution layer:** reply / reply-all from Gmail and IMAP metadata fixtures;
  missing-metadata → explicit error, never a guess.
- **State machine:** draft → sending → sent/failed/discarded/expired transitions;
  single-use link death on every terminal status; pending cap.
- **Signed URLs:** signature validation, TTL expiry, Host/Origin checks, GET never
  mutates, POST requires valid token.
- **SMTP transport:** against a mock server, including Sent-append.
- **Gmail:** scope-list assertion updates; send with threadId (mocked API).
- **Mode routing:** `send_draft` rejected for non-C accounts; tool results carry the
  right per-mode payload.
- **Fixture-harness smoke (product repo):** four tools visible in `tools/list`; a draft
  round-trips to `sent` in each mode.

## 12. Build order

Each phase is independently landable:

1. **Outbox core** — schema migration, outbox service/state machine, `draft_reply` /
   `draft_message` / `list_outbox` with IMAP-first resolution, pending cap.
2. **Confirm pages** — signed URLs, loopback routes, mode A page, mode B minimal page,
   mode config in Settings (global + per-account).
3. **SMTP send pipeline** — Sender contract, smtp sender, Sent-append, corpus loop
   verified.
4. **Remote confirm** — tunnel routing, OAuth carve-out for `/outbox/confirm/*`.
5. **Gmail transport** — `gmail.send` scope, re-consent via gmail-gate, gmail sender.
6. **Mode C** — `send_draft` tool, per-account opt-in, rate limit.
7. **Gmail reply-all enrichment** (§9).
8. **Slack pilot sender** — `send` cap + `contributes.senders` in manifest, extension
   sender RPC, pilot in `kia-plugins/slack-kia-connector` (`chat.postMessage`; user adds
   `chat:write` to their internal app). Chosen over WhatsApp for the pilot: pure HTTPS,
   token already pasted, no live-socket lifecycle.
9. **Outbox history panel** (§10).

## 13. Resolved design decisions

- Draft-first for every mode; no autonomous send in MVP (user decision 2026-07-23).
- Tool scope: reply + compose-new; compose is email-only (user decision).
- Transports: SMTP + Gmail API send (user decision).
- Confirmation UX: served confirm pages / signed links / chat-confirm instead of an
  in-app approval panel (user decision); POST-behind-button everywhere.
- Mode B links: signed, short TTL (~5 min), single-use (user decision).
- Mode C: in-chat draft display + explicit user agreement before `send_draft` (user
  decision).
