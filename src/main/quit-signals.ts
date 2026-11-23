type QuitApp = {
  on(event: 'before-quit', listener: () => void): unknown;
  quit(): void;
};

type QuitSignals = {
  on(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', listener: () => void): unknown;
};

/** Route terminal shutdown through the same awaited cleanup as the Quit menu. */
export function installQuitSignalHandlers(
  app: QuitApp,
  signals: QuitSignals = process,
): void {
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
  });
  const requestQuit = () => {
    if (quitting) return;
    quitting = true;
    app.quit();
  };
  // Keep the listeners installed: a second signal must neither exit Node
  // directly nor issue another app.quit() while providers are still stopping.
  signals.on('SIGINT', requestQuit);
  signals.on('SIGTERM', requestQuit);
  signals.on('SIGHUP', requestQuit);
}
