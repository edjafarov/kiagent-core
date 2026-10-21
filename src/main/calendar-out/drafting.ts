/**
 * `draft_event` (spec §5.4, §5.5): normalize, pick the calendar, then the
 * dedupe chain in order — already in the calendar → active draft →
 * dismissed → insert (with similar events and drafts as hints).
 */
import type { AccountId } from '@shared/contracts';

import type { Prefs } from '@shared/contracts';
import { currentClient, currentTransport } from '../core/mcp/transport-context';
import type { EventDraftRow, EventPayload } from '../core/store/event-drafts';
import { EVENT_DRAFT_PENDING_CAP } from '../core/store/event-drafts';
import type { CoreStore } from '../core/store/store';
import { draftSpan, zonedToUtc } from './availability';
import { calendarPrefs, type CalendarsView } from './calendars';
import { INSTRUCTION, PENDING_CAP_COPY } from './copy';
import { fingerprintOf, titleSimilarity } from './fingerprint';
import { placeholderState } from './placeholder';
import type {
  CalendarListItem,
  DraftEventArgs,
  DraftEventResult,
  SimilarEvent,
} from './types';
import type { DraftLock } from '../outbound/draft-lock';
import type { OutboundContext } from '../outbound/service';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:?\d{2})$/i;
const SIMILAR_MAX = 3;

export interface DraftingDeps {
  store: CoreStore;
  calendars: CalendarsView;
  prefs: Prefs;
  ctx: () => OutboundContext;
  /** null on the agent transport, or while the server is not up. */
  urlFor(row: EventDraftRow): Promise<string | null>;
  /** Serializes draft_event calls: the dedupe check and the insert must not
   *  interleave (a model captures in parallel batches). */
  lock: DraftLock;
}

export const systemTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A timed instant as UTC ISO. A wall time without an offset is read in
 *  `tz` — never in the machine's zone (models often omit offsets). */
