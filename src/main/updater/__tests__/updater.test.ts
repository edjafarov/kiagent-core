/** @jest-environment node */
import { EventEmitter } from 'events';
import { createUpdater } from '@main/updater/updater';
import type { UpdateState, UpdaterDeps } from '@main/updater/types';

/** A fake autoUpdater: an EventEmitter plus the methods the module calls. */
function fakeAutoUpdater() {
  const ee = new EventEmitter();
  return Object.assign(ee, {
    logger: null as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    forceDevUpdateConfig: undefined as boolean | undefined,
    checkForUpdates: jest.fn(async () => ({})),
    quitAndInstall: jest.fn(),
  });
}

function makeDeps(over: Partial<UpdaterDeps> = {}): {
  deps: UpdaterDeps;
  au: ReturnType<typeof fakeAutoUpdater>;
} {
  const au = fakeAutoUpdater();
  const deps: UpdaterDeps = {
    autoUpdater: au as unknown as UpdaterDeps['autoUpdater'],
    log: {
      transports: { file: { level: '' } },
    } as unknown as UpdaterDeps['log'],
    isPackaged: true,
    platform: 'win32',
    currentVersion: '0.38.0',
    now: () => 1000,
    ...over,
  };
  return { deps, au };
}

describe('createUpdater eligibility gate', () => {
  it('is disabled in dev with reason "dev"', () => {
    const { deps } = makeDeps({ isPackaged: false });
    const m = createUpdater(deps);
    expect(m.getState()).toMatchObject({ status: 'disabled', reason: 'dev' });
  });

  it('allows dev checks when devUpdates is set', () => {
    const { deps } = makeDeps({ isPackaged: false, devUpdates: true });
    const m = createUpdater(deps);
    expect(m.getState().status).toBe('idle');
  });

  it('is disabled on macOS while signing is off', () => {
    const { deps } = makeDeps({ platform: 'darwin' });
    const m = createUpdater(deps);
    expect(m.getState()).toMatchObject({
      status: 'disabled',
      reason: 'unsigned-macos',
    });
  });

  it('check() on a disabled updater never touches the network', async () => {
    const { deps, au } = makeDeps({ isPackaged: false });
    const m = createUpdater(deps);
    await m.check();
    expect(au.checkForUpdates).not.toHaveBeenCalled();
  });
});

describe('createUpdater event → state', () => {
  it('starts idle on an eligible platform', () => {
    const { deps } = makeDeps();
    expect(createUpdater(deps).getState()).toMatchObject({
      status: 'idle',
      currentVersion: '0.38.0',
      version: null,
    });
  });

  it('maps update-available → available with the target version', () => {
    const { deps, au } = makeDeps();
    const m = createUpdater(deps);
    const states: UpdateState[] = [];
    m.onStateChange((s) => states.push(s));
    au.emit('update-available', { version: '0.39.0' });
    expect(m.getState()).toMatchObject({
      status: 'available',
      version: '0.39.0',
    });
    expect(states.at(-1)).toMatchObject({
      status: 'available',
      version: '0.39.0',
    });
  });

  it('maps download-progress → downloading with percent', () => {
    const { deps, au } = makeDeps();
    const m = createUpdater(deps);
    au.emit('download-progress', { percent: 42.7, bytesPerSecond: 1000 });
    expect(m.getState()).toMatchObject({
      status: 'downloading',
      percent: 42.7,
    });
  });

  it('maps update-downloaded → downloaded', () => {
    const { deps, au } = makeDeps();
    const m = createUpdater(deps);
    au.emit('update-downloaded', { version: '0.39.0' });
    expect(m.getState()).toMatchObject({
      status: 'downloaded',
      version: '0.39.0',
    });
  });

  it('maps update-not-available → up-to-date with checkedAt', () => {
    const { deps, au } = makeDeps();
    const m = createUpdater(deps);
    au.emit('update-not-available', {});
    expect(m.getState()).toMatchObject({
      status: 'up-to-date',
      checkedAt: 1000,
    });
  });

  it('normalizes error events to a string and never throws', () => {
    const { deps, au } = makeDeps();
    const m = createUpdater(deps);
    au.emit('error', new Error('boom'));
    expect(m.getState()).toMatchObject({ status: 'error', error: 'boom' });
  });

  it('check() sets checking and calls electron-updater', async () => {
    const { deps, au } = makeDeps();
    const m = createUpdater(deps);
    const s = await m.check();
    expect(s.status).toBe('checking');
    expect(au.checkForUpdates).toHaveBeenCalled();
  });

  it('quitAndInstall delegates to autoUpdater', () => {
    const { deps, au } = makeDeps();
    createUpdater(deps).quitAndInstall();
    expect(au.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('onStateChange subscribers receive transitions', () => {
    const { deps, au } = makeDeps();
    const m = createUpdater(deps);
    const seen: UpdateState[] = [];
    const off = m.onStateChange((s) => seen.push(s));
    au.emit('update-available', { version: '0.39.0' });
    off();
    au.emit('update-downloaded', { version: '0.39.0' });
    expect(seen).toHaveLength(1);
    expect(seen[0].status).toBe('available');
  });
});
