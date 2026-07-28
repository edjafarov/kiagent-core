/**
 * The outbound layer's hub (spec §2): draft creation grounded in stored
 * documents, per-account confirmation modes, signed confirm URLs, and (from
 * Task 7) the confirm/cancel/send pipeline. Everything a tool returns is
 * JSON-serializable so the stdio sibling can proxy it verbatim.
 */
import type {
  Account,
  AccountId,
  ConfirmMode,
  DocumentId,
  OutboxRow,
  OutboxStatus,
  Prefs,
  SendIntent,
  SendResult,
  Sender,
} from '@shared/contracts';

import { currentTransport } from '../core/mcp/transport-context';
import type { LogSink } from '../core/engine/engine';
import type { CoreStore } from '../core/store/store';
import { isShapedSummary, shapeOutboundError } from './error-copy';
import { EMAIL_RX, selfAddressesFor, senderAddressFor } from './identity';
import { resolveImapReply } from './resolve';
import { resolveGmailReply } from './resolve-gmail';
// Type-only on purpose: the bundled senders (and their nodemailer/imapflow
// dependencies) must not be pulled into this module's runtime graph.
import type { SenderLookup } from './senders';
import { signConfirmToken, verifyConfirmToken } from './tokens';

export const CONFIRM_TTL_MS: Record<ConfirmMode, number> = {
  review: 30 * 60_000,
  link: 5 * 60_000,
  // Chat drafts carry no confirm URL of their own; this TTL is only spent on
  // the page-confirm fallback list_outbox re-links for them (spec mode C).
  chat: 30 * 60_000,
};
export const DRAFT_TTL_MS = 24 * 60 * 60_000;

/** gmail's `GmailReplyResolution` carries no subject — resolve-gmail.ts
 *  resolves recipients/threading only — so this mirrors resolve.ts's
 *  `Re: <title>` rule from the thread document's own title, the same way
 *  the imap path derives one from the message document's title. */
function subjectFor(title: string | null): string | null {
  return title === null ? null : /^re:/i.test(title) ? title : `Re: ${title}`;
}

export interface DraftToolResult {
  draft_id: string;
  mode: ConfirmMode;
  recipient_display: string;
  /** Absent for chat mode: the model confirms in conversation and calls
   *  send_draft — the page fallback link is re-issued by list_outbox. */
  confirm_url?: string;
  to?: string[]; // link + chat modes
  cc?: string[]; // link + chat modes
  subject?: string | null; // link + chat modes
  body?: string; // link + chat modes
  warnings: string[];
  instruction: string;
}

export interface OutboxListItem {
  draft_id: string;
  status: OutboxStatus;
  recipient_display: string;
  subject: string | null;
  created_at: string;
  error: string | null;
  confirm_url: string | null; // re-issued for status 'draft', else null
}

/** What `send_draft` reports back once a chat-confirmed draft has been sent
 *  (spec mode C). Terminal by construction: the only status it can carry is
 *  'sent' — every other outcome throws. */
export interface SendDraftResult {
  draft_id: string;
  status: 'sent';
  recipient_display: string;
  external_message_id: string | null;
}

/** The slice the MCP tools (and the stdio proxy) need — JSON-serializable
 *  args and results on every method. */
export interface OutboundToolApi {
  draftReply(a: {
    documentId: string;
    body: string;
    replyAll?: boolean;
  }): Promise<DraftToolResult>;
  draftMessage(a: {
    accountId: string;
    to: string[];
    subject: string;
    body: string;
  }): Promise<DraftToolResult>;
  listOutbox(a: { limit?: number }): Promise<OutboxListItem[]>;
  sendDraft(a: { draftId: string }): Promise<SendDraftResult>;
}

export type PeekResult =
  | { kind: 'ok'; row: OutboxRow; mode: ConfirmMode }
  | { kind: 'gone'; row: OutboxRow } // any non-draft status
  | { kind: 'invalid' };

