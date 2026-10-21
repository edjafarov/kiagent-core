/**
 * The outbound layer's hub (spec §2): draft creation grounded in stored
 * documents, per-account confirmation modes, signed confirm URLs, and (from
 * Task 7) the confirm/cancel/send pipeline. Everything a tool returns is
 * JSON-serializable so the stdio sibling can proxy it verbatim.
 */
import os from 'node:os';
import path from 'node:path';

import type {
  Account,
  AccountId,
  ConfirmMode,
  DocumentId,
  DraftMirror,
  DraftPatch,
  DraftSnapshot,
  OutboxAttachment,
  OutboxRow,
  OutboxStatus,
  Prefs,
  SendIntent,
  SendResult,
  Sender,
  SourceDescriptor,
} from '@shared/contracts';

import { withLogMessage } from '../core/mcp/log-safe';
import {
  currentClient,
  currentTransport,
  type McpTransport,
} from '../core/mcp/transport-context';
import type { LogSink } from '../core/engine/engine';
import {
  DRAFT_TTL_MS,
  normalizeSnapshot,
  snapshotOf,
} from '../core/store/outbox';
import type { CoreStore } from '../core/store/store';
import { createDraftLock } from './draft-lock';
import { isShapedSummary, shapeOutboundError } from './error-copy';
import { EMAIL_RX, selfAddressesFor, senderAddressFor } from './identity';
import {
  MIRROR_CALL_DEADLINE_MS,
  createMirrorOps,
  deadline,
  intentOf,
  providerLabel,
} from './mirror';
import {
  checkAttachments,
  type AttachmentBytes,
  type AttachmentInput,
  type AttachmentsApi,
} from './attachments';
import { resolveImapReply } from './resolve';
import { renderEmailBody } from './email-body';
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
export { DRAFT_TTL_MS };

/** gmail's `GmailReplyResolution` carries no subject — resolve-gmail.ts
 *  resolves recipients/threading only — so this mirrors resolve.ts's
 *  `Re: <title>` rule from the thread document's own title, the same way
 *  the imap path derives one from the message document's title. */
function subjectFor(title: string | null): string | null {
  return title === null ? null : /^re:/i.test(title) ? title : `Re: ${title}`;
}

/** Where an attachment came from, for every review surface. */
export function originOf(a: OutboxAttachment, provider?: string): string {
  if (!a.from) return `added in ${provider ?? 'the mail app'}`;
  if (a.from.kind === 'document') return 'from your indexed documents';
  const home = os.homedir();
  const p = a.from.path;
  return `from ${p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p}`;
}

/** One reply variant a source stored in `metadata.outbound`: the opaque
 *  `ref` round-tripped to its Sender, the `display` the user confirms, and —
 *  for email-shaped sources (ms365) — the exact `to`/`cc` addresses, which
 *  the draft row freezes so every surface shows real recipients. The
 *  metadata is source-written and untyped, so every field is validated;
 *  `to`/`cc`, when present, must be arrays of addresses. */
interface OutboundVariant {
  ref: unknown;
  display: string;
  to: string[];
  cc: string[];
}

function parseVariant(v: unknown): OutboundVariant | 'malformed' | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as {
    ref?: unknown;
    display?: unknown;
    to?: unknown;
    cc?: unknown;
  };
  if (typeof o.display !== 'string') return undefined;
  const addrs = (x: unknown): string[] | null =>
    x === undefined
      ? []
      : Array.isArray(x) &&
          x.every((a) => typeof a === 'string' && EMAIL_RX.test(a))
        ? (x as string[])
        : null;
  const to = addrs(o.to);
  const cc = addrs(o.cc);
  if (to === null || cc === null) return 'malformed';
  return { ref: o.ref, display: o.display, to, cc };
}

/** Pick the stored reply variant for a `draft_reply` call: an explicit
 *  per-message `target` key (e.g. a Slack day doc lists one per message so
 *  a reply can thread under it) wins; else `replyAll` when asked for and
 *  stored; else the document's default. Grounding holds because the model
 *  picks a key or a flag, never supplies a ref or an address. Undefined =
 *  the document stores no outbound metadata at all. */
function pickOutbound(
  meta: unknown,
  opts: { target?: string; replyAll: boolean },
): OutboundVariant | undefined {
  const m = meta as { targets?: unknown; replyAll?: unknown } | undefined;
  const base = parseVariant(m);
  if (base === undefined) return undefined;
  const malformed = () =>
    new Error(
      `draft_reply: this document's stored reply target is malformed — ` +
        `re-sync the account and try again`,
    );
  if (base === 'malformed') throw malformed();
  if (opts.target !== undefined) {
    const hit = Array.isArray(m?.targets)
      ? (m.targets as unknown[]).find(
          (t) =>
            typeof t === 'object' &&
            t !== null &&
            (t as { key?: unknown }).key === opts.target,
        )
      : undefined;
    const picked = parseVariant(hit);
    if (picked === 'malformed') throw malformed();
    if (!picked || picked.ref === undefined)
      throw new Error(
        `draft_reply: target '${opts.target}' matches none of the reply ` +
          `targets stored in this document — use a target key the ` +
          `document shows, or omit target for its default`,
      );
    return picked;
  }
  if (opts.replyAll) {
    const all = parseVariant(m?.replyAll);
    if (all === 'malformed') throw malformed();
    if (all) return all;
  }
  return base;
}

export interface DraftToolResult {
  draft_id: string;
  /** Bumped by every change; revise_draft and send_draft name it. */
  revision: number;
  mode: ConfirmMode;
  recipient_display: string;
  /** Absent for chat mode: the model confirms in conversation and calls
   *  send_draft — the page fallback link is re-issued by list_outbox. */
  confirm_url?: string;
  /** The whole current draft, in every mode: the model has to be able to
   *  show and revise what the user will actually send. */
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string | null;
  body: string;
  /** The body as the recipient sees it (email drafts, `listOutbox({html})`
   *  only — the phone shows it; models read `body`). */
  body_html?: string;
  attachments: { filename: string; size: number; origin: string }[];
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
  /** Pending drafts only (else null): the revision and the whole current
   *  draft — show it before asking to send. */
  revision: number | null;
  draft: DraftToolResult | null;
  /** A pending draft that is scheduled (ISO): it goes then, unless it
   *  changes. */
  scheduled_for?: string;
  /** A time suggested with schedule_drafts, waiting for the user (ISO). */
  suggested_for?: string;
}

/** One draft in a `schedule_drafts` call. `send_at` null cancels. */
export interface ScheduleItem {
  draftId: string;
  revision: number;
  sendAt?: string | null;
}

/** What `schedule_drafts` did with one draft. */
export interface ScheduleItemResult {
  draft_id: string;
  status: 'scheduled' | 'suggested' | 'unscheduled' | 'unchanged' | 'error';
  send_at?: string;
  confirm_url?: string;
  revision?: number;
  error?: string;
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
    /** Key of one of the document's stored per-message reply targets
     *  (`metadata.outbound.targets[].key`) — threads the reply under that
     *  message. Omit for the document's default `metadata.outbound.ref`. */
    target?: string;
    attachments?: AttachmentInput[];
  }): Promise<DraftToolResult>;
  draftMessage(a: {
    accountId: string;
    to: string[];
    subject: string;
    body: string;
    attachments?: AttachmentInput[];
  }): Promise<DraftToolResult>;
  /** `html`: pending email drafts also carry `body_html` (the phone). */
  listOutbox(a: { limit?: number; html?: boolean }): Promise<OutboxListItem[]>;
  sendDraft(a: { draftId: string; revision: number }): Promise<SendDraftResult>;
  /** Change a pending draft in place (spec §4.2). Refuses — with the current
   *  draft in the message — when `revision` is not the row's revision. */
  reviseDraft(
    a: DraftRevision & { draftId: string; revision: number },
  ): Promise<DraftToolResult>;
  /** Times for several drafts (spec 2026-10-21 §5.1): scheduled in chat
   *  mode, suggested for the user to confirm otherwise. */
  scheduleDrafts(a: {
    drafts: ScheduleItem[];
    spread?: { start?: string; minutes: number };
  }): Promise<{ results: ScheduleItemResult[]; instruction: string }>;
}

/** The fields revise_draft may change. */
export interface DraftRevision {
  body?: string;
  subject?: string;
  to?: string[];
  cc?: string[];
  addAttachments?: AttachmentInput[];
  /** Filenames of files on the draft. */
  removeAttachments?: string[];
}

