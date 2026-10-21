/**
 * Calendar event drafts — proposals Kia made and the user confirms
 * (alpha-cent docs/superpowers/specs/2026-10-21-calendar-events-booking-
 * design.md §5). Composed into CoreStore as `store.eventDrafts`, like
 * `store.outbox`.
 *
 * The state machine (§5.2) lives HERE as compare-and-set updates, so no
 * caller can skip a step:
 *   draft ─confirm(rev)→ creating ─ok→ created
 *                                  ├─refused→ failed
 *                                  └─timeout/crash→ unknown
 *   failed|unknown ─retry→ creating (same frozen key + payload)
 * A row that ever entered `creating` keeps its idempotency key and payload
 * for good: it can be retried or discarded, never edited again — so at most
 * one provider event exists per draft.
 */
import type { EventEmitter } from 'events';

import type { AccountId, CreatedEvent, EventIntent } from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import { newId } from '../ids';

export const EVENT_DRAFT_PENDING_CAP = 50;
/** Capture makes batches people approve later: a week, not mail's 30 min. */
export const EVENT_DRAFT_TTL_MS = 7 * 24 * 60 * 60_000;

export type EventDraftStatus =
  | 'draft'
  | 'creating'
  | 'created'
  | 'failed'
  | 'discarded'
  | 'expired'
  | 'unknown';

/** Everything a revision covers — the connector contract's event fields,
 *  so a stored draft and the intent built from it cannot drift apart. */
export type EventPayload = Omit<
  EventIntent,
  'accountId' | 'idempotencyKey' | 'kia'
>;

export interface EventDraftRow {
  id: string;
  accountId: AccountId;
  revision: number;
  payload: EventPayload;
  /** Set when creation first starts; frozen after. */
  idempotencyKey: string | null;
  sourceDocumentId: string | null;
  fingerprint: string;
  confirmMode: 'review' | 'link';
  status: EventDraftStatus;
  error: string | null;
  created: CreatedEvent | null;
  createdVia: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  expiresAt: string;
  /** The last draft_event call that created, revised or returned this row. */
  touchedAt: string;
  touchedVia: string;
}

export interface EventDraftInsert {
  accountId: AccountId;
  payload: EventPayload;
  sourceDocumentId: string | null;
  fingerprint: string;
  confirmMode: 'review' | 'link';
  createdVia: string;
  createdBy: string | null;
}

export interface EventDraftStore {
  insert(i: EventDraftInsert): Promise<EventDraftRow>;
  get(id: string): Promise<EventDraftRow | null>;
  /** A new revision of a `draft` (null otherwise, or on a stale revision). */
  revise(
    id: string,
    expectedRevision: number,
    payload: EventPayload,
    fingerprint: string,
    via: string,
  ): Promise<EventDraftRow | null>;
  touch(id: string, via: string): Promise<void>;
  /** CAS draft→creating on `revision`: freezes the key `${id}:${revision}`. */
  beginCreate(id: string, revision: number): Promise<EventDraftRow | null>;
  /** CAS failed|unknown→creating with the key unchanged. */
  beginRetry(id: string): Promise<EventDraftRow | null>;
  finishCreate(id: string, created: CreatedEvent): Promise<void>;
  failCreate(
    id: string,
    status: 'failed' | 'unknown',
    error: string,
  ): Promise<void>;
  /** draft|failed|unknown → discarded (the key, if any, is kept). */
  discard(id: string): Promise<EventDraftRow | null>;
  /** discarded|expired → draft (no key: revision+1, fresh expiry) or →
   *  unknown (key kept: only retry or discard remain). */
  restore(id: string): Promise<EventDraftRow | null>;
  /** Drafts past expiry that never started a create. Returns how many. */
  expireOverdue(): Promise<number>;
  /** Boot: a `creating` row means a process died mid-create. */
  recoverOrphanedCreating(): Promise<number>;
  byFingerprint(
    accountId: AccountId,
    fingerprint: string,
  ): Promise<EventDraftRow[]>;
  /** What the user still has to act on: draft, failed, unknown. */
  pending(accountId?: AccountId): Promise<EventDraftRow[]>;
  countPending(accountId: AccountId): Promise<number>;
  /** Rows that may hold time in [from, to): draft|creating|unknown|created. */
  inWindow(from: string, to: string): Promise<EventDraftRow[]>;
  /** Same-day candidates for similarity checks on one account. */
  activeOnDay(
    accountId: AccountId,
    dayStartIso: string,
    dayEndIso: string,
  ): Promise<EventDraftRow[]>;
  touchedSince(sinceIso: string, via: string): Promise<EventDraftRow[]>;
  onChange(cb: () => void): () => void;
}

