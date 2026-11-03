import fs from 'fs';
import path from 'path';

import type {
  AppPrefs,
  CalendarPrefs,
  OnboardingPrefs,
  Prefs,
} from '@shared/contracts';

import type { AppDb } from '../db/app-db';

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
    return (
      new Intl.DateTimeFormat('en-US', { timeZone: z }).resolvedOptions()
        .timeZone !== ''
    );
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

/** Preferences that belong to the user and follow them to every device (spec
 *  7.9). They live in the copied table `user_prefs` under `core.<key>`; the
 *  rest stay in `prefs.json` on this machine. */
export const USER_PREF_KEYS = ['outbound', 'calendar', 'features', 'theme'] as const;
export type UserPrefKey = (typeof USER_PREF_KEYS)[number];

const USER_KEY_SET: ReadonlySet<string> = new Set(USER_PREF_KEYS);
const tableKey = (k: string): string => `core.${k}`;

export function splitPatch(p: Partial<AppPrefs>): {
  user: Partial<AppPrefs>;
  device: Partial<AppPrefs>;
} {
  const user: Record<string, unknown> = {};
  const device: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    (USER_KEY_SET.has(k) ? user : device)[k] = v;
  }
  return { user: user as Partial<AppPrefs>, device: device as Partial<AppPrefs> };
}

/** The user's keys as the table holds them (`core.<key>` -> JSON value). */
export interface UserPrefsStore {
  all(): Promise<Record<string, unknown>>;
  set(key: string, value: unknown): Promise<void>;
  /** False on a follower: its copy of the table changes only by the feed. */
  canWrite(): boolean;
}

/** `Prefs` plus the three steps the sync wiring needs. `get()` stays
 *  synchronous: it merges the file with an in-memory mirror of the table, and
 *  the mirror is filled by `attachUser`, which main awaits once the DB is open
 *  (the store is async). Before then user keys come from the file. */
export interface CorePrefs extends Prefs {
  /** Load the mirror, seed once from the file when this device can write the
   *  table, and make the table the source of the user keys. */
  attachUser(store: UserPrefsStore): Promise<void>;
  /** Reload the mirror (after `sync.applied` touched `user_prefs`). */
  refreshUser(): Promise<void>;
  /** Seed from the file if that has not happened and this device can write
   *  now (called when a fence clears or the device is promoted). */
  seedUser(): Promise<void>;
  /** Where a user-key write goes when `canWrite()` is false. It receives only
   *  the user part and rejects when the leader can't take it; the device part
   *  has already been applied by then. */
  setForwardUser(fn: ((user: Partial<AppPrefs>) => Promise<void>) | null): void;
  /** Resolves once the store passed to `createPrefs` is attached. */
  readonly ready: Promise<void>;
  getExt(key: string): unknown;
  setExt(key: string, value: unknown, opts?: { notify?: boolean }): Promise<void>;
  onExtChange(cb: (key: string, value: unknown) => void): () => void;
  setForwardExt(fn: ((key: string, value: unknown) => Promise<void>) | null): void;
  /** A `core.*` row that is not one of the app preferences (`core.extensions`),
   *  from the same mirror. */
  getCore(key: string): unknown;
  /** Atomic read-modify-write of such a row, on the leader only (a follower's
   *  copy changes by the feed). `fn` returning undefined leaves the row. */
  updateCore(key: string, fn: (current: unknown) => unknown): Promise<void>;
  /** What this device would put in a join offer (spec 7.9 rule 6): every user
   *  setting it holds, `core.<key>` and `<extension>.<name>`, including a user
   *  key still in prefs.json that no seed has moved yet. Never a device key,
   *  and never `core.extensions` (that set travels on its own). */
  offerable(): Promise<Record<string, unknown>>;
  /** The master's half: writes each offered key the table lacks, nothing else.
   *  Master wins: an existing key keeps its value. Returns the keys written.
   *  Rejects on a device that can't write the table. */
  addMissing(entries: Record<string, unknown>): Promise<string[]>;
}

/** Extension settings share the table under `<extension id>.<name>`; the
 *  `core.` prefix is the app's own. */
const isExtKey = (k: string): boolean => typeof k === 'string' && k.length > 0 && !k.startsWith('core.');

/** A copy of `value` that is exactly what the table will hold; rejects what
 *  JSON would drop or change silently (functions, symbols, bigint, undefined). */
function jsonCopy(value: unknown): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') {
        throw new TypeError('not JSON');
      }
      return v;
    });
  } catch {
    throw new TypeError('a setting must be a JSON value');
  }
  if (text === undefined) throw new TypeError('a setting must be a JSON value');
  return JSON.parse(text);
}

/** The keys a join offer may carry: an extension's own, and the app's user
 *  preferences. `core.extensions` has its own channel. */
