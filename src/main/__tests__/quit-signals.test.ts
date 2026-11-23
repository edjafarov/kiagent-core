/** @jest-environment node */
import { EventEmitter } from 'events';
import { installQuitSignalHandlers } from '../quit-signals';

function lifecycle() {
  const signals = new EventEmitter();
  const app = Object.assign(new EventEmitter(), {
    quit: jest.fn(() => {
      app.emit('before-quit');
    }),
  });
  installQuitSignalHandlers(app, signals);
  return { app, signals };
}

test.each(['SIGINT', 'SIGTERM', 'SIGHUP'])(
  '%s requests the normal Electron quit lifecycle',
  (signal) => {
    const { app, signals } = lifecycle();
    const cleanup = jest.fn();
    app.on('before-quit', cleanup);
    signals.emit(signal);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  },
);

test('repeated terminal signals leave asynchronous provider cleanup in control', async () => {
  const { app, signals } = lifecycle();
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  app.once('before-quit', () => {
    void cleanup.then(() => app.quit());
  });

  signals.emit('SIGINT');
  signals.emit('SIGINT');
  signals.emit('SIGTERM');
  signals.emit('SIGHUP');
  expect(app.quit).toHaveBeenCalledTimes(1);

  finishCleanup();
  await cleanup;
  expect(app.quit).toHaveBeenCalledTimes(2);
});

test('a terminal signal cannot interrupt cleanup already started by the Quit menu', () => {
  const { app, signals } = lifecycle();
  app.quit();
  signals.emit('SIGTERM');
  signals.emit('SIGINT');
  expect(app.quit).toHaveBeenCalledTimes(1);
});
