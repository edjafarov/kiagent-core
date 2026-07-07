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

/** Open an auth window, intercept the redirect, return the full callback URL. */
export function runOAuthWindow(
  authUrl: string,
  redirectPrefix: string,
  parent?: BrowserWindow,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 680,
      parent,
      modal: false,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
      if (!win.isDestroyed()) win.close();
    };
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