export type ConfirmOutcome =
  | { kind: 'sent'; row: OutboxRow }
  | { kind: 'cancelled'; row: OutboxRow }
  | { kind: 'failed'; row: OutboxRow; error: string }
  | { kind: 'already'; row: OutboxRow } // link raced/reused
  | { kind: 'invalid' };

export interface OutboundService extends OutboundToolApi {
  peekByToken(token: string): Promise<PeekResult>;
  confirmByToken(token: string): Promise<ConfirmOutcome>; // Task 7 fills in
  cancelByToken(token: string): Promise<ConfirmOutcome>; // Task 7 fills in
  setBaseUrl(url: string): void;
  /** Product pushes the public device base URL (https://<device-subdomain>)
   *  when the remote HTTPS server is up, null when it goes down. */
  setRemoteBaseUrl(url: string | null): void;
  /** Panel support (spec §10): a fresh confirm URL for a row the user can
   *  still act on — a pending draft, or a `failed` row whose stored error
   *  PROVES the message was never accepted (that one lands on failedPage's
   *  shipped "Try again"). Null for everything else.
   *
   *  PANEL-ONLY — never an `/outbox/api` op, never on `OutboundToolApi`:
   *  routes.ts:339-379 dispatches that interface by name over the loopback
   *  JSON plane, and these two must stay off it. */
  confirmUrlFor(draftId: string): Promise<string | null>;
  /** Panel support (spec §10): duplicate a terminal row (`failed`,
   *  `expired`, `discarded` — NEVER `delivery_unknown`) into a fresh draft.
   *  Content, recipients and threading copied verbatim; mode re-frozen from
   *  the account's effective setting; fresh 24h TTL; createdVia 'panel'.
   *
   *  PANEL-ONLY — see confirmUrlFor. */
  redraft(draftId: string): Promise<OutboxRow>;
}

