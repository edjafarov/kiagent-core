/** @jest-environment node */
import http from 'node:http';

import { shell } from 'electron';

import { runOAuthLoopback } from '../oauth-window';

jest.mock('electron', () => ({ shell: { openExternal: jest.fn() } }));

const HOST = '127.0.0.1';
const PORT = 34987;
const REDIRECT_URI = `http://${HOST}:${PORT}/oauth/callback`;
const AUTH_URL = 'https://provider.example/authorize?client_id=abc';

/** Polls `check` until it resolves true or `timeoutMs` elapses. */
async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await check()) return;
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** True if a throwaway server can bind PORT (and is closed again right
 *  away) — i.e. nothing currently holds the listening socket. */
function canBindPort(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(PORT, HOST, () => probe.close(() => resolve(true)));
  });
}

/** `server.close()` doesn't hand the OS-level unbind back synchronously —
 *  poll rather than assume the port is free the instant a promise settles. */
const waitForPortFree = (timeoutMs = 2000) => pollUntil(canBindPort, timeoutMs);

const waitForPortBusy = (timeoutMs = 2000) =>
  pollUntil(async () => !(await canBindPort()), timeoutMs);

/** Retries `fetch` until the loopback server has started listening. */
async function fetchWithRetry(
  url: string,
  timeoutMs = 2000,
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await fetch(url);
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

describe('runOAuthLoopback', () => {
  afterEach(async () => {
    jest.clearAllMocks();
    // Safety net: a test that fails partway through must not leave the
    // fixed test port bound for the next test.
    await waitForPortFree();
  });

  it('opens the system browser and resolves with the full callback URL after a 200 html response', async () => {
    const promise = runOAuthLoopback(AUTH_URL, REDIRECT_URI);

    const res = await fetchWithRetry(`${REDIRECT_URI}?code=abc&state=xyz`);
    expect(shell.openExternal).toHaveBeenCalledWith(AUTH_URL);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    await expect(res.text()).resolves.toMatch(/Sign-in complete/);

    const callbackUrl = await promise;
    expect(callbackUrl).toContain('code=abc');
    expect(callbackUrl).toContain('state=xyz');
  });

  it('an error callback gets the didn’t-complete page but still resolves the URL (exchange owns validation)', async () => {
    const promise = runOAuthLoopback(AUTH_URL, REDIRECT_URI);

    const res = await fetchWithRetry(`${REDIRECT_URI}?error=access_denied`);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toMatch(/didn.t complete/);

    const callbackUrl = await promise;
    expect(callbackUrl).toContain('error=access_denied');
  });

  it('a stray request 404s and does not settle the promise; the real callback still resolves it', async () => {
    const promise = runOAuthLoopback(AUTH_URL, REDIRECT_URI);

    const strayRes = await fetchWithRetry(`http://${HOST}:${PORT}/favicon.ico`);
    expect(strayRes.status).toBe(404);

    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);

    const res = await fetch(`${REDIRECT_URI}?code=abc&state=xyz`);
    expect(res.status).toBe(200);

    const callbackUrl = await promise;
    expect(callbackUrl).toContain('code=abc');
  });

  it('rejects with a friendly message mentioning the port when it is already in use', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(PORT, HOST, resolve);
    });

    try {
      await expect(runOAuthLoopback(AUTH_URL, REDIRECT_URI)).rejects.toThrow(
        new RegExp(`${PORT}.*already in use`),
      );
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('abort rejects with the cancellation message and frees the port', async () => {
    const controller = new AbortController();
    const promise = runOAuthLoopback(AUTH_URL, REDIRECT_URI, controller.signal);
    await waitForPortBusy();

    controller.abort();
    await expect(promise).rejects.toThrow('connect flow cancelled');

    await waitForPortFree();
  });

  it('a pre-aborted signal rejects immediately without binding the port', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runOAuthLoopback(AUTH_URL, REDIRECT_URI, controller.signal),
    ).rejects.toThrow('connect flow cancelled');
    expect(shell.openExternal).not.toHaveBeenCalled();

    // The port was never touched — binding it now succeeds right away.
    await waitForPortFree(200);
  });
});
