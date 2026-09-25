import { windowChrome, DEFAULT_WINDOW, MIN_WINDOW } from '../window-chrome';

describe('windowChrome', () => {
  it('opens at the default size on a large display', () => {
    const c = windowChrome('darwin', { width: 1728, height: 1079 });
    expect([c.width, c.height]).toEqual([
      DEFAULT_WINDOW.width,
      DEFAULT_WINDOW.height,
    ]);
    expect([c.minWidth, c.minHeight]).toEqual([
      MIN_WINDOW.width,
      MIN_WINDOW.height,
    ]);
  });

  it('fits a small laptop work area', () => {
    const c = windowChrome('win32', { width: 1366, height: 728 });
    expect([c.width, c.height]).toEqual([1280, 728]);
  });

  it('never goes below the minimum', () => {
    const c = windowChrome('linux', { width: 800, height: 500 });
    expect([c.width, c.height]).toEqual([960, 600]);
  });

  it('puts the lights on the band on macOS and the caption overlay elsewhere', () => {
    expect(windowChrome('darwin', { width: 1440, height: 900 })).toMatchObject({
      trafficLightPosition: { x: 16, y: 17 },
    });
    expect(
      windowChrome('darwin', { width: 1440, height: 900 }).titleBarOverlay,
    ).toBeUndefined();
    expect(
      windowChrome('win32', { width: 1440, height: 900 }).titleBarOverlay,
    ).toEqual({
      color: '#ffffff',
      symbolColor: '#0f172a',
      height: 48,
    });
  });
});