const offerableKey = (k: string): boolean =>
  isExtKey(k) ||
  (k.startsWith('core.') && USER_KEY_SET.has(k.slice('core.'.length)));

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

export function createPrefs(dir: string, user?: UserPrefsStore): CorePrefs {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'prefs.json');
  let fromFile: AppPrefs;
  try {
    fromFile = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    fromFile = { ...DEFAULT_PREFS };
  }
  let store: UserPrefsStore | null = null;
  let mirror: Record<string, unknown> = {};
  let forwardUser: ((u: Partial<AppPrefs>) => Promise<void>) | null = null;
  let forwardExt: ((key: string, value: unknown) => Promise<void>) | null = null;
  const listeners = new Set<(p: AppPrefs) => void>();
  const extListeners = new Set<(key: string, value: unknown) => void>();
  const fireExt = (key: string, value: unknown): void => {
    for (const cb of extListeners) {
      try {
        cb(key, value);
      } catch {
        // one listener's failure must not hide the change from the rest
      }
    }
  };

  /** The file's device keys, plus its user keys until the table takes over. */
  const merge = (): AppPrefs => {
    if (!store) return fromFile;
    const raw: Record<string, unknown> = { ...fromFile };
    for (const k of USER_PREF_KEYS) {
      const t = tableKey(k);
      raw[k] = t in mirror ? mirror[t] : DEFAULT_PREFS[k];
    }
    return sanitize(raw);
  };
  let current = merge();
  const recompute = (): void => {
    current = merge();
  };
  const emit = (): void => {
    for (const cb of listeners) cb(current);
  };
  // The file keeps its user keys until a seed has succeeded on this device:
  // dropping them earlier would turn the user's settings into defaults.
  let seeded = false;
  const writeFile = (): void => {
    if (!store || !seeded) {
      fs.writeFileSync(file, JSON.stringify(fromFile, null, 2));
      return;
    }
    const device: Record<string, unknown> = { ...fromFile };
    for (const k of USER_PREF_KEYS) delete device[k];
    fs.writeFileSync(file, JSON.stringify(device, null, 2));
  };

  // Every read-merge-write of the user part runs one at a time, so a patch
  // always starts from the latest mirror.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const r = chain.then(fn);
    chain = r.catch(() => undefined);
    return r;
  };

  /** Move the file's user keys into the table, once, when this device can
   *  write it. Idempotent; runs inside the critical section. */
  const seedLocked = async (): Promise<void> => {
    const s = store;
    if (!s || seeded || !s.canWrite()) return;
    for (const k of USER_PREF_KEYS) {
      const t = tableKey(k);
      if (t in mirror || sameJson(fromFile[k], DEFAULT_PREFS[k])) continue;
      await s.set(t, fromFile[k]);
      mirror[t] = fromFile[k];
    }
    seeded = true;
    const before = current;
    recompute();
    writeFile();
    if (!sameJson(before, current)) emit();
  };

  const attachUser = (s: UserPrefsStore): Promise<void> =>
    serial(async () => {
      const loaded = await s.all();
      store = s;
      mirror = loaded;
      const before = current;
      recompute();
      await seedLocked();
      if (!sameJson(before, current)) emit();
    });

  const prefs: CorePrefs = {
    ready: Promise.resolve(),
    get: () => current,
    patch: (p) =>
      serial(async () => {
        const next = sanitize({
          ...current,
          ...p,
          processing: { ...current.processing, ...(p.processing ?? {}) },
          models: { ...current.models, ...(p.models ?? {}) },
          outbound: { ...current.outbound, ...(p.outbound ?? {}) },
          calendar: { ...current.calendar, ...(p.calendar ?? {}) },
          onboarding: { ...current.onboarding, ...(p.onboarding ?? {}) },
          features: { ...current.features, ...(p.features ?? {}) },
        });
        if (!store) {
          fromFile = next;
          current = next;
          writeFile();
          emit();
          return;
        }
        const { user: userPart, device } = splitPatch(p);
        const touched = (Object.keys(userPart) as UserPrefKey[]).filter((k) =>
          USER_KEY_SET.has(k),
        );
        // Device part first: it is applied whatever happens to the user part.
        if (Object.keys(device).length > 0) {
          const merged: Record<string, unknown> = { ...fromFile };
          for (const k of Object.keys(device)) merged[k] = (next as unknown as Record<string, unknown>)[k];
          fromFile = sanitize(merged);
          writeFile();
          recompute();
          emit();
        }
        if (touched.length === 0) return;
        await seedLocked();
        if (store.canWrite()) {
          for (const k of touched) {
            await store.set(tableKey(k), next[k]);
            mirror[tableKey(k)] = next[k];
          }
          recompute();
          emit();
        } else if (forwardUser) {
          // The leader writes it and it comes back by the feed; until then the
          // local mirror shows the change (the feed's value overwrites it).
          await forwardUser(userPart);
          for (const k of touched) mirror[tableKey(k)] = next[k];
          recompute();
          emit();
        } else {
          throw new Error('this device is a read-only copy: it cannot change this setting');
        }
      }),
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    attachUser,
    refreshUser: () =>
      serial(async () => {
        if (!store) return;
        const loaded = await store.all();
        if (!sameJson(loaded, mirror)) {
          const old = mirror;
          mirror = loaded;
          const before = current;
          recompute();
          if (!sameJson(before, current)) emit();
          for (const k of new Set([...Object.keys(old), ...Object.keys(loaded)])) {
            if (isExtKey(k) && !sameJson(old[k], loaded[k])) fireExt(k, loaded[k]);
          }
        }
        await seedLocked();
      }),
    seedUser: () => serial(seedLocked),
    getExt: (key) => (isExtKey(key) ? mirror[key] : undefined),
    setExt: (key, value, opts) =>
      serial(async () => {
        if (!isExtKey(key)) throw new Error(`'${key}' is not an extension setting`);
        const stored = jsonCopy(value);
        if (!store) throw new Error('settings are not ready yet');
        if (store.canWrite()) {
          await store.set(key, stored);
          mirror[key] = stored;
          if (opts?.notify) fireExt(key, stored);
        } else if (forwardExt) {
          // The leader writes it and it comes back by the feed.
          await forwardExt(key, stored);
          mirror[key] = stored;
        } else {
          throw new Error('this device is a read-only copy: it cannot change this setting');
        }
      }),
    getCore: (key) => mirror[key],
    updateCore: (key, fn) =>
      serial(async () => {
        if (!key.startsWith('core.')) throw new Error(`'${key}' is not a core setting`);
        if (!store) throw new Error('settings are not ready yet');
        if (!store.canWrite()) {
          throw new Error('this device is a read-only copy: it cannot change this setting');
        }
        const next = fn(mirror[key]);
        if (next === undefined) return;
        const stored = jsonCopy(next);
        if (sameJson(stored, mirror[key])) return;
        await store.set(key, stored);
        mirror[key] = stored;
      }),
    offerable: () =>
      serial(async () => {
        const rows = store ? await store.all() : mirror;
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(rows)) if (offerableKey(k)) out[k] = v;
        // A user key still in prefs.json (never seeded here) is a choice too.
        for (const k of USER_PREF_KEYS) {
          const t = tableKey(k);
          if (!(t in out) && !sameJson(fromFile[k], DEFAULT_PREFS[k])) out[t] = fromFile[k];
        }
        return out;
      }),
    addMissing: (entries) =>
      serial(async () => {
        if (!store) throw new Error('settings are not ready yet');
        if (!store.canWrite()) {
          throw new Error('this device is a read-only copy: it cannot change this setting');
        }
        // The master's own file values count as the master's: move them first.
        await seedLocked();
        const added: string[] = [];
        for (const [k, v] of Object.entries(entries)) {
          if (!offerableKey(k) || k in mirror) continue;
          let stored: unknown;
          try {
            stored = jsonCopy(v);
          } catch {
            continue; // one unusable value must not refuse the rest
          }
          await store.set(k, stored);
          mirror[k] = stored;
          added.push(k);
        }
        if (added.length === 0) return added;
        const before = current;
        recompute();
        if (!sameJson(before, current)) emit();
        for (const k of added) if (isExtKey(k)) fireExt(k, mirror[k]);
        return added;
      }),
    onExtChange(cb) {
      extListeners.add(cb);
      return () => extListeners.delete(cb);
    },
    setForwardExt(fn) {
      forwardExt = fn;
    },
    setForwardUser(fn) {
      forwardUser = fn;
    },
  };
  if (user) (prefs as { ready: Promise<void> }).ready = attachUser(user);
  return prefs;
}

/** The store over `user_prefs`. `canWrite` is asked on every call: a follower
 *  never writes the table, and a promotion changes the answer. */
export function createDbUserPrefsStore(
  db: Pick<AppDb, 'all' | 'run'>,
  canWrite: () => boolean,
): UserPrefsStore {
  return {
    canWrite,
    async all() {
      const out: Record<string, unknown> = {};
      for (const r of await db.all(`SELECT key, value_json FROM user_prefs`)) {
        try {
          out[String(r.key)] = JSON.parse(String(r.value_json));
        } catch {
          // a value nobody can read is the same as one nobody set
        }
      }
      return out;
    },
    async set(key, value) {
      await db.run(
        `INSERT INTO user_prefs (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        [key, JSON.stringify(value)],
      );
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
