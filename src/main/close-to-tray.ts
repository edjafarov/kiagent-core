/**
 * Close-to-tray for Windows and Linux.
 *
 * macOS has a window/app split the other two desktops don't: closing the last
 * window leaves the app running (main.ts's `window-all-closed` deliberately
 * skips `app.quit()` there) and the tray's "Open KIAgent" brings it back.
 * Everywhere else that same handler quits — and quitting this app is not
 * "closing a window": `before-quit` destroys the tray, stops MCP, stops every
 * extension and shuts the platform down, so the window's X button silently
 * ended all background indexing and took the remote-MCP tunnel with it.
 *
 * The fix is to stop the close rather than to stop the quit: on Windows and
 * Linux the window hides instead of closing, so `window-all-closed` never
 * fires and the tray stays as both the way back in and the way out. The quit
 * itself must still work, which is what `isQuitting` is for — main.ts flips it
 * in `before-quit`, before the teardown's own `app.quit()` reaches the window.
 *
 * Note for Linux: on a desktop with no AppIndicator support the tray icon is
 * created but never drawn, and a hidden window is then hard to get back
 * (a second launch focuses the running instance). That is inherent to the
 * "keep running in the background" behaviour this restores, not to hiding.
 */

/** The slice of BrowserWindow this policy touches. */
export interface ClosableWindow {
  on(
    event: 'close',
    listener: (event: { preventDefault: () => void }) => void,
  ): unknown;
  hide(): void;
}

export interface CloseToTrayDeps {
  platform: NodeJS.Platform;
  /** True once app quit is underway — then the close must proceed. */
  isQuitting: () => boolean;
}

/**
 * Make the window's close button hide it, leaving the app running in the
 * tray. No-op on macOS, whose close-then-recreate flow already keeps the app
 * alive.
 */
export function installCloseToTray(
  win: ClosableWindow,
  deps: CloseToTrayDeps,
): void {
  if (deps.platform === 'darwin') return;
  win.on('close', (event) => {
    if (deps.isQuitting()) return;
    event.preventDefault();
    win.hide();
  });
}
