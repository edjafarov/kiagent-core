import React from 'react';

const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

/** Drag strip shown ONLY on the signed-out gates (BootSplash, SignIn) —
 *  the signed-in shell gets its top drag band from the sidebar header plus
 *  .kg-topline instead. Taller on macOS (.mac): the traffic lights sit
 *  at y 18–32 (main.ts trafficLightPosition) and must not poke below it. */
export function TitleBar(): React.ReactElement {
  return (
    <div
      className={`kg-titlebar${isMac ? ' mac' : ''}`}
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