interface EventDraftSql {
  id: string;
  account_id: string;
  revision: number;
  payload_json: string;
  idempotency_key: string | null;
  source_document_id: string | null;
  fingerprint: string;
  confirm_mode: 'review' | 'link';
  status: EventDraftStatus;
  error: string | null;
  created_event_json: string | null;
  created_via: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  expires_at: string;
  touched_at: string;
  touched_via: string;
}

function toRow(r: EventDraftSql): EventDraftRow {
  return {
    id: r.id,
    accountId: r.account_id as AccountId,
    revision: r.revision,
    payload: JSON.parse(r.payload_json) as EventPayload,
    idempotencyKey: r.idempotency_key,
    sourceDocumentId: r.source_document_id,
    fingerprint: r.fingerprint,
    confirmMode: r.confirm_mode,
    status: r.status,
    error: r.error,
    created:
      r.created_event_json === null
        ? null
        : (JSON.parse(r.created_event_json) as CreatedEvent),
    createdVia: r.created_via,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    confirmedAt: r.confirmed_at,
    expiresAt: r.expires_at,
    touchedAt: r.touched_at,
    touchedVia: r.touched_via,
  };
}

/** Where an event payload starts and ends, as comparable UTC ISO strings —
 *  an all-day YYYY-MM-DD becomes that UTC midnight, close enough for
 *  window filtering (the service classifies precisely). */
const SQL_START = `CASE WHEN json_extract(payload_json,'$.allDay') THEN json_extract(payload_json,'$.start') || 'T00:00:00.000Z' ELSE strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(payload_json,'$.start')) END`;
const SQL_END = `CASE WHEN json_extract(payload_json,'$.allDay') THEN json_extract(payload_json,'$.end') || 'T00:00:00.000Z' ELSE strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(payload_json,'$.end')) END`;

