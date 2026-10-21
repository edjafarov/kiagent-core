/**
 * `list_calendars` and target resolution (spec §5.5): which calendars Kia
 * can add events to, whether it syncs them, and the effective write right
 * (writer registered && the user may edit && the write scope was granted).
 */
import type {
  AccountId,
  CalendarPrefs,
  Prefs,
  QueryAccount,
  WritableCalendar,
} from '@shared/contracts';

import type { CoreStore } from '../core/store/store';
import { withAccountTypes, type SourceLookup } from '../platform/account-types';
import type { LogSink } from '../core/engine/engine';
import type { CalendarWriterRegistry } from './writers';
import { NO_WRITER_NOTE, notIndexedCopy, reconnectCopy } from './copy';
import type { CalendarListItem } from './types';

export const CALENDAR_LIST_TTL_MS = 5 * 60_000;

/** The scope a source needs to create events; absent = not knowable. */
const WRITE_SCOPE: Record<string, string[]> = {
  'google-calendar': [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar',
  ],
};

export type { CalendarPrefs };

/** Optional access on purpose: partial Prefs fakes and older pref files. */
export function calendarPrefs(prefs: Prefs): CalendarPrefs {
  const c = (prefs.get() as { calendar?: Partial<CalendarPrefs> }).calendar;
  return {
    defaultCalendar: c?.defaultCalendar ?? null,
    workingHours: c?.workingHours ?? null,
    timeZone: c?.timeZone ?? null,
  };
}

export interface CalendarsView {
  list(): Promise<CalendarListItem[]>;
  /** Defaulting order of §5.5; throws with the user-facing reason. */
  resolveTarget(a: {
    accountId?: string;
    calendarId?: string;
  }): Promise<CalendarListItem>;
  /** Drop the cache (after a write error that suggests it is stale). */
  invalidate(accountId?: AccountId): void;
}

