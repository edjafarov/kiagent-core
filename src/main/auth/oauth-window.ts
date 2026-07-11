import { BrowserWindow } from 'electron';

import type { Credentials } from '@shared/contracts';

/**
 * Per-provider OAuth knowledge lives in a profile a source family registers;
 * the platform owns the interactive machinery. The "loopback" redirect URI is
 * never actually listened on — navigation to it is intercepted inside the
 * auth window (same trick the legacy app used on port 34123).
 */
export interface OAuthProfile {
  redirectUri: string;
  authUrl(scopes: string[], redirectUri: string): string;
  /** Exchange the intercepted callback URL for tokens. */
  exchange(callbackUrl: string, redirectUri: string): Promise<Credentials>;
}

/** Open an auth window, intercept the redirect, return the full callback URL.
 *  `signal` (a connect flow's cancellation) closes the window and rejects —
 *  without it the window is independent of the wizard and outlives a
 *  cancelled flow, letting a completed sign-in create an account anyway. */
export function runOAuthWindow(
  authUrl: string,
  redirectPrefix: string,
  parent?: BrowserWindow,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('connect flow cancelled'));
      return;
    }
    const win = new BrowserWindow({
      width: 520,
      height: 680,
      parent,
      modal: false,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    let settled = false;
    const onAbort = () =>
      settle(() => reject(new Error('connect flow cancelled')));
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      fn();
      if (!win.isDestroyed()) win.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: [`${redirectPrefix}*`] },
      (details, callback) => {
        callback({ cancel: true });
        settle(() => resolve(details.url));
      },
    );
    win.on('closed', () => {
      settle(() => reject(new Error('auth window closed')));
    });
    void win.loadURL(authUrl);
  });
}