export type PeekResult =
  | { kind: 'ok'; row: OutboxRow; mode: ConfirmMode }
  | { kind: 'gone'; row: OutboxRow } // any non-draft status
  | { kind: 'invalid' };

export type ConfirmOutcome =
  | { kind: 'sent'; row: OutboxRow }
  | { kind: 'cancelled'; row: OutboxRow }
  /** `refused`: the send can't go as the draft is (a file gone or changed,
   *  files a source can't carry) — trying again later won't help. */
  | { kind: 'failed'; row: OutboxRow; error: string; refused?: boolean }
  | { kind: 'already'; row: OutboxRow } // link raced/reused
  /** The caller showed another revision than the row's: review again. */
  | { kind: 'changed'; row: OutboxRow }
  | { kind: 'invalid' };

/** What calendar-out borrows from the mail service (calendar spec §5.3). */
export interface OutboundContext {
  /** The account's effective mail confirm mode (agent transport: review). */
  modeFor(account: Account): ConfirmMode;
  /** The URL origin for a transport; null while that server is not up. */
  baseFor(transport: McpTransport): string | null;
  createdViaNow(): 'mcp-local' | 'mcp-remote' | 'mcp-agent';
  /** The confirm-link HMAC secret (the outbox's, shared). */
  secret(): Promise<Buffer>;
}

export interface OutboundService extends OutboundToolApi {
  peekByToken(token: string): Promise<PeekResult>;
  /** `revision` = the one the page showed (null: an old page/link that
   *  carried none → `changed`). */
  confirmByToken(
    token: string,
    revision: number | null,
  ): Promise<ConfirmOutcome>;
  cancelByToken(token: string): Promise<ConfirmOutcome>;
  /** The link page's "Schedule for …" and Send later: `atMs` (the AI's
   *  suggestion, a preset or a custom time), at the revision the page
   *  showed. */
  scheduleByToken(
    token: string,
    revision: number,
    atMs: number,
  ): Promise<ScheduleOutcome>;
  /** The link page's "Cancel schedule": the draft stays, unscheduled, at
   *  the revision the page showed. */
  unscheduleByToken(token: string, revision: number): Promise<ScheduleOutcome>;
  /** An email row's body as it will be sent (core's rendering); undefined
   *  for chats. */
  bodyHtmlFor(row: OutboxRow): Promise<string | undefined>;
  /** The failed page's "Review again": reopen, then show the review. */
  reopenByToken(token: string): Promise<PeekResult>;
  setBaseUrl(url: string): void;
  /** Product pushes the public device base URL (https://<device-subdomain>)
   *  when the remote HTTPS server is up, null when it goes down. */
  setRemoteBaseUrl(url: string | null): void;
  /** The confirm-mode, URL-origin and transport closures, shared with
   *  calendar-out so event drafts gate exactly as mail does. */
  context(): OutboundContext;
  /** Panel support (spec §10): a fresh confirm URL for a row the user can
   *  still act on — a pending draft, or a `failed` row whose stored error
   *  PROVES the message was never accepted (that one lands on failedPage's
   *  shipped "Try again"). Null for everything else.
   *
   *  PANEL-ONLY — never an `/outbox/api` op, never on `OutboundToolApi`:
   *  `OUTBOUND_TOOL_OPS` (ops.ts) dispatches that interface by name over the
   *  loopback JSON plane, and these two must stay off it. */
  confirmUrlFor(draftId: string): Promise<string | null>;
  /** Panel support (spec §10): duplicate a terminal row (`failed`,
   *  `expired`, `discarded` — NEVER `delivery_unknown`) into a fresh draft.
   *  Content, recipients and threading copied verbatim; mode re-frozen from
   *  the account's effective setting; fresh 24h TTL; createdVia 'panel'.
   *
   *  PANEL-ONLY — see confirmUrlFor. */
  redraft(draftId: string): Promise<OutboxRow>;
  /** Panel support (Airy §9): the in-app review's Send — the page
   *  confirm's gate and send (`confirmRow`) for the draft the user is
   *  looking at. Same outcomes as `confirmByToken`; `invalid` = no such
   *  row. PANEL-ONLY — see confirmUrlFor. */
  sendById(draftId: string, revision: number): Promise<ConfirmOutcome>;
  /** Panel support: a provably-failed or expired row back to review as a
   *  new revision (spec §4.1 reopen). Null when it is neither. PANEL-ONLY. */
  reopenById(draftId: string): Promise<OutboxRow | null>;
  /** Panel support: the review sheet's edits. PANEL-ONLY. */
  reviseById(
    draftId: string,
    revision: number,
    patch: DraftRevision,
  ): Promise<DraftToolResult>;
  /** Discard a pending draft (in-app Discard, page Cancel). */
  discardById(draftId: string): Promise<OutboxRow | null>;
  /** The provider's current draft into the row, before a review surface
   *  shows it; an unreachable provider leaves the row. PANEL-ONLY. */
  refreshById(draftId: string): Promise<OutboxRow | null>;
  /** Listings: pending mirrored rows refreshed in parallel, ~5 s budget.
   *  PANEL-ONLY. */
  refreshPending(rows: OutboxRow[]): Promise<void>;
  /** Panel support: the source ids that can send (bundled + extension
   *  senders), for the Outbox's "Sends from". PANEL-ONLY. */
  senderSources(): string[];
  /** Whether drafts of this source are emails (rendered as HTML). */
  isEmailSource(sourceId: string): boolean;
  /** The review sheet's "Send later…" (spec §8): a confirm of `revision`
   *  that sets the send time instead of sending; `sendAt` null cancels.
   *  PANEL-ONLY — models may suggest a time, only the user schedules. */
  scheduleById(
    draftId: string,
    revision: number,
    sendAt: string | null,
  ): Promise<ScheduleOutcome>;
  /** The scheduler's send of one due row, if it is still scheduled for
   *  `sendAt` (a cancel or reschedule in between wins). */
  sendScheduled(draftId: string, sendAt: string): Promise<ScheduledSend>;
}

export type ScheduleOutcome =
  | { kind: 'scheduled'; row: OutboxRow }
  | { kind: 'unscheduled'; row: OutboxRow }
  | { kind: 'changed'; row: OutboxRow }
  | { kind: 'already'; row: OutboxRow }
  | { kind: 'failed'; row: OutboxRow; error: string }
  | { kind: 'invalid' };

/** What a scheduler tick did with one due row. */
export type ScheduledSend = 'skipped' | 'missed' | ConfirmOutcome['kind'];

/** A schedule is never kept later than this (sleep, app closed, a refresh
 *  that kept failing): the row waits for the user instead (spec §8). */
export const SCHEDULE_LATE_MS = 5 * 60_000;
/** The furthest ahead a send can be scheduled. */
const SCHEDULE_MAX_AHEAD_MS = 365 * 24 * 3600_000;

const HOUR_MS = 60 * 60_000;

/**
 * Distinct whole-minute times spread over `[startMs, startMs + minutes)`:
 * n equal slots, shuffled over the drafts, a random minute inside each
 * (spec 2026-10-21 §5.1). Needs `minutes >= n`.
 */
