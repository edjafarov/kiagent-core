import fs from 'fs';
import path from 'path';

import type { AppPrefs, OnboardingPrefs, Prefs } from '@shared/contracts';

export const DEFAULT_PREFS: AppPrefs = {
  theme: 'system',
  logLevel: 'info',
  launchAtLogin: false,
  showInMenuBar: true,
  processing: { enabled: true, window: 'idle' },
  privacy: { browserHistory: false, sendDiagnostics: false },
  models: { override: 'auto', autoInstall: true },
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

function sanitize(raw: unknown): AppPrefs {
  const r = (raw ?? {}) as Partial<AppPrefs>;
  return {
    theme: r.theme === 'light' || r.theme === 'dark' ? r.theme : 'system',
    logLevel:
      r.logLevel === 'warn' || r.logLevel === 'error' ? r.logLevel : 'info',
    launchAtLogin: r.launchAtLogin === true,
    showInMenuBar: r.showInMenuBar !== false,
    processing: {
      enabled: r.processing?.enabled !== false,
      window:
        r.processing?.window === 'always' || r.processing?.window === 'night'
          ? r.processing.window
          : 'idle',
    },
    privacy: {
      browserHistory: r.privacy?.browserHistory === true,
      sendDiagnostics: r.privacy?.sendDiagnostics === true,
    },
    models: {
      override:
        typeof r.models?.override === 'string' && r.models.override
          ? r.models.override
          : 'auto',
      autoInstall: r.models?.autoInstall !== false,
    },
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
        privacy: { ...current.privacy, ...(p.privacy ?? {}) },
        models: { ...current.models, ...(p.models ?? {}) },
        onboarding: { ...current.onboarding, ...(p.onboarding ?? {}) },
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
