import React from 'react';

const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** 30px drag strip shown ONLY on the signed-out gates (BootSplash, SignIn).
 *  The signed-in shell has no titlebar — the sidebar header is the drag
 *  region and macOS traffic lights float inside it (main.ts
 *  trafficLightPosition). */
export function TitleBar(): React.ReactElement {
  return (
    <div
      className="kg-titlebar"
      style={
        {
          paddingLeft: isMac ? 76 : 12,
          paddingRight: isMac ? 12 : 140,
        } as React.CSSProperties
      }
    >
      <span className="kg-titlebar-title">KIAgent</span>
    </div>
  );
}