export function spreadTimes(
  n: number,
  startMs: number,
  minutes: number,
  rand: () => number = Math.random,
): number[] {
  if (n < 1 || minutes < n) throw new Error('spread: more drafts than minutes');
  const s = minutes / n;
  const slots = Array.from({ length: n }, (_, i) => {
    const lo = Math.ceil(i * s);
    const hi = Math.max(lo, Math.ceil((i + 1) * s) - 1);
    return startMs + (lo + Math.floor(rand() * (hi - lo + 1))) * 60_000;
  });
  for (let i = slots.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  return slots;
}

/** Whether one more send at `t` keeps every 60-minute window that holds it
 *  at or under `limit` sends. */
export function fitsRate(times: number[], t: number, limit: number): boolean {
  const all = [...times, t].sort((a, b) => a - b);
  return all.every(
    (a) =>
      a > t ||
      a <= t - HOUR_MS ||
      all.filter((x) => x >= a && x < a + HOUR_MS).length <= limit,
  );
}

export function createOutboundService(deps: {
  store: CoreStore;
  prefs: Prefs;
  /** Either the bare bundled Map or an already-composed lookup (bundled +
   *  extension senders). Normalized to a lookup immediately below, so every
   *  existing caller keeps passing a Map unchanged. */
  senders: Map<string, Sender> | SenderLookup;
  logSink: LogSink;
  /** The registered source's descriptor — read for `compose: 'email'`
   *  (an extension email source whose accounts may originate mail).
   *  Optional: without it every non-bundled source stays reply-only. */
  descriptorFor?: (sourceId: string) => SourceDescriptor | undefined;
  /** Files on drafts; without it every attachment is refused. */
  attachments?: AttachmentsApi;
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

  const createdViaNow = (): 'mcp-local' | 'mcp-remote' | 'mcp-agent' => {
    const t = currentTransport();
    return t === 'remote'
      ? 'mcp-remote'
      : t === 'agent'
        ? 'mcp-agent'
        : 'mcp-local';
  };

  const modeFor = (account: Account): ConfirmMode => {
    // A hosted agent's drafts always wait for the page, whatever the
    // account or default says — chat confirmation would let it send.
    if (currentTransport() === 'agent') return 'review';
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

  const draftFields = (row: OutboxRow) => ({
    revision: row.revision,
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    body: row.bodyMarkdown,
    attachments: row.attachments.map((a) => ({
      filename: a.filename,
      size: a.size,
      origin: originOf(a, row.mirror?.provider),
    })),
  });

  const REVISE_HINT =
    `To change it, call revise_draft with this draft_id and revision — ` +
    `never create a new draft for a change.`;

  const toolResult = async (
    row: OutboxRow,
    warnings: string[],
  ): Promise<DraftToolResult> => {
    const mode = row.confirmMode;
    const base = {
      draft_id: row.id,
      mode,
      recipient_display: row.recipientDisplay,
      ...draftFields(row),
      warnings,
    };
    if (mode === 'chat') {
      // Mode C: no link at all — the model renders the draft, the user says
      // yes in the conversation, and send_draft carries out the send. The
      // page confirm stays available as a fallback via list_outbox, which
      // re-issues a URL for any pending row (including this one), so nothing
      // is lost if the model never calls send_draft.
      return {
        ...base,
        instruction:
          `Show the user this draft exactly as written — recipient, ` +
          `subject, body and attachments verbatim — and ask whether to send ` +
          `it. Call send_draft with this draft_id and revision ONLY after the ` +
          `user explicitly agrees in this conversation. If they want ` +
          `changes, call revise_draft with this draft_id and revision ` +
          `instead, then show the result. Never call send_draft without a ` +
          `clear yes.`,
      };
    }
    if (currentTransport() === 'agent') {
      // A confirm link is a send capability (a POST to it sends), so a
      // hosted agent never holds one: the user sends from the Outbox page.
      return {
        ...base,
        instruction:
          `Draft created — nothing has been sent. It waits in the user's ` +
          `Outbox in KIAgent, where they review and send it. ${REVISE_HINT}`,
      };
    }
    const url = await confirmUrl(row.id, mode);
    if (mode === 'review') {
      return {
        ...base,
        confirm_url: url,
        instruction:
          `Draft created — nothing has been sent. Show the user this link ` +
          `to review and send the message: ${url} (it expires in ` +
          `${CONFIRM_TTL_MS.review / 60_000} minutes; if it expires, call ` +
          `list_outbox for a fresh one). ${REVISE_HINT}`,
      };
    }
    return {
      ...base,
      confirm_url: url,
      instruction:
        `Draft created — nothing has been sent. Render the draft exactly ` +
        `as returned (recipient, subject, body, attachments) for the user to ` +
        `review in chat, then present this link as the send action: ${url}. ` +
        `It opens a page with a Send button; the link expires in ` +
        `${CONFIRM_TTL_MS.link / 60_000} minutes — call list_outbox for a ` +
        `fresh one if needed. ${REVISE_HINT}`,
    };
  };

  /** A refusal that carries the current draft: the caller showed (or
   *  revised) another revision, and must start from this one. */
  const changedError = (
    tool: string,
    shown: number | null,
    row: OutboxRow,
  ): Error => {
    const d = draftFields(row);
    const head = `${tool}: this draft changed${shown === null ? '' : ` since revision ${shown}`} — it is now revision ${row.revision}`;
    const lines = [
      `${head}. Show the user the current draft before going on:`,
      `To: ${row.recipientDisplay}`,
      ...(row.cc.length ? [`Cc: ${row.cc.join(', ')}`] : []),
      ...(row.bcc.length ? [`Bcc: ${row.bcc.join(', ')}`] : []),
      ...(row.subject ? [`Subject: ${row.subject}`] : []),
      ...(d.attachments.length
        ? [`Attachments: ${d.attachments.map((a) => a.filename).join(', ')}`]
        : []),
      '',
      row.bodyMarkdown,
    ];
    // The draft is for the caller; logs and the activity feed get the head.
    return withLogMessage(new Error(lines.join('\n')), head);
  };

  const notPendingError = (tool: string, row: OutboxRow): Error =>
    new Error(
      `${tool}: this draft is '${row.status}', not pending — create a new draft instead.`,
    );

  const expiresAt = (): string =>
    new Date(nowMs() + DRAFT_TTL_MS).toISOString();

  /** The send pipeline itself, shared by every confirmation surface (page
   *  confirm and chat's send_draft). PRECONDITION: the caller has already
   *  won the CAS that moved this row into 'sending' — this function owns the
   *  row from there on and always leaves it in a terminal state (or, for a
   *  bookkeeping throw after a successful send, in 'sending' for the
   *  boot-time recovery sweep; see the comment on the send attempt below).
   *  `row` is the pre-CAS snapshot: nothing the CAS writes is read here. */
  const executeSend = async (
    row: OutboxRow,
    /** Composed before the CAS (prepareSend); null for a mirrored row. */
    intent: SendIntent | null,
  ): Promise<ConfirmOutcome> => {
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

    // A mirrored row is sent as the provider's draft — the one the user
    // may have edited there — never re-composed from the row (§5.4).
    const ref = row.mirror?.ref ?? null;
    if (ref && !sender.drafts)
      return fail('not sent: this account can no longer send its drafts');

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
      result =
        ref && sender.drafts
          ? await sender.drafts.send(ref)
          : await sender.send(intent ?? intentOf(row));
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

  const isEmailSource = (sourceId: string): boolean =>
    sourceId === 'gmail' ||
    sourceId === 'imap' ||
    deps.descriptorFor?.(sourceId)?.compose === 'email';

  /** What the recipient sees, for an email account's draft. */
  async function bodyHtmlFor(row: OutboxRow): Promise<string | undefined> {
    const account = await deps.store.account(row.accountId);
    if (!account) return undefined;
    return isEmailSource(account.source)
      ? renderEmailBody(row.bodyMarkdown).html
      : undefined;
  }
  const bodyHtmlOf = async (row: OutboxRow) => {
    const h = await bodyHtmlFor(row);
    return h === undefined ? {} : { body_html: h };
  };

  const withDraft = createDraftLock();
  // Chat-mode sends and schedules of one account pass the rate rule one at
  // a time (account lock first, then the draft's).
  const withAccount = createDraftLock();

  /** The rate rule for a chat-mode send at `t` (spec 2026-10-21 §5.1):
   *  sent and scheduled sends of the account count. Caller holds the
   *  account lock. */
  const admits = async (
    account: Account,
    t: number,
    exceptId?: string,
  ): Promise<boolean> => {
    const times = await deps.store.outbox.listSendTimes(
      account.id,
      new Date(t - HOUR_MS).toISOString(),
      new Date(t + HOUR_MS).toISOString(),
      new Date(nowMs()).toISOString(),
      exceptId,
    );
    return fitsRate(times.map(Date.parse), t, sendsPerHourFor(account));
  };

  const sourceOf = async (row: OutboxRow): Promise<string> =>
    (await deps.store.account(row.accountId))?.source ?? '';
  /** The account's draft mirror, when its sender keeps provider drafts. */
  const draftsFor = async (row: OutboxRow): Promise<DraftMirror | undefined> =>
    lookup.get(await sourceOf(row))?.drafts;
  const mirror = createMirrorOps({
    store: deps.store,
    logSink: deps.logSink,
    nowMs,
    sourceOf,
  });

  /** A just-inserted row becomes a provider draft when the account can
   *  mirror (§5.2). Never throws: a failed create leaves it Outbox-only. */
  const mirrorNew = (
    row: OutboxRow,
    files: AttachmentBytes[] = [],
  ): Promise<{ row: OutboxRow; warnings: string[] }> =>
    withDraft(row.id, async () => {
      const drafts = await draftsFor(row);
      if (!drafts) return { row, warnings: [] };
      let intent: SendIntent;
      try {
        intent = await intentWithFiles(row, files);
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        await deps.store.outbox.setMirror(row.id, { ref: null, error });
        return {
          row: (await deps.store.outbox.get(row.id)) ?? row,
          warnings: [],
        };
      }
      return createWithFilesLocked(row, drafts, intent);
    });

  /** The provider draft first, its files after (§5.2): the create stays
   *  fast and inside its deadline whatever the files weigh, and the upload
   *  runs as an update, awaited to the end. A failed upload leaves a synced
   *  draft without those files, and says so — never a row whose files
   *  nothing can send. */
  const createWithFilesLocked = async (
    row: OutboxRow,
    drafts: DraftMirror,
    intent: SendIntent,
  ): Promise<{ row: OutboxRow; warnings: string[] }> => {
    const files = intent.attachments ?? [];
    const made = await mirror.createLocked(
      row,
      drafts,
      { ...intent, attachments: undefined },
      { readback: !files.length },
    );
    const source = await sourceOf(row);
    const label = providerLabel(source);
    if (!made.mirror?.ref)
      return {
        row: made,
        // Gmail and IMAP send files without the provider draft; only a
        // source whose files ride the draft can't send them now.
        warnings:
          files.length && attachRefusal(source, false)
            ? [
                `not synced to ${label} (${made.mirror?.error ?? 'unknown error'}), so its files can't be sent yet — edit the draft to try again, or remove the files`,
              ]
            : [],
      };
    if (!files.length) return { row: made, warnings: [] };
    try {
      return {
        row: await mirror.updateLocked(
          made,
          drafts,
          { attachments: files },
          { ...snapshotOf(made), attachments: row.attachments },
          { created: true },
        ),
        warnings: [],
      };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return {
        row: (await deps.store.outbox.get(row.id)) ?? made,
        warnings: [
          `the files were not added to the ${label} draft (${why}) — add them again`,
        ],
      };
    }
  };

  /** The provider's current draft into the row (§5.3); a row that is not
   *  mirrored comes back as it is. Throws `couldn't reach <provider>`. */
  const syncLocked = async (
    row: OutboxRow,
    ms?: number,
  ): Promise<OutboxRow> => {
    if (!row.mirror?.ref || row.status !== 'draft') return row;
    const drafts = await draftsFor(row);
    if (!drafts) return row;
    try {
      return await mirror.refreshLocked(row, drafts, ms);
    } catch (e) {
      const label = providerLabel(await sourceOf(row));
      deps.logSink.log(
        'outbound',
        'warn',
        `draft ${row.id}: refresh failed (${e instanceof Error ? e.message : String(e)})`,
        { draftId: row.id },
      );
      throw new Error(`couldn't reach ${label} — try again`);
    }
  };

  /** Refresh one row by id under its lock; a failure keeps the row.
   *  Concurrent callers share one read rather than queueing more of them on
   *  the lock ahead of a Send. */
  const inFlight = new Map<string, Promise<OutboxRow | null>>();
  const refreshById = (
    draftId: string,
    ms = MIRROR_CALL_DEADLINE_MS,
  ): Promise<OutboxRow | null> => {
    let run = inFlight.get(draftId);
    if (!run) {
      run = withDraft(draftId, async () => {
        const row = await deps.store.outbox.get(draftId);
        if (!row) return null;
        return syncLocked(row, ms).catch(() => row);
      }).finally(() => inFlight.delete(draftId));
      inFlight.set(draftId, run);
    }
    // A read never waits out a long write on the lock (an upload): past the
    // deadline it shows the row as stored.
    return deadline(run, ms, 'draft refresh').catch(() =>
      deps.store.outbox.get(draftId),
    );
  };

  /** Listings: every pending mirrored row refreshed in parallel, bounded;
   *  a miss renders the row as it was (§5.3). Reads only. */
  const LIST_REFRESH_MS = 5_000;
  const refreshPending = async (rows: OutboxRow[]): Promise<void> => {
    const ids = rows
      .filter((r) => r.status === 'draft' && r.mirror?.ref)
      .map((r) => r.id);
    if (!ids.length) return;
    await deadline(
      Promise.allSettled(ids.map((id) => refreshById(id, LIST_REFRESH_MS))),
      LIST_REFRESH_MS,
      'outbox refresh',
    ).catch(() => {});
  };

  /** Files ride the bundled email senders, or a provider draft (§6.2). */
  const attachRefusal = (source: string, mirrored: boolean): string | null => {
    if (source === 'gmail' || source === 'imap' || mirrored) return null;
    if (lookup.get(source)?.drafts)
      return `files need this draft synced to ${providerLabel(source)} first`;
    return "this source can't send files yet";
  };

  /** The files a tool call names, read and checked against what the draft
   *  already holds. Refuses before anything is written. */
  const resolveFiles = async (
    tool: string,
    inputs: AttachmentInput[] | undefined,
    existing: OutboxAttachment[],
    source: string,
    opts: { mirrored: boolean; userPicked?: boolean },
  ): Promise<
    Array<{ attachment: OutboxAttachment; bytes: AttachmentBytes }>
  > => {
    if (!inputs?.length) return [];
    const why = attachRefusal(source, opts.mirrored);
    if (why) throw new Error(`${tool}: ${why}`);
    const api = deps.attachments;
    if (!api) throw new Error(`${tool}: attachments are not available`);
    const files: Array<{
      attachment: OutboxAttachment;
      bytes: AttachmentBytes;
    }> = [];
    for (const input of inputs) {
      try {
        files.push(
          await api.resolve(input, {
            transport: currentTransport(),
            userPicked: opts.userPicked,
          }),
        );
      } catch (e) {
        throw new Error(
          `${tool}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    try {
      checkAttachments([...existing, ...files.map((f) => f.attachment)]);
    } catch (e) {
      throw new Error(`${tool}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return files;
  };

  const ATTACHMENT_READ_MS = 30_000;
  /** A send (or a create) of the row with every file's bytes. */
  const intentWithFiles = async (
    row: OutboxRow,
    known: AttachmentBytes[] = [],
  ): Promise<SendIntent> => {
    const intent = intentOf(row);
    if (!row.attachments.length) return intent;
    const api = deps.attachments;
    if (!api) throw new Error('attachments are not available');
    const byName = new Map(known.map((b) => [b.filename, b]));
    // Bounded: a send waits on these reads with its row in 'sending', and
    // a stalled source must end in a provable "not sent", not a hang.
    intent.attachments = await deadline(
      Promise.all(
        row.attachments.map((a) => byName.get(a.filename) ?? api.read(a)),
      ),
      ATTACHMENT_READ_MS,
      'reading the attachments',
    );
    return intent;
  };

  /** The send's intent with its files' bytes, or why it can't go: run
   *  before the CAS, so a refusal leaves the row a draft. A mirrored row
   *  needs none — it is sent as the provider's draft. */
  const prepareSend = async (
    row: OutboxRow,
  ): Promise<{ intent: SendIntent | null } | { error: string }> => {
    if (row.mirror?.ref) return { intent: null };
    const why = row.attachments.length
      ? attachRefusal(await sourceOf(row), false)
      : null;
    if (why) return { error: `not sent: ${why}` };
    try {
      return { intent: await intentWithFiles(row) };
    } catch (e) {
      return {
        error: `not sent: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };

  /** Discard in Kia removes the provider draft too (§5.4). */
  const discardLocked = async (
    draftId: string,
  ): Promise<{ moved: boolean; row: OutboxRow | null }> => {
    const stored = await deps.store.outbox.get(draftId);
    // A draft already sent (or gone) from the mail app is recorded as that,
    // never as discarded — "Draft again" on it would invite a duplicate.
    const before = stored ? await syncLocked(stored).catch(() => stored) : null;
    if (before && before.status !== 'draft')
      return { moved: false, row: before };
    const moved = await deps.store.outbox.transition(
      draftId,
      ['draft'],
      'discarded',
    );
    if (moved && before?.mirror?.ref) {
      const drafts = await draftsFor(before);
      if (drafts) await mirror.removeLocked(before, drafts);
    }
    return { moved, row: await deps.store.outbox.get(draftId) };
  };

  /** The page's confirm, once the caller has shown who is asking (a
   *  verified token, or the user's own click in the app): sweep, re-read,
   *  the revision check, the CAS, send. The ONE body every confirm path
   *  shares, so they cannot drift. Caller holds the draft lock. A failed
   *  row is never re-sent here: "Try again" is reopen (spec §4.1). */
  const ownBodyLocked = async (
    row: OutboxRow,
  ): Promise<
    { kind: 'ok'; row: OutboxRow } | { kind: 'stop'; outcome: ConfirmOutcome }
  > => {
    const m = row.mirror;
    if (!m?.ref || (m.ownKey !== undefined && m.ownKey === m.seenKey))
      return { kind: 'ok', row };
    const drafts = await draftsFor(row);
    if (!drafts) return { kind: 'ok', row };
    let next: OutboxRow;
    try {
      next = await mirror.updateLocked(
        row,
        drafts,
        {
          bodyMarkdown: row.bodyMarkdown,
          bodyHtml: renderEmailBody(row.bodyMarkdown).html,
        },
        snapshotOf(row),
      );
    } catch (e) {
      const error = `not sent: ${e instanceof Error ? e.message : String(e)}`;
      return { kind: 'stop', outcome: { kind: 'failed', row, error } };
    }
    if (next.revision !== row.revision)
      return { kind: 'stop', outcome: { kind: 'changed', row: next } };
    if (next.mirror?.ownKey === undefined)
      // The write went but its readback did not: what the provider holds
      // is not vouched for. Nothing was sent; Send can be pressed again.
      return {
        kind: 'stop',
        outcome: {
          kind: 'failed',
          row: next,
          error: `not sent: ${providerLabel(await sourceOf(row))} did not confirm the text — try again`,
        },
      };
    return { kind: 'ok', row: next };
  };

  const confirmLocked = async (
    draftId: string,
    revision: number | null,
    /** Last word before the CAS, once the row is refreshed and ready (a
     *  scheduled send re-checks its time here). An outcome stops the send. */
    lastCheck?: (row: OutboxRow) => Promise<ConfirmOutcome | null>,
  ): Promise<ConfirmOutcome> => {
    // Mirror peekByToken's lazy sweep: a token minted near the end of its
    // (short) TTL — or a review sheet left open — can still be nominally
    // valid past the draft row's own expires_at; without this, the CAS below
    // would happily move an expired draft into 'sending'.
    await deps.store.outbox.expireOverdue();
    const stored = await deps.store.outbox.get(draftId);
    if (!stored) return { kind: 'invalid' };
    if (stored.status !== 'draft') return { kind: 'already', row: stored };
    // A mirrored row sends what the provider holds now: read it first, and
    // refuse (provably unsent) when the provider can't be reached. The row
    // stays a draft — nothing happened to it, and Send can simply be
    // pressed again (§9: refresh failures leave the row as it was).
    let row: OutboxRow;
    try {
      row = await syncLocked(stored);
    } catch (e) {
      const error = `not sent: ${e instanceof Error ? e.message : String(e)}`;
      return { kind: 'failed', row: stored, error };
    }
    if (row.status !== 'draft') return { kind: 'already', row };
    if (revision === null || row.revision !== revision)
      return { kind: 'changed', row };
    // The mail carries exactly what the review showed (spec 2026-10-21
    // §3.4b): a provider body that is not Kia's own rendering as the
    // provider holds it — re-formatted there, an image or hidden text added,
    // an older draft — gets Kia's rendering written back first.
    const own = await ownBodyLocked(row);
    if (own.kind !== 'ok') return own.outcome;
    row = own.row;
    // What would refuse the send anyway refuses it here, with the row still
    // a draft (nothing happened to it): a file gone or changed, files on a
    // source that can't carry them.
    const ready = await prepareSend(row);
    if ('error' in ready)
      return {
        kind: 'failed',
        row,
        error: shapeOutboundError(ready.error).summary,
        // A read that ran out of time may go on a later try; the rest won't.
        refused: !/timed out$/.test(ready.error),
      };
    const stop = lastCheck ? await lastCheck(row) : null;
    if (stop) return stop;

    // The atomicity primitive: only the caller that wins this UPDATE
    // proceeds to send. In-process callers are already serialized by the
    // draft lock; the CAS stays as cheap defense.
    const moved = await deps.store.outbox.transition(
      row.id,
      ['draft'],
      'sending',
    );
    if (!moved) {
      const raced = await deps.store.outbox.get(row.id);
      return { kind: 'already', row: raced ?? row };
    }

    return executeSend(row, ready.intent);
  };

  const scheduleLocked = async (
    draftId: string,
    revision: number,
    sendAt: string | null,
    {
      gate,
      note,
      synced,
    }: {
      /** Last word before the schedule is stored (the rate rule). */
      gate?: (at: number) => Promise<string | null>;
      /** The draft's note after a cancel. */
      note?: string;
      /** The provider draft was just read (a batch's refresh): no second
       *  read here — the send reads it again before anything goes. */
      synced?: boolean;
    } = {},
  ): Promise<ScheduleOutcome> => {
    await deps.store.outbox.expireOverdue();
    const stored = await deps.store.outbox.get(draftId);
    if (!stored) return { kind: 'invalid' };
    if (stored.status !== 'draft') return { kind: 'already', row: stored };
    if (sendAt === null) {
      await deps.store.outbox.schedule(draftId, null, note);
      const row = (await deps.store.outbox.get(draftId)) ?? stored;
      return { kind: 'unscheduled', row };
    }
    const at = Date.parse(sendAt);
    if (!Number.isFinite(at)) throw new Error('outbox: not a time');
    if (at < nowMs() + 60_000)
      throw new Error('pick a time at least a minute from now');
    if (at > nowMs() + SCHEDULE_MAX_AHEAD_MS)
      throw new Error('pick a time within a year');
    // A confirm of what the user saw: the provider's draft now, at the
    // shown revision, and nothing that would refuse the send then.
    let row: OutboxRow;
    try {
      row = synced ? stored : await syncLocked(stored);
    } catch (e) {
      const error = `not scheduled: ${e instanceof Error ? e.message : String(e)}`;
      return { kind: 'failed', row: stored, error };
    }
    if (row.status !== 'draft') return { kind: 'already', row };
    if (row.revision !== revision) return { kind: 'changed', row };
    const ready = await prepareSend(row);
    if ('error' in ready)
      return {
        kind: 'failed',
        row,
        error: ready.error.replace(/^not sent: /, 'not scheduled: '),
      };
    const stop = gate ? await gate(at) : null;
    if (stop) return { kind: 'failed', row, error: stop };
    const saved = await deps.store.outbox.schedule(
      draftId,
      new Date(at).toISOString(),
    );
    const current = await deps.store.outbox.get(draftId);
    // It expired or moved on meanwhile (a sweep runs outside the lock).
    if (!saved || !current)
      return current ? { kind: 'already', row: current } : { kind: 'invalid' };
    return { kind: 'scheduled', row: current };
  };

  /** A batch item whose draft moved on from the revision the app passed. */
  const changedResult = (row: OutboxRow): ScheduleItemResult => ({
    draft_id: row.id,
    status: 'error',
    revision: row.revision,
    error: `This draft changed — it is now revision ${row.revision}; show it to the user again`,
  });

  /** A suggested time: checked like a schedule, stored for the user. */
  const suggestLocked = async (
    draftId: string,
    revision: number,
    at: number,
  ): Promise<ScheduleItemResult> => {
    const row = await deps.store.outbox.get(draftId);
    if (!row || row.status !== 'draft')
      return {
        draft_id: draftId,
        status: 'error',
        error: 'not a pending draft',
      };
    if (row.revision !== revision) return changedResult(row);
    const iso = new Date(at).toISOString();
    await deps.store.outbox.suggest(draftId, iso);
    return {
      draft_id: draftId,
      status: 'suggested',
      send_at: iso,
      ...(currentTransport() !== 'agent' && {
        confirm_url: await confirmUrl(draftId, 'review'),
      }),
    };
  };

  const timeError = (at: number): string | null =>
    !Number.isFinite(at)
      ? 'not a time — use ISO 8601 with an offset'
      : at < nowMs() + 60_000
        ? 'pick a time at least a minute from now'
        : at > nowMs() + SCHEDULE_MAX_AHEAD_MS
          ? 'pick a time within a year'
          : null;

  const scheduleDrafts: OutboundToolApi['scheduleDrafts'] = async ({
    drafts,
    spread,
  }) => {
    assertReady();
    if (!Array.isArray(drafts) || drafts.length < 1 || drafts.length > 50)
      throw new Error('schedule_drafts: give 1 to 50 drafts');
    const ids = new Set(drafts.map((d) => d.draftId));
    if (ids.size !== drafts.length)
      throw new Error('schedule_drafts: a draft is listed twice');
    const timed = drafts.filter((d) => d.sendAt !== undefined).length;
    if (spread ? timed > 0 : timed !== drafts.length)
      throw new Error(
        'schedule_drafts: give every draft a send_at, or give spread and no send_at',
      );
    await deps.store.outbox.expireOverdue();
    const rows = await Promise.all(
      drafts.map((d) => deps.store.outbox.get(d.draftId)),
    );
    const transport = currentTransport();
    const app = currentClient();
    const isChat = async (row: OutboxRow): Promise<Account | null> => {
      if (transport === 'agent' || row.confirmMode !== 'chat') return null;
      const account = await accountFor(row.accountId as string);
      return modeFor(account) === 'chat' ? account : null;
    };
    let times: Array<number | null>;
    if (spread) {
      const minutes = Number(spread.minutes);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)
        throw new Error('schedule_drafts: spread.minutes must be 5 to 1440');
      if (drafts.length > minutes)
        throw new Error(
          `schedule_drafts: ${drafts.length} drafts need a spread of at least ${drafts.length} minutes`,
        );
      const allChat = (
        await Promise.all(rows.map((r) => (r ? isChat(r) : null)))
      ).every(Boolean);
      const start =
        spread.start !== undefined
          ? Date.parse(spread.start)
          : // Whole minutes, as every surface shows them.
            Math.ceil((nowMs() + (allChat ? 5 : 30) * 60_000) / 60_000) *
            60_000;
      const err = timeError(start);
      if (err) throw new Error(`schedule_drafts: spread.start — ${err}`);
      times = spreadTimes(drafts.length, start, minutes);
    } else {
      times = drafts.map((d) =>
        d.sendAt === null ? null : Date.parse(d.sendAt!),
      );
    }
    // A chat batch reads its provider drafts together first, not one by one.
    await refreshPending(rows.filter((r): r is OutboxRow => r !== null));

    const results: ScheduleItemResult[] = [];
    for (const [i, item] of drafts.entries()) {
      const row = rows[i];
      const at = times[i];
      const id = item.draftId;
      if (!row || row.status !== 'draft') {
        results.push({
          draft_id: id,
          status: 'error',
          error: 'not a pending draft',
        });
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const account = await isChat(row);
      if (at === null) {
        // Cancel, at the revision the app passed (as the refresh left it):
        // a suggestion always goes; a schedule only when chat may handle
        // it — the user's own schedule is not the app's to undo.
        // eslint-disable-next-line no-await-in-loop
        const fresh = (await deps.store.outbox.get(id)) ?? row;
        if (fresh.revision !== item.revision) {
          results.push(changedResult(fresh));
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        await deps.store.outbox.suggest(id, null);
        if (fresh.sendAt && account) {
          // eslint-disable-next-line no-await-in-loop
          await withDraft(id, () =>
            scheduleLocked(id, item.revision, null, {
              note: `Schedule cancelled by ${app ?? 'an AI app'}`,
            }),
          );
          results.push({ draft_id: id, status: 'unscheduled' });
        } else
          results.push({
            draft_id: id,
            status: fresh.sendAt ? 'unchanged' : 'unscheduled',
            ...(fresh.sendAt && { error: 'the user scheduled this in Kia' }),
          });
        continue;
      }
      const err = timeError(at);
      if (err) {
        results.push({ draft_id: id, status: 'error', error: err });
        continue;
      }
      if (!account) {
        // eslint-disable-next-line no-await-in-loop
        results.push(
          await withDraft(id, () => suggestLocked(id, item.revision, at)),
        );
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const out = await withAccount(account.id, () =>
        withDraft(id, () =>
          scheduleLocked(id, item.revision, new Date(at).toISOString(), {
            // refreshPending above read this batch's provider drafts.
            synced: true,
            gate: async (t) =>
              (await admits(account, t, id))
                ? null
                : `rate limit — more than ${sendsPerHourFor(account)} sends in an hour from this account; spread these wider`,
          }),
        ),
      ).catch((e: unknown) => ({
        kind: 'failed' as const,
        row,
        error: e instanceof Error ? e.message : String(e),
      }));
      if (out.kind === 'scheduled')
        results.push({
          draft_id: id,
          status: 'scheduled',
          send_at: out.row.sendAt ?? undefined,
        });
      else if (out.kind === 'changed') results.push(changedResult(out.row));
      else
        results.push({
          draft_id: id,
          status: 'error',
          error:
            out.kind === 'failed'
              ? out.error
              : `can no longer be scheduled (${out.kind})`,
        });
    }
    const suggested = results.some((r) => r.status === 'suggested');
    return {
      results,
      instruction: suggested
        ? `Suggested times are not schedules: nothing is sent until the user confirms each draft in KIAgent${
            transport === 'agent'
              ? '.'
              : ' or on its confirm_url (show those links).'
          }`
        : 'Scheduled drafts go at their send_at unless they change; tell the user the times.',
    };
  };

  const confirmRow = (draftId: string, revision: number | null) =>
    withDraft(draftId, () => confirmLocked(draftId, revision));

  // Back to review as the same row: an expired draft, or a failure that
  // provably never went out. Uncertain failures stay terminal.
  const isReopenable = (row: OutboxRow): boolean =>
    row.status === 'expired' ||
    (row.status === 'failed' && shapeOutboundError(row.error ?? '').canRetry);

  const reopenLocked = async (draftId: string): Promise<OutboxRow | null> => {
    const row = await deps.store.outbox.get(draftId);
    if (!row) return null;
    if (!isReopenable(row)) return null;
    return deps.store.outbox.reopen(row.id, expiresAt());
  };

  const reviseLocked = async (
    tool: string,
    draftId: string,
    revision: number,
    patch: DraftRevision,
    opts: { userPicked?: boolean } = {},
  ): Promise<DraftToolResult> => {
    await deps.store.outbox.expireOverdue();
    const stored = await deps.store.outbox.get(draftId);
    if (!stored) throw new Error(`${tool}: unknown draft '${draftId}'`);
    if (stored.status !== 'draft') throw notPendingError(tool, stored);
    let row: OutboxRow;
    try {
      row = await syncLocked(stored);
    } catch (e) {
      throw new Error(
        `${tool}: ${e instanceof Error ? e.message : String(e)} — the draft was not changed`,
      );
    }
    if (row.status !== 'draft') throw notPendingError(tool, row);
    if (row.revision !== revision) throw changedError(tool, revision, row);
    const touchesRecipients = patch.to !== undefined || patch.cc !== undefined;
    if (touchesRecipients && row.kind !== 'new')
      throw new Error(
        `${tool}: the recipients of a reply come from the original message — ` +
          `change only the body, or the user can edit recipients in their mail app`,
      );
    const addrs = (xs: string[] | undefined, field: string) => {
      if (xs === undefined) return undefined;
      const trimmed = xs.map((t) => String(t).trim()).filter(Boolean);
      const bad = trimmed.filter((t) => !EMAIL_RX.test(t));
      if (bad.length || (field === 'to' && trimmed.length === 0))
        throw withLogMessage(
          new Error(
            `${tool}: invalid ${field} address(es): ${bad.join(', ') || '(none given)'}`,
          ),
          `${tool}: invalid ${field} address(es) (${bad.length})`,
        );
      return trimmed;
    };
    const to = addrs(patch.to, 'to');
    const cc = addrs(patch.cc, 'cc');
    if (patch.body !== undefined && !patch.body.trim())
      throw new Error(`${tool}: body must not be empty`);
    const removed = new Set(patch.removeAttachments ?? []);
    for (const name of removed)
      if (!row.attachments.some((a) => a.filename === name))
        throw new Error(`${tool}: no file named "${name}" on this draft`);
    const kept = row.attachments.filter((a) => !removed.has(a.filename));
    const source = await sourceOf(row);
    const files = await resolveFiles(tool, patch.addAttachments, kept, source, {
      mirrored: Boolean(row.mirror?.ref),
      userPicked: opts.userPicked,
    });
    const providerPatch: DraftPatch = {
      ...(to ? { to } : {}),
      ...(cc ? { cc } : {}),
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.body !== undefined
        ? {
            bodyMarkdown: patch.body,
            bodyHtml: renderEmailBody(patch.body).html,
          }
        : {}),
      ...(files.length ? { attachments: files.map((f) => f.bytes) } : {}),
      ...(removed.size ? { removeAttachments: [...removed] } : {}),
    };
    const local: DraftSnapshot = {
      ...snapshotOf(row),
      ...(to ? { to } : {}),
      ...(cc ? { cc } : {}),
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.body !== undefined ? { bodyMarkdown: patch.body } : {}),
      attachments: [...kept, ...files.map((f) => f.attachment)],
    };
    // Files named in the edit are always written: the same name and size
    // can still be other bytes.
    if (
      !files.length &&
      normalizeSnapshot(local) === normalizeSnapshot(snapshotOf(row))
    )
      return toolResult(row, []);
    const drafts = await draftsFor(row);
    if (row.mirror?.ref && drafts) {
      // Kia's edit goes to the provider; its readback is what the row holds.
      try {
        const next = await mirror.updateLocked(
          row,
          drafts,
          providerPatch,
          local,
        );
        return toolResult(next, []);
      } catch (e) {
        const label = providerLabel(await sourceOf(row));
        deps.logSink.log(
          'outbound',
          'warn',
          `draft ${row.id}: update failed (${e instanceof Error ? e.message : String(e)})`,
          { draftId: row.id },
        );
        throw new Error(
          `${tool}: couldn't update the ${label} draft (${e instanceof Error ? e.message : String(e)}) — it now shows what ${label} has; try again`,
        );
      }
    }
    const { row: next } = await deps.store.outbox.applyContent(row.id, local);
    // Not mirrored yet on an account that can: a revise is when the create
    // is tried again, from the edited row (one revision bump).
    if (drafts && !next.mirror?.ref) {
      const known = files.map((f) => f.bytes);
      const intent = await intentWithFiles(next, known).catch(() => null);
      if (intent) {
        const made = await createWithFilesLocked(next, drafts, intent);
        return toolResult(made.row, made.warnings);
      }
    }
    return toolResult(next, []);
  };

  return {
    setBaseUrl(url) {
      baseUrl = url;
    },

    setRemoteBaseUrl(url) {
      remoteBaseUrl = url;
    },

    context: () => ({
      modeFor,
      baseFor: (t) => (t === 'remote' ? remoteBaseUrl : baseUrl),
      createdViaNow,
      secret: () => deps.store.outbox.secret(),
    }),

    async draftReply({ documentId, body, replyAll, target, attachments }) {
      assertReady();
      const doc = await deps.store.read.document(documentId as DocumentId);
      if (!doc)
        throw new Error(`draft_reply: unknown document '${documentId}'`);
      const account = await accountFor(doc.accountId as string);
      const mode = modeFor(account);
      const files = await resolveFiles(
        'draft_reply',
        attachments,
        [],
        account.source,
        // A new draft on a mirroring account becomes a provider draft.
        { mirrored: Boolean(lookup.get(account.source)?.drafts) },
      );
      const fileList = files.map((f) => f.attachment);

      // Universality hook (spec §6): a source that wrote metadata.outbound
      // owns its reply addressing — the ref is opaque and round-trips to
      // that source's Sender verbatim. Bundled email resolution otherwise.
      const picked = pickOutbound(doc.metadata.outbound, {
        target,
        replyAll: replyAll === true,
      });
      let row: OutboxRow;
      let warnings: string[] = [];
      if (picked) {
        row = await deps.store.outbox.create({
          accountId: account.id,
          kind: 'reply',
          replyToDocumentId: doc.id,
          outboundRef: picked.ref,
          recipientDisplay: picked.display,
          to: picked.to,
          cc: picked.cc,
          subject: null,
          bodyMarkdown: body,
          confirmMode: mode,
          createdVia: createdViaNow(),
          createdBy: currentClient(),
          expiresAt: expiresAt(),
          attachments: fileList,
        });
      } else if (target !== undefined) {
        // Per-message targets live only in metadata.outbound.targets; email
        // replies thread from stored headers, not model-picked keys.
        throw new Error(
          `draft_reply: this document stores no per-message reply targets — ` +
            `omit 'target'`,
        );
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
          createdBy: currentClient(),
          expiresAt: expiresAt(),
          attachments: fileList,
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
          createdBy: currentClient(),
          expiresAt: expiresAt(),
          attachments: fileList,
        });
      }
      const made = await mirrorNew(
        row,
        files.map((f) => f.bytes),
      );
      return toolResult(made.row, [...warnings, ...made.warnings]);
    },

    async draftMessage({ accountId, to, subject, body, attachments }) {
      assertReady();
      const account = await accountFor(accountId);
      // An extension source that declares `compose: 'email'` sends as the
      // account's own mailbox (its Sender owns From). Everything else must
      // resolve a From address here — which also refuses compose for
      // reply-only extension sources (Slack, chats) with its own wording.
      if (deps.descriptorFor?.(account.source)?.compose !== 'email')
        senderAddressFor(account); // fail fast when no From address resolves
      const trimmed = to.map((t) => t.trim());
      const bad = trimmed.filter((t) => !EMAIL_RX.test(t));
      if (trimmed.length === 0 || bad.length > 0) {
        throw withLogMessage(
          new Error(
            `draft_message: invalid recipient address(es): ${bad.join(', ') || '(none given)'}`,
          ),
          `draft_message: invalid recipient address(es) (${bad.length})`,
        );
      }
      const files = await resolveFiles(
        'draft_message',
        attachments,
        [],
        account.source,
        // A new draft on a mirroring account becomes a provider draft.
        { mirrored: Boolean(lookup.get(account.source)?.drafts) },
      );
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
        createdBy: currentClient(),
        expiresAt: expiresAt(),
        attachments: files.map((f) => f.attachment),
      });
      const made = await mirrorNew(
        row,
        files.map((f) => f.bytes),
      );
      return toolResult(made.row, made.warnings);
    },

    async listOutbox({ limit, html }) {
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
      await refreshPending(await deps.store.outbox.listRecent(clampedLimit));
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
        if (row.status === 'draft' && currentTransport() !== 'agent') {
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
          revision: row.status === 'draft' ? row.revision : null,
          draft:
            row.status === 'draft'
              ? {
                  draft_id: row.id,
                  mode: row.confirmMode,
                  recipient_display: row.recipientDisplay,
                  ...draftFields(row),
                  ...(html && (await bodyHtmlOf(row))),
                  warnings: [],
                  instruction: `Show the user this draft before asking to send it. ${
                    REVISE_HINT
                  }`,
                }
              : null,
          ...(row.status === 'draft' && row.sendAt
            ? { scheduled_for: row.sendAt }
            : {}),
          ...(row.status === 'draft' && !row.sendAt && row.suggestedSendAt
            ? { suggested_for: row.suggestedSendAt }
            : {}),
        });
      }
      return out;
    },

    async reviseDraft({ draftId, revision, ...patch }) {
      assertReady();
      return withDraft(draftId, () =>
        reviseLocked('revise_draft', draftId, revision, patch),
      );
    },

    // The review sheet's files come from the user's own file dialog.
    reviseById: (draftId, revision, patch) =>
      withDraft(draftId, () =>
        reviseLocked('revise', draftId, revision, patch, { userPicked: true }),
      ),

    reopenById: (draftId) => withDraft(draftId, () => reopenLocked(draftId)),

    async reopenByToken(token) {
      const secret = await deps.store.outbox.secret();
      const parsed = verifyConfirmToken(secret, token, nowMs());
      if (!parsed) return { kind: 'invalid' };
      const row = await withDraft(parsed.draftId, async () => {
        await reopenLocked(parsed.draftId);
        return deps.store.outbox.get(parsed.draftId);
      });
      if (!row) return { kind: 'invalid' };
      if (row.status !== 'draft') return { kind: 'gone', row };
      return { kind: 'ok', row, mode: row.confirmMode };
    },

    discardById: (draftId) =>
      withDraft(draftId, async () => (await discardLocked(draftId)).row),

    refreshById: (draftId) => refreshById(draftId),

    refreshPending,

    async sendDraft({ draftId, revision }) {
      // Deliberately NO transport gate (unlike the drafting tools): a draft
      // row can only exist if drafting was permitted on the transport that
      // created it, and the user's agreement is observed by the model
      // wherever the conversation happens. The gates that matter here are
      // the live chat opt-in and the per-account rate limit, both below.
      if (currentTransport() === 'agent') {
        throw new Error(
          "send_draft: this draft needs the user's confirmation on the " +
            'Outbox review page — it can never send.',
        );
      }
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

      // Same CAS gate the page confirm uses — the single-use property and
      // the race protection live here, not in the checks above. The rate
      // rule counts what was sent and what is scheduled around now.
      const outcome = await withAccount(account.id, async () => {
        if (!(await admits(account, nowMs(), row.id))) {
          const limit = sendsPerHourFor(account);
          throw new Error(
            `send_draft: rate limit reached — ${limit} message(s) an hour ` +
              `from this account, counting sent and scheduled ones. The ` +
              `draft is still pending; try again later or use list_outbox ` +
              `for a confirmation link.`,
          );
        }
        return withDraft(row.id, () =>
          confirmLocked(row.id, typeof revision === 'number' ? revision : null),
        );
      });
      if (outcome.kind === 'changed')
        throw changedError(
          'send_draft',
          typeof revision === 'number' ? revision : null,
          outcome.row,
        );
      if (outcome.kind === 'already' || outcome.kind === 'invalid') {
        const current = await deps.store.outbox.get(row.id);
        throw new Error(
          `send_draft: this draft can no longer be sent — its status is ` +
            `'${current?.status ?? 'unknown'}'.`,
        );
      }
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
      // Every review shows the provider's current draft (§5.3).
      const row = await refreshById(parsed.draftId);
      if (!row) return { kind: 'invalid' };
      if (row.status !== 'draft') return { kind: 'gone', row };
      return { kind: 'ok', row, mode: row.confirmMode };
    },

    async confirmByToken(token, revision) {
      const secret = await deps.store.outbox.secret();
      const parsed = verifyConfirmToken(secret, token, nowMs());
      if (!parsed) return { kind: 'invalid' };
      return confirmRow(parsed.draftId, revision);
    },

    async scheduleByToken(token, revision, atMs) {
      const secret = await deps.store.outbox.secret();
      const parsed = verifyConfirmToken(secret, token, nowMs());
      if (!parsed) return { kind: 'invalid' };
      return withDraft(parsed.draftId, async () => {
        const row = await deps.store.outbox.get(parsed.draftId);
        if (!row) return { kind: 'invalid' };
        // Any time the page offered or the user typed there: the AI's
        // suggestion, a Send later preset or a custom time.
        try {
          return await scheduleLocked(
            row.id,
            revision,
            new Date(atMs).toISOString(),
          );
        } catch (e) {
          return {
            kind: 'failed',
            row,
            error: `not scheduled: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      });
    },

    async unscheduleByToken(token, revision) {
      const secret = await deps.store.outbox.secret();
      const parsed = verifyConfirmToken(secret, token, nowMs());
      if (!parsed) return { kind: 'invalid' };
      return withDraft(parsed.draftId, async () => {
        const row = await deps.store.outbox.get(parsed.draftId);
        if (!row) return { kind: 'invalid' };
        if (row.status !== 'draft') return { kind: 'already', row };
        if (row.revision !== revision) return { kind: 'changed', row };
        return scheduleLocked(row.id, revision, null);
      });
    },

    bodyHtmlFor,

    sendById: (draftId, revision) => confirmRow(draftId, revision),

    scheduleById: (draftId, revision, sendAt) =>
      withDraft(draftId, () => scheduleLocked(draftId, revision, sendAt)),

    scheduleDrafts,

    sendScheduled: (draftId, sendAt) =>
      withDraft(draftId, async (): Promise<ScheduledSend> => {
        const row = await deps.store.outbox.get(draftId);
        if (!row || row.status !== 'draft' || row.sendAt !== sendAt)
          return 'skipped';
        const late = nowMs() - Date.parse(sendAt) > SCHEDULE_LATE_MS;
        // An extension's sender comes up a little after boot: wait for it
        // (still armed) rather than fail the send.
        if (!late && !lookup.get(await sourceOf(row))) return 'skipped';
        if (late) {
          await deps.store.outbox.missSchedule(draftId, sendAt, expiresAt());
          deps.logSink.log(
            'outbound',
            'info',
            `draft ${draftId}: missed its scheduled time`,
            { draftId },
          );
          return 'missed';
        }
        // The confirmed revision: any edit since cleared send_at, and one
        // adopted from the provider right now comes back as `changed`. A
        // provider out of reach leaves the row armed for the next tick. The
        // time is checked again just before the send: the refresh may have
        // taken it past the 5 minutes, or the clock may have gone back.
        let verdict: ScheduledSend | null = null;
        const out = await confirmLocked(draftId, row.revision, async (r) => {
          const t = nowMs();
          const due = Date.parse(sendAt);
          if (r.sendAt !== sendAt || t < due) verdict = 'skipped';
          else if (t - due > SCHEDULE_LATE_MS) {
            await deps.store.outbox.missSchedule(draftId, sendAt, expiresAt());
            verdict = 'missed';
          }
          return verdict ? { kind: 'already', row: r } : null;
        });
        if (verdict) return verdict;
        if (out.kind === 'failed' && out.refused) {
          // Waiting won't fix it: stop now and say why.
          await deps.store.outbox.missSchedule(
            draftId,
            sendAt,
            expiresAt(),
            `Not sent at its time — ${out.error.replace(/^not sent:\s*/, '')}`,
          );
          return 'missed';
        }
        deps.logSink.log(
          'outbound',
          'info',
          `draft ${draftId}: scheduled send → ${out.kind}`,
          { draftId },
        );
        return out.kind;
      }),

    senderSources: () => lookup.ids(),

    isEmailSource,

    async cancelByToken(token) {
      const secret = await deps.store.outbox.secret();
      const parsed = verifyConfirmToken(secret, token, nowMs());
      if (!parsed) return { kind: 'invalid' };
      const before = await deps.store.outbox.get(parsed.draftId);
      if (!before) return { kind: 'invalid' };
      if (before.status !== 'draft') return { kind: 'already', row: before };
      const after = await withDraft(before.id, () => discardLocked(before.id));
      if (!after.moved) return { kind: 'already', row: after.row ?? before };
      return { kind: 'cancelled', row: after.row ?? before };
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
      // A row that can come back to review (expired, or a failure that
      // provably never went out) is reopened instead: the same row, so one
      // provider draft is only ever owned by one row. A new row is for a
      // discarded draft, or a failure that cannot be retried as is.
      if (isReopenable(row))
        throw new Error(
          `this draft can be tried again as it is — use Try again`,
        );
      if (row.status !== 'discarded' && row.status !== 'failed') {
        throw new Error(
          `only failed or discarded drafts can be re-drafted — this one is ` +
            `'${row.status}'`,
        );
      }
      // Account-gone and unsupported-source refusals, identical to
      // draft_reply time (service.ts:191-201), read live off the lookup.
      const account = await accountFor(row.accountId as string);
      // One provider draft belongs to one row: a failed row's draft goes
      // before the new row makes its own.
      if (row.mirror?.ref && row.status === 'failed') {
        const drafts = await draftsFor(row);
        if (drafts)
          await withDraft(row.id, () => mirror.removeLocked(row, drafts));
      }
      // Deliberately NO re-resolution: outboundRef / to / cc / threading are
      // copied verbatim off the frozen row. Re-running the resolver could
      // surface the "this document has no reply target" refusal
      // (service.ts:494-498) for a row that already HAS a valid target, and
      // could silently re-target a reply if the thread moved.
      // create() itself runs expireOverdue() and enforces
      // OUTBOX_PENDING_CAP (outbox.ts:171-217) — no extra gate needed here.
      const fresh = await deps.store.outbox.create({
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
        createdBy: null,
        expiresAt: expiresAt(),
        bcc: row.bcc,
        // Files added in the mail app went with the removed provider draft.
        attachments: row.attachments.filter((a) => a.from),
      });
      return (await mirrorNew(fresh)).row;
    },
  };
}
