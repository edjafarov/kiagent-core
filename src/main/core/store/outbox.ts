/**
 * Outbox table access — frozen outbound drafts and their state machine
 * (docs/superpowers/specs/2026-07-23-unified-outbound-design.md §3).
 * Composed into CoreStore as `store.outbox` the way vault/identity/consents
 * are; kept in its own module so store.ts doesn't grow another 200 lines.
 */
import { randomBytes } from 'crypto';
import type { EventEmitter } from 'events';

import type {
  AccountId,
  ConfirmMode,
  DocumentId,
  DraftRef,
  DraftSnapshot,
  MirrorState,
  OutboxAttachment,
  OutboxRow,
  OutboxStatus,
} from '@shared/contracts';

import type { AppDb, AppDbParam } from '../../db/app-db';
import { newId } from '../ids';

export const OUTBOX_PENDING_CAP = 20;
/** How long a pending draft waits for review before it expires. */
export const DRAFT_TTL_MS = 24 * 60 * 60_000;

export interface OutboxDraftInput {
  accountId: AccountId;
  kind: 'reply' | 'new';
  replyToDocumentId?: DocumentId | null;
  outboundRef?: unknown;
  recipientDisplay: string;
  to: string[];
  cc: string[];
  subject?: string | null;
  bodyMarkdown: string;
  threading?: Record<string, unknown> | null;
  confirmMode: ConfirmMode;
  createdVia: 'mcp-local' | 'mcp-remote' | 'mcp-agent' | 'panel';
  /** The drafting MCP client's name; null for the panel or an unnamed app. */
  createdBy?: string | null;
  expiresAt: string;
  bcc?: string[];
  attachments?: OutboxAttachment[];
}

/** A row that mirrors a provider draft: never expires, not in the cap. */
const MIRRORED = `(mirror_json IS NOT NULL AND json_extract(mirror_json, '$.ref') IS NOT NULL)`;

/** An address as compared: the mailbox alone, lower-cased. Gmail re-saves
 *  an opened draft with display names ("Ann <ann@x>"), which is no edit. */
const addressKey = (x: string) =>
  (/<([^<>]+)>\s*$/.exec(x)?.[1] ?? x).trim().toLowerCase();
const lowerAll = (xs: string[]) => xs.map(addressKey);

/** The comparison key of a draft's reviewable content (spec §4.1): trimmed,
 *  CRLF → LF, trailing whitespace stripped per line, addresses by mailbox,
 *  attachments as a set of filename + size + where Kia got it (a file
 *  swapped for another of the same name and size is still a change).
 *  `provider`: the key a provider's copy is compared by — within each
 *  paragraph every whitespace run as one space, since Gmail re-wraps plain
 *  text when a draft is merely opened there; a paragraph break still counts. */
export function normalizeSnapshot(
  s: DraftSnapshot,
  { provider = false }: { provider?: boolean } = {},
): string {
  const body = provider
    ? s.bodyMarkdown
        .replace(/\r\n/g, '\n')
        .split(/\n[ \t]*\n\s*/)
        .map((p) => p.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n\n')
    : s.bodyMarkdown
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.replace(/\s+$/, ''))
        .join('\n')
        .trim();
  return JSON.stringify([
    lowerAll(s.to),
    lowerAll(s.cc),
    lowerAll(s.bcc),
    s.subject?.trim() ?? null,
    body,
    s.attachments
      .map((a) => JSON.stringify([a.filename, a.size, a.from ?? null]))
      .sort(),
  ]);
}

export interface ApplyOptions {
  /** Files Kia is uploading in this write: where each came from. */
  origins?: OutboxAttachment[];
  /** Where the snapshot comes from (default: Kia's own edit).
   *  - `provider`: the provider's copy, compared by
   *    `normalizeSnapshot(…, { provider: true })`.
   *  - `created`: the same, read right after the create — a reply that left
   *    its subject to the provider (Outlook's createReply writes "RE: …")
   *    takes the provider's without a new revision.
   *  - `echo`: the provider's copy of Kia's own write — Kia's text, the
   *    provider's files, compared strictly. */
  from?: 'provider' | 'created' | 'echo';
  /** Body hashes for the mirror (spec 2026-10-21 §3.4): `seenKey` replaces
   *  the stored one; `ownKey` a string sets it, `null` clears it, absent
   *  keeps it. */
  keys?: { seenKey?: string; ownKey?: string | null };
}

