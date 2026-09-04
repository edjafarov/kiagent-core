import { installCloseToTray } from '../close-to-tray';
import type { ClosableWindow } from '../close-to-tray';

/** Minimal stand-in for the BrowserWindow surface the policy touches. */
function fakeWindow() {
  const listeners: ((event: { preventDefault: () => void }) => void)[] = [];
  let hidden = 0;
  const win: ClosableWindow = {
    on(event, listener) {
      expect(event).toBe('close');
      listeners.push(listener);
      return win;
    },
    hide() {
      hidden += 1;
    },
  };
  return {
    win,
    listenerCount: () => listeners.length,
    /** Fire a close the way Electron does; returns whether it was vetoed. */
    close() {
      let prevented = false;
      for (const listener of listeners)
        listener({
          preventDefault: () => {
            prevented = true;
          },
        });
      return prevented;
    },
    hidden: () => hidden,
  };
}

describe('installCloseToTray', () => {
  it('hides the window instead of closing it on Windows/Linux', () => {
    for (const platform of ['win32', 'linux'] as NodeJS.Platform[]) {
      const w = fakeWindow();
      installCloseToTray(w.win, { platform, isQuitting: () => false });
      expect(w.close()).toBe(true);
      expect(w.hidden()).toBe(1);
    }
  });

  it('lets the close through once a quit is underway', () => {
    const w = fakeWindow();
    let quitting = false;
    installCloseToTray(w.win, {
      platform: 'win32',
      isQuitting: () => quitting,
    });
    quitting = true;
    expect(w.close()).toBe(false);
    expect(w.hidden()).toBe(0);
  });

  it('leaves macOS alone — no close listener at all', () => {
    const w = fakeWindow();
    installCloseToTray(w.win, { platform: 'darwin', isQuitting: () => false });
    expect(w.listenerCount()).toBe(0);
  });
});
