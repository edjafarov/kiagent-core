import fs from 'fs';
import path from 'path';

import type {
  AppPrefs,
  CalendarPrefs,
  OnboardingPrefs,
  Prefs,
} from '@shared/contracts';

export const DEFAULT_PREFS: AppPrefs = {
  theme: 'system',
  logLevel: 'info',
  launchAtLogin: true,
  showInMenuBar: true,
  processing: { enabled: true, window: 'idle' },
  models: { override: 'auto', autoInstall: true },
  outbound: { defaultMode: 'review' },
  calendar: { defaultCalendar: null, workingHours: null, timeZone: null },
  features: {},
  onboarding: {
    sourceBackfilledAt: null,
    mcpConnectedAt: null,
    firstQueryAt: null,
    dismissedAt: null,
  },
};

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

function validZone(z: unknown): z is string {
  if (typeof z !== 'string' || !z) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

function sanitizeCalendar(raw: unknown): CalendarPrefs {
  const c = (raw ?? {}) as Partial<Record<keyof CalendarPrefs, unknown>>;
  const d = c.defaultCalendar as {
    accountId?: unknown;
    calendarId?: unknown;
  } | null;
  const w = c.workingHours as {
    start?: unknown;
    end?: unknown;
    days?: unknown;
  } | null;
  const days = Array.isArray(w?.days)
    ? [
        ...new Set(
          w!.days.filter(
            (x): x is number => Number.isInteger(x) && x >= 1 && x <= 7,
          ),
        ),
      ].sort()
    : [];
  return {
    defaultCalendar:
      d &&
      typeof d.accountId === 'string' &&
      d.accountId &&
      typeof d.calendarId === 'string' &&
      d.calendarId
        ? { accountId: d.accountId, calendarId: d.calendarId }
        : null,
    workingHours:
      w &&
      typeof w.start === 'string' &&
      typeof w.end === 'string' &&
      HHMM.test(w.start) &&
      HHMM.test(w.end) &&
      w.start < w.end &&
      days.length > 0
        ? { start: w.start, end: w.end, days }
        : null,
    timeZone: validZone(c.timeZone) ? c.timeZone : null,
  };
}

function sanitize(raw: unknown): AppPrefs {
  const r = (raw ?? {}) as Partial<AppPrefs>;
  return {
    theme: r.theme === 'light' || r.theme === 'dark' ? r.theme : 'system',
    logLevel:
      r.logLevel === 'warn' || r.logLevel === 'error' ? r.logLevel : 'info',
    launchAtLogin: r.launchAtLogin !== false,
    showInMenuBar: r.showInMenuBar !== false,
    processing: {
      enabled: r.processing?.enabled !== false,
      window:
        r.processing?.window === 'always' || r.processing?.window === 'night'
          ? r.processing.window
          : 'idle',
    },
    models: {
      override:
        typeof r.models?.override === 'string' && r.models.override
          ? r.models.override
          : 'auto',
      autoInstall: r.models?.autoInstall !== false,
    },
    outbound: {
      defaultMode:
        r.outbound?.defaultMode === 'link' || r.outbound?.defaultMode === 'chat'
          ? r.outbound.defaultMode
          : 'review',
    },
    calendar: sanitizeCalendar(r.calendar),
    features: Object.fromEntries(
      Object.entries(
        r.features && typeof r.features === 'object' ? r.features : {},
      ).filter(([, v]) => typeof v === 'boolean'),
    ) as Record<string, boolean>,
    onboarding: {
      sourceBackfilledAt: isoOrNull(r.onboarding?.sourceBackfilledAt),
      mcpConnectedAt: isoOrNull(r.onboarding?.mcpConnectedAt),
      firstQueryAt: isoOrNull(r.onboarding?.firstQueryAt),
      dismissedAt: isoOrNull(r.onboarding?.dismissedAt),
    },
  };
}

export function createPrefs(dir: string): Prefs {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'prefs.json');
  let current: AppPrefs;
  try {
    current = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    current = { ...DEFAULT_PREFS };
  }
  const listeners = new Set<(p: AppPrefs) => void>();

  return {
    get: () => current,
    async patch(p) {
      current = sanitize({
        ...current,
        ...p,
        processing: { ...current.processing, ...(p.processing ?? {}) },
        models: { ...current.models, ...(p.models ?? {}) },
        outbound: { ...current.outbound, ...(p.outbound ?? {}) },
        calendar: { ...current.calendar, ...(p.calendar ?? {}) },
        onboarding: { ...current.onboarding, ...(p.onboarding ?? {}) },
        features: { ...current.features, ...(p.features ?? {}) },
      });
      fs.writeFileSync(file, JSON.stringify(current, null, 2));
      for (const cb of listeners) cb(current);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

/** Idempotent onboarding latch: writes now() only if `key` is still null.
 *  Shared by every latch site (source-live, client-connect, first-query) —
 *  and by future ones (a remote-MCP OAuth grant handler calls this same
 *  helper), so "connected" stays one latch no matter which transport set it. */
export async function markOnboardingOnce(
  prefs: Prefs,
  key: keyof OnboardingPrefs,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const cur = prefs.get().onboarding;
  if (cur[key] != null) return false;
  await prefs.patch({ onboarding: { ...cur, [key]: nowIso } });
  return true;
}