export function snapshotOf(row: OutboxRow): DraftSnapshot {
  return {
    to: row.to,
    cc: row.cc,
    bcc: row.bcc,
    subject: row.subject,
    bodyMarkdown: row.bodyMarkdown,
    attachments: row.attachments,
  };
}

export interface OutboxStore {
  create(d: OutboxDraftInput): Promise<OutboxRow>; // throws on pending cap
  get(id: string): Promise<OutboxRow | null>;
  listRecent(limit: number): Promise<OutboxRow[]>; // newest first
  /** Status-filtered, keyset-paged listing — `ORDER BY created_at DESC, id
   *  DESC` (same order as `listRecent`). `before` is the last row of the
   *  previous page: pass its `{ createdAt, id }` to fetch the next one.
   *  Unlike `listRecent`, this can walk the WHOLE table a page at a time, so
   *  a pending draft behind any number of newer terminal-status rows is
   *  reachable with `status: ['draft']`. `status` omitted (`undefined`) means
   *  no filter, every status; `status: []` (present but empty) means match
   *  NOTHING — the two are deliberately not the same. */
  list(opts: {
    limit: number;
    status?: OutboxStatus[];
    before?: { createdAt: string; id: string };
  }): Promise<OutboxRow[]>;
  /** Exact count of draft rows across every account (`OUTBOX_PENDING_CAP` is
   *  per-account; this is the whole outbox). */
  countPending(): Promise<number>;
  /** Subscribe to "the outbox may have changed" — fired once per effective
   *  change: a create, a transition whose compare-and-set actually moved a
   *  row, an expireOverdue sweep that expired at least one row, and a
   *  removeAccount cascade (store.ts's commit(), since the cascade delete
   *  runs in SQL and never calls into this module). Never fired on a no-op.
   *  Returns an unsubscribe function. */
  onChange(cb: () => void): () => void;
  /** Atomic compare-and-set; true iff exactly one row moved.
   *
   *  `patch` fields only ever SET a value — `null` and "field omitted" are
   *  the same instruction: leave the stored column unchanged (COALESCE
   *  against the existing value). No transition ever clears a patch field
   *  back to null — with one exception: 'draft' → 'sending' drops the
   *  draft's schedule note (a draft's `error` is only ever that note). The
   *  table is otherwise an audit log, and a retry/redraft is a NEW row,
   *  never a scrub of an old one's `error`/`externalMessageId`/`sentAt`. */
  transition(
    id: string,
    from: OutboxStatus[],
    to: OutboxStatus,
    patch?: {
      error?: string | null;
      externalMessageId?: string | null;
      sentAt?: string | null;
    },
  ): Promise<boolean>;
  countDrafts(accountId: AccountId): Promise<number>;
  /** Rows that reached 'sent' at or after sinceIso, for the mode-C rate limit. */
  countSentSince(accountId: AccountId, sinceIso: string): Promise<number>;
  /** draft rows past expires_at → status 'expired'. Called lazily. */
  expireOverdue(): Promise<void>;
  /** Boot-time sweep: rows still in 'sending' can only mean the previous
   *  process died mid-send → 'delivery_unknown' (the message MAY have been
   *  sent; never auto-retried). Sends run in-process, so at boot no send can
   *  legitimately be in flight. */
  recoverOrphanedSending(): Promise<void>;
  /** The ONE content write (spec §4.1). The caller holds the per-draft
   *  lock and has compared revisions. Stores `ref` when given; when the
   *  normalized content differs, writes it, bumps the revision, clears
   *  send_at and recomputes recipient_display. Throws on a non-draft. */
  applyContent(
    id: string,
    snapshot: DraftSnapshot,
    ref?: DraftRef,
    opts?: ApplyOptions,
  ): Promise<{ row: OutboxRow; changed: boolean }>;
  /** Mirror bookkeeping only; no revision bump. */
  setMirror(id: string, mirror: MirrorState): Promise<void>;
  /** Sets or clears send_at on a draft; no revision bump. Clears the
   *  draft's schedule note ("Missed its time", "Edited — schedule again"). */
  schedule(id: string, sendAt: string | null): Promise<boolean>;
  /** Scheduled drafts whose time has come (send_at <= nowIso). */
  listDue(nowIso: string): Promise<Array<{ id: string; sendAt: string }>>;
  /** A schedule that can no longer be kept (more than 5 min late): send_at
   *  cleared, a fresh expiry, the note "Missed its time — send now or
   *  reschedule". Only if send_at is still `sendAt`. */
  missSchedule(
    id: string,
    sendAt: string,
    expiresAt: string,
    /** Why, when not merely late (a send that can't go as it is). */
    note?: string,
  ): Promise<boolean>;
  /** A provably-failed or expired row back to draft as a new revision
   *  (error and send_at cleared, fresh expiry). Null if it was neither. */
  reopen(id: string, expiresAt: string): Promise<OutboxRow | null>;
  /** Lazily generated 32-byte HMAC secret, sealed with the store's encrypt
   *  codec, persisted in the meta table under 'outboundSecret'. */
  secret(): Promise<Buffer>;
}