export function createCalendarsView(deps: {
  store: CoreStore;
  writers: Pick<CalendarWriterRegistry, 'get'>;
  /** The source registry: accounts carry their documentTypes from it. */
  sources: SourceLookup;
  prefs: Prefs;
  vaultScope: (accountId: AccountId) => Promise<string | undefined>;
  logSink: LogSink;
  nowMs: () => number;
}): CalendarsView {
  const cache = new Map<string, { at: number; cals: WritableCalendar[] }>();

  const calendarsOf = async (a: QueryAccount): Promise<WritableCalendar[]> => {
    const hit = cache.get(a.id);
    if (hit && deps.nowMs() - hit.at < CALENDAR_LIST_TTL_MS) return hit.cals;
    const cals = await deps.writers.get(a.source)!.listCalendars(a.id);
    cache.set(a.id, { at: deps.nowMs(), cals });
    return cals;
  };

  /** The calendars the user picked to sync. `calendarRoots` when the
   *  source names them; `folderRoots` only on a calendar-only source (on a
   *  mail source they are mail folders). Null = no explicit pick: fall back
   *  to "has indexed events". */
  const explicitRoots = (a: QueryAccount): Set<string> | null => {
    const cfg = a.config as {
      folderRoots?: { id: string }[];
      calendarRoots?: { id: string }[];
    };
    const calendarOnly =
      a.documentTypes?.length === 1 && a.documentTypes[0] === 'calendar.event';
    const roots = cfg.calendarRoots ?? (calendarOnly ? cfg.folderRoots : null);
    return Array.isArray(roots) ? new Set(roots.map((r) => r.id)) : null;
  };

  const list = async (): Promise<CalendarListItem[]> => {
    const accounts = await withAccountTypes(
      deps.store.read,
      deps.sources,
    ).accounts();
    const def = calendarPrefs(deps.prefs).defaultCalendar;
    const out: CalendarListItem[] = [];
    for (const a of accounts) {
      if (!deps.writers.get(a.source)) {
        if (a.documentTypes?.includes('calendar.event'))
          out.push(noteItem(a, NO_WRITER_NOTE));
        continue;
      }
      let cals: WritableCalendar[];
      try {
        cals = await calendarsOf(a);
      } catch (e) {
        const msg = (e as Error).message;
        deps.logSink.log(
          'calendar-out',
          'warn',
          `listCalendars ${a.id}: ${msg}`,
        );
        out.push(
          noteItem(
            a,
            /reconnect/i.test(msg) ? reconnectCopy(a.identifier) : msg,
          ),
        );
        continue;
      }
      const need = WRITE_SCOPE[a.source];
      const granted = need ? await deps.vaultScope(a.id) : undefined;
      const scopeOk =
        granted === undefined ||
        need!.some((s) => granted.split(' ').includes(s));
      const roots = explicitRoots(a);
      for (const c of cals) {
        const indexed = roots
          ? roots.has(c.id)
          : await deps.store.calendarIndex.hasEvents(a.id, c.id);
        const canWrite = c.canWrite && scopeOk;
        out.push({
          accountId: a.id,
          accountEmail: a.identifier,
          source: a.source,
          calendarId: c.id,
          name: c.name,
          primary: c.primary,
          shared: c.shared,
          timeZone: c.timeZone,
          indexed,
          canWrite,
          isDefault: def?.accountId === a.id && def.calendarId === c.id,
          ...(c.canWrite && !scopeOk && { note: reconnectCopy(a.identifier) }),
        });
      }
    }
    return out;
  };

  const resolveTarget: CalendarsView['resolveTarget'] = async (a) => {
    const all = await list();
    const real = all.filter((c) => c.calendarId !== '');
    let pick: CalendarListItem | undefined;
    if (a.calendarId) {
      pick = real.find(
        (c) =>
          c.calendarId === a.calendarId &&
          (!a.accountId || c.accountId === a.accountId),
      );
      if (!pick)
        throw new Error(
          `unknown calendar '${a.calendarId}' — ${choices(real)}`,
        );
    } else {
      const def = calendarPrefs(deps.prefs).defaultCalendar;
      pick =
        (def &&
          (!a.accountId || def.accountId === a.accountId) &&
          real.find(
            (c) =>
              c.accountId === def.accountId && c.calendarId === def.calendarId,
          )) ||
        undefined;
      if (!pick) {
        const accounts = new Set(
          real
            .filter((c) => !a.accountId || c.accountId === a.accountId)
            .map((c) => c.accountId),
        );
        if (accounts.size === 1) {
          const [only] = [...accounts];
          pick = real.find((c) => c.accountId === only && c.primary);
        }
      }
      if (!pick)
        throw new Error(`which calendar? pass calendar_id — ${choices(real)}`);
    }
    if (!pick.canWrite)
      throw new Error(
        pick.note ??
          `the calendar "${pick.name}" is read-only for ${pick.accountEmail}`,
      );
    if (!pick.indexed)
      throw new Error(notIndexedCopy(pick.name, pick.accountEmail));
    return pick;
  };

  return {
    list,
    resolveTarget,
    invalidate: (accountId) => {
      if (accountId) cache.delete(accountId);
      else cache.clear();
    },
  };
}

function noteItem(a: QueryAccount, note: string): CalendarListItem {
  return {
    accountId: a.id,
    accountEmail: a.identifier,
    source: a.source,
    calendarId: '',
    name: a.identifier,
    primary: false,
    shared: false,
    timeZone: null,
    indexed: false,
    canWrite: false,
    isDefault: false,
    note,
  };
}

function choices(cals: CalendarListItem[]): string {
  const ok = cals.filter((c) => c.canWrite && c.indexed);
  return ok.length
    ? `choices: ${ok.map((c) => `"${c.name}" (${c.accountEmail}, calendar_id ${c.calendarId})`).join('; ')}`
    : 'no calendar Kia can add events to is connected — connect Google Calendar or Microsoft 365 under Sources';
}
