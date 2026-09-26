// One install flow for every screen that installs, updates or re-consents
// an extension. It knows nothing about where the user goes afterwards.
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Cap,
  DeclaredFileRoot,
  ExtensionSnapshot,
  OAuthSourceBinding,
} from '@shared/contracts';

export type InstallMode = 'install' | 'update' | 'review';

/** What the install sheet asks the user to agree to. `token` is set for
 *  install/update (a staged package); review re-consents an installed id. */
export interface InstallRequest {
  mode: InstallMode;
  token?: string;
  id: string;
  name: string;
  version: string;
  caps: Cap[];
  oauthSources?: OAuthSourceBinding[];
  fileRoots?: DeclaredFileRoot[];
  /** The extension contributes pages, which run with full access to the app. */
  addsPages?: boolean;
  sizeBytes?: number;
  integrity?: string | null;
  iconDataUrl?: string;
  ref?: string;
}

export interface ExtensionInstall {
  consent: InstallRequest | null;
  busy: boolean;
  error: string | null;
  /** Stages `ref` and opens the sheet; a refusal lands in `error`. */
  preview: (ref: string, mode: 'install' | 'update') => Promise<void>;
  review: (snapshot: ExtensionSnapshot) => void;
  /** Applies the open request and closes the sheet either way. */
  commit: () => Promise<{ ok: boolean; id?: string }>;
  cancel: () => void;
  uninstall: (id: string) => Promise<void>;
  setEnabled: (id: string, on: boolean) => Promise<void>;
}

export function useExtensionInstall(): ExtensionInstall {
  const [consent, setConsent] = useState<InstallRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Runs one host call with `busy` held; `fail` names a refusal without text.
  const run = useCallback(
    async (
      call: () => Promise<{ ok: boolean; error?: string }>,
      fail: string,
    ): Promise<void> => {
      setError(null);
      setBusy(true);
      try {
        const r = await call();
        if (alive.current && !r.ok) setError(r.error ?? fail);
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [],
  );

  const preview = useCallback(
    async (ref: string, mode: 'install' | 'update'): Promise<void> => {
      setError(null);
      setBusy(true);
      try {
        const p = await window.kiagent.invoke('extension:install-preview', {
          ref,
        });
        if (!alive.current) return;
        if (!('token' in p)) {
          setError(p.error);
          return;
        }
        setConsent({
          mode,
          token: p.token,
          id: p.id,
          name: p.name,
          version: p.version,
          caps: p.caps,
          oauthSources: p.oauthSources,
          fileRoots: p.fileRoots,
          addsPages: p.ui.length > 0,
          sizeBytes: p.sizeBytes,
          integrity: p.integrity,
          iconDataUrl: p.iconDataUrl,
          ref,
        });
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [],
  );

  const review = useCallback((e: ExtensionSnapshot): void => {
    setError(null);
    setConsent({
      mode: 'review',
      id: e.id,
      name: e.name,
      version: e.version,
      caps: e.caps,
      oauthSources: e.oauthSources,
      fileRoots: e.fileRoots,
      addsPages: (e.ui ?? []).length > 0,
      iconDataUrl: e.iconDataUrl,
      ref: e.ref,
    });
  }, []);

  const commit = useCallback(async (): Promise<{
    ok: boolean;
    id?: string;
  }> => {
    if (!consent) return { ok: false };
    const r =
      consent.mode === 'review'
        ? {
            ...(await window.kiagent.invoke('extension:grant-consent', {
              id: consent.id,
            })),
            id: consent.id,
          }
        : await window.kiagent.invoke('extension:install-commit', {
            token: consent.token!,
          });
    if (alive.current) {
      if (!r.ok) setError(r.error ?? 'operation failed');
      setConsent(null);
    }
    return { ok: r.ok, id: r.ok ? (r.id ?? consent.id) : undefined };
  }, [consent]);

  const cancel = useCallback(() => setConsent(null), []);

  const uninstall = useCallback(
    (id: string) =>
      run(
        () => window.kiagent.invoke('extension:uninstall', { id }),
        'uninstall failed',
      ),
    [run],
  );

  const setEnabled = useCallback(
    (id: string, on: boolean) =>
      run(
        () =>
          window.kiagent.invoke('extension:set-enabled', { id, enabled: on }),
        'operation failed',
      ),
    [run],
  );

  return {
    consent,
    busy,
    error,
    preview,
    review,
    commit,
    cancel,
    uninstall,
    setEnabled,
  };
}