export function normalizeInstant(s: string, tz: string): string {
  const t = s.trim();
  if (HAS_OFFSET.test(t)) {
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) throw new Error(`invalid date-time '${s}'`);
    return new Date(ms).toISOString();
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(t);
  if (!m) throw new Error(`invalid date-time '${s}'`);
  const [, y, mo, d, h, mi] = m.map(Number);
  return new Date(zonedToUtc(y, mo, d, h, mi, tz)).toISOString();
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The event fields of a draft_event call, defaults applied. */
export function buildPayload(
  a: DraftEventArgs,
  base: EventPayload | null,
  target: CalendarListItem,
  defaultTz: string,
): EventPayload {
  const timeZone = a.timeZone ?? base?.timeZone ?? defaultTz;
  const startRaw = (a.start ?? base?.start).trim();
  const allDay =
    a.allDay ?? (a.start ? DATE_ONLY.test(startRaw) : base!.allDay);
  let start: string;
  let end: string;
  if (allDay) {
    start = startRaw.slice(0, 10);
    if (!DATE_ONLY.test(start)) throw new Error(`invalid date '${startRaw}'`);
    end = a.end
      ? a.end.trim().slice(0, 10)
      : a.start
        ? addDays(start, 1)
        : base!.end;
    if (end <= start) throw new Error('end must be after start');
  } else {
    start = normalizeInstant(startRaw, timeZone);
    end = a.end
      ? normalizeInstant(a.end, timeZone)
      : a.start || !base
        ? new Date(Date.parse(start) + 30 * 60_000).toISOString()
        : base.end;
    if (Date.parse(end) <= Date.parse(start))
      throw new Error('end must be after start');
  }
  const title = (a.title ?? base?.title ?? '').trim();
  if (!title) throw new Error('title is required');
  return {
    calendarId: target.calendarId,
    title,
    start,
    end,
    allDay,
    timeZone,
    location: a.location ?? base?.location ?? null,
    description: a.description ?? base?.description ?? null,
    attendees: a.attendees ?? base?.attendees ?? [],
    conference: a.conference ?? base?.conference ?? 'none',
    category: a.category ?? base!.category,
  };
}

const ACTIVE = new Set(['draft', 'creating', 'unknown']);

export function createDrafting(deps: DraftingDeps) {
  const { store } = deps;

  const sameDayWindow = (p: EventPayload) => {
    const span = draftSpan(p);
    const dayMs = 24 * 60 * 60_000;
    // Conservative SQL window (±1 day covers every zone offset); callers
    // apply the exact same-day test themselves.
    return {
      span,
      from: new Date(Date.parse(span.start) - dayMs).toISOString(),
      to: new Date(Date.parse(span.end) + dayMs).toISOString(),
    };
  };

  const localDay = (iso: string, tz: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso));

  /** §5.4 rule 1: same iCalUID is not knowable for a new draft, so: an
   *  indexed event at the same start with a ≥0.8 similar title. */
  const alreadyInCalendar = async (accountId: AccountId, p: EventPayload) => {
    const w = sameDayWindow(p);
    const events = await store.calendarIndex.overlap(w.from, w.to, accountId);
    return events.filter((e) => {
      const m = e.metadata;
      const sameStart = p.allDay
        ? m.allDay && (m.startDate ?? m.start.slice(0, 10)) === p.start
        : !m.allDay && Date.parse(m.start) === Date.parse(p.start);
      return sameStart && titleSimilarity(e.title ?? '', p.title) >= 0.8;
    });
  };

  const similarTo = async (
    accountId: AccountId,
    p: EventPayload,
    selfId: string,
  ): Promise<SimilarEvent[]> => {
    const w = sameDayWindow(p);
    const day = p.allDay ? p.start : localDay(p.start, p.timeZone);
    const onDay = (iso: string, allDay: boolean, date?: string) =>
      (allDay ? (date ?? iso.slice(0, 10)) : localDay(iso, p.timeZone)) === day;
    const out: SimilarEvent[] = [];
    for (const e of await store.calendarIndex.overlap(
      w.from,
      w.to,
      accountId,
    )) {
      if (!onDay(e.metadata.start, e.metadata.allDay, e.metadata.startDate))
        continue;
      if (titleSimilarity(e.title ?? '', p.title) < 0.5) continue;
      out.push({
        kind: 'event',
        title: e.title ?? '',
        start: e.metadata.allDay
          ? (e.metadata.startDate ?? e.metadata.start)
          : e.metadata.start,
        calendar: e.metadata.calendarName,
      });
    }
    for (const r of await store.eventDrafts.activeOnDay(
      accountId,
      w.from,
      w.to,
    )) {
      if (r.id === selfId) continue;
      if (
        r.status === 'created' &&
        (await placeholderState(store, r)) === 'seen'
      )
        continue;
      if (!onDay(r.payload.start, r.payload.allDay)) continue;
      if (titleSimilarity(r.payload.title, p.title) < 0.5) continue;
      out.push({
        kind: 'draft',
        title: r.payload.title,
        start: r.payload.start,
        calendar: '',
        draftId: r.id,
      });
    }
    return out.slice(0, SIMILAR_MAX);
  };

  const result = async (
    row: EventDraftRow,
    target: CalendarListItem,
    existing: boolean,
  ): Promise<DraftEventResult> => {
    // The review page serves `draft` rows only; other states wait in the
    // Outbox and say where they stand.
    const url = row.status === 'draft' ? await deps.urlFor(row) : null;
    return {
      draftId: row.id,
      revision: row.revision,
      mode: row.confirmMode,
      ...(url && { confirmUrl: url }),
      calendar: {
        id: target.calendarId,
        name: target.name,
        accountEmail: target.accountEmail,
      },
      similarEvents: existing
        ? []
        : await similarTo(row.accountId, row.payload, row.id),
      ...(existing && { existing: true as const }),
      instruction:
        row.status !== 'draft'
          ? INSTRUCTION.inProgress
          : existing
            ? INSTRUCTION.existing
            : url
              ? INSTRUCTION.link
              : INSTRUCTION.review,
    };
  };

  const confirmModeFor = async (
    accountId: AccountId,
  ): Promise<'review' | 'link'> => {
    if (currentTransport() === 'agent') return 'review';
    const account = await store.account(accountId);
    const mode = account ? deps.ctx().modeFor(account) : 'review';
    return mode === 'chat' ? 'link' : mode;
  };

  const draftEvent = (a: DraftEventArgs): Promise<DraftEventResult> =>
    deps.lock('draft_event', () => draftEventLocked(a));

  async function draftEventLocked(
    a: DraftEventArgs,
  ): Promise<DraftEventResult> {
    const via = deps.ctx().createdViaNow();
    const defaultTz = calendarPrefs(deps.prefs).timeZone ?? systemTimeZone();

    // ── Revise in place ────────────────────────────────────────────────
    if (a.draftId !== undefined || a.revision !== undefined) {
      if (!a.draftId || a.revision === undefined)
        throw new Error('pass both draft_id and revision to revise a draft');
      const row = await store.eventDrafts.get(a.draftId);
      if (!row) throw new Error(`unknown draft '${a.draftId}'`);
      if (row.status !== 'draft')
        throw new Error(
          `this draft is ${row.status} and can no longer be changed — draft a new event instead`,
        );
      const target = await deps.calendars.resolveTarget({
        accountId: a.accountId ?? row.accountId,
        calendarId: a.calendarId ?? row.payload.calendarId,
      });
      if (target.accountId !== row.accountId)
        throw new Error(
          'a draft cannot move to another account — draft a new event instead',
        );
      const payload = buildPayload(a, row.payload, target, defaultTz);
      const next = await store.eventDrafts.revise(
        row.id,
        a.revision,
        payload,
        fingerprintOf(row.accountId, payload),
        via,
      );
      if (!next)
        throw new Error(
          `draft '${row.id}' is at revision ${row.revision}, not ${a.revision} — use the current revision`,
        );
      return result(next, target, false);
    }

    // ── New draft ──────────────────────────────────────────────────────
    const target = await deps.calendars.resolveTarget(a);
    const { accountId } = target;
    const payload = buildPayload(a, null, target, defaultTz);
    const fp = fingerprintOf(accountId, payload);

    const inCal = await alreadyInCalendar(accountId, payload);
    if (inCal.length)
      return {
        alreadyInCalendar: inCal.map((e) => ({
          title: e.title ?? '',
          start: e.metadata.allDay
            ? (e.metadata.startDate ?? e.metadata.start)
            : e.metadata.start,
          calendar: e.metadata.calendarName,
        })),
        instruction: INSTRUCTION.alreadyInCalendar,
      };

    const same = await store.eventDrafts.byFingerprint(accountId, fp);
    for (const r of same) {
      const active =
        ACTIVE.has(r.status) ||
        (r.status === 'created' &&
          (await placeholderState(store, r)) === 'unseen');
      if (active) {
        await store.eventDrafts.touch(r.id, via);
        const own =
          (await deps.calendars.list()).find(
            (c) =>
              c.accountId === r.accountId &&
              c.calendarId === r.payload.calendarId,
          ) ?? target;
        return result((await store.eventDrafts.get(r.id))!, own, true);
      }
    }

    const dismissed = same.find((r) => r.status === 'discarded');
    if (dismissed) {
      if (!a.force)
        return {
          dismissed: true,
          draftId: dismissed.id,
          instruction: INSTRUCTION.dismissed,
        };
      if (currentTransport() === 'agent')
        throw new Error(
          'force is not available here — the user can restore it from the Outbox',
        );
      const restored = await store.eventDrafts.restore(dismissed.id);
      if (!restored)
        throw new Error(`could not restore draft '${dismissed.id}'`);
      await store.eventDrafts.touch(restored.id, via);
      return result((await store.eventDrafts.get(restored.id))!, target, false);
    }

    if (
      (await store.eventDrafts.countPending(accountId)) >=
      EVENT_DRAFT_PENDING_CAP
    )
      throw new Error(PENDING_CAP_COPY(EVENT_DRAFT_PENDING_CAP));

    const row = await store.eventDrafts.insert({
      accountId,
      payload,
      sourceDocumentId: a.sourceDocumentId ?? null,
      fingerprint: fp,
      confirmMode: await confirmModeFor(accountId),
      createdVia: via,
      createdBy: currentClient(),
    });
    return result(row, target, false);
  }

  return { draftEvent, similarTo };
}
