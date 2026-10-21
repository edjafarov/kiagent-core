/**
 * Calendar-out: Kia drafts calendar events, the user confirms, core creates
 * them (alpha-cent docs/superpowers/specs/2026-10-21-calendar-events-
 * booking-design.md §5). The gate lives HERE: `createEvent` is reached only
 * from `runCreate`, after a confirm (or Try again) on a row the store moved
 * to `creating` by compare-and-set. The tool layer gets `CalendarToolApi`
 * only — it can list, look and draft, never create.
 */
import type { AccountId, EventIntent, Prefs } from '@shared/contracts';

import type { LogSink } from '../core/engine/engine';
import { currentTransport } from '../core/mcp/transport-context';
import type { EventDraftRow } from '../core/store/event-drafts';
import type { CoreStore } from '../core/store/store';
import { createDraftLock } from '../outbound/draft-lock';
import type { OutboundContext } from '../outbound/service';
import { signEventToken, verifyEventToken } from '../outbound/tokens';
import { createCalendarsView } from './calendars';
import { reconnectCopy, UNKNOWN_COPY } from './copy';
import { createDrafting } from './drafting';
import { createFreeTime } from './free-time';
import type {
  CalendarListItem,
  DraftEventArgs,
  DraftEventResult,
  EventConfirmOutcome,
  EventDraftView,
  EventPeek,
  FindFreeTimeArgs,
  FreeTimeResult,
} from './types';
import type { CalendarWriterRegistry } from './writers';

export type * from './types';

/** What MCP tools may call. Deliberately no confirm. */
export interface CalendarToolApi {
  listCalendars(a: Record<string, never>): Promise<CalendarListItem[]>;
  findFreeTime(a: FindFreeTimeArgs): Promise<FreeTimeResult>;
  draftEvent(a: DraftEventArgs): Promise<DraftEventResult>;
}

export interface CalendarOutService extends CalendarToolApi {
  peekByToken(token: string): Promise<EventPeek>;
  confirmByToken(token: string, revision: number): Promise<EventConfirmOutcome>;
  cancelByToken(token: string): Promise<EventConfirmOutcome>;
  confirmById(id: string, revision: number): Promise<EventConfirmOutcome>;
  retryById(id: string): Promise<EventConfirmOutcome>;
  discardById(id: string): Promise<EventDraftRow | null>;
  restoreById(id: string): Promise<EventDraftRow | null>;
  listPending(): Promise<EventDraftView[]>;
  /** A review-page URL for the row's CURRENT revision; null while the
   *  server for that transport is not up. */
  confirmUrl(
    id: string,
    opts?: { ttlMs?: number; remote?: boolean },
  ): Promise<string | null>;
  touchedSince(sinceIso: string, via: string): Promise<EventDraftView[]>;
  /** Boot: `creating` rows become `unknown`; overdue drafts expire. */
  recover(): Promise<void>;
  expireOverdue(): Promise<number>;
}

/** Writer errors → row status by message class (spec §5.3). Auth wording
 *  differs per connector, so any "reconnect" counts and is re-worded. */
export function classifyWriterError(
  msg: string,
  accountEmail: string,
): { status: 'failed' | 'unknown'; error: string } {
  if (/\breconnect\b/i.test(msg))
    return {
      status: 'failed',
      error: /reconnect .* in Settings/.test(msg)
        ? msg
        : reconnectCopy(accountEmail),
    };
  if (/^(rate-limited|not created):/.test(msg))
    return { status: 'failed', error: msg };
  return { status: 'unknown', error: `${msg} — ${UNKNOWN_COPY}` };
}

