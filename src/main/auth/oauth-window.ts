import type { Credentials } from '@shared/contracts';

/**
 * Per-provider OAuth knowledge lives in a profile a source family registers;
 * the platform owns the interactive machinery.
 *
 * Sign-in runs in the system browser (`shell.openExternal`), NOT an embedded
 * BrowserWindow: Google's OAuth policy blocks sign-in inside embedded
 * webviews for native apps, and Google's app-verification reviewer needs to
 * see a real browser address bar in the demo video. We instead run a
 * loopback `node:http` server on the profile's registered redirect URI
 * (`http://127.0.0.1:<port><path>`) and capture the callback the browser
 * navigates to once the user completes consent.
 *
 * Port 34123 is shared with the separate remote-mcp sign-in flow (a sibling
 * loopback OAuth flow in a different part of the app) — if that flow's
 * server already has the port bound, EADDRINUSE surfaces as a friendly
 * "already in progress" error instead of a raw errno.
 */
export interface OAuthProfile {
  redirectUri: string;
  authUrl(scopes: string[], redirectUri: string): string;
  /** Exchange the captured callback URL for tokens. */
  exchange(callbackUrl: string, redirectUri: string): Promise<Credentials>;
}

/** How long we wait for the user to complete consent before giving up. */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

/** Branded landing page for the browser tab the provider redirects back to.
 *  Mirrors the shared web-ui "minimal" shell (tokens.css values inlined —
 *  this file must stay import-clean under jest, so no `?raw` CSS imports). */
function donePage(ok: boolean): string {
  const title = ok ? 'Sign-in complete' : 'Sign-in didn&#39;t complete';
  const body = ok
    ? 'You can close this tab and return to kiagent.'
    : 'You can close this tab and try again from kiagent.';
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${ok ? 'Sign-in complete' : 'Sign-in didn’t complete'}</title>` +
    '<style>' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;' +
    'justify-content:center;background:#ffffff;color:#0f172a;' +
    "font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI'," +
    'sans-serif;padding:32px 24px;box-sizing:border-box}' +
    '.card{max-width:440px;display:flex;flex-direction:column;gap:14px;' +
    'border-left:3px solid #7c3aed;padding-left:22px}' +
    'h1{font-size:22px;font-weight:600;letter-spacing:-0.02em;' +
    'line-height:1.18;margin:0}' +
    'p{font-size:13px;color:#64748b;margin:0;line-height:1.6}' +
    '</style></head><body>' +
    `<div class="card"><h1>${title}</h1><p>${body}</p></div>` +
    '</body></html>'
  );
}

/** Open the system browser on `authUrl`, listen on `redirectUri`'s loopback
 *  host/port/path for the provider's redirect, and resolve with the full
 *  callback URL (the redirect URI's origin + the request's path and query)
 *  once it lands — `exchange()` parses `code`/`state`/`error` and does the
 *  CSRF check itself, so the server only has to capture the URL. `signal`
 *  (a connect flow's cancellation) rejects and tears the server down —
 *  without it the server is independent of the wizard and outlives a
 *  cancelled flow, letting a completed sign-in create an account anyway. */
export function runOAuthLoopback(
  authUrl: string,
  redirectUri: string,
  signal?: AbortSignal,
): Promise<string> {
  // Lazy-required so importing this module under jest (no electron) is
  // safe — see the module-load-safety note above.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('node:http') as typeof import('node:http');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { shell } = require('electron') as typeof import('electron');

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('connect flow cancelled'));
      return;
    }

    const target = new URL(redirectUri);
    const host = target.hostname;
    const port = target.port ? Number(target.port) : 80;
    const callbackPath = target.pathname;

    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', redirectUri);
      // Only the callback path settles; stray requests (favicon, etc.) get a
      // 404 and must NOT resolve the promise before the real redirect lands.
      if (reqUrl.pathname !== callbackPath) {
        res.writeHead(404, { Connection: 'close' }).end();
        return;
      }
      // `Connection: close` — this server is single-shot; forcing the socket
      // shut instead of keep-alive lets it release the port right away
      // rather than waiting out an idle keep-alive timeout. The page only
      // reflects the callback's error param — exchange() still does the real
      // code/state validation on the resolved URL.
      res
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          Connection: 'close',
        })
        .end(donePage(!reqUrl.searchParams.get('error')));
      settle(() => resolve(target.origin + (req.url ?? '')));
    });

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
      server.close();
    };

    const onAbort = () =>
      settle(() => reject(new Error('connect flow cancelled')));
    signal?.addEventListener('abort', onAbort, { once: true });

    server.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        settle(() =>
          reject(
            new Error(
              `Loopback port ${port} is already in use — another sign-in ` +
                'may be in progress; finish or cancel it and retry.',
            ),
          ),
        );
      } else {
        settle(() => reject(e));
      }
    });

    server.listen(port, host, () => {
      timer = setTimeout(
        () =>
          settle(() =>
            reject(new Error('Sign-in timed out — please try again.')),
          ),
        OAUTH_TIMEOUT_MS,
      );
      void shell.openExternal(authUrl);
    });
  });
}