export function createOutboundService(deps: {
  store: CoreStore;
  prefs: Prefs;
  /** Either the bare bundled Map or an already-composed lookup (bundled +
   *  extension senders). Normalized to a lookup immediately below, so every
   *  existing caller keeps passing a Map unchanged. */
  senders: Map<string, Sender> | SenderLookup;
  logSink: LogSink;
  nowMs?: () => number; // injectable clock for tests; default Date.now
}): OutboundService {
  // Bound to a local first: property narrowing on `deps.senders` would not
  // survive into the closures below. Lazy by construction — the Map is read
  // on every call, never copied — so a sender registered after the service
  // was built is still visible to it.
  const { senders } = deps;
  const lookup: SenderLookup =
    senders instanceof Map
      ? { get: (id) => senders.get(id), ids: () => [...senders.keys()] }
      : senders;
  // Token expiry (CONFIRM_TTL_MS) and draft-row expiresAt (DRAFT_TTL_MS) are
  // both minted off THIS clock. The store's own expireOverdue() sweep reads
  // `expires_at` against its OWN wall clock (outbox.ts's `deps.now()`) —
  // a test that fast-forwards nowMs here does NOT move that sweep, and vice
  // versa. Don't assume the two are the same clock.
  const nowMs = deps.nowMs ?? (() => Date.now());
  let baseUrl: string | null = null;
  let remoteBaseUrl: string | null = null;

  // Picks the confirm-URL origin for the CURRENT call's transport, at mint
  // time — so a draft created locally but listed via list_outbox on the
  // remote transport gets a remote URL (the user is on their phone), and
  // vice versa. Also doubles as the readiness gate: called first thing in
  // every tool method (via assertReady) so a cold/unset base refuses before
  // any store access, never leaving an orphan draft row behind.
  const baseFor = (): string => {
    if (currentTransport() === 'remote') {
      if (!remoteBaseUrl) {
        throw new Error(
          'Outbound drafting over the remote connection needs remote ' +
            'access fully set up on the KIAgent machine — or use an MCP ' +
            'client on that machine directly.',
        );
      }
      return remoteBaseUrl;
    }
    if (!baseUrl) throw new Error('outbound: server not ready');
    return baseUrl;
  };

  const assertReady = (): void => {
    baseFor();
  };

  const createdViaNow = (): 'mcp-local' | 'mcp-remote' =>
    currentTransport() === 'remote' ? 'mcp-remote' : 'mcp-local';

  const modeFor = (account: Account): ConfirmMode => {
    const cfg = (account.config as { outbound?: { mode?: unknown } }).outbound;
    if (cfg?.mode === 'review' || cfg?.mode === 'link') return cfg.mode;
    // Optional access on purpose: partial Prefs fakes (tests) and pre-Task-9
    // pref files have no `outbound` slice yet.
    const p = deps.prefs.get() as {
      outbound?: { defaultMode?: ConfirmMode };
    };
    return p.outbound?.defaultMode ?? 'review';
  };

  const accountFor = async (id: string): Promise<Account> => {
    const account = await deps.store.account(id as AccountId);
    if (!account) throw new Error(`outbound: unknown account '${id}'`);
    if (!lookup.get(account.source)) {
      throw new Error(
        `sending from '${account.source}' accounts is not supported yet — ` +
          `supported: ${lookup.ids().join(', ')}`,
      );
    }
    return account;
  };

  // Sync half — takes an already-fetched secret so a caller minting several
  // URLs in one pass (listOutbox) pays for the secret's meta-read+decrypt
  // once, not once per row.
  const buildConfirmUrl = (
    secret: Buffer,
    draftId: string,
    mode: ConfirmMode,
  ): string => {
    const base = baseFor();
    const token = signConfirmToken(
      secret,
      draftId,
      nowMs() + CONFIRM_TTL_MS[mode],
    );
    return `${base}/outbox/confirm/${token}`;
  };

  const confirmUrl = async (
    draftId: string,
    mode: ConfirmMode,
  ): Promise<string> => {
    const secret = await deps.store.outbox.secret();
    return buildConfirmUrl(secret, draftId, mode);
  };

  const toolResult = async (
    row: OutboxRow,
    warnings: string[],
  ): Promise<DraftToolResult> => {
    const mode = row.confirmMode;
    if (mode === 'chat') {
      // Mode C: no link at all — the model renders the draft, the user says
      // yes in the conversation, and send_draft carries out the send. The
      // page confirm stays available as a fallback via list_outbox, which
      // re-issues a URL for any pending row (including this one), so nothing
      // is lost if the model never calls send_draft.
      return {
        draft_id: row.id,
        mode,
        recipient_display: row.recipientDisplay,
        to: row.to,
        cc: row.cc,
        subject: row.subject,
        body: row.bodyMarkdown,
        warnings,
        instruction:
          `Show the user this draft exactly as written — recipient, ` +
          `subject, and body verbatim — and ask whether to send it. Call ` +
          `send_draft with this draft_id ONLY after the user explicitly ` +
          `agrees in this conversation. If they want changes, create a new ` +
          `draft instead. Never call send_draft without a clear yes.`,
      };
    }
    const url = await confirmUrl(row.id, mode);
    if (mode === 'review') {
      return {
        draft_id: row.id,
        mode,
        recipient_display: row.recipientDisplay,
        confirm_url: url,
        warnings,
        instruction:
          `Draft created — nothing has been sent. Show the user this link ` +
          `to review and send the message: ${url} (it expires in ` +
          `${CONFIRM_TTL_MS.review / 60_000} minutes; if it expires, call ` +
          `list_outbox for a fresh one).`,
      };
    }
    return {
      draft_id: row.id,
      mode,
      recipient_display: row.recipientDisplay,
      confirm_url: url,
      to: row.to,
      cc: row.cc,
      subject: row.subject,
      body: row.bodyMarkdown,
      warnings,
      instruction:
        `Draft created — nothing has been sent. Render the draft exactly ` +
        `as returned (recipient, subject, body) for the user to review in ` +
        `chat, then present this link as the send action: ${url}. It opens ` +
        `a page with a Send button; the link expires in ` +
        `${CONFIRM_TTL_MS.link / 60_000} minutes — call list_outbox for a ` +
        `fresh one if needed.`,
    };
  };

  const expiresAt = (): string =>
    new Date(nowMs() + DRAFT_TTL_MS).toISOString();

  /** The send pipeline itself, shared by every confirmation surface (page
   *  confirm and chat's send_draft). PRECONDITION: the caller has already
   *  won the CAS that moved this row into 'sending' — this function owns the
   *  row from there on and always leaves it in a terminal state (or, for a
   *  bookkeeping throw after a successful send, in 'sending' for the
   *  boot-time recovery sweep; see the comment on the send attempt below).
   *  `row` is the pre-CAS snapshot: nothing the CAS writes is read here. */
  const executeSend = async (row: OutboxRow): Promise<ConfirmOutcome> => {
    const fail = async (message: string): Promise<ConfirmOutcome> => {
      // Store the classifier's short summary, never the raw error — the
      // page, list_outbox, and logs all read this column, and render-time
      // re-classification of the summary gates the Try-again button
      // (fixed-point property tested in error-copy.test.ts).
      const errMsg = shapeOutboundError(message).summary;
      const failMoved = await deps.store.outbox.transition(
        row.id,
        ['sending'],
        'failed',
        { error: errMsg },
      );
      if (!failMoved) {
        // Unreachable in-process today — nothing else moves a 'sending'
        // row concurrently — but if it ever does, this is the trace.
        deps.logSink.log(
          'outbound',
          'error',
          `confirm ${row.id}: 'sending'->'failed' found no matching row (concurrent mutation?)`,
          { draftId: row.id },
        );
      }
      const failedRow = await deps.store.outbox.get(row.id);
      deps.logSink.log(
        'outbound',
        'error',
        `confirm ${row.id} failed: ${errMsg}`,
        {
          draftId: row.id,
        },
      );
      return { kind: 'failed', row: failedRow ?? row, error: errMsg };
    };

    let sender: Sender;
    try {
      // accountFor already validates the account exists AND that a sender
      // is registered for its source — the re-check below is defense in
      // depth (never observed to trip), not a second independent lookup.
      const account = await accountFor(row.accountId as string);
      const found = lookup.get(account.source);
      if (!found) {
        throw new Error(
          `sending from '${account.source}' accounts is not supported yet — ` +
            `supported: ${lookup.ids().join(', ')}`,
        );
      }
      sender = found;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(message);
    }

    const intent: SendIntent = {
      accountId: row.accountId,
      kind: row.kind,
      outboundRef: row.outboundRef ?? undefined,
      to: row.to,
      cc: row.cc,
      subject: row.subject ?? undefined,
      bodyMarkdown: row.bodyMarkdown,
      threading: row.threading ?? undefined,
    };

    // Only the send attempt itself is caught here. A throw from this
    // block is recorded as 'failed' and classified by shapeOutboundError:
    // provably-rejected kinds (quota/auth) render a retryable page,
    // ambiguous kinds (timeout/5xx/network) render delivery-uncertain
    // copy — the row status alone no longer claims the message never
    // left. Everything AFTER a successful send (the DB transition, the re-read,
    // the log line) sits outside the catch on purpose: once sender.send()
    // has resolved, the message may already be gone out over the wire, so
    // a bookkeeping throw here must never be reported as 'failed' (that
    // would invite the user to re-draft and double-send). If bookkeeping
    // throws, the row is simply left in 'sending' — the boot-time
    // recovery sweep classifies it 'delivery_unknown', which is the
    // honest "it may have sent, go check" outcome for that case.
    let result: SendResult;
    try {
      result = await sender.send(intent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return fail(message);
    }

    const sentMoved = await deps.store.outbox.transition(
      row.id,
      ['sending'],
      'sent',
      {
        sentAt: new Date(nowMs()).toISOString(),
        externalMessageId: result?.externalMessageId ?? null,
      },
    );
    if (!sentMoved) {
      // Unreachable in-process today — nothing else moves a 'sending'
      // row concurrently — but if it ever does, this is the trace.
      deps.logSink.log(
        'outbound',
        'error',
        `confirm ${row.id}: 'sending'->'sent' found no matching row (concurrent mutation?)`,
        { draftId: row.id },
      );
    }
    const sentRow = await deps.store.outbox.get(row.id);
    deps.logSink.log('outbound', 'info', `confirm ${row.id} sent`, {
      draftId: row.id,
    });
    return { kind: 'sent', row: sentRow ?? row };
  };

  /** Per-account hourly send cap for mode C — a hidden `config.outbound`
   *  knob (no UI). The chat opt-in is global; this bound stays per account
   *  so one runaway conversation cannot drain an account. */
  const sendsPerHourFor = (account: Account): number => {
    const cfg =
      (account.config as { outbound?: { sendsPerHour?: unknown } }).outbound ??
      {};
    const n = Number(cfg.sendsPerHour);
    return Number.isFinite(n) && n > 0 ? n : 30;
  };

  return {
    setBaseUrl(url) {
      baseUrl = url;
    },

    setRemoteBaseUrl(url) {
      remoteBaseUrl = url;
    },

    async draftReply({ documentId, body, replyAll }) {
      assertReady();
      const doc = await deps.store.read.document(documentId as DocumentId);
      if (!doc)
        throw new Error(`draft_reply: unknown document '${documentId}'`);
      const account = await accountFor(doc.accountId as string);
      const mode = modeFor(account);

      // Universality hook (spec §6): a source that wrote metadata.outbound
      // owns its reply addressing — the ref is opaque and round-trips to
      // that source's Sender verbatim. Bundled email resolution otherwise.
      const outboundMeta = doc.metadata.outbound as
        | { ref?: unknown; display?: unknown }
        | undefined;
      let row: OutboxRow;
      let warnings: string[] = [];
      if (outboundMeta && typeof outboundMeta.display === 'string') {
        row = await deps.store.outbox.create({
          accountId: account.id,
          kind: 'reply',
          replyToDocumentId: doc.id,
          outboundRef: outboundMeta.ref,
          recipientDisplay: outboundMeta.display,
          to: [],
          cc: [],
          subject: null,
          bodyMarkdown: body,
          confirmMode: mode,
          createdVia: createdViaNow(),
          expiresAt: expiresAt(),
        });
      } else if (account.source === 'gmail') {
        const r = resolveGmailReply(
          doc,
          selfAddressesFor(account),
          replyAll === true,
        );
        warnings = r.warnings;
        row = await deps.store.outbox.create({
          accountId: account.id,
          kind: 'reply',
          replyToDocumentId: doc.id,
          recipientDisplay: r.recipientDisplay,
          to: r.to,
          cc: r.cc,
          subject: subjectFor(doc.title ?? null),
          bodyMarkdown: body,
          threading: r.threading,
          confirmMode: mode,
          createdVia: createdViaNow(),
          expiresAt: expiresAt(),
        });
      } else if (account.source !== 'imap') {
        // A document from an extension-sender source that carries no
        // metadata.outbound: its source never wrote a reply ref for it (not
        // every document type is replyable). Falling through to the imap
        // resolver would call selfAddressesFor() and surface identity.ts's
        // COMPOSE refusal ('compose is email-only') on a REPLY — true, and
        // useless — so name the real gap instead.
        throw new Error(
          `this document has no reply target — its source did not record ` +
            `one for it; only documents synced with reply support can be ` +
            `replied to`,
        );
      } else {
        const r = resolveImapReply(
          doc,
          selfAddressesFor(account),
          replyAll === true,
        );
        warnings = r.warnings;
        row = await deps.store.outbox.create({
          accountId: account.id,
          kind: 'reply',
          replyToDocumentId: doc.id,
          recipientDisplay: r.recipientDisplay,
          to: r.to,
          cc: r.cc,
          subject: r.subject,
          bodyMarkdown: body,
          threading: r.threading,
          confirmMode: mode,
          createdVia: createdViaNow(),
          expiresAt: expiresAt(),
        });
      }
      return toolResult(row, warnings);
    },

    async draftMessage({ accountId, to, subject, body }) {
      assertReady();
      const account = await accountFor(accountId);
      senderAddressFor(account); // fail fast when no From address resolves
      const trimmed = to.map((t) => t.trim());
      const bad = trimmed.filter((t) => !EMAIL_RX.test(t));
      if (trimmed.length === 0 || bad.length > 0) {
        throw new Error(
          `draft_message: invalid recipient address(es): ${bad.join(', ') || '(none given)'}`,
        );
      }
      const row = await deps.store.outbox.create({
        accountId: account.id,
        kind: 'new',
        recipientDisplay: trimmed.join(', '),
        to: trimmed,
        cc: [],
        subject,
        bodyMarkdown: body,
        confirmMode: modeFor(account),
        createdVia: createdViaNow(),
        expiresAt: expiresAt(),
      });
      return toolResult(row, []);
    },

    async listOutbox({ limit }) {
      assertReady();
      await deps.store.outbox.expireOverdue();
      // The model supplies `limit` straight from tool args (list-outbox.ts
      // only checks `typeof === 'number'`, so NaN/Infinity can still arrive)
      // and it reaches outbox.ts's `LIMIT ?` unclamped — SQLite treats a
      // negative LIMIT as UNBOUNDED, so an unclamped -1 would return the
      // entire table. Clamp here, at the service boundary, to a sane
      // [1, 100] window regardless of what was asked for.
      const clampedLimit =
        typeof limit === 'number' && Number.isFinite(limit)
          ? Math.min(100, Math.max(1, Math.floor(limit)))
          : 20;
      const rows = await deps.store.outbox.listRecent(clampedLimit);
      // Fetch the (decrypted) secret at most once per call rather than once
      // per draft row — with OUTBOX_PENDING_CAP-sized listings this avoids
      // up to 20 sequential meta-reads+decrypts for the same 32 bytes.
      const secret = rows.some((r) => r.status === 'draft')
        ? await deps.store.outbox.secret()
        : null;
      const out: OutboxListItem[] = [];
      for (const row of rows) {
        let url: string | null = null;
        if (row.status === 'draft') {
          url = buildConfirmUrl(secret as Buffer, row.id, row.confirmMode);
        }
        out.push({
          draft_id: row.id,
          status: row.status,
          recipient_display: row.recipientDisplay,
          subject: row.subject,
          created_at: row.createdAt,
          // A retried failed->sent row keeps its stale error string in the DB
          // by design (audit trail — see executeSend's fail() comment);
          // gate what the MODEL sees on the row's CURRENT status so a
          // successfully-retried send is never reported back as still
          // failed.
          error: row.status === 'failed' ? row.error : null,
          confirm_url: url,
        });
      }
      return out;
    },

    async sendDraft({ draftId }) {
      // Deliberately NO transport gate (unlike the drafting tools): a draft
      // row can only exist if drafting was permitted on the transport that
      // created it, and the user's agreement is observed by the model
      // wherever the conversation happens. The gates that matter here are
      // the live chat opt-in and the per-account rate limit, both below.
      await deps.store.outbox.expireOverdue();
      const row = await deps.store.outbox.get(draftId);
      if (!row) throw new Error(`send_draft: unknown draft '${draftId}'`);

      // The FROZEN mode: a draft created under page confirmation is never
      // sendable by tool call, no matter what the settings say now.
      if (row.confirmMode !== 'chat') {
        throw new Error(
          `send_draft is only honored for chat-mode drafts — this draft is ` +
            `mode '${row.confirmMode}'. Use list_outbox to get its ` +
            `confirmation link instead.`,
        );
      }

      const account = await accountFor(row.accountId as string);

      // ...and the LIVE opt-in: turning chat mode off globally, or setting
      // this account back to review/link, must kill pending chat sends
      // rather than leaving a tool call armed against the user's current
      // intent. Both must be chat for the send to proceed.
      const mode = modeFor(account);
      if (mode !== 'chat') {
        throw new Error(
          `send_draft: this account is no longer in chat mode (it is now ` +
            `'${mode}') — chat sending was turned off after this draft was ` +
            `created. Use list_outbox to get a confirmation link instead.`,
        );
      }

      const limit = sendsPerHourFor(account);
      const sinceIso = new Date(nowMs() - 60 * 60_000).toISOString();
      const sentLastHour = await deps.store.outbox.countSentSince(
        account.id,
        sinceIso,
      );
      if (sentLastHour >= limit) {
        throw new Error(
          `send_draft: rate limit reached — ${sentLastHour} message(s) ` +
            `already sent from this account in the last hour (limit ` +
            `${limit}). The draft is still pending; try again later or use ` +
            `list_outbox for a confirmation link.`,
        );
      }

      // Same CAS gate the page confirm uses — the single-use property and
      // the race protection live here, not in the checks above.
      const moved = await deps.store.outbox.transition(
        row.id,
        ['draft'],
        'sending',
      );
      if (!moved) {
        const current = await deps.store.outbox.get(row.id);
        throw new Error(
          `send_draft: this draft can no longer be sent — its status is ` +
            `'${current?.status ?? 'unknown'}'.`,
        );
      }

      const outcome = await executeSend(row);
      if (outcome.kind !== 'sent') {
        const detail =
          outcome.kind === 'failed'
            ? outcome.error
            : `the draft ended in state '${outcome.kind}'`;
        // shapeOutboundError's `unknown` branch already emits summaries
        // prefixed `send failed: `, so re-prefixing here would double it on
        // the commonest failure path. The prefix convention belongs to
        // error-copy.ts — ask it rather than re-testing its regex here, so
        // this stays correct if that convention ever changes.
        throw new Error(
          isShapedSummary(detail) ? detail : `send failed: ${detail}`,
        );
      }
      return {
        draft_id: row.id,
        status: 'sent',
        // Read off the post-transition re-read, never the pre-CAS snapshot:
        // that one still carries a null external id.
        recipient_display: outcome.row.recipientDisplay,
        external_message_id: outcome.row.externalMessageId ?? null,
      };
    },

    async peekByToken(token) {
      const secret = await deps.store.outbox.secret();
      const parsed = verifyConfirmToken(secret, token, nowMs());
      if (!parsed) return { kind: 'invalid' };
      await deps.store.outbox.expireOverdue();
      const row = await deps.store.outbox.get(parsed.draftId);
      if (!row) return { kind: 'invalid' };
      if (row.status !== 'draft') return { kind: 'gone', row };
      return { kind: 'ok', row, mode: row.confirmMode };
    },

    async confirmByToken(token) {
      const secret = await deps.store.outbox.secret();
      const parsed = verifyConfirmToken(secret, token, nowMs());
      if (!parsed) return { kind: 'invalid' };
      // Mirror peekByToken's lazy sweep: a token minted near the end of its
      // (short) TTL can still be nominally valid past the draft row's own
      // (much longer) expires_at if nothing called peekByToken/listOutbox
      // first to trigger the sweep — without this, the CAS below would
      // happily move an expired draft into 'sending'.
      await deps.store.outbox.expireOverdue();
      const row = await deps.store.outbox.get(parsed.draftId);
      if (!row) return { kind: 'invalid' };
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
      if (!moved) {
        const raced = await deps.store.outbox.get(row.id);
        return { kind: 'already', row: raced ?? row };
      }

      return executeSend(row);
    },

    async cancelByToken(token) {
      const secret = await deps.store.outbox.secret();
      const parsed = verifyConfirmToken(secret, token, nowMs());
      if (!parsed) return { kind: 'invalid' };
      const row = await deps.store.outbox.get(parsed.draftId);
      if (!row) return { kind: 'invalid' };

      const moved = await deps.store.outbox.transition(
        row.id,
        ['draft'],
        'discarded',
      );
      if (!moved) {
        const current = await deps.store.outbox.get(row.id);
        return { kind: 'already', row: current ?? row };
      }
      const discarded = await deps.store.outbox.get(row.id);
      return { kind: 'cancelled', row: discarded ?? row };
    },

    async confirmUrlFor(draftId) {
      // No assertReady() on purpose: a row that is not openable must return
      // null so the caller can name its status, rather than throwing a
      // readiness error. A cold base still surfaces from confirmUrl below.
      await deps.store.outbox.expireOverdue();
      const row = await deps.store.outbox.get(draftId);
      if (!row) return null;
      if (row.status === 'draft') return confirmUrl(row.id, row.confirmMode);
      // A failed row is re-confirmable ONLY when its stored error classifies
      // as provably-not-sent — the same gate confirmByToken applies
      // (service.ts:706-714). The token lands on gonePage → failedPage,
      // which ships a live "Try again" POST, and the CAS there uses the
      // OBSERVED status as its from-state, so this cannot double-send.
      // Strictly better than re-drafting for this class: same row, shipped
      // page, shipped copy.
      if (
        row.status === 'failed' &&
        shapeOutboundError(row.error ?? '').canRetry
      ) {
        return confirmUrl(row.id, row.confirmMode);
      }
      return null;
    },

    async redraft(draftId) {
      // Same readiness gate every drafting tool uses, and for the same
      // reason (service.ts:155-158): refuse BEFORE the insert, so a cold or
      // unset base can never leave an orphan draft row behind.
      assertReady();
      await deps.store.outbox.expireOverdue();
      const row = await deps.store.outbox.get(draftId);
      if (!row) throw new Error(`redraft: unknown draft '${draftId}'`);
      if (row.status === 'delivery_unknown') {
        // Deliberately NOT re-draftable. executeSend's fail() comment
        // (service.ts:370-378) and routes.ts:126-132 both exist to stop the
        // app from inviting a duplicate send on a message that MAY have gone
        // out. This refusal is that policy at the service boundary.
        throw new Error(
          `this message may already have been sent — its status is ` +
            `'delivery_unknown'. Check your Sent folder before creating a ` +
            `new draft.`,
        );
      }
      if (
        row.status !== 'failed' &&
        row.status !== 'expired' &&
        row.status !== 'discarded'
      ) {
        throw new Error(
          `only failed, expired, or discarded drafts can be re-drafted — ` +
            `this one is '${row.status}'`,
        );
      }
      // Account-gone and unsupported-source refusals, identical to
      // draft_reply time (service.ts:191-201), read live off the lookup.
      const account = await accountFor(row.accountId as string);
      // Deliberately NO re-resolution: outboundRef / to / cc / threading are
      // copied verbatim off the frozen row. Re-running the resolver could
      // surface the "this document has no reply target" refusal
      // (service.ts:494-498) for a row that already HAS a valid target, and
      // could silently re-target a reply if the thread moved.
      // create() itself runs expireOverdue() and enforces
      // OUTBOX_PENDING_CAP (outbox.ts:171-217) — no extra gate needed here.
      return deps.store.outbox.create({
        accountId: row.accountId,
        kind: row.kind,
        replyToDocumentId: row.replyToDocumentId,
        outboundRef: row.outboundRef,
        recipientDisplay: row.recipientDisplay,
        to: row.to,
        cc: row.cc,
        subject: row.subject,
        bodyMarkdown: row.bodyMarkdown,
        threading: row.threading,
        // The account's effective mode — per-account override, else the
        // global default. NOT the old row's frozen mode, which is history.
        // Note this can resolve to 'chat' from a GLOBAL setting flipped
        // since: the fresh row then carries no confirm URL of its own, and
        // the panel's own link falls through to the FULL review page
        // (routes.ts:176-187). Intended, and strictly stronger.
        confirmMode: modeFor(account),
        createdVia: 'panel',
        expiresAt: expiresAt(),
      });
    },
  };
}