export function createCalendarOutService(deps: {
  store: CoreStore;
  writers: CalendarWriterRegistry;
  ctx: () => OutboundContext;
  prefs: Prefs;
  /** Credentials.scope, for effective can_write. */
  vaultScope: (accountId: AccountId) => Promise<string | undefined>;
  now?: () => Date;
  logSink: LogSink;
}): CalendarOutService {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const nowMs = () => now().getTime();
  const withDraft = createDraftLock();

  // The tool-side view of the registry: listing only.
  const calendars = createCalendarsView({
    store,
    writers: { get: (id) => deps.writers.get(id) },
    prefs: deps.prefs,
    vaultScope: deps.vaultScope,
    logSink: deps.logSink,
    nowMs,
  });

  const mintUrl = async (
    row: EventDraftRow,
    transport: 'local' | 'remote' | 'agent',
    ttlMs?: number,
  ): Promise<string | null> => {
    if (transport === 'agent') return null;
    const base = deps.ctx().baseFor(transport);
    if (!base) return null;
    const exp =
      ttlMs !== undefined ? nowMs() + ttlMs : Date.parse(row.expiresAt);
    const token = signEventToken(
      await deps.ctx().secret(),
      row.id,
      row.revision,
      exp,
    );
    return `${base}/outbox/event/confirm/${token}`;
  };

  const drafting = createDrafting({
    store,
    calendars,
    prefs: deps.prefs,
    ctx: deps.ctx,
    urlFor: (row) => mintUrl(row, currentTransport()),
  });

  const findFreeTime = createFreeTime({
    store,
    calendars,
    prefs: deps.prefs,
    now,
  });

  const toView = async (row: EventDraftRow): Promise<EventDraftView> => {
    const account = await store.account(row.accountId);
    let calendarName: string | null = null;
    try {
      calendarName =
        (await calendars.list()).find(
          (c) =>
            c.accountId === row.accountId &&
            c.calendarId === row.payload.calendarId,
        )?.name ?? null;
    } catch {
      calendarName = null;
    }
    const doc = row.sourceDocumentId
      ? await store.read.document(row.sourceDocumentId as never)
      : null;
    return {
      ...row,
      calendarName,
      accountEmail: account?.identifier ?? null,
      source: doc
        ? { title: doc.title ?? null, createdAt: doc.createdAt ?? null }
        : null,
      similarEvents:
        row.status === 'draft'
          ? await drafting.similarTo(row.accountId, row.payload, row.id)
          : [],
    };
  };

  /** Only ever entered with the row in `creating` (CAS done by caller). */
  const runCreate = async (
    row: EventDraftRow,
  ): Promise<EventConfirmOutcome> => {
    const account = await store.account(row.accountId);
    const email = account?.identifier ?? 'the account';
    const writer = account && deps.writers.get(account.source);
    if (!writer) {
      const error = `not created: Kia can't add events to ${email} right now — is its connector installed and enabled?`;
      await store.eventDrafts.failCreate(row.id, 'failed', error);
      return { kind: 'failed', error };
    }
    const intent: EventIntent = {
      ...row.payload,
      accountId: row.accountId,
      idempotencyKey: row.idempotencyKey!,
      kia: { draftId: row.id, sourceDocumentId: row.sourceDocumentId },
    };
    try {
      const event = await writer.createEvent(intent);
      await store.eventDrafts.finishCreate(row.id, event);
      return { kind: 'created', event };
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      const c = classifyWriterError(msg, email);
      deps.logSink.log(
        'calendar-out',
        'warn',
        `create ${row.id} → ${c.status}: ${msg}`,
      );
      if (c.status === 'failed' && /reconnect/i.test(c.error))
        calendars.invalidate(row.accountId);
      await store.eventDrafts.failCreate(row.id, c.status, c.error);
      return { kind: c.status, error: c.error };
    }
  };

  const confirmById = (id: string, revision: number) =>
    withDraft(id, async (): Promise<EventConfirmOutcome> => {
      const row = await store.eventDrafts.get(id);
      if (!row || row.status !== 'draft') return { kind: 'gone' };
      if (row.revision !== revision) return { kind: 'changed' };
      const started = await store.eventDrafts.beginCreate(id, revision);
      if (!started) return { kind: 'changed' };
      return runCreate(started);
    });

  const verify = async (token: string) => {
    const t = verifyEventToken(await deps.ctx().secret(), token);
    if (!t) return { kind: 'invalid' as const };
    if (nowMs() > t.expiresAtMs) return { kind: 'expired' as const };
    return { kind: 'ok' as const, ...t };
  };

  return {
    listCalendars: () => calendars.list(),
    findFreeTime,
    draftEvent: drafting.draftEvent,

    async peekByToken(token) {
      const t = await verify(token);
      if (t.kind !== 'ok') return { kind: t.kind };
      const row = await store.eventDrafts.get(t.draftId);
      if (!row || row.status !== 'draft') return { kind: 'gone' };
      if (row.revision !== t.revision) return { kind: 'changed' };
      return { kind: 'ok', view: await toView(row) };
    },

    async confirmByToken(token, revision) {
      const t = await verify(token);
      if (t.kind !== 'ok') return { kind: 'gone' };
      if (t.revision !== revision) return { kind: 'changed' };
      return confirmById(t.draftId, revision);
    },

    async cancelByToken(token) {
      const t = await verify(token);
      if (t.kind !== 'ok') return { kind: 'gone' };
      const row = await withDraft(t.draftId, () =>
        store.eventDrafts.discard(t.draftId),
      );
      return row ? { kind: 'discarded' } : { kind: 'gone' };
    },

    confirmById,

    retryById: (id) =>
      withDraft(id, async () => {
        const started = await store.eventDrafts.beginRetry(id);
        if (!started) return { kind: 'gone' };
        return runCreate(started);
      }),

    discardById: (id) => withDraft(id, () => store.eventDrafts.discard(id)),
    restoreById: (id) => withDraft(id, () => store.eventDrafts.restore(id)),

    async listPending() {
      return Promise.all((await store.eventDrafts.pending()).map(toView));
    },

    async confirmUrl(id, opts) {
      const row = await store.eventDrafts.get(id);
      if (!row || row.status !== 'draft') return null;
      return mintUrl(row, opts?.remote ? 'remote' : 'local', opts?.ttlMs);
    },

    async touchedSince(sinceIso, via) {
      return Promise.all(
        (await store.eventDrafts.touchedSince(sinceIso, via)).map(toView),
      );
    },

    async recover() {
      const n = await store.eventDrafts.recoverOrphanedCreating();
      if (n)
        deps.logSink.log(
          'calendar-out',
          'warn',
          `${n} event(s) were being added at shutdown — now "unknown"`,
        );
      await store.eventDrafts.expireOverdue();
    },

    expireOverdue: () => store.eventDrafts.expireOverdue(),
  };
}
