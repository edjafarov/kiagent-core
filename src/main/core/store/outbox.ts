/**
 * Outbox table access — frozen outbound drafts and their state machine
 * (docs/superpowers/specs/2026-07-23-unified-outbound-design.md §3).
 * Composed into CoreStore as `store.outbox` the way vault/identity/consents
 * are; kept in its own module so store.ts doesn't grow another 200 lines.
 */
import { randomBytes } from 'crypto';

import type {
  AccountId,
  ConfirmMode,
  DocumentId,
  OutboxRow,
  OutboxStatus,
} from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import { newId } from '../ids';

export const OUTBOX_PENDING_CAP = 20;

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
  createdVia: 'mcp-local' | 'mcp-remote' | 'panel';
  expiresAt: string;
}

export interface OutboxStore {
  create(d: OutboxDraftInput): Promise<OutboxRow>; // throws on pending cap
  get(id: string): Promise<OutboxRow | null>;
  listRecent(limit: number): Promise<OutboxRow[]>; // newest first
  /** Atomic compare-and-set; true iff exactly one row moved.
   *
   *  `patch` fields only ever SET a value — `null` and "field omitted" are
   *  the same instruction: leave the stored column unchanged (COALESCE
   *  against the existing value). No transition ever clears a patch field
   *  back to null; the table is an audit log, and a retry/redraft is a NEW
   *  row, never a scrub of an old one's `error`/`externalMessageId`/`sentAt`. */
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
  created_via: 'mcp-local' | 'mcp-remote' | 'panel';
  created_at: string;
  sent_at: string | null;
  expires_at: string;
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
    createdAt: r.created_at,
    sentAt: r.sent_at,
    expiresAt: r.expires_at,
  };
}

export function createOutboxStore(
  db: AppDb,
  deps: {
    now: () => string;
    encrypt(plain: string): Buffer;
    decrypt(blob: Buffer): string;
  },
): OutboxStore {
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
          WHERE account_id = ? AND status = 'draft'`,
        [accountId],
      )
    )[0] as { n: number };
    return r.n;
  };

  const expireOverdue = async (): Promise<void> => {
    await db.run(
      `UPDATE outbox SET status = 'expired'
        WHERE status = 'draft' AND expires_at <= ?`,
      [deps.now()],
    );
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
           created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
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
          deps.now(),
          d.expiresAt,
        ],
      );
      const row = await get(id);
      if (!row) throw new Error('outbox: insert readback failed');
      return row;
    },

    async listRecent(limit) {
      const rows = (await db.all(
        `SELECT * FROM outbox ORDER BY created_at DESC, id DESC LIMIT ?`,
        [limit],
      )) as unknown as OutboxRowSql[];
      return rows.map(toRow);
    },

    async transition(id, from, to, patch = {}) {
      // Single UPDATE = the atomicity primitive; db.batch is the only AppDb
      // surface that reports `changes`, so the compare-and-set rides it.
      const placeholders = from.map(() => '?').join(',');
      const results = await db.batch([
        {
          sql: `UPDATE outbox SET status = ?,
                  error = COALESCE(?, error),
                  external_message_id = COALESCE(?, external_message_id),
                  sent_at = COALESCE(?, sent_at)
                WHERE id = ? AND status IN (${placeholders})`,
          params: [
            to,
            patch.error ?? null,
            patch.externalMessageId ?? null,
            patch.sentAt ?? null,
            id,
            ...from,
          ],
        },
      ]);
      return results[0].changes === 1;
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
