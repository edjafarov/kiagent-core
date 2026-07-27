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
import { shapeOutboundError } from './error-copy';
import { EMAIL_RX, selfAddressesFor, senderAddressFor } from './identity';
import { resolveImapReply } from './resolve';
import { resolveGmailReply } from './resolve-gmail';
import { signConfirmToken, verifyConfirmToken } from './tokens';

export const CONFIRM_TTL_MS: Record<ConfirmMode, number> = {
  review: 30 * 60_000,
  link: 5 * 60_000,
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
  confirm_url: string;
  to?: string[]; // link mode only
  cc?: string[]; // link mode only
  subject?: string | null; // link mode only
  body?: string; // link mode only
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
}

export function createOutboundService(deps: {
  store: CoreStore;
  prefs: Prefs;
  senders: Map<string, Sender>;
  logSink: LogSink;
  nowMs?: () => number; // injectable clock for tests; default Date.now
}): OutboundService {
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
    if (!deps.senders.has(account.source)) {
      throw new Error(
        `sending from '${account.source}' accounts is not supported yet — ` +
          `supported: ${[...deps.senders.keys()].join(', ')}`,
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
          // by design (audit trail — see confirmByToken's fail() comment);
          // gate what the MODEL sees on the row's CURRENT status so a
          // successfully-retried send is never reported back as still
          // failed.
          error: row.status === 'failed' ? row.error : null,
          confirm_url: url,
        });
      }
      return out;
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
        const found = deps.senders.get(account.source);
        if (!found) {
          throw new Error(
            `sending from '${account.source}' accounts is not supported yet — ` +
              `supported: ${[...deps.senders.keys()].join(', ')}`,
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

      // Only the send attempt itself is caught here — a throw from this
      // block means the message was never accepted, so 'failed' is honest.
      // Everything AFTER a successful send (the DB transition, the re-read,
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
  };
}