interface OutboxRowSql {
  id: string;
  account_id: string;
  kind: 'reply' | 'new';
  reply_to_document_id: string | null;
  outbound_ref: string | null;
  recipient_display: string;
  to_json: string;
  cc_json: string;
  subject: string | null;
  body_markdown: string;
  threading_json: string | null;
  confirm_mode: ConfirmMode;
  status: OutboxStatus;
  error: string | null;
  external_message_id: string | null;
  created_via: 'mcp-local' | 'mcp-remote' | 'mcp-agent' | 'panel';
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
  expires_at: string;
  revision: number;
  bcc_json: string;
  attachments_json: string;
  mirror_json: string | null;
  send_at: string | null;
}

function toRow(r: OutboxRowSql): OutboxRow {
  return {
    id: r.id,
    accountId: r.account_id as AccountId,
    kind: r.kind,
    replyToDocumentId: (r.reply_to_document_id as DocumentId | null) ?? null,
    outboundRef: r.outbound_ref === null ? null : JSON.parse(r.outbound_ref),
    recipientDisplay: r.recipient_display,
    to: JSON.parse(r.to_json) as string[],
    cc: JSON.parse(r.cc_json) as string[],
    subject: r.subject,
    bodyMarkdown: r.body_markdown,
    threading:
      r.threading_json === null
        ? null
        : (JSON.parse(r.threading_json) as Record<string, unknown>),
    confirmMode: r.confirm_mode,
    status: r.status,
    error: r.error,
    externalMessageId: r.external_message_id,
    createdVia: r.created_via,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    expiresAt: r.expires_at,
    revision: r.revision,
    bcc: JSON.parse(r.bcc_json) as string[],
    attachments: JSON.parse(r.attachments_json) as OutboxAttachment[],
    mirror:
      r.mirror_json === null
        ? null
        : (JSON.parse(r.mirror_json) as MirrorState),
    sendAt: r.send_at,
  };
}

