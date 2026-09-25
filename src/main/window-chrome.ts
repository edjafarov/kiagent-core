/** Main-window size and title-bar chrome. The renderer draws one 48px band
 *  across the top (sidebar head + page top bar); the traffic lights and the
 *  Windows/Linux caption buttons sit inside it. */

export const DEFAULT_WINDOW = { width: 1280, height: 800 } as const;
export const MIN_WINDOW = { width: 960, height: 600 } as const;
const BAND_HEIGHT = 48;

export interface WindowChrome {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  trafficLightPosition: { x: number; y: number };
  titleBarOverlay?: { color: string; symbolColor: string; height: number };
}

function fit(want: number, available: number, min: number): number {
  return Math.max(min, Math.min(want, available));
}

export function windowChrome(
  platform: NodeJS.Platform,
  workArea: { width: number; height: number },
): WindowChrome {
  return {
    width: fit(DEFAULT_WINDOW.width, workArea.width, MIN_WINDOW.width),
    height: fit(DEFAULT_WINDOW.height, workArea.height, MIN_WINDOW.height),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    // Centres the lights on the band.
    // ui.css pads the sidebar head and gate band 90px to clear these.
    trafficLightPosition: { x: 16, y: 17 },
    // On macOS a titleBarOverlay would override trafficLightPosition.
    ...(platform !== 'darwin' && {
      titleBarOverlay: {
        color: '#ffffff',
        symbolColor: '#0f172a',
        height: BAND_HEIGHT,
      },
    }),
  };
}