export function createEventDraftStore(
  db: AppDb,
  deps: { now: () => string; changed: EventEmitter },
): EventDraftStore {
  const fire = () => deps.changed.emit('change');
  const freshExpiry = () =>
    new Date(Date.parse(deps.now()) + EVENT_DRAFT_TTL_MS).toISOString();

  const get = async (id: string): Promise<EventDraftRow | null> => {
    const r = (
      await db.all(`SELECT * FROM event_drafts WHERE id = ?`, [id])
    )[0] as unknown as EventDraftSql | undefined;
    return r ? toRow(r) : null;
  };
  const many = async (sql: string, params: unknown[]) =>
    ((await db.all(sql, params as never)) as unknown as EventDraftSql[]).map(
      toRow,
    );
  /** One UPDATE; the row back when it changed exactly one row. */
  const cas = async (
    id: string,
    sql: string,
    params: unknown[],
  ): Promise<EventDraftRow | null> => {
    const [r] = await db.batch([{ sql, params: params as never }]);
    if (r.changes !== 1) return null;
    fire();
    return get(id);
  };

  return {
    get,

    async insert(i) {
      const id = newId<'event_draft'>() as string;
      const now = deps.now();
      await db.run(
        `INSERT INTO event_drafts (id, account_id, revision, payload_json,
           source_document_id, fingerprint, confirm_mode, status, created_via,
           created_by, created_at, updated_at, expires_at, touched_at,
           touched_via)
         VALUES (?, ?, 1, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          i.accountId,
          JSON.stringify(i.payload),
          i.sourceDocumentId,
          i.fingerprint,
          i.confirmMode,
          i.createdVia,
          i.createdBy,
          now,
          now,
          freshExpiry(),
          now,
          i.createdVia,
        ],
      );
      const row = await get(id);
      if (!row) throw new Error('event_drafts: insert readback failed');
      fire();
      return row;
    },

    revise(id, expectedRevision, payload, fingerprint, via) {
      const now = deps.now();
      return cas(
        id,
        `UPDATE event_drafts
            SET payload_json = ?, fingerprint = ?, revision = revision + 1,
                updated_at = ?, expires_at = ?, touched_at = ?, touched_via = ?
          WHERE id = ? AND status = 'draft' AND revision = ?`,
        [
          JSON.stringify(payload),
          fingerprint,
          now,
          freshExpiry(),
          now,
          via,
          id,
          expectedRevision,
        ],
      );
    },

    async touch(id, via) {
      await db.run(
        `UPDATE event_drafts SET touched_at = ?, touched_via = ? WHERE id = ?`,
        [deps.now(), via, id],
      );
    },

    beginCreate(id, revision) {
      const now = deps.now();
      return cas(
        id,
        `UPDATE event_drafts
            SET status = 'creating', idempotency_key = id || ':' || revision,
                confirmed_at = ?, updated_at = ?, error = NULL
          WHERE id = ? AND status = 'draft' AND revision = ?
            AND idempotency_key IS NULL`,
        [now, now, id, revision],
      );
    },

    beginRetry(id) {
      return cas(
        id,
        `UPDATE event_drafts SET status = 'creating', updated_at = ?
          WHERE id = ? AND status IN ('failed','unknown')
            AND idempotency_key IS NOT NULL`,
        [deps.now(), id],
      );
    },

    async finishCreate(id, created) {
      await cas(
        id,
        `UPDATE event_drafts
            SET status = 'created', created_event_json = ?, error = NULL,
                updated_at = ?
          WHERE id = ? AND status = 'creating'`,
        [JSON.stringify(created), deps.now(), id],
      );
    },

    async failCreate(id, status, error) {
      await cas(
        id,
        `UPDATE event_drafts SET status = ?, error = ?, updated_at = ?
          WHERE id = ? AND status = 'creating'`,
        [status, error, deps.now(), id],
      );
    },

    discard(id) {
      return cas(
        id,
        `UPDATE event_drafts SET status = 'discarded', updated_at = ?
          WHERE id = ? AND status IN ('draft','failed','unknown')`,
        [deps.now(), id],
      );
    },

    async restore(id) {
      const now = deps.now();
      const fresh = await cas(
        id,
        `UPDATE event_drafts
            SET status = 'draft', revision = revision + 1, updated_at = ?,
                expires_at = ?, error = NULL
          WHERE id = ? AND status IN ('discarded','expired')
            AND idempotency_key IS NULL`,
        [now, freshExpiry(), id],
      );
      if (fresh) return fresh;
      return cas(
        id,
        `UPDATE event_drafts SET status = 'unknown', updated_at = ?
          WHERE id = ? AND status IN ('discarded','expired')
            AND idempotency_key IS NOT NULL`,
        [now, id],
      );
    },

    async expireOverdue() {
      const [r] = await db.batch([
        {
          sql: `UPDATE event_drafts SET status = 'expired', updated_at = ?
                 WHERE status = 'draft' AND idempotency_key IS NULL
                   AND expires_at <= ?`,
          params: [deps.now(), deps.now()],
        },
      ]);
      if (r.changes > 0) fire();
      return r.changes;
    },

    async recoverOrphanedCreating() {
      const [r] = await db.batch([
        {
          sql: `UPDATE event_drafts
                   SET status = 'unknown', updated_at = ?,
                       error = 'Kia closed while adding this event — it may have been added. Check your calendar, then Try again or Discard.'
                 WHERE status = 'creating'`,
          params: [deps.now()],
        },
      ]);
      if (r.changes > 0) fire();
      return r.changes;
    },

    byFingerprint(accountId, fingerprint) {
      return many(
        `SELECT * FROM event_drafts WHERE account_id = ? AND fingerprint = ?
          ORDER BY created_at DESC`,
        [accountId, fingerprint],
      );
    },

    pending(accountId) {
      return accountId
        ? many(
            `SELECT * FROM event_drafts
              WHERE account_id = ? AND status IN ('draft','failed','unknown')
              ORDER BY created_at DESC`,
            [accountId],
          )
        : many(
            `SELECT * FROM event_drafts
              WHERE status IN ('draft','failed','unknown')
              ORDER BY created_at DESC`,
            [],
          );
    },

    async countPending(accountId) {
      const r = (
        await db.all(
          `SELECT COUNT(*) AS n FROM event_drafts
            WHERE account_id = ? AND status = 'draft'`,
          [accountId],
        )
      )[0] as { n: number };
      return Number(r.n);
    },

    inWindow(from, to) {
      return many(
        `SELECT * FROM event_drafts
          WHERE status IN ('draft','creating','unknown','created')
            AND ${SQL_START} < ? AND ${SQL_END} > ?`,
        [to, from],
      );
    },

    activeOnDay(accountId, dayStartIso, dayEndIso) {
      return many(
        `SELECT * FROM event_drafts
          WHERE account_id = ?
            AND status IN ('draft','creating','unknown','created')
            AND ${SQL_START} < ? AND ${SQL_END} > ?`,
        [accountId, dayEndIso, dayStartIso],
      );
    },

    touchedSince(sinceIso, via) {
      return many(
        `SELECT * FROM event_drafts WHERE touched_at >= ? AND touched_via = ?
          ORDER BY touched_at`,
        [sinceIso, via],
      );
    },

    onChange(cb) {
      deps.changed.on('change', cb);
      return () => deps.changed.off('change', cb);
    },
  };
}