export function createOutboxStore(
  db: AppDb,
  deps: {
    now: () => string;
    encrypt(plain: string): Buffer;
    decrypt(blob: Buffer): string;
    /** Shared with store.ts: `onChange` subscribes here, and store.ts's own
     *  `commit()` fires it directly for the removeAccount cascade (that
     *  delete runs in SQL — schema.ts:561's ON DELETE CASCADE — and never
     *  touches this module's create/transition/expireOverdue). */
    changed: EventEmitter;
  },
): OutboxStore {
  const fireChanged = () => deps.changed.emit('change');
  const freshExpiry = () =>
    new Date(Date.parse(deps.now()) + DRAFT_TTL_MS).toISOString();

  const get = async (id: string): Promise<OutboxRow | null> => {
    const r = (
      await db.all(`SELECT * FROM outbox WHERE id = ?`, [id])
    )[0] as unknown as OutboxRowSql | undefined;
    return r ? toRow(r) : null;
  };

  const countDrafts = async (accountId: AccountId): Promise<number> => {
    const r = (
      await db.all(
        `SELECT COUNT(*) AS n FROM outbox
          WHERE account_id = ? AND status = 'draft' AND NOT ${MIRRORED}`,
        [accountId],
      )
    )[0] as { n: number };
    return r.n;
  };

  const expireOverdue = async (): Promise<void> => {
    // db.batch (not db.run) so the sweep can tell whether it actually moved
    // a row — onChange must stay silent on a sweep that finds nothing.
    const results = await db.batch([
      {
        sql: `UPDATE outbox SET status = 'expired'
                WHERE status = 'draft' AND expires_at <= ?
                  AND send_at IS NULL AND NOT ${MIRRORED}`,
        params: [deps.now()],
      },
    ]);
    if (results[0].changes > 0) fireChanged();
  };

  return {
    get,
    countDrafts,
    expireOverdue,

    async countSentSince(accountId, sinceIso) {
      const rows = await db.all(
        `SELECT COUNT(*) AS n FROM outbox
         WHERE account_id = ? AND status = 'sent' AND sent_at >= ?`,
        [accountId, sinceIso],
      );
      return Number(rows[0]?.n ?? 0);
    },

    async create(d) {
      // Lazy sweep first so stale drafts never occupy cap slots.
      await expireOverdue();
      // Advisory, not a hard invariant: this check-then-insert is not atomic
      // with the insert below, so two concurrent create() calls for the same
      // account can briefly land the count one or two over the cap.
      // OUTBOX_PENDING_CAP exists to stop runaway drafting, not to guarantee
      // an exact ceiling — accepted.
      const pending = await countDrafts(d.accountId);
      if (pending >= OUTBOX_PENDING_CAP) {
        throw new Error(
          `outbox: account has ${pending} pending drafts (cap ` +
            `${OUTBOX_PENDING_CAP}) — confirm or cancel existing drafts first ` +
            `(list_outbox shows them).`,
        );
      }
      const id = newId<'outbox'>() as string;
      await db.run(
        `INSERT INTO outbox (id, account_id, kind, reply_to_document_id,
           outbound_ref, recipient_display, to_json, cc_json, subject,
           body_markdown, threading_json, confirm_mode, status, created_via,
           created_by, created_at, expires_at, bcc_json, attachments_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
        [
          id,
          d.accountId,
          d.kind,
          d.replyToDocumentId ?? null,
          d.outboundRef === undefined || d.outboundRef === null
            ? null
            : JSON.stringify(d.outboundRef),
          d.recipientDisplay,
          JSON.stringify(d.to),
          JSON.stringify(d.cc),
          d.subject ?? null,
          d.bodyMarkdown,
          d.threading ? JSON.stringify(d.threading) : null,
          d.confirmMode,
          d.createdVia,
          d.createdBy ?? null,
          deps.now(),
          d.expiresAt,
          JSON.stringify(d.bcc ?? []),
          JSON.stringify(d.attachments ?? []),
        ],
      );
      const row = await get(id);
      if (!row) throw new Error('outbox: insert readback failed');
      fireChanged();
      return row;
    },

    async listRecent(limit) {
      const rows = (await db.all(
        `SELECT * FROM outbox ORDER BY created_at DESC, id DESC LIMIT ?`,
        [limit],
      )) as unknown as OutboxRowSql[];
      return rows.map(toRow);
    },

    async list({ limit, status, before }) {
      const where: string[] = [];
      const params: AppDbParam[] = [];
      // `status` is optional-absent vs. present-empty, and they mean opposite
      // things: `undefined` (the key omitted) is "no filter, every status" —
      // `[]` (present, deliberately empty) must match NOTHING, not
      // everything. A caller (e.g. a UI status-picker with nothing checked)
      // that ends up with an empty array asked for zero rows; silently
      // falling through to "no filter" would be the worst failure direction
      // for an outbox view. `status?.length` alone cannot tell these apart —
      // both are falsy — so the length-0 case is branched explicitly.
      if (status !== undefined) {
        where.push(
          status.length === 0
            ? '0 = 1'
            : `status IN (${status.map(() => '?').join(',')})`,
        );
        params.push(...status);
      }
      if (before) {
        // Matches ORDER BY created_at DESC, id DESC exactly.
        where.push(`(created_at < ? OR (created_at = ? AND id < ?))`);
        params.push(before.createdAt, before.createdAt, before.id);
      }
      const rows = (await db.all(
        `SELECT * FROM outbox ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        [...params, limit],
      )) as unknown as OutboxRowSql[];
      return rows.map(toRow);
    },

    async countPending() {
      const r = (
        await db.all(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'draft'`)
      )[0] as { n: number };
      return r.n;
    },

    onChange(cb) {
      deps.changed.on('change', cb);
      return () => {
        deps.changed.off('change', cb);
      };
    },

    async transition(id, from, to, patch = {}) {
      // Single UPDATE = the atomicity primitive; db.batch is the only AppDb
      // surface that reports `changes`, so the compare-and-set rides it.
      const placeholders = from.map(() => '?').join(',');
      const results = await db.batch([
        {
          // Leaving 'draft' drops a draft's schedule note unless the patch
          // brings its own (a missed time must not follow a discard).
          sql: `UPDATE outbox SET status = ?,
                  error = CASE WHEN status = 'draft' THEN ?
                               ELSE COALESCE(?, error) END,
                  external_message_id = COALESCE(?, external_message_id),
                  sent_at = COALESCE(?, sent_at)
                WHERE id = ? AND status IN (${placeholders})`,
          params: [
            to,
            patch.error ?? null,
            patch.error ?? null,
            patch.externalMessageId ?? null,
            patch.sentAt ?? null,
            id,
            ...from,
          ],
        },
      ]);
      const moved = results[0].changes === 1;
      if (moved) fireChanged();
      return moved;
    },

    async applyContent(id, incoming, ref, { origins = [], from, keys } = {}) {
      const row = await get(id);
      if (!row || row.status !== 'draft')
        throw new Error('outbox: not a draft');
      const fromProvider = from !== undefined;
      // A readback carries no `from`: keep where Kia got each file. A
      // provider's size is its own count (Outlook adds MIME overhead), so a
      // file Kia attached keeps the size Kia read — while the provider
      // reports the size it reported last time (none remembered: Kia's own
      // count), or Kia is uploading it now. Another size under the same name
      // is a file replaced there (the same size is not caught: no provider
      // hands out a content hash on a read).
      const known = new Map(
        [...row.attachments, ...origins]
          .filter((a) => a.from)
          .map((a) => [a.filename, a]),
      );
      const uploading = new Set(origins.map((a) => a.filename));
      const seen = row.mirror?.sizes ?? {};
      const snapshot = {
        ...incoming,
        attachments: incoming.attachments.map((a) => {
          const k = known.get(a.filename);
          if (a.from || !k) return a;
          if (!fromProvider) return { ...a, from: k.from };
          return uploading.has(a.filename) ||
            a.size === (seen[a.filename] ?? k.size)
            ? { ...a, from: k.from, size: k.size }
            : a;
        }),
      };
      // The provider's count of each file, as just read. Kia's own write
      // forgets the count of each file it uploads or drops: whatever the
      // provider reports next for that name is not vouched for.
      const sizes = fromProvider
        ? Object.fromEntries(
            incoming.attachments.map((a) => [a.filename, a.size]),
          )
        : row.mirror?.sizes &&
          Object.fromEntries(
            Object.entries(row.mirror.sizes).filter(
              ([name]) =>
                !uploading.has(name) &&
                incoming.attachments.some((a) => a.filename === name),
            ),
          );
      const loose = from === 'provider' || from === 'created';
      const key = (x: DraftSnapshot) =>
        normalizeSnapshot(x, { provider: loose });
      const filled =
        from === 'created' && row.subject === null && snapshot.subject !== null;
      const changed =
        key({
          ...snapshotOf(row),
          ...(filled && { subject: snapshot.subject }),
        }) !== key(snapshot);
      const merged =
        ref === undefined
          ? undefined
          : JSON.stringify({
              ...(row.mirror ?? {}),
              ref,
              error: undefined,
              ...(sizes && {
                sizes: Object.keys(sizes).length ? sizes : undefined,
              }),
              ...(keys?.seenKey !== undefined && { seenKey: keys.seenKey }),
              ...(keys?.ownKey !== undefined && {
                ownKey: keys.ownKey ?? undefined,
              }),
            });
      // An unchanged mirror is no write and no change event: a refresh that
      // found nothing new must not wake the screens that list the Outbox.
      const mirror =
        merged === undefined || merged === JSON.stringify(row.mirror)
          ? undefined
          : merged;
      if (changed) {
        const sameTo =
          JSON.stringify(lowerAll(row.to)) ===
          JSON.stringify(lowerAll(snapshot.to));
        const display =
          row.kind === 'reply' && sameTo
            ? row.recipientDisplay
            : snapshot.to.join(', ') || row.recipientDisplay;
        const results = await db.batch([
          {
            sql: `UPDATE outbox SET to_json = ?, cc_json = ?, bcc_json = ?,
                    subject = ?, body_markdown = ?, attachments_json = ?,
                    recipient_display = ?, revision = revision + 1,
                    error = CASE WHEN send_at IS NOT NULL
                                 THEN 'Edited — schedule again' ELSE NULL END,
                    -- A schedule kept the draft from expiring; without it
                    -- the draft gets a fresh wait, not a lapsed one.
                    expires_at = CASE WHEN send_at IS NOT NULL
                                      THEN ? ELSE expires_at END,
                    send_at = NULL, mirror_json = COALESCE(?, mirror_json)
                  WHERE id = ? AND status = 'draft'`,
            params: [
              JSON.stringify(snapshot.to),
              JSON.stringify(snapshot.cc),
              JSON.stringify(snapshot.bcc),
              snapshot.subject,
              snapshot.bodyMarkdown,
              JSON.stringify(snapshot.attachments),
              display,
              freshExpiry(),
              mirror ?? null,
              id,
            ],
          },
        ]);
        // expireOverdue runs outside the per-draft lock.
        if (results[0].changes !== 1) throw new Error('outbox: not a draft');
        fireChanged();
      } else if (filled) {
        await db.run(
          `UPDATE outbox SET subject = ?, mirror_json = COALESCE(?, mirror_json)
            WHERE id = ?`,
          [snapshot.subject, mirror ?? null, id],
        );
        fireChanged();
      } else if (mirror !== undefined) {
        await db.run(`UPDATE outbox SET mirror_json = ? WHERE id = ?`, [
          mirror,
          id,
        ]);
        fireChanged();
      }
      const next = await get(id);
      if (!next) throw new Error('outbox: row vanished');
      return { row: next, changed };
    },

    async setMirror(id, mirror) {
      const json = JSON.stringify(mirror);
      const results = await db.batch([
        {
          sql: `UPDATE outbox SET mirror_json = ?
                WHERE id = ? AND mirror_json IS NOT ?`,
          params: [json, id, json],
        },
      ]);
      if (results[0].changes === 1) fireChanged();
    },

    async schedule(id, sendAt) {
      const results = await db.batch([
        {
          sql: `UPDATE outbox SET send_at = ?, error = NULL,
                  expires_at = CASE WHEN ? IS NULL AND send_at IS NOT NULL
                                    THEN ? ELSE expires_at END
                WHERE id = ? AND status = 'draft'`,
          params: [sendAt, sendAt, freshExpiry(), id],
        },
      ]);
      const moved = results[0].changes === 1;
      if (moved) fireChanged();
      return moved;
    },

    async listDue(nowIso) {
      const rows = (await db.all(
        `SELECT id, send_at FROM outbox
          WHERE status = 'draft' AND send_at IS NOT NULL AND send_at <= ?
          ORDER BY send_at`,
        [nowIso],
      )) as unknown as Array<{ id: string; send_at: string }>;
      return rows.map((r) => ({ id: r.id, sendAt: r.send_at }));
    },

    async missSchedule(id, sendAt, expiresAt, note) {
      const results = await db.batch([
        {
          sql: `UPDATE outbox SET send_at = NULL, expires_at = ?, error = ?
                WHERE id = ? AND status = 'draft' AND send_at = ?`,
          params: [
            expiresAt,
            note ?? 'Missed its time — send now or reschedule',
            id,
            sendAt,
          ],
        },
      ]);
      const moved = results[0].changes === 1;
      if (moved) fireChanged();
      return moved;
    },

    async reopen(id, expiresAt) {
      const results = await db.batch([
        {
          sql: `UPDATE outbox SET status = 'draft', error = NULL,
                  revision = revision + 1, send_at = NULL, expires_at = ?
                WHERE id = ? AND status IN ('failed', 'expired')`,
          params: [expiresAt, id],
        },
      ]);
      if (results[0].changes !== 1) return null;
      fireChanged();
      return get(id);
    },

    async recoverOrphanedSending() {
      await db.run(
        `UPDATE outbox SET status = 'delivery_unknown',
           error = 'the app closed while sending — the message may have been sent; check the Sent folder before re-drafting'
         WHERE status = 'sending'`,
      );
    },

    async secret() {
      const r = (
        await db.all(`SELECT value FROM meta WHERE key = 'outboundSecret'`)
      )[0] as { value: string } | undefined;
      if (r) {
        return Buffer.from(
          deps.decrypt(Buffer.from(r.value, 'base64')),
          'base64',
        );
      }
      const secret = randomBytes(32);
      const sealed = deps.encrypt(secret.toString('base64')).toString('base64');
      await db.run(
        `INSERT INTO meta(key, value) VALUES('outboundSecret', ?)
         ON CONFLICT(key) DO NOTHING`,
        [sealed],
      );
      // Re-read: a concurrent generator may have won the ON CONFLICT race.
      const back = (
        await db.all(`SELECT value FROM meta WHERE key = 'outboundSecret'`)
      )[0] as { value: string };
      return Buffer.from(
        deps.decrypt(Buffer.from(back.value, 'base64')),
        'base64',
      );
    },
  };
}
